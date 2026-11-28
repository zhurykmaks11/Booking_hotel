/**
 * Лаб. №8 — Resilience Engineering: демонстрація і вимірювання.
 *
 *   node scripts/resilience-demo.js status                      — режим захисту і лічильники
 *   node scripts/resilience-demo.js config protection=none jitter=false ...
 *   node scripts/resilience-demo.js reset                       — конфігурація зі змінних середовища, лічильники = 0
 *   node scripts/resilience-demo.js stampede --mode none -n 600 — холодний ключ + 600 одночасних запитів
 *   node scripts/resilience-demo.js compare -n 600 --save       — stampede для none / singleflight / lock / swr
 *   node scripts/resilience-demo.js avalanche --jitter off --save
 *   node scripts/resilience-demo.js penetration --negative off --save
 *   node scripts/resilience-demo.js k6 --mode lock --vus 500 --save   — k6: 500 VUs, TTL 5 с
 *   node scripts/resilience-demo.js k6-all --save                      — k6 для всіх режимів
 *
 * Кількість звернень до СУБД рахується двома незалежними способами:
 *   app — лічильник dbLoads (скільки разів API виконав запит, Redis HINCRBY, спільний для 3 інстансів);
 *   db  — pg_stat_statements.calls для запиту статистики (маркер stats_cost) на вузлі, де лежить готель.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const args = process.argv.slice(2);
const command = args[0] || 'status';
const baseUrl = getArg('-u', 'http://localhost');
const RESULTS = path.join(__dirname, '..', 'load-tests', 'results-lab8');
const NODE_CONTAINER = { 'shard-a': 'database_shard_a', 'shard-b': 'database_shard_b', global: 'database_primary' };
const MODES = ['none', 'singleflight', 'lock', 'swr'];
const DEFAULTS = { statsTtlSec: 60, statsJitterSec: 15, jitter: true, negativeCache: true, protection: 'lock' };

const c = {
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const hasFlag = (flag) => args.includes(flag);
const onOff = (flag, fallback) => (getArg(flag, fallback ? 'on' : 'off') === 'on');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Службові запити — через keep-alive; навантаження — окреме з'єднання на кожен запит (як різні клієнти)
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const burstAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
// Тривале навантаження з хоста (Avalanche, Penetration): постійні з'єднання, по одному на «клієнта»
const loadAgent = new http.Agent({ keepAlive: true, maxSockets: 512 });

function title(text) {
    console.log(`\n${c.cyan('='.repeat(78))}\n  ${text}\n${c.cyan('='.repeat(78))}`);
}

function request(method, urlPath, body, useAgent = agent) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const start = process.hrtime.bigint();
        const req = http.request(
            `${baseUrl}${urlPath}`,
            { method, agent: useAgent, headers: data ? { 'Content-Type': 'application/json' } : {}, timeout: 30_000 },
            (res) => {
                let raw = '';
                res.on('data', (chunk) => (raw += chunk));
                res.on('end', () => {
                    let json = null;
                    try {
                        json = JSON.parse(raw);
                    } catch {
                        json = raw;
                    }
                    resolve({
                        status: res.statusCode,
                        body: json,
                        ms: Number(process.hrtime.bigint() - start) / 1e6,
                        cache: res.headers['x-cache'] ?? '—',
                        instance: res.headers['x-instance-id'] ?? '—',
                    });
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (err) => resolve({ status: 0, body: err.message, ms: Number(process.hrtime.bigint() - start) / 1e6, cache: 'ERROR' }));
        if (data) req.write(data);
        req.end();
    });
}

async function must(method, urlPath, body, expected = [200, 201]) {
    const res = await request(method, urlPath, body);
    if (!expected.includes(res.status)) throw new Error(`${method} ${urlPath} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
}

const percentile = (values, p) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const f1 = (n) => Number(n).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function save(name, data) {
    fs.mkdirSync(RESULTS, { recursive: true });
    const file = path.join(RESULTS, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    console.log(c.dim(`збережено: ${path.relative(process.cwd(), file)}`));
}

// ------------------------------------------------------------------ кластер
const setConfig = async (patch) => {
    const cfg = await must('PUT', '/resilience/config', patch);
    await sleep(1500); // інші інстанси перечитують конфігурацію раз на секунду
    return cfg;
};
const metrics = async () => (await must('GET', '/resilience')).metrics;
const resetMetrics = () => must('POST', '/resilience/metrics/reset');
const expireStats = (ids) => must('POST', '/resilience/expire', { resource: 'stats', ids });

async function pickHotel() {
    const explicit = getArg('--hotel', null);
    if (explicit) return explicit;
    const hotels = await must('GET', '/hotels');
    if (!hotels.length) throw new Error('Немає готелів: node scripts/sharding-demo.js seed');
    return hotels[0].id;
}

async function nodeOf(hotelId) {
    const route = await request('GET', `/sharding/route/${hotelId}`);
    const shard = route.status === 200 ? route.body.shard : 'global';
    return { shard, container: NODE_CONTAINER[shard] ?? 'database_primary' };
}

function psql(container, sql) {
    return execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'hotel_booking', '-tAc', sql], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
}

/** Скидає pg_stat_statements на вузлі (створює розширення, якщо його ще немає). */
function resetDbCalls(container) {
    psql(container, 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    psql(container, 'SELECT pg_stat_statements_reset()');
}

/** Скільки разів СУБД виконала запит статистики готелю (маркер stats_cost). */
function dbCalls(container) {
    const out = psql(container, "SELECT COALESCE(SUM(calls), 0) FROM pg_stat_statements WHERE query LIKE '%stats_cost%'");
    return Number(out.split('\n').pop()) || 0;
}

/**
 * Thundering Herd на боці СУБД: скільки запитів статистики виконуються ОДНОЧАСНО.
 * psql у контейнері кожні ~0,1 с протягом seconds; повертає Promise з масивом вибірок.
 */
function sampleActive(container, seconds) {
    const sql =
        "SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%stats_cost%' AND pid <> pg_backend_pid()";
    const script = `end=$(( $(date +%s) + ${seconds} )); while [ $(date +%s) -lt $end ]; do psql -U postgres -d hotel_booking -tAc "${sql}"; sleep 0.1; done`;
    return new Promise((resolve) => {
        execFile('docker', ['exec', container, 'sh', '-c', script], { encoding: 'utf8' }, (err, stdout) => {
            resolve((stdout || '').split('\n').map(Number).filter((n) => !Number.isNaN(n) && stdout.trim() !== ''));
        });
    });
}

// ------------------------------------------------------------------ status / config
async function status() {
    const res = await must('GET', '/resilience');
    title('Конфігурація захисту кешу (спільна для всіх інстансів)');
    for (const [k, v] of Object.entries(res.config)) console.log(`  ${pad(k, 18)} ${c.yellow(v)}`);
    title('Лічильники (з моменту останнього reset)');
    const m = res.metrics;
    if (!Object.keys(m).length) console.log(c.dim('  порожньо'));
    for (const [k, v] of Object.entries(m)) console.log(`  ${pad(k, 18)} ${v}`);
}

async function config() {
    const patch = {};
    for (const pair of args.slice(1)) {
        const [k, v] = pair.split('=');
        if (!k || v === undefined) continue;
        patch[k] = v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v);
    }
    const cfg = await setConfig(patch);
    console.log(cfg);
}

