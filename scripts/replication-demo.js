/**
 * Демонстрація реплікації БД для захисту (Лаб. №6).
 *
 *   node scripts/replication-demo.js status            — стан Primary / Replica, LSN, Replication Lag
 *   node scripts/replication-demo.js replicate         — п. 2.1: запис на Primary → дані на Replica, Replica read-only
 *   node scripts/replication-demo.js lag 3000          — синтетична затримка відтворення WAL на Replica (0 — вимкнути)
 *   node scripts/replication-demo.js stale [-d 3000]   — п. 2.3–2.4: Stale Read і захист Sticky Routing / Explicit Primary
 *   node scripts/replication-demo.js failover-replica  — п. 2.5: docker stop database_replica → Primary Fallback
 *   node scripts/replication-demo.js failover-primary  — п. 2.5: docker stop database_primary → Read-Only Mode
 *
 * Запити йдуть через Nginx (http://localhost), тому їх обробляють різні інстанси API (X-Instance-ID).
 */
const http = require('http');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const command = args[0] || 'status';
const baseUrl = getArg('-u', 'http://localhost');

const PRIMARY = 'database_primary';
const REPLICA = 'database_replica';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function title(text) {
    console.log(`\n${c.cyan('='.repeat(70))}\n  ${text}\n${c.cyan('='.repeat(70))}`);
}

function request(method, path, body, headers = {}) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const start = Date.now();
        const req = http.request(
            `${baseUrl}${path}`,
            {
                method,
                headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
            },
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
                        ms: Date.now() - start,
                        node: res.headers['x-db-node'] || '—',
                        route: res.headers['x-db-route'] || '—',
                        instance: res.headers['x-instance-id'] || '—',
                        cache: res.headers['x-cache'],
                        json,
                    });
                });
            },
        );
        req.on('error', (err) => resolve({ status: 'ERROR', ms: Date.now() - start, node: '—', route: '—', instance: '—', json: err.message }));
        req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
        if (data) req.write(data);
        req.end();
    });
}

function show(label, res, extra = '') {
    const ok = typeof res.status === 'number' && res.status < 400;
    const status = ok ? c.green(res.status) : c.red(res.status);
    // Відповідь з Redis (HIT) не звертається до жодного вузла БД
    if (res.cache) extra = `${c.dim(`cache=${res.cache}`)} ${extra}`;
    console.log(
        `${label.padEnd(34)} ${status}  node=${c.cyan(String(res.node).padEnd(15))} route=${String(res.route).padEnd(18)} ` +
            `${c.dim(`api=${res.instance} ${res.ms}ms`)} ${extra}`,
    );
}

/** SQL напряму у вузол через docker exec (оминаючи API). */
function psql(container, sql) {
    try {
        return {
            ok: true,
            out: execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'hotel_booking', '-tA', '-c', sql], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim(),
        };
    } catch (err) {
        return { ok: false, out: String(err.stderr || err.message).trim() };
    }
}

function docker(...cmd) {
    execFileSync('docker', cmd, { stdio: 'ignore' });
}

function setApplyDelay(ms) {
    const value = Number(ms) > 0 ? `${Number(ms)}ms` : '0';
    psql(REPLICA, `ALTER SYSTEM SET recovery_min_apply_delay = '${value}'`);
    psql(REPLICA, 'SELECT pg_reload_conf()');
    return value;
}

async function waitFor(predicate, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(500);
    }
    return false;
}

// ---------------------------------------------------------------------------

