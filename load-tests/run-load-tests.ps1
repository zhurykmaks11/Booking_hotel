<#
.SYNOPSIS
    Навантажувальне тестування Booking_Hotel (Лаб. №5, №6, №7): k6 у Docker + збір метрик середовища.

.DESCRIPTION
    Експерименти:
      baseline  — сценарії A (Read), B (Write), C (Workflow) на 3 інстансах з теплим кешем
      scaling   — той самий сценарій на 1 інстансі та на 3 інстансах (Scaling Impact Analysis)
      caching   — сценарій A з вимкненим Redis та з теплим кешем (Caching Impact Analysis)
      replication — Лаб. №6: Single Primary vs Primary + Replica (Read Scaling Impact) для сценаріїв
                  -ReplicationScenarios (за замовчуванням D — mixed, A — read); Redis вимкнено,
                  CPU кожного вузла СУБД обмежено до -DbCpus, щоб вузьким місцем була саме СУБД
      sharding  — Лаб. №7 (результати в results-lab7/), порівняння з -ShardRuns:
                    local  — сценарій E (Shard-Local) на 1 і на 2 шардах;
                    fanout — сценарій F (Cross-Shard Fan-out) на 1 і на 2 шардах;
                    hot    — сценарій G (Hot Shard) зі стратегією city і зі стратегією hash.
                  Перед кожним прогоном шарди перестворюються порожніми, Redis вимкнено,
                  CPU кожного шарду обмежено до -DbCpus
      single    — один прогін вибраного сценарію (для демонстрації на захисті)
      all       — baseline + scaling + caching

    Під час кожного прогону:
      * k6 запускається в окремому контейнері з обмеженням CPU (ізоляція генератора навантаження);
      * живий дашборд k6: http://localhost:5665, HTML-звіт з графіками: results/<назва>-dashboard.html;
      * кожні 3 с знімається docker stats (CPU/RAM контейнерів) → results/<назва>-docker-stats.csv;
      * до/після знімаються лічильники PostgreSQL Primary і Replica (транзакції, відкати) → results/<назва>-db.json.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File load-tests/run-load-tests.ps1 -Experiment all -ApplyLimits
    powershell -ExecutionPolicy Bypass -File load-tests/run-load-tests.ps1 -Experiment single -Scenario c -Hold 20
    powershell -ExecutionPolicy Bypass -File load-tests/run-load-tests.ps1 -Experiment replication -ApplyLimits
    powershell -ExecutionPolicy Bypass -File load-tests/run-load-tests.ps1 -Experiment sharding -ApplyLimits
#>
param(
    [ValidateSet('baseline', 'scaling', 'caching', 'replication', 'sharding', 'single', 'all')]
    [string]$Experiment = 'baseline',

    [ValidateSet('a', 'b', 'c', 'd', 'e', 'f', 'g')]
    [string]$Scenario = 'a',

    # Лаб. №6: сценарії для експерименту replication і ліміт CPU кожного вузла СУБД на час експерименту
    [string]$ReplicationScenarios = 'd,a',
    [string]$DbCpus = '0.25',

    # Лаб. №7: які порівняння виконати в експерименті sharding і обсяг тестових даних
    [string]$ShardRuns = 'local,fanout,hot',
    [int]$SeedHotels = 40,
    [int]$SeedBookings = 2000,
    [string]$SeedCityWeights = 'Kyiv:40,Lviv:20,Odesa:15,Kharkiv:15,Chernivtsi:10',

    [string]$Levels = '10,25,50,100,200',
    [int]$Hold = 60,
    [int]$Ramp = 10,
    [int]$Warmup = 30,
    [double]$Think = 0.1,

    [string]$K6Image = 'grafana/k6:1.0.0',
    [string]$K6Cpus = '2',
    [string]$BaseUrl = 'http://nginx',

    # Перезапустити кластер з лімітами CPU/RAM і пулом з'єднань з load-tests/docker-compose.loadtest.yml
    [switch]$ApplyLimits
)

# 'Continue': у Windows PowerShell 5.1 режим 'Stop' перетворює будь-який вивід docker у stderr на виняток.
# Помилки, що мають зупиняти скрипт, кидаються явно (throw).
$ErrorActionPreference = 'Continue'