async function reset() {
    await must('POST', '/resilience/config/reset');
    await resetMetrics();
    console.log(c.green('Конфігурація — зі змінних середовища, лічильники обнулено'));
}

// ------------------------------------------------------------------ 2.2 / 2.4: Cache Stampede
async function stampedeRun(mode, n, hotelId) {
    const node = await nodeOf(hotelId);
    await setConfig({ protection: mode, statsTtlSec: DEFAULTS.statsTtlSec, statsJitterSec: DEFAULTS.statsJitterSec });

    // SWR захищає саме момент «старіння»: ключ є, але застарів. Готуємо такий стан: TTL 2 с → чекаємо 2,5 с.
    if (mode === 'swr') {
        await setConfig({ statsTtlSec: 2, statsJitterSec: 0 });
        await expireStats([hotelId]);
        await request('GET', `/hotels/${hotelId}/stats`);
        await sleep(2500);
    } else {
        await expireStats([hotelId]); // Force Expire: холодний ключ
    }
    await resetMetrics();
    resetDbCalls(node.container);

    // k6: n VUs, кожен — один запит, усі одночасно (генератор усередині мережі Docker)
    const sampler = sampleActive(node.container, 12);
    const k6 = runK6({ scenario: 'burst', vus: n, hotelId, output: `burst-${mode}.json`, quiet: true });
    await sleep(800); // фонове оновлення SWR і лічильники
    const samples = await sampler;
    const m = await metrics();
    const calls = dbCalls(node.container);
    if (mode === 'swr') await setConfig({ statsTtlSec: DEFAULTS.statsTtlSec, statsJitterSec: DEFAULTS.statsJitterSec });

    return {
        mode,
        requests: n,
        node: node.shard,
        dbLoadsApp: m.dbLoads ?? 0,
        dbCalls: calls,
        peakActiveDb: samples.length ? Math.max(...samples) : 0,
        rps: k6.rps,
        p50: k6.p50,
        p95: k6.p95,
        p99: k6.p99,
        max: k6.max,
        errors: Math.round((k6.errorRate / 100) * k6.requests),
        errorRate: k6.errorRate,
        byCache: k6.byCache,
        metrics: m,
    };
}

