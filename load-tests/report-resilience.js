/**
 * Звіт Лаб. №8 (Resilience Engineering): results-lab8/*.json → results-lab8/SUMMARY.md + charts/*.svg.
 *   node load-tests/report-resilience.js
 * Дані збирає scripts/resilience-demo.js (compare --save, k6-all, avalanche --save, penetration --save).
 */
const fs = require('fs');
const path = require('path');

const RESULTS = path.join(__dirname, 'results-lab8');
const CHARTS = path.join(RESULTS, 'charts');
const MODES = ['none', 'singleflight', 'lock', 'swr'];
const LABEL = { none: 'Unprotected', singleflight: 'Single-flight', lock: 'Distributed Lock', swr: 'SWR + Lock' };

const f1 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(1));
const f2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(2));
const read = (name) => {
    const file = path.join(RESULTS, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

// ------------------------------- SVG -------------------------------
const COLORS = ['#dc2626', '#2563eb', '#16a34a', '#9333ea'];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = (v) => (v >= 100 ? Math.round(v) : Number(v).toFixed(1));

function frame(title, yLabel, top, T, L, plotW, plotH, W, H) {
    const y = (v) => T + plotH - (v / top) * plotH;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif" font-size="12">`;
    svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;
    svg += `<text x="${L}" y="28" font-size="15" font-weight="600" fill="#111">${esc(title)}</text>`;
    for (let k = 0; k <= 5; k++) {
        const v = (top * k) / 5;
        svg += `<line x1="${L}" x2="${L + plotW}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/>`;
        svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#555">${fmt(v)}</text>`;
    }
    svg += `<text transform="translate(18 ${T + plotH / 2}) rotate(-90)" text-anchor="middle" fill="#333">${esc(yLabel)}</text>`;
    return { svg, y };
}

/** Згруповані стовпчики: groups = [{ label, values: [..] }], series = назви стовпчиків у групі. */
function barChart({ title, groups, series, yLabel }) {
    const W = 760, H = 380, L = 70, R = 170, T = 50, B = 55;
    const plotW = W - L - R, plotH = H - T - B;
    const top = Math.max(1, ...groups.flatMap((g) => g.values)) * 1.15;
    const { svg: head, y } = frame(title, yLabel, top, T, L, plotW, plotH, W, H);
    let svg = head;
    const groupW = plotW / groups.length;
    const barW = Math.min(60, (groupW * 0.7) / series.length);
    groups.forEach((g, gi) => {
        const gx = L + gi * groupW + (groupW - barW * series.length) / 2;
        g.values.forEach((v, si) => {
            const bx = gx + si * barW;
            const color = series.length === 1 ? COLORS[gi % COLORS.length] : COLORS[(si + 1) % COLORS.length];
            svg += `<rect x="${bx}" y="${y(v)}" width="${barW - 4}" height="${T + plotH - y(v)}" fill="${color}"/>`;
            svg += `<text x="${bx + (barW - 4) / 2}" y="${y(v) - 5}" text-anchor="middle" fill="#222">${fmt(v)}</text>`;
        });
        svg += `<text x="${L + gi * groupW + groupW / 2}" y="${T + plotH + 20}" text-anchor="middle" fill="#333">${esc(g.label)}</text>`;
    });
    if (series.length > 1) {
        series.forEach((name, si) => {
            const ly = T + 10 + si * 20;
            svg += `<rect x="${L + plotW + 15}" y="${ly - 7}" width="20" height="12" fill="${COLORS[(si + 1) % COLORS.length]}"/>`;
            svg += `<text x="${L + plotW + 40}" y="${ly + 4}" fill="#222">${esc(name)}</text>`;
        });
    }
    return svg + '</svg>';
}

function lineChart({ title, xLabels, series, yLabel, xTitle }) {
    const W = 760, H = 380, L = 70, R = 170, T = 50, B = 55;
    const plotW = W - L - R, plotH = H - T - B;
    const top = Math.max(1, ...series.flatMap((s) => s.values)) * 1.1;
    const { svg: head, y } = frame(title, yLabel, top, T, L, plotW, plotH, W, H);
    let svg = head;
    const x = (i) => L + (i * plotW) / Math.max(1, xLabels.length - 1);
    xLabels.forEach((lab, i) => {
        if (i % 5 === 4 || i === 0) svg += `<text x="${x(i)}" y="${T + plotH + 20}" text-anchor="middle" fill="#555">${esc(lab)}</text>`;
    });
    svg += `<text x="${L + plotW / 2}" y="${H - 12}" text-anchor="middle" fill="#333">${esc(xTitle)}</text>`;
    series.forEach((s, si) => {
        const color = COLORS[si % COLORS.length];
        svg += `<polyline fill="none" stroke="${color}" stroke-width="2" points="${s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>`;
        const ly = T + 10 + si * 20;
        svg += `<line x1="${L + plotW + 15}" x2="${L + plotW + 35}" y1="${ly}" y2="${ly}" stroke="${color}" stroke-width="3"/>`;
        svg += `<text x="${L + plotW + 40}" y="${ly + 4}" fill="#222">${esc(s.name)}</text>`;
    });
    return svg + '</svg>';
}

function chart(file, svg) {
    fs.mkdirSync(CHARTS, { recursive: true });
    fs.writeFileSync(path.join(CHARTS, file), svg, 'utf8');
    return `charts/${file}`;
}

// ------------------------------- розділи -------------------------------
function stampedeSection(md) {
    const data = read('stampede-compare.json');
    if (!data) return;
    const rows = MODES.map((m) => data.rows.find((r) => r.mode === m)).filter(Boolean);
    md.push(`## 1. Cache Stampede: холодний ключ + ${data.requests} одночасних запитів (k6, per-vu-iterations)`, '');
    md.push('| Режим | Запитів до СУБД (pg_stat_statements) | Лічильник API | Пік одночасних запитів у СУБД | Throughput (RPS) | p50, мс | p95, мс | p99, мс | Error Rate, % | X-Cache |');
    md.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
        const cache = Object.entries(r.byCache).map(([k, v]) => `${k} ${v}`).join(', ');
        md.push(`| ${LABEL[r.mode]} | **${r.dbCalls}** | ${r.dbLoadsApp} | ${r.peakActiveDb} | ${f1(r.rps)} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.p99)} | ${f2(r.errorRate)} | ${cache} |`);
    }
    const db = chart('stampede-db.svg', barChart({ title: `Звернень до СУБД: ${data.requests} одночасних запитів`, yLabel: 'запитів до СУБД', series: ['db'], groups: rows.map((r) => ({ label: LABEL[r.mode], values: [r.dbCalls] })) }));
    const lat = chart('stampede-latency.svg', barChart({ title: 'Затримка залпу запитів', yLabel: 'мс', series: ['p95', 'p99'], groups: rows.map((r) => ({ label: LABEL[r.mode], values: [r.p95, r.p99] })) }));
    md.push('', `![](${db})`, '', `![](${lat})`, '');
}

function k6Section(md) {
    const rows = MODES.map((m) => read(`k6-${m}.json`)).filter((r) => r && r.dbCalls !== undefined);
    if (!rows.length) return;
    const r0 = rows[0];
    md.push(`## 2. Порівняльна матриця (п. 2.7): k6, ${r0.vus} VUs × ${Math.round(r0.durationSec)} с, ключ вигасає кожні ${r0.ttl} с`, '');
    md.push('| Режим / Показник | Кількість запитів до СУБД | Throughput (RPS) | p95 Latency, мс | p99 Latency, мс | Error Rate, % | X-Cache |');
    md.push('|---|---|---|---|---|---|---|');
    for (const r of rows) {
        const cache = Object.entries(r.byCache).map(([k, v]) => `${k} ${v}`).join(', ');
        md.push(`| ${LABEL[r.mode]} | **${r.dbCalls}** | ${f1(r.rps)} | ${f1(r.p95)} | ${f1(r.p99)} | ${f2(r.errorRate)} | ${cache} |`);
    }
    const db = chart('k6-db.svg', barChart({ title: `k6 ${r0.vus} VUs: звернень до СУБД за ${Math.round(r0.durationSec)} с`, yLabel: 'запитів до СУБД', series: ['db'], groups: rows.map((r) => ({ label: LABEL[r.mode], values: [r.dbCalls] })) }));
    const lat = chart('k6-latency.svg', barChart({ title: `k6 ${r0.vus} VUs: затримка`, yLabel: 'мс', series: ['p95', 'p99'], groups: rows.map((r) => ({ label: LABEL[r.mode], values: [r.p95, r.p99] })) }));
    md.push('', `![](${db})`, '', `![](${lat})`, '');
}

function avalancheSection(md) {
    const off = read('avalanche-jitter-off.json');
    const on = read('avalanche-jitter-on.json');
    if (!off || !on) return;
    md.push(`## 3. Cache Avalanche і TTL Jitter: ${off.keys} популярних ключів, TTL ${off.ttl} с, ${off.concurrency} клієнтів, ${off.duration} с`, '');
    md.push('| TTL | Звернень до СУБД, усього | Пік звернень за 1 с | p95 найгіршої секунди, мс | p99 за тест, мс |');
    md.push('|---|---|---|---|---|');
    md.push(`| ${off.ttl} с (без jitter) | ${off.totalDbLoads} | **${off.peakDbLoadsPerSec}** | **${f1(off.worstSecondP95)}** | ${f1(off.p99Overall)} |`);
    md.push(`| ${on.ttl} ± ${on.jitterSec} с | ${on.totalDbLoads} | **${on.peakDbLoadsPerSec}** | **${f1(on.worstSecondP95)}** | ${f1(on.p99Overall)} |`);
    const labels = off.timeline.map((t) => String(t.second));
    const db = chart('avalanche-db.svg', lineChart({ title: 'Звернень до СУБД щосекунди', xTitle: 'секунда тесту', yLabel: 'запитів до СУБД / с', xLabels: labels, series: [{ name: 'без jitter', values: off.timeline.map((t) => t.dbLoads) }, { name: `jitter ±${on.jitterSec} с`, values: on.timeline.map((t) => t.dbLoads) }] }));
    const p95 = chart('avalanche-p95.svg', lineChart({ title: 'p95 затримки щосекунди', xTitle: 'секунда тесту', yLabel: 'мс', xLabels: labels, series: [{ name: 'без jitter', values: off.timeline.map((t) => t.p95) }, { name: `jitter ±${on.jitterSec} с`, values: on.timeline.map((t) => t.p95) }] }));
    md.push('', `![](${db})`, '', `![](${p95})`, '');
}

function penetrationSection(md) {
    const off = read('penetration-negative-off.json');
    const on = read('penetration-negative-on.json');
    if (!off || !on) return;
    md.push(`## 4. Cache Penetration: ${off.requests} запитів до ${off.ids} неіснуючих готелів, ${off.concurrency} клієнтів`, '');
    md.push('| Negative Caching | Запитів до СУБД | Відповідей з Negative Cache | Throughput (RPS) | p95, мс | p99, мс |');
    md.push('|---|---|---|---|---|---|');
    for (const r of [off, on]) {
        md.push(`| ${r.negativeCache ? 'увімкнено' : 'вимкнено'} | **${r.dbCalls}** | ${r.negativeHits} | ${f1(r.rps)} | ${f1(r.p95)} | ${f1(r.p99)} |`);
    }
    const db = chart('penetration-db.svg', barChart({ title: 'Cache Penetration: звернень до СУБД', yLabel: 'запитів до СУБД', series: ['db'], groups: [{ label: 'без Negative Cache', values: [off.dbCalls] }, { label: 'Negative Cache', values: [on.dbCalls] }] }));
    md.push('', `![](${db})`, '');
}

function main() {
    const md = ['# Лаб. №8 — результати вимірювань', '', 'Згенеровано `node load-tests/report-resilience.js` з `load-tests/results-lab8/*.json`.', ''];
    stampedeSection(md);
    k6Section(md);
    avalancheSection(md);
    penetrationSection(md);
    fs.writeFileSync(path.join(RESULTS, 'SUMMARY.md'), md.join('\n'), 'utf8');
    console.log(`SUMMARY.md: ${path.relative(process.cwd(), path.join(RESULTS, 'SUMMARY.md'))}`);
}

main();