async function status() {
    title('СТАН РЕПЛІКАЦІЇ (GET /replication/status)');
    const res = await request('GET', '/replication/status');
    if (res.status !== 200) return console.log(c.red(`Помилка: ${res.status} ${JSON.stringify(res.json)}`));
    const s = res.json;
    const r = s.router;
    console.log(`Топологія: ${r.topology}   Режим: ${r.mode}   Читання з: ${r.readsFrom}   Sticky TTL: ${r.stickyTtlMs} мс`);
    console.log(`Primary:   ${s.primary.reachable ? c.green('доступний') : c.red('недоступний')}  LSN=${s.primary.currentLsn ?? '—'}`);
    for (const rep of s.primary.replicas ?? []) {
        console.log(
            `  └ ${rep.clientAddr} state=${rep.state} sync=${rep.syncState} replay_lsn=${rep.replayLsn} ` +
                `відставання=${rep.replayLagBytes} B, replay_lag=${rep.replayLagMs ?? 0} мс`,
        );
    }
    if (s.replica.enabled === false) {
        console.log('Replica:   вимкнена (DATABASE_REPLICA_URL не задано)');
    } else {
        console.log(
            `Replica:   ${s.replica.reachable ? c.green('доступна') : c.red('недоступна')}  in_recovery=${s.replica.inRecovery} ` +
                `read_only=${s.replica.readOnly} replay_lsn=${s.replica.replayLsn ?? '—'} apply_delay=${s.replica.applyDelay ?? '—'}`,
        );
    }
    console.log(`Replication Lag: ${s.replicationLag.behindBytes ?? '—'} байт WAL (caughtUp=${s.replicationLag.caughtUp})`);
    console.log(c.dim(`Маршрутизація цього інстансу: ${JSON.stringify(r.stats.routes)}`));
}

async function replicate() {
    title('П. 2.1: ЗАПИС НА PRIMARY → АВТОРЕПЛІКАЦІЯ НА REPLICA');
    const name = `Replication Demo ${new Date().toISOString().slice(11, 19)}`;
    const created = await request('POST', '/hotels', { name, address: 'Khreshchatyk 1', city: 'Kyiv' });
    show('POST /hotels', created);
    if (created.status !== 201) return;
    const id = created.json.id;

    await sleep(300);
    const sql = `SELECT name, city FROM hotels WHERE id = '${id}'`;
    const p = psql(PRIMARY, sql);
    const r = psql(REPLICA, sql);
    console.log(`\nPrimary (${PRIMARY}):  ${p.out || c.red('рядок не знайдено')}`);
    console.log(`Replica (${REPLICA}):  ${r.out ? c.green(r.out) : c.red('рядок ще не з’явився')}`);

    console.log('\nПозиції WAL:');
    console.log(`  Primary  pg_current_wal_lsn()      = ${psql(PRIMARY, 'SELECT pg_current_wal_lsn()').out}`);
    console.log(`  Replica  pg_last_wal_replay_lsn()  = ${psql(REPLICA, 'SELECT pg_last_wal_replay_lsn()').out}`);
    console.log('\npg_stat_replication на Primary (client | state | sync_state | replay_lag):');
    console.log(`  ${psql(PRIMARY, "SELECT client_addr || ' | ' || state || ' | ' || sync_state || ' | ' || coalesce(replay_lag::text, '0') FROM pg_stat_replication").out}`);

    console.log('\nСпроба запису напряму в Replica:');
    const w = psql(REPLICA, `INSERT INTO hotels (id, name, address, city) VALUES (gen_random_uuid(), 'x', 'x', 'x')`);
    console.log(`  ${w.ok ? c.red('запис пройшов (?!)') : c.green(w.out.split('\n')[0])}`);
}

async function lag() {
    const ms = args[1] ?? '0';
    const value = setApplyDelay(ms);
    console.log(`recovery_min_apply_delay на Replica = ${c.yellow(value)} (Replica відтворює WAL із затримкою)`);
}