# Не даємо Windows заснути під час тесту: сон (Modern Standby) посеред фази утримання спотворює виміри.
# Діє лише поки працює цей процес; закриття кришки ноутбука все одно призведе до сну.
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.Power]::SetThreadExecutionState([uint32]'0x80000003') | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path      # ...\backend\load-tests
$Backend = Split-Path -Parent $Root                            # ...\backend
$ResultsDirName = 'results'
if ($Experiment -eq 'sharding') { $ResultsDirName = 'results-lab7' }
$Results = Join-Path $Root $ResultsDirName
New-Item -ItemType Directory -Force -Path $Results | Out-Null

# nginx.conf перезаписується під час перемикання топологій — наприкінці повертаємо оригінал
$NginxConf = Join-Path $Backend 'nginx.conf'
$OriginalNginx = [IO.File]::ReadAllText($NginxConf)

$PrimaryDb = 'database_primary'
$ReplicaDb = 'database_replica'
# Single Primary Topology (Лаб. №6): API запускається без DATABASE_REPLICA_URL
$script:SingleDb = $false
# Sharded Topology (Лаб. №7): docker-compose.sharding.yml; OneShard — усі бакети на shard-a
$script:Sharding = $false
$script:OneShard = $false
$script:ShardLabel = ''
$ShardContainers = @('database_shard_a', 'database_shard_b')
# Обсяг тестових даних k6 (для sharding задається параметрами -Seed*)
$script:SeedHotelsNow = 20
$script:SeedBookingsNow = 0
$script:SeedCityWeightsNow = ''

$ScenarioFiles = @{
    a = 'scenario-a-read.js'
    b = 'scenario-b-write.js'
    c = 'scenario-c-workflow.js'
    d = 'scenario-d-mixed.js'
    e = 'scenario-e-shard-local.js'
    f = 'scenario-f-cross-shard.js'
    g = 'scenario-g-hot-shard.js'
}

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Invoke-Compose([string[]]$ComposeArgs) {
    Push-Location $Backend
    try {
        $files = @('-f', 'docker-compose.yml')
        if ($ApplyLimits) { $files += @('-f', 'load-tests/docker-compose.loadtest.yml') }
        if ($script:SingleDb) { $files += @('-f', 'load-tests/docker-compose.single-db.yml') }
        if ($script:Sharding) {
            $files += @('-f', 'docker-compose.sharding.yml')
            if ($ApplyLimits) { $files += @('-f', 'load-tests/docker-compose.sharding-loadtest.yml') }
            if ($script:OneShard) { $files += @('-f', 'load-tests/docker-compose.one-shard.yml') }
        }
        & docker compose @files @ComposeArgs
        if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArgs -join ' ') завершився з помилкою" }
    }
    finally { Pop-Location }
}

function Wait-Healthy([int]$TimeoutSec = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri 'http://localhost/health' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { return }
        }
        catch { }
        Start-Sleep -Seconds 2
    }
    throw 'Система не відповідає на http://localhost/health. Перевірте docker compose ps.'
}

function Get-ClusterNetwork {
    $net = docker inspect hotel_booking_nginx --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
    if ($LASTEXITCODE -ne 0 -or -not $net) { throw 'Контейнер hotel_booking_nginx не знайдено. Спершу: docker compose up -d' }
    return ($net.Trim() -split ' ')[0]
}

function Set-Nginx([string]$Config) {
    Copy-Item -Path (Join-Path $Backend "nginx/nginx.$Config.conf") -Destination (Join-Path $Backend 'nginx.conf') -Force -ErrorAction Stop
    docker exec hotel_booking_nginx nginx -s reload | Out-Null
    Start-Sleep -Seconds 2
}

function Set-Topology([int]$Instances) {
    if ($Instances -eq 1) {
        # Спершу конфіг з одним вузлом, потім зупинка зайвих інстансів
        Set-Nginx 'single'
        Invoke-Compose @('stop', 'api-2', 'api-3') | Out-Null
    }
    else {
        Invoke-Compose @('start', 'api-2', 'api-3') | Out-Null
        Start-Sleep -Seconds 10
        Set-Nginx 'roundrobin'
    }
    Wait-Healthy
    Write-Host "Топологія: $Instances backend-інстанс(и)" -ForegroundColor DarkGray
}

