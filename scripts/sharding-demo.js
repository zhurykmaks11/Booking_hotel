const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const command = args[0] || 'status';
const baseUrl = getArg('-u', 'http://localhost');
const RESULTS = path.join(__dirname, '..', 'load-tests', 'results-lab7');
const SHARD_CONTAINER = { 'shard-a': 'database_shard_a', 'shard-b': 'database_shard_b' };
const CITY_WEIGHTS = [
    ['Kyiv', 40],
    ['Lviv', 20],
    ['Odesa', 15],
    ['Kharkiv', 15],
    ['Chernivtsi', 10],
];

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

function title(text) {
    console.log(`\n${c.cyan('='.repeat(78))}\n  ${text}\n${c.cyan('='.repeat(78))}`);
}

function request(method, urlPath, body) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const start = process.hrtime.bigint();
        const req = http.request(
            `${baseUrl}${urlPath}`,
            { method, agent, headers: data ? { 'Content-Type': 'application/json' } : {} },
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
                        shard: res.headers['x-shard'] ?? '—',
                        bucket: res.headers['x-shard-bucket'],
                        fanOut: res.headers['x-shard-fanout'],
                        partial: res.headers['x-shard-partial'],
                        instance: res.headers['x-instance-id'] ?? '—',
                    });
                });
            },
        );
        req.on('error', (err) => resolve({ status: 0, body: err.message, ms: 0, shard: '—', instance: '—' }));
        if (data) req.write(data);
        req.end();
    });
}

