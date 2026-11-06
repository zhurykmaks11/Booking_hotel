/**
 * Зведений звіт Лаб. №7 (Sharding). Читає load-tests/results-lab7/:
 *   <run>.json, <run>-db.json, <run>-docker-stats.csv — прогони k6 (run-load-tests.ps1 -Experiment sharding);
 *   distribution-<strategy>.json, resharding.json, latency-local-vs-fanout.json — з scripts/sharding-demo.js.
 * Формує results-lab7/SUMMARY.md і графіки results-lab7/charts/*.svg.
 *
 * Запуск: node load-tests/report-sharding.js
 */
const fs = require('fs');
const path = require('path');

const RESULTS = path.join(__dirname, 'results-lab7');
const CHARTS = path.join(RESULTS, 'charts');
const SHARDS = ['database_shard_a', 'database_shard_b'];
const SHARD_LABEL = { database_shard_a: 'Shard A', database_shard_b: 'Shard B' };

// Ті самі критерії насичення, що й у Лаб. №5–6 (load-tests/report.js)
const LOAD_EFFICIENCY_MIN = 0.5;
const P95_JUMP = 3.0;
const ERROR_LIMIT = 1.0;

const f1 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(1));
const f2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(2));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const maybeJson = (name) => (fs.existsSync(path.join(RESULTS, name)) ? readJson(path.join(RESULTS, name)) : null);

function loadRun(name) {
    const file = path.join(RESULTS, `${name}.json`);
    if (!fs.existsSync(file)) return null;
    const run = readJson(file);
    run.db = maybeJson(`${name}-db.json`);
    run.cpu = shardCpu(name);
    return run;
}

/** Середнє і пікове CPU кожного шарду за прогін (docker stats кожні 3 с; 100% = 1 ядро). */
function shardCpu(name) {
    const file = path.join(RESULTS, `${name}-docker-stats.csv`);
    if (!fs.existsSync(file)) return null;
    const samples = Object.fromEntries(SHARDS.map((s) => [s, []]));
    for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
        const [, container, cpu] = line.split(',');
        if (samples[container] && cpu) samples[container].push(parseFloat(cpu));
    }
    const out = {};
    for (const [container, values] of Object.entries(samples)) {
        // Лише проміжок під навантаженням: відкидаємо простій до старту і після завершення (< 1%)
        const busy = values.filter((v) => v >= 1);
        out[container] = {
            avg: busy.length ? busy.reduce((a, b) => a + b, 0) / busy.length : 0,
            max: values.length ? Math.max(...values) : 0,
        };
    }
    return out;
}

function analyze(rows) {
    let saturation = null;
    for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const cur = rows[i];
        const reasons = [];
        const efficiency = cur.rps / prev.rps / (cur.vus / prev.vus);
        if (efficiency < LOAD_EFFICIENCY_MIN) reasons.push(`VUs ×${f1(cur.vus / prev.vus)}, а RPS лише ×${f2(cur.rps / prev.rps)}`);
        if (prev.p95 > 0 && cur.p95 / prev.p95 > P95_JUMP) reasons.push(`p95 ×${f1(cur.p95 / prev.p95)}`);
        if (cur.errorRate > ERROR_LIMIT) reasons.push(`помилки ${f2(cur.errorRate)}%`);
        if (reasons.length) {
            saturation = { from: prev.vus, to: cur.vus, reasons };
            break;
        }
    }
    const stableRows = saturation ? rows.filter((r) => r.vus <= saturation.from) : rows;
    const stable = stableRows.reduce((best, r) => (r.rps > best.rps ? r : best), stableRows[0]);
    const peak = rows.reduce((best, r) => (r.rps > best.rps ? r : best), rows[0]);
    return { saturation, stable, peak };
}