function Set-Redis([bool]$Enabled) {
    if ($Enabled) {
        docker start hotel_booking_redis | Out-Null
        for ($i = 0; $i -lt 20; $i++) {
            $pong = docker exec hotel_booking_redis redis-cli ping 2>$null
            if ($pong -eq 'PONG') { break }
            Start-Sleep -Seconds 1
        }
        docker exec hotel_booking_redis redis-cli FLUSHALL | Out-Null   # холодний старт кешу, розігріває фаза warm-up
        Start-Sleep -Seconds 4                                         # клієнти API перепідключаються (retryStrategy ≤ 2 с)
        Write-Host 'Redis: увімкнено (кеш очищено, розігріється у фазі warm-up)' -ForegroundColor DarkGray
    }
    else {
        docker stop hotel_booking_redis | Out-Null
        Start-Sleep -Seconds 3
        Write-Host 'Redis: вимкнено (усі читання йдуть у PostgreSQL, X-Cache: BYPASS)' -ForegroundColor DarkGray
    }
}

function Set-DbTopology([bool]$WithReplica) {
    # Перестворюємо API з іншим DATABASE_REPLICA_URL; вузли СУБД не змінюються
    $script:SingleDb = -not $WithReplica
    Invoke-Compose @('up', '-d', '--no-deps', 'api-1', 'api-2', 'api-3') | Out-Null
    Start-Sleep -Seconds 10
    Set-Nginx 'roundrobin'   # reload: nginx заново резолвить IP перестворених контейнерів
    Wait-Healthy
    $topology = 'Single Primary (читання і запис на Primary)'
    if ($WithReplica) { $topology = 'Primary + Replica (читання на Replica)' }
    Write-Host "Топологія СУБД: $topology" -ForegroundColor DarkGray
}

function Get-DbCounters([string]$Container = $PrimaryDb) {
    $q = "select xact_commit, xact_rollback, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted from pg_stat_database where datname = 'hotel_booking'"
    $line = docker exec $Container psql -U postgres -d hotel_booking -tAc $q 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $line) {
        return [pscustomobject]@{ commit = 0; rollback = 0; returned = 0; fetched = 0; inserted = 0; updated = 0; deleted = 0 }
    }
    $p = ($line | Out-String).Trim() -split '\|'
    return [pscustomobject]@{
        commit   = [int64]$p[0]
        rollback = [int64]$p[1]
        returned = [int64]$p[2]
        fetched  = [int64]$p[3]
        inserted = [int64]$p[4]
        updated  = [int64]$p[5]
        deleted  = [int64]$p[6]
    }
}

function Write-Environment {
    $file = Join-Path $Results 'environment.md'
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $cs = Get-CimInstance Win32_ComputerSystem
    $dockerCpus = docker info --format '{{.NCPU}}'
    $dockerMem = [math]::Round([int64](docker info --format '{{.MemTotal}}') / 1GB, 1)
    $nodeVersion = (node --version) 2>$null
    $limits = 'не задані (контейнери без обмежень)'
    if ($ApplyLimits) { $limits = 'load-tests/docker-compose.loadtest.yml: api 1 CPU / 512 МБ, db-primary 1 CPU / 1 ГБ, db-replica 1 CPU / 1 ГБ, redis 0.5 CPU / 256 МБ, nginx 1 CPU / 256 МБ' }
    $pool = 'Prisma за замовчуванням (num_cpus × 2 + 1 на інстанс до кожного вузла БД)'
    if ($ApplyLimits) { $pool = 'connection_limit=10, pool_timeout=10 с на інстанс до кожного вузла БД' }

    $lines = @(
        '# Baseline Environment Specification',
        '',
        "Знято: $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
        '',
        '| Параметр | Значення |',
        '|---|---|',
        "| Хост (CPU) | $($cpu.Name.Trim()), $($cpu.NumberOfCores) ядер / $($cpu.NumberOfLogicalProcessors) потоків |",
        "| Хост (RAM) | $([math]::Round($cs.TotalPhysicalMemory / 1GB, 1)) ГБ |",
        "| Docker Desktop | $dockerCpus CPU, $dockerMem ГБ RAM |",
        "| Ліміти контейнерів | $limits |",
        '| Backend | NestJS 10 (Node.js 24 у контейнері), 3 інстанси за Nginx (Round Robin), для Scaling — 1 інстанс |',
        "| Пул з'єднань БД | $pool |",
        '| БД | PostgreSQL 16: Primary + Read Replica (асинхронна streaming replication); для Лаб. №5 і Single Primary читання йдуть на Primary |',
        '| Кеш | Redis 7, maxmemory 128 МБ, allkeys-lru (для Caching — вимкнений / теплий) |',
        "| Генератор навантаження | $K6Image в окремому контейнері, ліміт $K6Cpus CPU, мережа кластера (запити напряму до nginx) |",
        "| Профіль | розігрів $Warmup с, ступені $Levels VUs, перехід $Ramp с, утримання $Hold с, пауза $Think с |",
        "| Node.js на хості | $nodeVersion |",
        '',
        '## Стан контейнерів',
        '',
        '```'
    )
    $lines += (docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | Out-String).TrimEnd()
    $lines += '```'
    Set-Content -Path $file -Value $lines -Encoding UTF8
}