function printStampede(r) {
    const color = r.dbCalls <= 1 ? c.green : c.red;
    console.log(`  Режим захисту:             ${c.yellow(r.mode)}   (вузол СУБД: ${r.node})`);
    console.log(`  Одночасних запитів:        ${r.requests}`);
    console.log(`  Звернень до СУБД (db):     ${color(r.dbCalls)}   ${c.dim('pg_stat_statements.calls')}`);
    console.log(`  Звернень до СУБД (app):    ${color(r.dbLoadsApp)}   ${c.dim('лічильник dbLoads API')}`);
    console.log(`  Пік одночасних запитів у СУБД: ${r.peakActiveDb}   ${c.dim('pg_stat_activity (Thundering Herd)')}`);
    console.log(`  Latency p50 / p95 / p99 / max: ${f1(r.p50)} / ${f1(r.p95)} / ${f1(r.p99)} / ${f1(r.max)} мс`);
    console.log(`  Throughput:                ${f1(r.rps)} RPS`);
    console.log(`  Помилки:                   ${r.errors ? c.red(`${r.errors} (${f1(r.errorRate)} %)`) : c.green('0')}`);
    console.log(`  Відповіді за X-Cache:      ${Object.entries(r.byCache).map(([k, v]) => `${k}=${v}`).join('  ')}`);
}

async function stampede() {
    const mode = getArg('--mode', 'none');
    const n = Number(getArg('-n', 600));
    const hotelId = await pickHotel();
    title(`Cache Stampede: Force Expire + ${n} одночасних GET /hotels/${hotelId.slice(0, 8)}…/stats`);
    const r = await stampedeRun(mode, n, hotelId);
    printStampede(r);
    if (hasFlag('--save')) save(`stampede-${mode}.json`, r);
    await setConfig({ protection: DEFAULTS.protection });
}

async function compare() {
    const n = Number(getArg('-n', 600));
    const hotelId = await pickHotel();
    const rows = [];
    for (const mode of MODES) {
        title(`Режим ${mode}: ${n} одночасних запитів до холодного ключа`);
        const r = await stampedeRun(mode, n, hotelId);
        printStampede(r);
        rows.push(r);
        await sleep(1500);
    }
    title('Порівняльна матриця (п. 2.7)');
    console.log(`  ${pad('Режим', 14)}${padL('СУБД (db)', 10)}${padL('app', 6)}${padL('пік', 6)}${padL('RPS', 9)}${padL('p95', 9)}${padL('p99', 9)}${padL('Err %', 8)}`);
    for (const r of rows) {
        console.log(
            `  ${pad(r.mode, 14)}${padL(r.dbCalls, 10)}${padL(r.dbLoadsApp, 6)}${padL(r.peakActiveDb, 6)}${padL(f1(r.rps), 9)}${padL(f1(r.p95), 9)}${padL(f1(r.p99), 9)}${padL(f1(r.errorRate), 8)}`,
        );
    }
    if (hasFlag('--save')) save('stampede-compare.json', { requests: n, hotelId, rows });
    await setConfig({ protection: DEFAULTS.protection });
}