async function must(method, urlPath, body, expected = [200, 201]) {
    const res = await request(method, urlPath, body);
    if (!expected.includes(res.status)) {
        throw new Error(`${method} ${urlPath} → ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res;
}

/** Виконує задачі з обмеженою паралельністю. */
async function pool(items, concurrency, worker) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                results[i] = await worker(items[i], i);
            }
        }),
    );
    return results;
}

const percentile = (values, p) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const avg = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const f1 = (n) => Number(n).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);

function save(name, data) {
    fs.mkdirSync(RESULTS, { recursive: true });
    const file = path.join(RESULTS, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    console.log(c.dim(`збережено: ${path.relative(process.cwd(), file)}`));
}

function addDays(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

const randInt = (max) => Math.floor(Math.random() * max);
const pick = (list) => list[randInt(list.length)];

// ------------------------------------------------------------------ Команди

async function status() {
    title('Стан шардованого кластера (GET /sharding/status)');
    const { body } = await must('GET', '/sharding/status');
    console.log(`Топологія: ${c.cyan(body.topology)}   стратегія: ${c.cyan(body.strategy)}   бакетів: ${body.buckets}`);
    for (const s of body.shards) {
        const state = s.healthy ? c.green('UP  ') : c.red('DOWN');
        console.log(`  ${pad(s.name, 8)} ${state} бакетів: ${pad(s.buckets, 3)} reads: ${pad(s.stats.reads, 7)} writes: ${pad(s.stats.writes, 7)} fan-out: ${s.stats.fanOutQueries}`);
    }
    console.log(c.dim(`Карта бакетів (bucket → shard): ${body.bucketMap.join('')}`));
    console.log(c.dim('Лічильники — одного інстансу API, що відповів (запити розподіляє Nginx).'));
}

function cityFor(i, total) {
    const sum = CITY_WEIGHTS.reduce((acc, [, w]) => acc + w, 0);
    let point = ((i + 0.5) / total) * sum;
    for (const [city, weight] of CITY_WEIGHTS) {
        if (point < weight) return city;
        point -= weight;
    }
    return CITY_WEIGHTS[0][0];
}

async function seed() {
    const hotels = Number(getArg('-h', 200));
    const roomsPerHotel = Number(getArg('-r', 5));
    const bookings = Number(getArg('-b', 2000));
    const guestsCount = Number(getArg('-g', 100));
    const run = Date.now().toString(36);
    title(`Тестовий набір: ${hotels} готелів × ${roomsPerHotel} номерів, ${guestsCount} гостей, ${bookings} бронювань`);
    console.log(c.dim(`Міста: ${CITY_WEIGHTS.map(([city, w]) => `${city} ${w}%`).join(', ')} — реалістично нерівномірно`));

    const createdHotels = await pool([...Array(hotels).keys()], 20, (i) =>
        must('POST', '/hotels', { name: `Shard Demo ${run}-${i + 1}`, address: `Demo St ${i + 1}`, city: cityFor(i, hotels), rating: 3 + (i % 3) }),
    );
    const roomBodies = createdHotels.flatMap((h) =>
        [...Array(roomsPerHotel).keys()].map((r) => ({ hotelId: h.body.id, roomNumber: String(100 + r), type: 'DOUBLE', pricePerNight: 1000 + 250 * (r % 4), capacity: 2 })),
    );
    const rooms = await pool(roomBodies, 20, (b) => must('POST', '/rooms', b));
    const guests = await pool([...Array(guestsCount).keys()], 20, (i) => must('POST', '/guests', { fullName: `Shard Guest ${i + 1}`, email: `shard-${run}-${i}@demo.test` }));
    let created = 0;
    await pool([...Array(bookings).keys()], 20, async () => {
        const checkIn = addDays('2045-01-01', randInt(3650));
        const res = await request('POST', '/bookings', { roomId: pick(rooms).body.id, guestId: pick(guests).body.id, checkInDate: checkIn, checkOutDate: addDays(checkIn, 1 + randInt(4)) });
        if (res.status === 201) created++;
    });
    console.log(c.green(`Створено: ${createdHotels.length} готелів, ${rooms.length} номерів, ${guests.length} гостей, ${created} бронювань`));
    await distribution();
}

async function routing() {
    title('Детермінована маршрутизація (п. 2.2)');
    const guest = await must('POST', '/guests', { fullName: 'Routing Demo', email: `routing-${Date.now()}@demo.test` });
    for (const city of ['Kyiv', 'Lviv', 'Odesa']) {
        const hotel = await must('POST', '/hotels', { name: `Routing ${city}`, address: 'Demo', city, rating: 4 });
        const room = await must('POST', '/rooms', { hotelId: hotel.body.id, roomNumber: '101', type: 'DOUBLE', pricePerNight: 1500, capacity: 2 });
        const booking = await must('POST', '/bookings', { roomId: room.body.id, guestId: guest.body.id, checkInDate: '2046-05-01', checkOutDate: '2046-05-03' });
        console.log(`\n${c.cyan(city)}`);
        for (const [label, res] of [['готель    ', hotel], ['номер     ', room], ['бронювання', booking]]) {
            console.log(`  ${label} ${res.body.id}  bucket ${pad(res.bucket, 3)} → ${c.yellow(res.shard)}`);
        }
        // Той самий ID з різних інстансів API — завжди той самий шард
        const seen = [];
        for (let i = 0; i < 4; i++) {
            const r = await must('GET', `/bookings/${booking.body.id}`);
            seen.push(`${r.instance.slice(-6)}→${r.shard}`);
        }
        console.log(c.dim(`  GET /bookings/:id 4 рази (інстанс→шард): ${seen.join('  ')}`));
    }
    console.log(c.dim('\nПерші 2 hex-символи ID = номер бакета (0x00–0x3f); бакет → шард за картою (GET /sharding/route/:id).'));
}

async function distribution() {
    title('Dataset Distribution Matrix (GET /sharding/distribution)');
    const { body } = await must('GET', '/sharding/distribution');
    console.log(`Стратегія: ${c.cyan(body.strategy)}`);
    console.log(`  ${pad('Шард', 8)} ${pad('Готелі', 7)} ${pad('Номери', 7)} ${pad('Брон.', 7)} ${pad('Записів', 8)} ${pad('Даних %', 8)} ${pad('Write %', 8)} ${pad('Бакетів', 8)} Міста`);
    for (const s of body.shards) {
        const cities = Object.entries(s.hotelsByCity).map(([city, n]) => `${city} ${n}`).join(', ');
        console.log(`  ${pad(s.shard, 8)} ${pad(s.hotels, 7)} ${pad(s.rooms, 7)} ${pad(s.bookings, 7)} ${pad(s.records, 8)} ${pad(f1(s.dataPercent), 8)} ${pad(f1(s.writePercent), 8)} ${pad(s.usedBuckets, 8)} ${cities}`);
    }
    if (body.unavailable.length) console.log(c.red(`Недоступні шарди: ${body.unavailable.join(', ')}`));
    if (hasFlag('--save')) save(`distribution-${body.strategy}.json`, body);
    return body;
}

async function writesByShard() {
    const { body } = await must('GET', '/sharding/distribution');
    return Object.fromEntries(body.shards.map((s) => [s.shard, s.writeOps]));
}

/** CPU шардів. Асинхронно: синхронний виклик заблокував би event loop і додав ~2 с до всіх запитів у польоті. */
function shardCpu() {
    return new Promise((resolve) => {
        const format = ['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}}', ...Object.values(SHARD_CONTAINER)];
        execFile('docker', format, { encoding: 'utf8' }, (err, out) =>
            resolve(err ? 'docker stats недоступний' : out.trim().split('\n').map((line) => line.trim()).join('   ')),
        );
    });
}

async function hot() {
    const total = Number(getArg('-n', 600));
    const concurrency = Number(getArg('-c', 30));
    const hotCity = getArg('--city', 'Kyiv');
    const cpus = getArg('--cpus', null);
    if (cpus) execFileSync('docker', ['update', '--cpus', cpus, ...Object.values(SHARD_CONTAINER)], { stdio: 'ignore' });
    const { body: state } = await must('GET', '/sharding/status');
    title(`Hot Shard: ${total} бронювань, 90% — у місті ${hotCity}, ${concurrency} паралельно, стратегія ${state.strategy}${cpus ? `, CPU шарду ${cpus}` : ''} (п. 2.3)`);

    const rooms = (await must('GET', '/rooms')).body;
    const hotRooms = rooms.filter((r) => r.hotel.city === hotCity);
    const coldRooms = rooms.filter((r) => r.hotel.city !== hotCity);
    const guests = (await must('GET', '/guests')).body;
    if (!hotRooms.length || !guests.length) throw new Error('Немає даних: спершу node scripts/sharding-demo.js seed');

    // Прогрів (не вимірюється): пули з'єднань Prisma на всіх інстансах API відкривають з'єднання до обох шардів
    await pool([...Array(concurrency * 4).keys()], concurrency, () => {
        const checkIn = addDays('2047-01-01', randInt(3650));
        return request('POST', '/bookings', { roomId: pick(rooms).id, guestId: pick(guests).id, checkInDate: checkIn, checkOutDate: addDays(checkIn, 1) });
    });

    const before = await writesByShard();
    const byShard = {};
    let cpuSample = Promise.resolve('');
    const started = Date.now();
    await pool([...Array(total).keys()], concurrency, async (i) => {
        const room = pick(Math.random() < 0.9 || !coldRooms.length ? hotRooms : coldRooms);
        const checkIn = addDays('2047-01-01', randInt(3650));
        const res = await request('POST', '/bookings', { roomId: room.id, guestId: pick(guests).id, checkInDate: checkIn, checkOutDate: addDays(checkIn, 1 + randInt(3)) });
        (byShard[res.shard] ??= []).push(res.ms);
        if (i === Math.floor(total / 3)) cpuSample = shardCpu();
    });
    const seconds = (Date.now() - started) / 1000;
    const after = await writesByShard();

    const totalWrites = Object.keys(after).reduce((acc, s) => acc + (after[s] - (before[s] ?? 0)), 0) || 1;
    const rows = Object.keys(after).map((shard) => {
        const lat = byShard[shard] ?? [];
        return {
            shard,
            requests: lat.length,
            writePercent: ((after[shard] - (before[shard] ?? 0)) / totalWrites) * 100,
            p50: percentile(lat, 50),
            p95: percentile(lat, 95),
            p99: percentile(lat, 99),
        };
    });
    console.log(`  ${pad('Шард', 8)} ${pad('Запитів', 8)} ${pad('Записів %', 10)} ${pad('p50, мс', 9)} ${pad('p95, мс', 9)} p99, мс`);
    for (const r of rows) {
        console.log(`  ${pad(r.shard, 8)} ${pad(r.requests, 8)} ${pad(f1(r.writePercent), 10)} ${pad(f1(r.p50), 9)} ${pad(f1(r.p95), 9)} ${f1(r.p99)}`);
    }
    const cpu = await cpuSample;
    console.log(`  Throughput: ${f1(total / seconds)} бронювань/с`);
    console.log(c.dim(`  CPU під час сплеску (100% = 1 ядро): ${cpu}`));
    if (hasFlag('--save')) {
        save(`hot-demo-${state.strategy}.json`, { strategy: state.strategy, total, concurrency, hotCity, cpus, throughput: total / seconds, cpu, rows });
    }
}

async function latency() {
    const n = Number(getArg('-n', 100));
    title(`Shard-Local vs Cross-Shard: ${n} послідовних запитів на ендпоінт (п. 2.4)`);
    const hotels = (await must('GET', '/hotels')).body;
    const rooms = (await must('GET', '/rooms')).body;
    const guests = (await must('GET', '/guests')).body;
    const bookings = (await must('GET', '/bookings')).body;
    if (!hotels.length || !bookings.length) throw new Error('Немає даних: спершу node scripts/sharding-demo.js seed');

    // Redis зупиняється на час вимірювання: інакше картки й пошук віддавались би з кешу,
    // і ми міряли б Redis, а не вартість Shard-Local / Fan-out запитів до PostgreSQL
    execFileSync('docker', ['stop', 'hotel_booking_redis'], { stdio: 'ignore' });
    try {
        await measureLatency(n, { hotels, rooms, guests, bookings });
    } finally {
        execFileSync('docker', ['start', 'hotel_booking_redis'], { stdio: 'ignore' });
    }
}

async function measureLatency(n, { hotels, rooms, guests, bookings }) {
    await sleep(3000); // API помічає, що Redis недоступний (X-Cache: BYPASS)
    const endpoints = [
        { endpoint: 'GET /rooms/:id', type: 'Shard-Local', url: () => `/rooms/${pick(rooms).id}` },
        { endpoint: 'GET /bookings/:id', type: 'Shard-Local', url: () => `/bookings/${pick(bookings).id}` },
        { endpoint: 'GET /sharding/analytics/hotels/:id', type: 'Shard-Local', url: () => `/sharding/analytics/hotels/${pick(hotels).id}` },
        { endpoint: 'GET /guests/:id/bookings', type: 'Cross-Shard', url: () => `/guests/${pick(guests).id}/bookings` },
        { endpoint: 'GET /rooms/search', type: 'Cross-Shard', url: () => `/rooms/search?city=${pick(CITY_WEIGHTS)[0]}&checkIn=${addDays('2045-01-02', randInt(500))}&checkOut=${addDays('2046-06-01', 0)}&guests=2` },
        { endpoint: 'GET /sharding/analytics/cities', type: 'Cross-Shard', url: () => '/sharding/analytics/cities' },
    ];
    const rows = [];
    console.log(`  ${pad('Ендпоінт', 36)} ${pad('Тип', 12)} ${pad('Шардів', 7)} ${pad('p50', 7)} ${pad('p95', 7)} avg`);
    for (const e of endpoints) {
        for (let i = 0; i < 5; i++) await request('GET', e.url()); // розігрів
        const times = [];
        let shards = 1;
        for (let i = 0; i < n; i++) {
            const res = await request('GET', e.url());
            if (res.status !== 200) throw new Error(`${e.endpoint} → ${res.status}`);
            times.push(res.ms);
            if (res.fanOut) shards = Number(res.fanOut);
        }
        const row = { endpoint: e.endpoint, type: e.type, shards, p50: percentile(times, 50), p95: percentile(times, 95), avg: avg(times) };
        rows.push(row);
        console.log(`  ${pad(e.endpoint, 36)} ${pad(e.type, 12)} ${pad(shards, 7)} ${pad(f1(row.p50), 7)} ${pad(f1(row.p95), 7)} ${f1(row.avg)}`);
    }
    const analytics = await must('GET', '/sharding/analytics/cities');
    console.log(c.dim(`  Fan-out аналітика: ${analytics.body.shards.map((s) => `${s.shard} ${s.ms} мс`).join(', ')}, усього ${analytics.body.totalMs} мс на сервері`));
    console.log(c.dim('  Redis був зупинений на час вимірювання — усі запити йшли в PostgreSQL.'));
    if (hasFlag('--save')) save('latency-local-vs-fanout.json', { iterations: n, cache: 'off', rows, measuredAt: new Date().toISOString() });
}

/** Готель, що потрапив на потрібний шард (створює кілька, якщо треба). */
async function hotelOn(shard, label) {
    for (let i = 0; i < 20; i++) {
        const hotel = await must('POST', '/hotels', { name: `Saga ${label} ${i}`, address: 'Demo', city: 'Lviv', rating: 4 });
        if (hotel.shard === shard) return hotel.body;
    }
    throw new Error(`Не вдалося створити готель на ${shard} (стратегія city кладе місто на один шард — використайте hash)`);
}

async function saga() {
    title('Cross-Shard Write: переселення між шардами (Saga) (п. 2.4)');
    const guest = await must('POST', '/guests', { fullName: 'Saga Demo', email: `saga-${Date.now()}@demo.test` });
    const hotelA = await hotelOn('shard-a', 'A');
    const hotelB = await hotelOn('shard-b', 'B');
    const roomA = (await must('POST', '/rooms', { hotelId: hotelA.id, roomNumber: '101', type: 'DOUBLE', pricePerNight: 1500, capacity: 2 })).body;
    const roomA2 = (await must('POST', '/rooms', { hotelId: hotelA.id, roomNumber: '102', type: 'DOUBLE', pricePerNight: 1600, capacity: 2 })).body;
    const roomB = (await must('POST', '/rooms', { hotelId: hotelB.id, roomNumber: '201', type: 'SUITE', pricePerNight: 3000, capacity: 4 })).body;
    const roomB2 = (await must('POST', '/rooms', { hotelId: hotelB.id, roomNumber: '202', type: 'SUITE', pricePerNight: 3200, capacity: 4 })).body;
    // Ті самі дати щоразу: попереднє бронювання на roomA вже скасоване переселенням
    const book = async () => (await must('POST', '/bookings', { roomId: roomA.id, guestId: guest.body.id, checkInDate: '2048-03-01', checkOutDate: '2048-03-05' })).body;

    const show = (res) => {
        console.log(`  HTTP ${res.status}  mode: ${c.cyan(res.body.mode)}  ${res.body.from ?? ''} → ${res.body.to ?? ''}`);
        for (const s of res.body.steps ?? []) {
            const color = s.status === 'done' ? c.green : s.status === 'compensated' ? c.yellow : c.red;
            console.log(`    ${pad(s.step, 42)} ${pad(s.shard, 8)} ${color(s.status)}`);
        }
    };

    console.log(`\n1) Той самий шард (номер ${roomA.roomNumber} → ${roomA2.roomNumber}, обидва на shard-a): локальна ACID-транзакція`);
    const b1 = await book();
    show(await request('POST', `/bookings/${b1.id}/relocate`, { roomId: roomA2.id }));

    console.log(`\n2) Різні шарди (shard-a → shard-b): Saga T1 → T2 → T3`);
    const b2 = await book();
    const ok = await request('POST', `/bookings/${b2.id}/relocate`, { roomId: roomB.id });
    show(ok);
    const oldState = await must('GET', `/bookings/${b2.id}`);
    console.log(c.dim(`    старе бронювання: ${oldState.body.status} (${oldState.shard}); нове: ${ok.body.booking?.status} (${ok.body.to})`));

    console.log(`\n3) Збій перед T2 (simulateFailure): компенсація C1 скасовує резерв на shard-b`);
    const b3 = await book();
    const failed = await request('POST', `/bookings/${b3.id}/relocate`, { roomId: roomB2.id, simulateFailure: true });
    show(failed);
    const original = await must('GET', `/bookings/${b3.id}`);
    const reservationId = failed.body.steps?.find((s) => s.step.startsWith('T1'))?.detail;
    const reservation = reservationId ? await must('GET', `/bookings/${reservationId}`) : null;
    console.log(c.dim(`    оригінал: ${original.body.status} (не зачеплено); резерв: ${reservation?.body.status ?? '—'} (компенсовано)`));
}

async function resharding() {
    title('Модель решардингу: яка частка даних переїжджає (п. 2.5)');
    const { body } = await must('GET', `/sharding/resharding?keys=${getArg('-k', 100000)}`);
    console.log(`  ${pad('Перехід', 9)} ${pad('Схема', 17)} ${pad('Переїжджає %', 13)} ${pad('Мінімум %', 10)} Max/Avg`);
    for (const r of body.transitions) {
        const color = r.scheme === 'modulo' ? c.red : c.green;
        console.log(`  ${pad(`${r.from} → ${r.to}`, 9)} ${pad(r.scheme, 17)} ${color(pad(f1(r.movedPercent), 13))} ${pad(f1(r.idealPercent), 10)} ${r.maxToAvg.toFixed(2)}`);
    }
    console.log('\n  Consistent Hashing, 4 шарди — рівномірність залежно від віртуальних вузлів:');
    for (const r of body.ringBalance) console.log(`    vnodes ${pad(r.vnodes, 4)} max/avg ${r.maxToAvg.toFixed(2)}   частки: ${r.loadPercent.map(f1).join(' / ')}`);
    if (hasFlag('--save')) save('resharding.json', body);
}

async function isolation() {
    title('Ізоляція збою: зупинка shard-b (docker stop database_shard_b)');
    const hotels = (await must('GET', '/hotels')).body;
    const onShard = async (shard) => {
        for (const h of hotels) if ((await request('GET', `/sharding/route/${h.id}`)).body.shard === shard) return h;
        return null;
    };
    const a = await onShard('shard-a');
    const b = await onShard('shard-b');
    if (!a || !b) throw new Error('Потрібні готелі на обох шардах: спершу seed');

    execFileSync('docker', ['stop', SHARD_CONTAINER['shard-b']], { stdio: 'ignore' });
    try {
        await sleep(1500);
        for (const [label, id] of [['готель на shard-a', a.id], ['готель на shard-b', b.id]]) {
            const res = await request('GET', `/sharding/analytics/hotels/${id}`);
            const ok = res.status === 200;
            console.log(`  GET ${label}: ${ok ? c.green(res.status) : c.red(res.status)} ${ok ? '' : res.body.message}`);
        }
        const list = await request('GET', '/hotels');
        console.log(`  GET /hotels (fan-out): ${list.status}, готелів ${Array.isArray(list.body) ? list.body.length : '—'} з ${hotels.length}, X-Shard-Partial: ${c.yellow(list.partial ?? '—')}`);
        const health = await request('GET', '/health');
        console.log(`  GET /health: ${health.body.status} shards=${JSON.stringify(health.body.shards)}`);
    } finally {
        execFileSync('docker', ['start', SHARD_CONTAINER['shard-b']], { stdio: 'ignore' });
        console.log(c.dim('  shard-b знову запущено'));
    }
}

async function reset() {
    const strategy = getArg('--strategy', 'hash');
    title(`Порожні шарди, SHARD_STRATEGY=${strategy}`);
    const root = path.join(__dirname, '..');
    const env = { ...process.env, SHARD_STRATEGY: strategy };
    const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.sharding.yml', 'up', '-d'];
    const docker = (cmd) => execFileSync('docker', cmd, { cwd: root, env, stdio: 'ignore' });
    docker([...compose, '--wait', '--force-recreate', '--renew-anon-volumes', 'db-shard-a', 'db-shard-b']);
    // API перестворюється: нова стратегія + міграції на порожніх шардах (docker/api/entrypoint.sh)
    docker([...compose, '--no-deps', '--force-recreate', 'api-1', 'api-2', 'api-3']);
    docker(['exec', 'hotel_booking_redis', 'redis-cli', 'FLUSHALL']);
    for (let i = 0; i < 60; i++) {
        await sleep(2000);
        const res = await request('GET', '/sharding/status');
        if (res.status === 200 && res.body.strategy === strategy) {
            docker(['exec', 'hotel_booking_nginx', 'nginx', '-s', 'reload']); // нові IP контейнерів API
            await sleep(1000);
            console.log(c.green(`Готово: ${res.body.topology}, стратегія ${res.body.strategy}`));
            return;
        }
    }
    throw new Error('API не піднявся за 2 хв: docker compose logs api-1');
}

async function reportData() {
    args.push('--save');
    await distribution();
    await latency();
    await resharding();
    console.log(c.dim('\nДалі: node load-tests/report-sharding.js'));
}

const commands = { status, reset, seed, routing, distribution, hot, latency, saga, resharding, isolation, 'report-data': reportData };

(async () => {
    const fn = commands[command];
    if (!fn) {
        console.log(`Невідома команда "${command}". Доступні: ${Object.keys(commands).join(', ')}`);
        process.exit(1);
    }
    try {
        await fn();
    } catch (err) {
        console.error(c.red(`Помилка: ${err.message}`));
        process.exitCode = 1;
    } finally {
        agent.destroy();
    }
})();