function Invoke-K6([string]$Name, [string]$ScenarioKey) {
    $script = $ScenarioFiles[$ScenarioKey]
    Write-Step "$Name  ($script)"
    Write-Host 'Живий дашборд k6: http://localhost:5665' -ForegroundColor Yellow

    $network = Get-ClusterNetwork
    $statsFile = Join-Path $Results "$Name-docker-stats.csv"
    $job = Start-Job -ArgumentList $statsFile -ScriptBlock {
        param($f)
        Set-Content -Path $f -Value 'time,container,cpu,mem' -Encoding UTF8
        while ($true) {
            $t = Get-Date -Format 'HH:mm:ss'
            docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' |
                ForEach-Object { Add-Content -Path $f -Value "$t,$_" -Encoding UTF8 }
            Start-Sleep -Seconds 3
        }
    }

    $before = Get-DbCounters $PrimaryDb
    $beforeReplica = Get-DbCounters $ReplicaDb
    $beforeShards = @{}
    if ($script:Sharding) { foreach ($c in $ShardContainers) { $beforeShards[$c] = Get-DbCounters $c } }
    $sw = [Diagnostics.Stopwatch]::StartNew()

    $dockerArgs = @(
        'run', '--rm', '-i',
        '--network', $network,
        '--cpus', $K6Cpus,
        '-p', '5665:5665',
        '-v', "${Root}:/scripts",
        '-w', '/scripts',
        '-e', "BASE_URL=$BaseUrl",
        '-e', "TEST_NAME=$Name",
        '-e', "LEVELS=$Levels",
        '-e', "HOLD=$Hold",
        '-e', "RAMP=$Ramp",
        '-e', "WARMUP=$Warmup",
        '-e', "THINK=$Think",
        '-e', "RESULTS_DIR=$ResultsDirName",
        '-e', "SEED_HOTELS=$($script:SeedHotelsNow)",
        '-e', "SEED_BOOKINGS=$($script:SeedBookingsNow)",
        '-e', "SEED_CITY_WEIGHTS=$($script:SeedCityWeightsNow)",
        '-e', 'K6_WEB_DASHBOARD=true',
        '-e', "K6_WEB_DASHBOARD_EXPORT=$ResultsDirName/$Name-dashboard.html",
        $K6Image, 'run', $script
    )
    try {
        & docker @dockerArgs
    }
    finally {
        $sw.Stop()
        Stop-Job $job | Out-Null
        Remove-Job $job -Force | Out-Null
    }

    $after = Get-DbCounters $PrimaryDb
    $afterReplica = Get-DbCounters $ReplicaDb
    $seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $db = [ordered]@{
        name              = $Name
        durationSec       = $seconds
        commits           = $after.commit - $before.commit
        rollbacks         = $after.rollback - $before.rollback
        tuplesReturned    = $after.returned - $before.returned
        tuplesFetched     = $after.fetched - $before.fetched
        tuplesInserted    = $after.inserted - $before.inserted
        commitsPerSec     = [math]::Round(($after.commit - $before.commit) / $seconds, 1)
        rollbacksPerSec   = [math]::Round(($after.rollback - $before.rollback) / $seconds, 2)
        # Лаб. №6: транзакції (читання) на Replica — частка read-трафіку, знятого з Primary
        replicaCommits    = $afterReplica.commit - $beforeReplica.commit
        replicaCommitsPerSec = [math]::Round(($afterReplica.commit - $beforeReplica.commit) / $seconds, 1)
        replicaTuplesReturned = $afterReplica.returned - $beforeReplica.returned
    }
    if ($script:Sharding) {
        # Лаб. №7: транзакції і записи (insert + update + delete) на кожному шарді за прогін
        $shardStats = [ordered]@{}
        foreach ($c in $ShardContainers) {
            $a = Get-DbCounters $c
            $b = $beforeShards[$c]
            $shardStats[$c] = [ordered]@{
                commits        = $a.commit - $b.commit
                commitsPerSec  = [math]::Round(($a.commit - $b.commit) / $seconds, 1)
                writes         = ($a.inserted - $b.inserted) + ($a.updated - $b.updated) + ($a.deleted - $b.deleted)
                tuplesReturned = $a.returned - $b.returned
            }
        }
        $db['shards'] = $shardStats
        $db['shardTopology'] = $script:ShardLabel
    }
    $db | ConvertTo-Json | Set-Content -Path (Join-Path $Results "$Name-db.json") -Encoding UTF8
    Write-Host ("PostgreSQL Primary за прогін: {0} commit ({1}/с), {2} rollback; Replica: {3} commit ({4}/с)" -f $db.commits, $db.commitsPerSec, $db.rollbacks, $db.replicaCommits, $db.replicaCommitsPerSec) -ForegroundColor DarkGray
}

