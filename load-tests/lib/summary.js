// Формування підсумкової таблиці (п. 2.4) з метрик k6 для кожного ступеня навантаження.
// Результат: таблиця в консолі + results/<TEST_NAME>.json + results/<TEST_NAME>.md
import { BASE_URL, HOLD, LEVELS, RAMP, TEST_NAME, THINK, WARMUP, WARMUP_VUS } from './config.js';

function metric(data, name, level) {
    return data.metrics[`${name}{stage:${level}}`];
}

function value(m, key, fallback = 0) {
    return m && m.values && m.values[key] !== undefined ? m.values[key] : fallback;
}

export function collectRows(data) {
    const rows = [];
    for (const level of LEVELS) {
        const duration = metric(data, 'http_req_duration', level);
        const reqs = metric(data, 'http_reqs', level);
        if (!duration || !reqs || value(reqs, 'count') === 0) continue;

        const count = value(reqs, 'count');
        const cache = metric(data, 'cache_hit', level);
        rows.push({
            vus: level,
            requests: count,
            rps: count / HOLD,
            iterationsPerSec: value(metric(data, 'iterations', level), 'count') / HOLD,
            avg: value(duration, 'avg'),
            p50: value(duration, 'med'),
            p95: value(duration, 'p(95)'),
            p99: value(duration, 'p(99)'),
            max: value(duration, 'max'),
            errorRate: value(metric(data, 'http_req_failed', level), 'rate') * 100,
            errors5xx: value(metric(data, 'resp_5xx', level), 'count'),
            conflicts409: value(metric(data, 'resp_409', level), 'count'),
            networkErrors: value(metric(data, 'resp_network_error', level), 'count'),
            cacheHitRate: cache && value(cache, 'passes') + value(cache, 'fails') > 0 ? value(cache, 'rate') * 100 : null,
        });
    }
    return rows;
}

const f1 = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(1));
const f2 = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(2));

export function markdownTable(rows) {
    const lines = [
        '| Навантаження (VUs) | Throughput (RPS) | Avg, мс | p50, мс | p95, мс | p99, мс | Max, мс | Error Rate, % | 5xx | 409 | Cache HIT, % |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const r of rows) {
        lines.push(
            `| ${r.vus} | ${f1(r.rps)} | ${f1(r.avg)} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.p99)} | ${f1(r.max)} | ${f2(r.errorRate)} | ${r.errors5xx} | ${r.conflicts409} | ${f1(r.cacheHitRate)} |`,
        );
    }
    return lines.join('\n');
}

function consoleTable(title, rows) {
    const pad = (s, n) => String(s).padStart(n);
    const out = [
        '',
        `================ ${title} (${TEST_NAME}) ================`,
        `${pad('VUs', 5)} ${pad('RPS', 8)} ${pad('avg', 8)} ${pad('p50', 8)} ${pad('p95', 8)} ${pad('p99', 8)} ${pad('err%', 7)} ${pad('5xx', 6)} ${pad('409', 6)} ${pad('HIT%', 6)}`,
    ];
    for (const r of rows) {
        out.push(
            `${pad(r.vus, 5)} ${pad(f1(r.rps), 8)} ${pad(f1(r.avg), 8)} ${pad(f1(r.p50), 8)} ${pad(f1(r.p95), 8)} ${pad(f1(r.p99), 8)} ${pad(f2(r.errorRate), 7)} ${pad(r.errors5xx, 6)} ${pad(r.conflicts409, 6)} ${pad(f1(r.cacheHitRate), 6)}`,
        );
    }
    out.push('(затримки в мс; RPS = запити фази утримання / тривалість утримання)', '');
    return out.join('\n');
}

export function buildSummary(data, scenario, title) {
    const rows = collectRows(data);
    const result = {
        name: TEST_NAME,
        scenario,
        title,
        finishedAt: new Date().toISOString(),
        config: { BASE_URL, LEVELS, WARMUP, WARMUP_VUS, RAMP, HOLD, THINK },
        rows,
    };
    const md = [
        `## ${title} — \`${TEST_NAME}\``,
        '',
        `Профіль: розігрів ${WARMUP} с × ${WARMUP_VUS} VUs, ступені ${LEVELS.join(' → ')} VUs, перехід ${RAMP} с, утримання ${HOLD} с, пауза між ітераціями ${THINK} с.`,
        '',
        markdownTable(rows),
        '',
    ].join('\n');

    return {
        stdout: consoleTable(title, rows),
        [`results/${TEST_NAME}.json`]: JSON.stringify(result, null, 2),
        [`results/${TEST_NAME}.md`]: md,
    };
}