// ------------------------------------------------------------------ 2.3 / 2.5: Cache Avalanche і TTL Jitter
async function avalanche() {
    const keys = Number(getArg('--keys', 40));
    const duration = Number(getArg('--duration', 45));
    const ttl = Number(getArg('--ttl', 10));
    const concurrency = Number(getArg('-c', 40));
    const jitter = onOff('--jitter', false);
    const hotels = (await must('GET', '/hotels')).slice(0, keys).map((h) => h.id);

    title(`Cache Avalanche: ${hotels.length} популярних ключів, TTL ${ttl} с, jitter ${jitter ? `±${Math.round(ttl / 2)} с` : 'вимкнено'}`);
    // lock — щоб виміряти саме синхронне вигасання ГРУПИ ключів (кожен ключ = рівно 1 звернення)
    await setConfig({ protection: 'lock', jitter, statsTtlSec: ttl, statsJitterSec: Math.round(ttl / 2) });
    await expireStats();
    // Прогрів одним «пакетом» — як після деплою / рестарту Redis: усі ключі записані в ту саму секунду
    await Promise.all(hotels.map((id) => request('GET', `/hotels/${id}/stats`, null, burstAgent)));
    await resetMetrics();

    const perSec = Array.from({ length: duration }, () => ({ ms: [], errors: 0, dbLoads: 0 }));
    const start = Date.now();
    let stop = false;
    let prevLoads = 0;
    const sampler = (async () => {
        for (let s = 0; s < duration; s++) {
            await sleep(start + (s + 1) * 1000 - Date.now());
            const loads = (await metrics()).dbLoads ?? 0;
            perSec[s].dbLoads = loads - prevLoads;
            prevLoads = loads;
        }
        stop = true;
    })();
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (!stop) {
                const id = hotels[Math.floor(Math.random() * hotels.length)];
                const r = await request('GET', `/hotels/${id}/stats`, null, loadAgent);
                const s = Math.floor((Date.now() - start) / 1000);
                if (s < duration) {
                    perSec[s].ms.push(r.ms);
                    if (r.status !== 200) perSec[s].errors++;
                }
            }
        }),
    );
    await sampler;
    await setConfig({ ...DEFAULTS });

    const timeline = perSec.map((b, s) => ({
        second: s + 1,
        rps: b.ms.length,
        p95: percentile(b.ms, 95),
        max: b.ms.length ? Math.max(...b.ms) : 0,
        dbLoads: b.dbLoads,
        errors: b.errors,
    }));
    console.log(`  ${pad('с', 4)}${padL('RPS', 6)}${padL('p95', 8)}${padL('max', 8)}${padL('БД', 5)}  звернення до СУБД`);
    for (const t of timeline) {
        const bar = '█'.repeat(t.dbLoads);
        console.log(`  ${pad(t.second, 4)}${padL(t.rps, 6)}${padL(f1(t.p95), 8)}${padL(f1(t.max), 8)}${padL(t.dbLoads, 5)}  ${t.dbLoads >= keys / 2 ? c.red(bar) : c.green(bar)}`);
    }
    const loads = timeline.map((t) => t.dbLoads);
    const summary = {
        keys: hotels.length,
        ttl,
        jitter,
        jitterSec: jitter ? Math.round(ttl / 2) : 0,
        concurrency,
        duration,
        totalDbLoads: loads.reduce((a, b) => a + b, 0),
        peakDbLoadsPerSec: Math.max(...loads),
        p95Overall: percentile(perSec.flatMap((b) => b.ms), 95),
        p99Overall: percentile(perSec.flatMap((b) => b.ms), 99),
        worstSecondP95: Math.max(...timeline.map((t) => t.p95)),
        timeline,
    };
    console.log(
        `\n  Пік звернень до СУБД за 1 с: ${summary.peakDbLoadsPerSec}, усього: ${summary.totalDbLoads}; ` +
            `p95 найгіршої секунди: ${f1(summary.worstSecondP95)} мс; p99 за весь тест: ${f1(summary.p99Overall)} мс`,
    );
    if (hasFlag('--save')) save(`avalanche-jitter-${jitter ? 'on' : 'off'}.json`, summary);
}