function Invoke-Baseline {
    Set-Topology 3
    Set-Redis $true
    foreach ($s in @('a', 'b', 'c')) { Invoke-K6 "baseline-$s" $s }
}

function Invoke-Scaling {
    Set-Redis $true
    Set-Topology 1
    Invoke-K6 "scaling-1x-$Scenario" $Scenario
    Set-Topology 3
    Set-Redis $true
    Invoke-K6 "scaling-3x-$Scenario" $Scenario
}

function Invoke-Caching {
    Set-Topology 3
    Set-Redis $false
    Invoke-K6 'cache-off-a' 'a'
    Set-Redis $true
    Invoke-K6 'cache-on-a' 'a'
}

function Set-DbCpus([string]$Cpus) {
    # docker update змінює ліміт CPU без перезапуску контейнерів (реплікація не переривається)
    docker update --cpus $Cpus $PrimaryDb $ReplicaDb | Out-Null
    Write-Host "CPU вузлів СУБД: $Cpus (кожен)" -ForegroundColor DarkGray
}

function Invoke-Replication {
    # Redis вимкнено: кожне читання доходить до СУБД, тож видно саме ефект масштабування читання.
    # СУБД обмежена до -DbCpus: у конфігурації Лаб. №5 вузьке місце — CPU API, і зміна топології СУБД
    # на пропускну здатність не впливала б (див. LAB6.md).
    $originalCpus = [double](docker inspect $PrimaryDb --format '{{.HostConfig.NanoCpus}}') / 1e9
    Set-Topology 3
    Set-Redis $false
    Set-DbCpus $DbCpus
    try {
        foreach ($s in ($ReplicationScenarios -split ',' | ForEach-Object { $_.Trim() })) {
            Set-DbTopology $false
            Invoke-K6 "repl-single-$s" $s
            Set-DbTopology $true
            Invoke-K6 "repl-replica-$s" $s
        }
    }
    finally {
        Set-DbCpus ([string]$originalCpus).Replace(',', '.')
    }
}

function Wait-Shards([int]$TimeoutSec = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $ready = $ShardContainers | Where-Object { (docker inspect $_ --format '{{.State.Health.Status}}' 2>$null) -eq 'healthy' }
        if (@($ready).Count -eq $ShardContainers.Count) { return }
        Start-Sleep -Seconds 2
    }
    throw 'Шарди не стали healthy. Перевірте docker compose ps.'
}