function runTable(rows) {
    const out = [
        '| VUs | Throughput (RPS) | Avg, мс | p50, мс | p95, мс | p99, мс | Error Rate, % | 5xx | 409 |',
        '|---|---|---|---|---|---|---|---|---|',
    ];
    for (const r of rows) {
        out.push(`| ${r.vus} | ${f1(r.rps)} | ${f1(r.avg)} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.p99)} | ${f2(r.errorRate)} | ${r.errors5xx} | ${r.conflicts409} |`);
    }
    return out.join('\n');
}

// ------------------------------- SVG -------------------------------
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function lineChart({ title, xLabels, series, yLabel }) {
    const W = 760, H = 380, L = 70, R = 190, T = 50, B = 55;
    const plotW = W - L - R, plotH = H - T - B;
    const all = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
    const maxY = Math.max(1, ...all) * 1.1;
    const x = (i) => L + (xLabels.length === 1 ? plotW / 2 : (i * plotW) / (xLabels.length - 1));
    const y = (v) => T + plotH - (v / maxY) * plotH;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif" font-size="12">`;
    svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
    svg += `<text x="${L}" y="28" font-size="15" font-weight="600" fill="#111">${esc(title)}</text>`;
    for (let k = 0; k <= 5; k++) {
        const v = (maxY * k) / 5;
        svg += `<line x1="${L}" x2="${L + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/>`;
        svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#555">${v >= 100 ? Math.round(v) : v.toFixed(1)}</text>`;
    }
    xLabels.forEach((lab, i) => {
        svg += `<text x="${x(i)}" y="${T + plotH + 20}" text-anchor="middle" fill="#555">${esc(lab)}</text>`;
    });
    svg += `<text x="${L + plotW / 2}" y="${H - 12}" text-anchor="middle" fill="#333">Virtual Users</text>`;
    svg += `<text transform="translate(18 ${T + plotH / 2}) rotate(-90)" text-anchor="middle" fill="#333">${esc(yLabel)}</text>`;
    series.forEach((s, si) => {
        const color = s.color || COLORS[si % COLORS.length];
        const pts = s.values.map((v, i) => (v === null || v === undefined ? null : [x(i), y(v)])).filter(Boolean);
        if (pts.length) {
            svg += `<polyline fill="none" stroke="${color}" stroke-width="2.2" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
            for (const [px, py] of pts) svg += `<circle cx="${px}" cy="${py}" r="3.5" fill="${color}"/>`;
        }
        const ly = T + 10 + si * 20;
        svg += `<line x1="${L + plotW + 15}" x2="${L + plotW + 35}" y1="${ly}" y2="${ly}" stroke="${color}" stroke-width="3"/>`;
        svg += `<text x="${L + plotW + 40}" y="${ly + 4}" fill="#222">${esc(s.name)}</text>`;
    });
    return svg + '</svg>';
}

/** Згруповані стовпчики: groups = [{ label, values: [..] }], series = назви стовпчиків у групі. */
function barChart({ title, groups, series, yLabel, maxY }) {
    const W = 760, H = 380, L = 70, R = 190, T = 50, B = 55;
    const plotW = W - L - R, plotH = H - T - B;
    const top = maxY || Math.max(1, ...groups.flatMap((g) => g.values)) * 1.15;
    const y = (v) => T + plotH - (v / top) * plotH;
    const groupW = plotW / groups.length;
    const barW = Math.min(60, (groupW * 0.7) / series.length);
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif" font-size="12">`;
    svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
    svg += `<text x="${L}" y="28" font-size="15" font-weight="600" fill="#111">${esc(title)}</text>`;
    for (let k = 0; k <= 5; k++) {
        const v = (top * k) / 5;
        svg += `<line x1="${L}" x2="${L + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/>`;
        svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#555">${v >= 100 ? Math.round(v) : v.toFixed(1)}</text>`;
    }
    svg += `<text transform="translate(18 ${T + plotH / 2}) rotate(-90)" text-anchor="middle" fill="#333">${esc(yLabel)}</text>`;
    groups.forEach((g, gi) => {
        const gx = L + gi * groupW + (groupW - barW * series.length) / 2;
        g.values.forEach((v, si) => {
            const bx = gx + si * barW;
            svg += `<rect x="${bx}" y="${y(v)}" width="${barW - 4}" height="${T + plotH - y(v)}" fill="${COLORS[si % COLORS.length]}"/>`;
            svg += `<text x="${bx + (barW - 4) / 2}" y="${y(v) - 5}" text-anchor="middle" fill="#222">${f1(v)}</text>`;
        });
        svg += `<text x="${L + gi * groupW + groupW / 2}" y="${T + plotH + 20}" text-anchor="middle" fill="#333">${esc(g.label)}</text>`;
    });
    series.forEach((name, si) => {
        const ly = T + 10 + si * 20;
        svg += `<rect x="${L + plotW + 15}" y="${ly - 7}" width="20" height="12" fill="${COLORS[si % COLORS.length]}"/>`;
        svg += `<text x="${L + plotW + 40}" y="${ly + 4}" fill="#222">${esc(name)}</text>`;
    });
    return svg + '</svg>';
}

function writeSvg(file, svg) {
    fs.mkdirSync(CHARTS, { recursive: true });
    fs.writeFileSync(path.join(CHARTS, file), svg, 'utf8');
    return `charts/${file}`;
}

function compare(file, title, yLabel, items, pick) {
    const levels = [...new Set(items.flatMap((it) => it.run.rows.map((r) => r.vus)))].sort((a, b) => a - b);
    return writeSvg(
        file,
        lineChart({
            title,
            xLabels: levels.map(String),
            yLabel,
            series: items.map((it) => ({
                name: it.label,
                values: levels.map((l) => {
                    const row = it.run.rows.find((r) => r.vus === l);
                    return row ? pick(row) : null;
                }),
            })),
        }),
    );
}

// ------------------------------- Розділи звіту -------------------------------
function distributionSection(md) {
    const dists = ['hash', 'city'].map((s) => ({ strategy: s, data: maybeJson(`distribution-${s}.json`) })).filter((d) => d.data);
    if (!dists.length) return;
    md.push('## Dataset Distribution Matrix (п. 2.3)', '', 'Згенеровано `node scripts/sharding-demo.js distribution` після `seed` (однаковий набір даних, різна стратегія розміщення).', '');
    for (const { strategy, data } of dists) {
        md.push(`### Стратегія \`${strategy}\``, '');
        md.push('| Шард / Вузол | Готелі | Номери | Бронювання | Кількість записів | Частка даних (%) | Частка Write Operations (%) | Зайнятих бакетів | Готелі за містами |');
        md.push('|---|---|---|---|---|---|---|---|---|');
        for (const s of data.shards) {
            const cities = Object.entries(s.hotelsByCity).map(([c, n]) => `${c} ${n}`).join(', ');
            md.push(`| ${s.shard} | ${s.hotels} | ${s.rooms} | ${s.bookings} | ${s.records} | ${f1(s.dataPercent)} | ${f1(s.writePercent)} | ${s.usedBuckets} | ${cities} |`);
        }
        md.push('');
    }
    const chart = writeSvg(
        'distribution.svg',
        barChart({
            title: 'Частка даних по шардах: city vs hash',
            yLabel: '% записів',
            maxY: 100,
            series: ['Shard A', 'Shard B'],
            groups: dists.map((d) => ({ label: `strategy=${d.strategy}`, values: d.data.shards.map((s) => s.dataPercent) })),
        }),
    );
    md.push(`![Розподіл даних](${chart})`, '');
}

/** Короткий сплеск із scripts/sharding-demo.js hot --save (той самий тест, що показується на захисті). */
function hotDemoSection(md) {
    const runs = ['city', 'hash'].map((s) => maybeJson(`hot-demo-${s}.json`)).filter(Boolean);
    if (!runs.length) return;
    const first = runs[0];
    md.push('## Hot Shard: сплеск бронювань (демонстрація, п. 2.3)', '');
    md.push(
        `\`node scripts/sharding-demo.js hot -n ${first.total} -c ${first.concurrency} --cpus ${first.cpus} --save\`: ${first.total} бронювань, 90% — у готелях ${first.hotCity}, ${first.concurrency} паралельних клієнтів, CPU кожного шарду ${first.cpus}.`,
        '',
    );
    md.push('| Стратегія | Шард | Запитів | Частка запитів, % | Частка tuple-записів, % | p50, мс | p95, мс | p99, мс | Throughput, бронювань/с | CPU під час сплеску |');
    md.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const run of runs) {
        const total = run.rows.reduce((acc, r) => acc + r.requests, 0) || 1;
        run.rows.forEach((r, i) => {
            const head = i === 0 ? [run.strategy, '', '', ''] : ['', '', '', ''];
            md.push(`| ${head[0]} | ${r.shard} | ${r.requests} | ${f1((r.requests / total) * 100)} | ${f1(r.writePercent)} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.p99)} | ${i === 0 ? f1(run.throughput) : ''} | ${i === 0 ? esc(run.cpu) : ''} |`);
        });
    }
    md.push('');
    const chart = writeSvg(
        'hot-demo-p50.svg',
        barChart({
            title: 'Сплеск у одному місті: p50 по шардах',
            yLabel: 'p50, мс',
            series: runs[0].rows.map((r) => r.shard),
            groups: runs.map((run) => ({ label: `strategy=${run.strategy}`, values: run.rows.map((r) => r.p50) })),
        }),
    );
    md.push(`![p50 по шардах](${chart})`, '');
}

function hotSection(md) {
    const city = loadRun('hot-city-g');
    const hash = loadRun('hot-hash-g');
    if (!city || !hash) return;
    md.push('## Hot Shard: city vs hash (сценарій G, п. 2.3)', '');
    md.push('90% бронювань — у готелі одного міста (Kyiv). Однакові дані, 2 шарди, CPU кожного шарду обмежено; змінюється лише стратегія розміщення.', '');
    md.push('| Стратегія | Записи Shard A (%) | Записи Shard B (%) | CPU A avg / max, % | CPU B avg / max, % | Стабільний Throughput, RPS | Пік RPS | p95 / p99 на 100 VUs, мс | Насичення |');
    md.push('|---|---|---|---|---|---|---|---|---|');
    const shareRows = [];
    const cpuRows = [];
    for (const [label, run] of [['city (наївна)', city], ['hash + virtual buckets', hash]]) {
        const a = analyze(run.rows);
        const w = run.db?.shards ?? {};
        const total = SHARDS.reduce((acc, s) => acc + (w[s]?.writes ?? 0), 0) || 1;
        const share = SHARDS.map((s) => ((w[s]?.writes ?? 0) / total) * 100);
        const cpu = SHARDS.map((s) => run.cpu?.[s] ?? { avg: 0, max: 0 });
        const r100 = run.rows.find((r) => r.vus === 100) ?? run.rows[run.rows.length - 1];
        const sat = a.saturation ? `${a.saturation.from} → ${a.saturation.to} VUs (${a.saturation.reasons.join('; ')})` : 'не досягнуто';
        md.push(`| ${label} | ${f1(share[0])} | ${f1(share[1])} | ${f1(cpu[0].avg)} / ${f1(cpu[0].max)} | ${f1(cpu[1].avg)} / ${f1(cpu[1].max)} | ${f1(a.stable.rps)} | ${f1(a.peak.rps)} | ${f1(r100.p95)} / ${f1(r100.p99)} | ${sat} |`);
        shareRows.push({ label, values: share });
        cpuRows.push({ label, values: cpu.map((c) => c.avg) });
    }
    md.push('');
    const shareChart = writeSvg('hot-shard-writes.svg', barChart({ title: 'Hot Shard: частка записів по шардах', yLabel: '% записів', maxY: 100, series: ['Shard A', 'Shard B'], groups: shareRows }));
    const cpuChart = writeSvg('hot-shard-cpu.svg', barChart({ title: 'Hot Shard: середнє CPU шардів під навантаженням', yLabel: '% CPU (100 = 1 ядро)', series: ['Shard A', 'Shard B'], groups: cpuRows }));
    const items = [{ label: 'city (hot shard)', run: city }, { label: 'hash (вирівняно)', run: hash }];
    const p95 = compare('hot-shard-p95.svg', 'Hot Shard: p95 до і після оптимізації', 'p95, мс', items, (r) => r.p95);
    const rps = compare('hot-shard-throughput.svg', 'Hot Shard: Throughput до і після оптимізації', 'RPS', items, (r) => r.rps);
    md.push(`![Частка записів](${shareChart})`, '', `![CPU шардів](${cpuChart})`, '', `![p95](${p95})`, '', `![Throughput](${rps})`, '');
    for (const [label, run] of [['city', city], ['hash', hash]]) md.push(`<details><summary>Повна таблиця: ${label}</summary>`, '', runTable(run.rows), '', '</details>', '');
}

function topologySection(md, key, title) {
    const one = loadRun(`shard1-${key}`);
    const two = loadRun(`shard2-${key}`);
    if (!one || !two) return null;
    const a1 = analyze(one.rows);
    const a2 = analyze(two.rows);
    md.push(`## ${title}`, '');
    md.push('| Топологія | Стабільний Throughput, RPS | Пік RPS | p95 / p99 на 50 VUs, мс | p95 / p99 на 200 VUs, мс | Max Error Rate, % | Насичення | Commits/с A / B |');
    md.push('|---|---|---|---|---|---|---|---|');
    for (const [label, run, a] of [['Single Node (1 шард)', one, a1], ['Sharded (2 шарди)', two, a2]]) {
        const at = (v) => run.rows.find((r) => r.vus === v) ?? {};
        const sat = a.saturation ? `${a.saturation.from} → ${a.saturation.to} VUs (${a.saturation.reasons.join('; ')})` : 'не досягнуто';
        const s = run.db?.shards ?? {};
        md.push(
            `| ${label} | ${f1(a.stable.rps)} | ${f1(a.peak.rps)} | ${f1(at(50).p95)} / ${f1(at(50).p99)} | ${f1(at(200).p95)} / ${f1(at(200).p99)} | ${f2(Math.max(...run.rows.map((r) => r.errorRate)))} | ${sat} | ${f1(s.database_shard_a?.commitsPerSec)} / ${f1(s.database_shard_b?.commitsPerSec)} |`,
        );
    }
    md.push('');
    const items = [{ label: 'Single Node (1 шард)', run: one }, { label: 'Sharded (2 шарди)', run: two }];
    const rps = compare(`${key}-throughput.svg`, `${title}: Throughput`, 'RPS', items, (r) => r.rps);
    const p95 = compare(`${key}-p95.svg`, `${title}: p95`, 'p95, мс', items, (r) => r.p95);
    const p99 = compare(`${key}-p99.svg`, `${title}: p99`, 'p99, мс', items, (r) => r.p99);
    md.push(`![Throughput](${rps})`, '', `![p95](${p95})`, '', `![p99](${p99})`, '');
    for (const [label, run] of [['1 шард', one], ['2 шарди', two]]) md.push(`<details><summary>Повна таблиця: ${label}</summary>`, '', runTable(run.rows), '', '</details>', '');
    return { one, two };
}

function latencySection(md) {
    const data = maybeJson('latency-local-vs-fanout.json');
    if (!data) return;
    md.push('## Shard-Local vs Cross-Shard: затримка одного запиту (п. 2.4)', '');
    md.push(`Послідовні запити без конкуренції (${data.iterations} на ендпоінт), \`node scripts/sharding-demo.js latency\`, Redis зупинено на час вимірювання (міряється PostgreSQL, а не кеш).`, '');
    md.push('| Ендпоінт | Тип | Шардів у запиті | p50, мс | p95, мс | Avg, мс |');
    md.push('|---|---|---|---|---|---|');
    for (const r of data.rows) md.push(`| \`${r.endpoint}\` | ${r.type} | ${r.shards} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.avg)} |`);
    md.push('');
}

function reshardingSection(md) {
    const data = maybeJson('resharding.json');
    if (!data) return;
    md.push('## Модель решардингу (п. 2.5)', '');
    md.push(`Симуляція на ${data.keys} випадкових hotelId (\`GET /sharding/resharding\`, \`src/sharding/resharding.ts\`).`, '');
    md.push('| Перехід | Схема | Переїжджає ключів, % | Теоретичний мінімум, % | Max / Avg навантаження після |');
    md.push('|---|---|---|---|---|');
    for (const r of data.transitions) md.push(`| ${r.from} → ${r.to} | ${r.scheme} | ${f1(r.movedPercent)} | ${f1(r.idealPercent)} | ${f2(r.maxToAvg)} |`);
    md.push('');
    const transitions = [...new Set(data.transitions.map((r) => `${r.from} → ${r.to}`))];
    const schemes = ['modulo', 'virtual-buckets', 'consistent-hash'];
    const chart = writeSvg(
        'resharding.svg',
        barChart({
            title: 'Частка даних, що переїжджає при додаванні шардів',
            yLabel: '% ключів',
            maxY: 100,
            series: schemes,
            groups: transitions.map((t) => ({ label: t, values: schemes.map((s) => data.transitions.find((r) => `${r.from} → ${r.to}` === t && r.scheme === s).movedPercent) })),
        }),
    );
    md.push(`![Решардинг](${chart})`, '');
    md.push('Рівномірність кільця Consistent Hashing залежно від кількості віртуальних вузлів (4 шарди):', '');
    md.push('| Віртуальних вузлів на шард | Max / Avg | Частки шардів, % |');
    md.push('|---|---|---|');
    for (const r of data.ringBalance) md.push(`| ${r.vnodes} | ${f2(r.maxToAvg)} | ${r.loadPercent.map(f1).join(' / ')} |`);
    md.push('');
}

function main() {
    if (!fs.existsSync(RESULTS)) {
        console.log('Немає results-lab7. Спершу: run-load-tests.ps1 -Experiment sharding і scripts/sharding-demo.js report-data');
        return;
    }
    const md = ['# Результати Лаб. №7 — Sharding', '', `Згенеровано: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (node load-tests/report-sharding.js)`, ''];
    const envFile = path.join(RESULTS, 'environment.md');
    if (fs.existsSync(envFile)) md.push(fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '').replace(/^# /m, '## '), '');
    md.push(
        '## Методика',
        '',
        '- k6 у Docker-контейнері, ступені 10 → 25 → 50 → 100 → 200 VUs, метрики лише з фаз утримання (як у Лаб. №5–6).',
        '- Redis вимкнено: кожне читання доходить до шардів. CPU кожного шарду обмежено (`-DbCpus`), щоб вузьким місцем була СУБД.',
        '- Перед кожним прогоном шарди перестворюються порожніми, дані створює `setup()` k6 через API (Shard Router розміщує їх сам).',
        '- Single Node = той самий код із одним шардом у `SHARD_URLS` (усі 64 бакети на shard-a).',
        '',
    );
    distributionSection(md);
    hotDemoSection(md);
    hotSection(md);
    topologySection(md, 'e-local', 'Single Node vs Sharded: Shard-Local операції (сценарій E)');
    topologySection(md, 'f-fanout', 'Single Node vs Sharded: Cross-Shard Fan-out (сценарій F)');
    latencySection(md);
    reshardingSection(md);
    fs.writeFileSync(path.join(RESULTS, 'SUMMARY.md'), md.join('\n'), 'utf8');
    console.log(`Звіт: ${path.join(RESULTS, 'SUMMARY.md')}`);
}

main();