// ------------------------------------------------------------------ 2.6: Cache Penetration і Negative Caching
async function penetration() {
    const n = Number(getArg('-n', 3000));
    const concurrency = Number(getArg('-c', 50));
    const idCount = Number(getArg('--ids', 50));
    const negative = onOff('--negative', true);
    // Неіснуючі id: «атакувальник» перебирає обмежений набір (наприклад, старі посилання / бот)
    const ids = Array.from({ length: idCount }, () => randomUUID());

    title(`Cache Penetration: ${n} запитів до ${idCount} неіснуючих готелів, Negative Caching ${negative ? 'увімкнено' : 'вимкнено'}`);
    await setConfig({ protection: 'lock', negativeCache: negative });
    await expireStats(ids);
    await resetMetrics();
    const containers = [...new Set(Object.values(NODE_CONTAINER))];
    for (const ct of containers) resetDbCalls(ct);

    const ms = [];
    let next = 0;
    let notFound = 0;
    let other = 0;
    const byCache = {};
    const t0 = Date.now();
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            while (next < n) {
                next++;
                const id = ids[Math.floor(Math.random() * ids.length)];
                const r = await request('GET', `/hotels/${id}/stats`, null, loadAgent);
                ms.push(r.ms);
                if (r.status === 404) notFound++;
                else other++;
                byCache[r.cache] = (byCache[r.cache] ?? 0) + 1;
            }
        }),
    );
    const wallMs = Date.now() - t0;
    await sleep(500);
    const m = await metrics();
    const calls = containers.reduce((sum, ct) => sum + dbCalls(ct), 0);
    await setConfig({ ...DEFAULTS });

    const result = {
        negativeCache: negative,
        requests: n,
        ids: idCount,
        concurrency,
        dbCalls: calls,
        dbLoadsApp: m.dbLoads ?? 0,
        negativeHits: m.negativeHits ?? 0,
        notFound,
        otherStatuses: other,
        rps: n / (wallMs / 1000),
        p50: percentile(ms, 50),
        p95: percentile(ms, 95),
        p99: percentile(ms, 99),
        byCache,
    };
    const color = result.dbCalls <= idCount ? c.green : c.red;
    console.log(`  Відповідей 404:            ${notFound} з ${n}${other ? c.red(`, інших: ${other}`) : ''}`);
    console.log(`  Звернень до СУБД (db):     ${color(result.dbCalls)}   ${c.dim('pg_stat_statements, усі вузли')}`);
    console.log(`  Звернень до СУБД (app):    ${color(result.dbLoadsApp)}`);
    console.log(`  Відповідей з Negative Cache: ${result.negativeHits}`);
    console.log(`  Throughput / p95 / p99:    ${f1(result.rps)} RPS / ${f1(result.p95)} мс / ${f1(result.p99)} мс`);
    console.log(`  X-Cache:                   ${Object.entries(byCache).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    if (hasFlag('--save')) save(`penetration-negative-${negative ? 'on' : 'off'}.json`, result);
}

// ------------------------------------------------------------------ k6: 500 VUs, порівняльна матриця
function networkOf(container) {
    return execFileSync('docker', ['inspect', container, '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'], {
        encoding: 'utf8',
    })
        .trim()
        .split(' ')[0];
}

/** k6 у Docker у мережі кластера; результат — JSON з handleSummary (load-tests/results-lab8/<output>). */
function runK6({ scenario, vus, duration = 30, hotelId, output, quiet = false }) {
    const loadTests = path.join(__dirname, '..', 'load-tests');
    execFileSync(
        'docker',
        [
            'run', '--rm', '-i',
            '--network', networkOf('hotel_booking_nginx'),
            '--cpus', getArg('--k6-cpus', '2'),
            '-v', `${loadTests}:/scripts`,
            '-w', '/scripts',
            '-e', 'BASE_URL=http://nginx',
            '-e', `HOTEL_ID=${hotelId}`,
            '-e', `SCENARIO=${scenario}`,
            '-e', `VUS=${vus}`,
            '-e', `DURATION=${duration}s`,
            // Пауза між запитами VU: 500 VUs × 1 / 0,5 с ≈ 1000 RPS — нижче насичення CPU трьох API
            '-e', `THINK=${getArg('--think', '0.5')}`,
            '-e', 'RESULTS_DIR=results-lab8',
            '-e', `OUTPUT=${output}`,
            getArg('--k6-image', 'grafana/k6:1.0.0'),
            'run', '--quiet', '--no-usage-report', 'scenario-h-stampede.js',
        ],
        { stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' },
    );
    return JSON.parse(fs.readFileSync(path.join(RESULTS, output), 'utf8'));
}

async function k6Run(mode, hotelId) {
    const vus = Number(getArg('--vus', 500));
    const duration = Number(getArg('--duration', 30));
    const ttl = Number(getArg('--ttl', 5));
    const node = await nodeOf(hotelId);
    title(`k6: ${vus} VUs × ${duration} с, GET /hotels/:id/stats, TTL ${ttl} с (ключ вигасає кожні ${ttl} с), режим ${mode}`);

    await setConfig({ protection: mode, statsTtlSec: ttl, statsJitterSec: 0 });
    await expireStats([hotelId]);
    await resetMetrics();
    resetDbCalls(node.container);
    const k6 = runK6({ scenario: 'sustained', vus, duration, hotelId, output: `k6-${mode}.json` });

    await sleep(1000);
    const m = await metrics();
    const calls = dbCalls(node.container);
    await setConfig({ ...DEFAULTS });
    const result = { ...k6, mode, ttl, node: node.shard, dbCalls: calls, dbLoadsApp: m.dbLoads ?? 0, metrics: m };
    console.log(
        `  ${c.yellow(mode)}: СУБД ${result.dbCalls} (app ${result.dbLoadsApp}), ${f1(result.rps)} RPS, ` +
            `p95 ${f1(result.p95)} мс, p99 ${f1(result.p99)} мс, помилок ${f1(result.errorRate)} %`,
    );
    save(`k6-${mode}.json`, result);
    return result;
}

async function k6() {
    await k6Run(getArg('--mode', 'none'), await pickHotel());
}

async function k6All() {
    const hotelId = await pickHotel();
    const rows = [];
    for (const mode of MODES) {
        rows.push(await k6Run(mode, hotelId));
        await sleep(3000);
    }
    title('k6: порівняльна матриця (п. 2.7)');
    console.log(`  ${pad('Режим', 14)}${padL('СУБД', 7)}${padL('RPS', 9)}${padL('p95', 9)}${padL('p99', 9)}${padL('Err %', 8)}`);
    for (const r of rows) {
        console.log(`  ${pad(r.mode, 14)}${padL(r.dbCalls, 7)}${padL(f1(r.rps), 9)}${padL(f1(r.p95), 9)}${padL(f1(r.p99), 9)}${padL(f1(r.errorRate), 8)}`);
    }
}

const commands = { status, config, reset, stampede, compare, avalanche, penetration, k6, 'k6-all': k6All };

(async () => {
    const fn = commands[command];
    if (!fn) {
        console.log(`Невідома команда: ${command}. Доступні: ${Object.keys(commands).join(', ')}`);
        process.exit(1);
    }
    try {
        await fn();
    } catch (err) {
        console.error(c.red(err.message));
        process.exit(1);
    }
})();