function Set-ShardTopology([int]$Shards, [string]$Strategy, [string]$Cpus = $DbCpus) {
    # Свіжі порожні шарди (--renew-anon-volumes); API перестворюється з новими SHARD_URLS / SHARD_STRATEGY
    # і при старті накатує міграції на шарди (docker/api/entrypoint.sh)
    $env:SHARD_STRATEGY = $Strategy
    $script:Sharding = $true
    $script:OneShard = ($Shards -eq 1)
    $script:ShardLabel = "$Shards shard(s), strategy=$Strategy"
    Invoke-Compose @('up', '-d', '--force-recreate', '--renew-anon-volumes', 'db-shard-a', 'db-shard-b') | Out-Null
    Wait-Shards
    docker update --cpus $Cpus $ShardContainers | Out-Null
    Invoke-Compose @('up', '-d', '--no-deps', '--force-recreate', 'api-1', 'api-2', 'api-3') | Out-Null
    Start-Sleep -Seconds 15
    Set-Nginx 'roundrobin'   # reload: nginx заново резолвить IP перестворених контейнерів
    Wait-Healthy 120
    Write-Host "Топологія: $script:ShardLabel, CPU кожного шарду $Cpus" -ForegroundColor DarkGray
}

function Invoke-Sharding {
    # Redis вимкнено (як у Лаб. №6): кожне читання доходить до шардів.
    # Глобальний вузол (гості) не обмежується -DbCpus — він не є предметом порівняння.
    Set-Topology 3
    Set-Redis $false
    $script:SeedHotelsNow = $SeedHotels
    $script:SeedCityWeightsNow = $SeedCityWeights
    $runs = $ShardRuns -split ',' | ForEach-Object { $_.Trim() }
    if ($runs -contains 'local') {
        $script:SeedBookingsNow = 0
        Set-ShardTopology 1 'hash'; Invoke-K6 'shard1-e-local' 'e'
        Set-ShardTopology 2 'hash'; Invoke-K6 'shard2-e-local' 'e'
    }
    if ($runs -contains 'fanout') {
        $script:SeedBookingsNow = $SeedBookings
        Set-ShardTopology 1 'hash'; Invoke-K6 'shard1-f-fanout' 'f'
        Set-ShardTopology 2 'hash'; Invoke-K6 'shard2-f-fanout' 'f'
    }
    if ($runs -contains 'hot') {
        $script:SeedBookingsNow = 0
        Set-ShardTopology 2 'city'; Invoke-K6 'hot-city-g' 'g'
        Set-ShardTopology 2 'hash'; Invoke-K6 'hot-hash-g' 'g'
    }
}

# ------------------------------------------------------------------
Write-Step "Підготовка (експеримент: $Experiment)"
if ($ApplyLimits) {
    Write-Host 'Перезапуск кластера з лімітами CPU/RAM (load-tests/docker-compose.loadtest.yml)...'
    Invoke-Compose @('up', '-d') | Out-Null
}
Wait-Healthy
Write-Environment

try {
    switch ($Experiment) {
        'baseline' { Invoke-Baseline }
        'scaling' { Invoke-Scaling }
        'caching' { Invoke-Caching }
        'replication' { Invoke-Replication }
        'sharding' { Invoke-Sharding }
        'single' { Set-Topology 3; Set-Redis $true; Invoke-K6 "single-$Scenario" $Scenario }
        'all' { Invoke-Baseline; Invoke-Scaling; Invoke-Caching }
    }
}
finally {
    # Повертаємо кластер у робочий стан: 3 інстанси, Round Robin, Redis увімкнено, читання з Replica
    Write-Step 'Відновлення робочої конфігурації'
    if ($script:SingleDb) { try { Set-DbTopology $true } catch { Write-Warning $_ } }
    # Лаб. №7: лишаємо шардований кластер (2 шарди, hash, CPU як у compose) для демонстрацій
    if ($script:Sharding) { try { Set-ShardTopology 2 'hash' '1' } catch { Write-Warning $_ } }
    try { Set-Redis $true } catch { Write-Warning $_ }
    try { Set-Topology 3 } catch { Write-Warning $_ }
    try {
        [IO.File]::WriteAllText($NginxConf, $OriginalNginx)
        docker exec hotel_booking_nginx nginx -s reload | Out-Null
    }
    catch { Write-Warning $_ }
}

Write-Step 'Зведений звіт'
if ($Experiment -eq 'sharding') { node (Join-Path $Root 'report-sharding.js') }
else { node (Join-Path $Root 'report.js') }
Write-Host "Готово. Результати: $Results" -ForegroundColor Green