async function stale() {
    const delay = Number(getArg('-d', '3000'));
    title(`П. 2.3–2.4: STALE READ І READ-AFTER-WRITE CONSISTENCY (lag ${delay} мс)`);
    console.log(`Синтетичний Replication Lag: recovery_min_apply_delay = ${setApplyDelay(delay)}\n`);
    await sleep(500);

    const writer = { 'X-Session-Id': `writer-${Date.now()}` };
    const reader = { 'X-Session-Id': `reader-${Date.now()}` };

    try {
        // 1. Створення гостя і зміна телефону — сесія writer
        const guest = await request('POST', '/guests', { fullName: 'Stale Read Demo', email: `stale-${Date.now()}@demo.io`, phone: '+380-OLD' }, writer);
        show('[writer] POST /guests', guest);
        if (guest.status !== 201) return;
        const id = guest.json.id;

        console.log(c.dim(`\nЧекаємо, поки Replica отримає створення гостя (${delay} мс)...`));
        await waitFor(async () => (await request('GET', `/guests/${id}`, null, reader)).status === 200, delay + 10000);

        const writeAt = Date.now();
        const patch = await request('PATCH', `/guests/${id}`, { phone: '+380-NEW' }, writer);
        show('[writer] PATCH /guests/:id  phone→NEW', patch);

        console.log(`\n${c.yellow('Одразу після запису:')}`);
        const r1 = await request('GET', `/guests/${id}`, null, reader);
        const staleNow = r1.json && r1.json.phone === '+380-OLD';
        show('[reader] GET /guests/:id', r1, staleNow ? c.red(`phone=${r1.json.phone}  ← STALE READ`) : `phone=${r1.json && r1.json.phone}`);

        const r2 = await request('GET', `/guests/${id}`, null, writer);
        show('[writer] GET /guests/:id', r2, c.green(`phone=${r2.json && r2.json.phone}  ← Sticky Routing (RYW)`));

        const booking = await request('GET', `/guests/${id}/bookings`, null, writer);
        show('[writer] GET /guests/:id/bookings', booking, c.dim('теж sticky'));

        // 2. Explicit Primary Routing: підтвердження бронювання завжди з Primary
        const rooms = await request('GET', '/rooms', null, reader);
        let room = Array.isArray(rooms.json) ? rooms.json[0] : null;
        if (!room) {
            // Порожня БД: створюємо готель з номером (STRONG-перевірка готелю на Primary)
            const hotel = await request('POST', '/hotels', { name: 'Demo Hotel', address: 'x', city: 'Kyiv' }, writer);
            const createdRoom = await request('POST', '/rooms', { hotelId: hotel.json.id, roomNumber: '101', type: 'DOUBLE', pricePerNight: 1500, capacity: 2 }, writer);
            show('[writer] POST /rooms', createdRoom);
            room = createdRoom.json;
        }
        if (room && room.id) {
            const checkIn = `2035-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`;
            const checkOut = checkIn.replace(/-1(\d)$/, '-2$1');
            const created = await request('POST', '/bookings', { roomId: room.id, guestId: id, checkInDate: checkIn, checkOutDate: checkOut }, writer);
            show('[writer] POST /bookings', created);
            if (created.status === 201) {
                const confirm = await request('GET', `/bookings/${created.json.id}`, null, reader);
                show('[reader] GET /bookings/:id', confirm, c.green('← Explicit Primary Routing (strong)'));
                await request('DELETE', `/bookings/${created.json.id}`, null, writer);
            }
        }

        // 3. Скільки триває вікно застарілого читання
        console.log(c.dim('\nОпитуємо Replica, доки вона не наздожене Primary...'));
        await waitFor(async () => {
            const r = await request('GET', `/guests/${id}`, null, reader);
            return r.json && r.json.phone === '+380-NEW';
        }, delay + 15000);
        const lagMs = Date.now() - writeAt;
        const r3 = await request('GET', `/guests/${id}`, null, reader);
        show('[reader] GET /guests/:id', r3, c.green(`phone=${r3.json.phone}`));
        console.log(`\nВікно Stale Read ≈ ${c.yellow(`${lagMs} мс`)} (Replication Lag). Sticky TTL має бути більшим за типовий lag.`);

        await request('DELETE', `/guests/${id}`, null, writer);
    } finally {
        setApplyDelay(0);
        console.log(c.dim('recovery_min_apply_delay скинуто до 0'));
    }
}

