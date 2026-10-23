/**
 * Зведений звіт навантажувального тестування (Лаб. №5).
 * Читає load-tests/results/*.json (результати k6 і лічильники PostgreSQL) і формує:
 *   results/SUMMARY.md     — таблиці, точка насичення, масштабування, кеш, картка Baseline
 *   results/charts/*.svg   — графіки Throughput і Latency (p50/p95/p99) від навантаження
 *
 * Запуск: node load-tests/report.js
 */
const fs = require('fs');
const path = require('path');

const RESULTS = path.join(__dirname, 'results');
const CHARTS = path.join(RESULTS, 'charts');

// Критерії насичення (перший ступінь, де виконується хоча б один):
//  * ефективність масштабування навантаження < 0.5: (RPS₂/RPS₁) / (VUs₂/VUs₁) —
//    VUs зросли, а Throughput росте менш ніж наполовину від цього (система перестала «встигати»);
//  * p95 зросла більш ніж утричі за один ступінь (запити стоять у черзі);
//  * Error Rate > 1%.
const LOAD_EFFICIENCY_MIN = 0.5;
const P95_JUMP = 3.0;
const ERROR_LIMIT = 1.0;

const f1 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(1));
const f2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(2));

function readJson(file) {
    // PowerShell 5.1 пише UTF-8 з BOM — прибираємо його перед розбором
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function loadRuns() {
    if (!fs.existsSync(RESULTS)) return {};
    const runs = {};
    for (const file of fs.readdirSync(RESULTS)) {
        if (!file.endsWith('.json') || file.endsWith('-db.json')) continue;
        const run = readJson(path.join(RESULTS, file));
        if (!run.rows || !run.name) continue;
        const dbFile = path.join(RESULTS, `${run.name}-db.json`);
        if (fs.existsSync(dbFile)) run.db = readJson(dbFile);
        runs[run.name] = run;
    }
    return runs;
}

/** Аналіз кривої: точка насичення і стабільна пропускна здатність. */
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
            saturation = { from: prev.vus, to: cur.vus, reasons, prev, cur };
            break;
        }
    }
    const stableRows = saturation ? rows.filter((r) => r.vus <= saturation.from) : rows;
    const healthy = stableRows.filter((r) => r.errorRate <= ERROR_LIMIT);
    const stable = (healthy.length ? healthy : stableRows).reduce((best, r) => (r.rps > best.rps ? r : best), stableRows[0]);
    const peak = rows.reduce((best, r) => (r.rps > best.rps ? r : best), rows[0]);
    const maxError = Math.max(...rows.map((r) => r.errorRate));
    return { saturation, stable, peak, maxError };
}

function table(rows) {
    const out = [
        '| VUs | Throughput (RPS) | Avg, мс | p50, мс | p95, мс | p99 (Tail), мс | Max, мс | Error Rate, % | 5xx | 409 | Cache HIT, % |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const r of rows) {
        out.push(
            `| ${r.vus} | ${f1(r.rps)} | ${f1(r.avg)} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.p99)} | ${f1(r.max)} | ${f2(r.errorRate)} | ${r.errors5xx} | ${r.conflicts409} | ${f1(r.cacheHitRate)} |`,
        );
    }
    return out.join('\n');
}

// ------------------------------- SVG-графіки -------------------------------
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

function lineChart({ title, xLabels, series, yLabel }) {
    const W = 760, H = 380, L = 70, R = 170, T = 50, B = 55;
    const plotW = W - L - R, plotH = H - T - B;
    const all = series.flatMap((s) => s.values.filter((v) => v !== null && v !== undefined));
    const maxY = Math.max(1, ...all) * 1.1;
    const x = (i) => L + (xLabels.length === 1 ? plotW / 2 : (i * plotW) / (xLabels.length - 1));
    const y = (v) => T + plotH - (v / maxY) * plotH;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

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

function writeChart(file, spec) {
    fs.mkdirSync(CHARTS, { recursive: true });
    fs.writeFileSync(path.join(CHARTS, file), lineChart(spec), 'utf8');
    return `charts/${file}`;
}

function runCharts(run) {
    const xs = run.rows.map((r) => String(r.vus));
    const rps = writeChart(`${run.name}-throughput.svg`, {
        title: `${run.title}: Throughput`,
        xLabels: xs,
        yLabel: 'RPS',
        series: [{ name: 'Throughput, RPS', values: run.rows.map((r) => r.rps) }],
    });
    const lat = writeChart(`${run.name}-latency.svg`, {
        title: `${run.title}: Latency`,
        xLabels: xs,
        yLabel: 'мс',
        series: [
            { name: 'p50', values: run.rows.map((r) => r.p50) },
            { name: 'p95', values: run.rows.map((r) => r.p95) },
            { name: 'p99 (tail)', values: run.rows.map((r) => r.p99) },
            { name: 'avg', values: run.rows.map((r) => r.avg), color: '#6b7280' },
        ],
    });
    return { rps, lat };
}

function compareChart(file, title, yLabel, a, b, pickA, pickB) {
    const levels = [...new Set([...a.run.rows, ...b.run.rows].map((r) => r.vus))].sort((m, n) => m - n);
    const at = (run, lvl, pickFn) => {
        const row = run.rows.find((r) => r.vus === lvl);
        return row ? pickFn(row) : null;
    };
    return writeChart(file, {
        title,
        xLabels: levels.map(String),
        yLabel,
        series: [
            { name: a.label, values: levels.map((l) => at(a.run, l, pickA)) },
            { name: b.label, values: levels.map((l) => at(b.run, l, pickB)) },
        ],
    });
}

// ------------------------------- Звіт -------------------------------
function main() {
    const runs = loadRuns();
    const names = Object.keys(runs).sort();
    if (!names.length) {
        console.log('Немає результатів у load-tests/results. Спершу запустіть тести (run-load-tests.ps1).');
        return;
    }

    const md = ['# Результати навантажувального тестування (Лаб. №5)', '', `Згенеровано: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (node load-tests/report.js)`, ''];

    const envFile = path.join(RESULTS, 'environment.md');
    if (fs.existsSync(envFile)) {
        md.push(fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '').replace(/^# /m, '## '), '');
    }

    md.push(
        '## Методика',
        '',
        '- Інструмент: k6 (скрипти в `load-tests/`), генератор у окремому Docker-контейнері з лімітом CPU.',
        '- Профіль: розігрів (warm-up) → ступені VUs; метрики беруться лише з фаз утримання кожного ступеня.',
        '- Throughput = кількість запитів у фазі утримання / тривалість утримання.',
        '- Error Rate = частка відповідей 5xx, 4xx (крім 409) і мережевих помилок. 409 — коректна бізнес-відмова (номер зайнятий).',
        `- Точка насичення: перший ступінь, де Throughput росте менш ніж на ${LOAD_EFFICIENCY_MIN * 100}% від приросту VUs, або p95 зростає більш ніж у ${P95_JUMP} рази, або Error Rate > ${ERROR_LIMIT}%.`,
        '',
    );

    const analyses = {};
    for (const name of names) {
        const run = runs[name];
        if (!run.rows.length) continue;
        const a = analyze(run.rows);
        analyses[name] = a;
        const charts = runCharts(run);
        md.push(`## ${run.title} — \`${name}\``, '', table(run.rows), '');
        if (a.saturation) {
            md.push(`**Точка насичення:** між ${a.saturation.from} і ${a.saturation.to} VUs (${a.saturation.reasons.join('; ')}).`);
        } else {
            md.push(`**Точка насичення:** у межах ${run.rows[run.rows.length - 1].vus} VUs не досягнута.`);
        }
        md.push(
            `**Стабільна пропускна здатність:** ${f1(a.stable.rps)} RPS при ${a.stable.vus} VUs (p95 ${f1(a.stable.p95)} мс, p99 ${f1(a.stable.p99)} мс).`,
            `**Пікова пропускна здатність:** ${f1(a.peak.rps)} RPS при ${a.peak.vus} VUs.`,
        );
        if (run.db) {
            md.push(`**PostgreSQL за прогін:** ${run.db.commits} транзакцій (${run.db.commitsPerSec}/с), ${run.db.rollbacks} відкатів.`);
        }
        md.push('', `![Throughput](${charts.rps})`, '', `![Latency](${charts.lat})`, '');
    }

    // ---- Scaling Impact Analysis ----
    const s1 = names.find((n) => n.startsWith('scaling-1x-'));
    const s3 = names.find((n) => n.startsWith('scaling-3x-'));
    if (s1 && s3) {
        const r1 = runs[s1], r3 = runs[s3];
        const peak1 = analyses[s1].peak.rps, peak3 = analyses[s3].peak.rps;
        const efficiency = peak3 / (3 * peak1);
        md.push('## Scaling Impact Analysis: 1 instance vs 3 instances', '');
        md.push('| VUs | RPS (1×) | RPS (3×) | p95 1×, мс | p95 3×, мс | p99 1×, мс | p99 3×, мс | Error 1×, % | Error 3×, % |', '|---|---|---|---|---|---|---|---|---|');
        for (const row1 of r1.rows) {
            const row3 = r3.rows.find((r) => r.vus === row1.vus);
            if (!row3) continue;
            md.push(`| ${row1.vus} | ${f1(row1.rps)} | ${f1(row3.rps)} | ${f1(row1.p95)} | ${f1(row3.p95)} | ${f1(row1.p99)} | ${f1(row3.p99)} | ${f2(row1.errorRate)} | ${f2(row3.errorRate)} |`);
        }
        md.push(
            '',
            `**Пікова пропускна здатність:** 1 інстанс — ${f1(peak1)} RPS, 3 інстанси — ${f1(peak3)} RPS (прискорення ×${f2(peak3 / peak1)}).`,
            `**Scalability Efficiency Factor** = RPS(3) / (3 × RPS(1)) = ${f1(peak3)} / (3 × ${f1(peak1)}) = **${f2(efficiency)}** (1.00 — ідеальне лінійне масштабування).`,
            '',
        );
        const c1 = compareChart('scaling-throughput.svg', 'Масштабування: Throughput', 'RPS', { label: '1 instance', run: r1 }, { label: '3 instances', run: r3 }, (r) => r.rps, (r) => r.rps);
        const c2 = compareChart('scaling-p95.svg', 'Масштабування: p95 Latency', 'мс', { label: '1 instance', run: r1 }, { label: '3 instances', run: r3 }, (r) => r.p95, (r) => r.p95);
        md.push(`![Scaling throughput](${c1})`, '', `![Scaling p95](${c2})`, '');
    }

    // ---- Caching Impact Analysis ----
    if (runs['cache-off-a'] && runs['cache-on-a']) {
        const off = runs['cache-off-a'], on = runs['cache-on-a'];
        md.push('## Caching Impact Analysis: Cache Disabled vs Warm Cache (Scenario A)', '');
        md.push('| VUs | RPS без кешу | RPS з кешем | p50 без / з кешем, мс | p95 без / з кешем, мс | p99 без / з кешем, мс | Cache HIT, % |', '|---|---|---|---|---|---|---|');
        for (const a of off.rows) {
            const b = on.rows.find((r) => r.vus === a.vus);
            if (!b) continue;
            md.push(`| ${a.vus} | ${f1(a.rps)} | ${f1(b.rps)} | ${f1(a.p50)} / ${f1(b.p50)} | ${f1(a.p95)} / ${f1(b.p95)} | ${f1(a.p99)} / ${f1(b.p99)} | ${f1(b.cacheHitRate)} |`);
        }
        md.push('');
        if (off.db && on.db) {
            const offPerReq = off.db.commits / Math.max(1, off.rows.reduce((s, r) => s + r.requests, 0));
            const onPerReq = on.db.commits / Math.max(1, on.rows.reduce((s, r) => s + r.requests, 0));
            md.push(
                '**Навантаження на СУБД:**',
                '',
                '| Режим | Транзакцій PostgreSQL | Транзакцій/с | Транзакцій на 1 HTTP-запит |',
                '|---|---|---|---|',
                `| Cache Disabled | ${off.db.commits} | ${off.db.commitsPerSec} | ${f2(offPerReq)} |`,
                `| Warm Cache | ${on.db.commits} | ${on.db.commitsPerSec} | ${f2(onPerReq)} |`,
                '',
                `Кеш зменшив кількість звернень до БД на один запит у ${f1(offPerReq / Math.max(onPerReq, 1e-9))} раза.`,
                '',
            );
        }
        const c1 = compareChart('cache-p95.svg', 'Кешування: p95 Latency', 'мс', { label: 'Cache disabled', run: off }, { label: 'Warm cache', run: on }, (r) => r.p95, (r) => r.p95);
        const c2 = compareChart('cache-throughput.svg', 'Кешування: Throughput', 'RPS', { label: 'Cache disabled', run: off }, { label: 'Warm cache', run: on }, (r) => r.rps, (r) => r.rps);
        md.push(`![Cache p95](${c1})`, '', `![Cache throughput](${c2})`, '');
    }

    // ---- Performance Baseline (чернетка за baseline-прогонами) ----
    const base = names.filter((n) => n.startsWith('baseline-'));
    if (base.length) {
        const critical = base
            .map((n) => ({ n, a: analyses[n] }))
            .filter((x) => x.a)
            .reduce((worst, x) => (!worst || x.a.stable.rps < worst.a.stable.rps ? x : worst), null);
        const readRun = analyses['baseline-a'] ? 'baseline-a' : base[0];
        const ra = analyses[readRun];
        const sat = ra.saturation ? `${ra.saturation.from}–${ra.saturation.to} VUs (${readRun})` : `не досягнута до ${runs[readRun].rows.slice(-1)[0].vus} VUs (${readRun})`;
        md.push(
            '## SYSTEM PERFORMANCE BASELINE (чернетка, уточнити Primary Bottleneck)',
            '',
            '```text',
            '=== SYSTEM PERFORMANCE BASELINE ===',
            'Environment Config: див. розділ Baseline Environment Specification',
            `Stable Throughput:  ${f1(ra.stable.rps)} RPS при ${ra.stable.vus} VUs (${readRun})`,
            `Saturation Point:   ${sat}`,
            `p95 / p99 Latency:  ${f1(ra.stable.p95)} / ${f1(ra.stable.p99)} мс при стабільному навантаженні`,
            `Error Rate:         макс. ${f2(ra.maxError)}% (${readRun})`,
            `Critical Scenario:  ${critical ? `${runs[critical.n].title} (найменша стабільна пропускна здатність: ${f1(critical.a.stable.rps)} RPS)` : '—'}`,
            'Primary Bottleneck: <визначається з docker-stats.csv, кодів помилок і rollback PostgreSQL>',
            '```',
            '',
        );
    }

    fs.writeFileSync(path.join(RESULTS, 'SUMMARY.md'), md.join('\n'), 'utf8');
    console.log(`Звіт: ${path.join(RESULTS, 'SUMMARY.md')}`);
}

main();