async function burst(label, calls) {
    for (const [method, path, body, note] of calls) {
        show(`${label} ${method} ${path.split('?')[0]}`, await request(method, path, body), note || '');
    }
}

async function failoverReplica() {
    title('П. 2.5: ВТРАТА REPLICA (docker stop database_replica)');
    const hotels = await request('GET', '/hotels');
    const hotelId = hotels.json[0] && hotels.json[0].id;
    docker('stop', REPLICA);
    console.log(c.yellow('Replica зупинено\n'));
    try {
        await burst('[без Replica]', [
            ['GET', '/hotels'],
            ['GET', '/rooms'],
            ['GET', `/hotels/${hotelId}`],
            ['POST', '/hotels', { name: 'Failover Replica', address: 'x', city: 'Lviv' }],
            ['GET', '/health'],
        ]);
        const health = await request('GET', '/health');
        console.log(`\n/health: status=${health.json.status} readsFrom=${health.json.readsFrom} replica=${health.json.replica}`);
    } finally {
        docker('start', REPLICA);
        console.log(c.dim('\nReplica запущено, чекаємо на повернення в ротацію...'));
        const back = await waitFor(async () => (await request('GET', '/hotels')).node === 'replica');
        console.log(back ? c.green('Читання знову йдуть на Replica') : c.red('Replica не повернулась за 60 с'));
    }
}

async function failoverPrimary() {
    title('П. 2.5: ВТРАТА PRIMARY (docker stop database_primary)');
    const hotels = await request('GET', '/hotels');
    const hotelId = hotels.json[0] && hotels.json[0].id;
    const bookings = await request('GET', '/bookings');
    const bookingId = Array.isArray(bookings.json) && bookings.json[0] ? bookings.json[0].id : '00000000-0000-0000-0000-000000000000';
    docker('stop', PRIMARY);
    console.log(c.yellow('Primary зупинено\n'));
    try {
        await sleep(500);
        await burst('[без Primary]', [
            ['GET', '/hotels', null, c.green('каталог з Replica')],
            ['GET', '/rooms/search?city=Kyiv&checkIn=2031-03-01&checkOut=2031-03-04', null, c.green('пошук з Replica')],
            ['GET', `/hotels/${hotelId}`],
            ['POST', '/hotels', { name: 'Failover Primary', address: 'x', city: 'Lviv' }, c.yellow('Read-Only Mode')],
            ['POST', '/guests', { fullName: 'x', email: `ro-${Date.now()}@demo.io` }, c.yellow('Read-Only Mode')],
            ['GET', `/bookings/${bookingId}`, null, c.yellow('strong-читання неможливе')],
        ]);
        const write = await request('POST', '/hotels', { name: 'x', address: 'x', city: 'x' });
        console.log(`\nВідповідь на запис: ${JSON.stringify(write.json)}`);
        const health = await request('GET', '/health');
        console.log(`/health: HTTP ${health.status} status=${health.json.status} dbMode=${health.json.dbMode}`);
    } finally {
        docker('start', PRIMARY);
        console.log(c.dim('\nPrimary запущено, чекаємо на відновлення запису...'));
        const back = await waitFor(async () => {
            const r = await request('POST', '/hotels', { name: 'Primary is back', address: 'x', city: 'Lviv' });
            if (r.status === 201) await request('DELETE', `/hotels/${r.json.id}`);
            return r.status === 201;
        });
        console.log(back ? c.green('Primary відновлено → Read-Write') : c.red('Primary не відновився за 60 с'));
    }
}

const commands = {
    status,
    replicate,
    lag,
    stale,
    'failover-replica': failoverReplica,
    'failover-primary': failoverPrimary,
};

if (!commands[command]) {
    console.log(`Невідома команда "${command}". Доступні: ${Object.keys(commands).join(', ')}`);
    process.exit(1);
}

commands[command]().catch((err) => {
    console.error(c.red(err.stack || err));
    process.exit(1);
});
