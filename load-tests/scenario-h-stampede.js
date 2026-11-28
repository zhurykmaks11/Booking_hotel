// Scenario H — Cache Stampede (Лаб. №8). Запускається з scripts/resilience-demo.js (k6 у Docker, мережа кластера).
//
//   SCENARIO=burst     — VUS віртуальних користувачів, кожен робить РІВНО ОДИН запит, усі стартують одночасно
//                        (холодний ключ після Force Expire: п. 2.2, live-демонстрація «500+ запитів»);
//   SCENARIO=sustained — VUS користувачів безперервно читають популярний ключ DURATION секунд; ключ сам
//                        вигасає кожні statsTtlSec (задає demo-скрипт) — для матриці п. 2.7 (RPS, p95, p99).
//
// Генератор усередині мережі Docker: 600 нових TCP-з'єднань з Windows через проброс портів Docker Desktop
// встановлюються секундами — це спотворювало б і «одночасність», і затримки.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://nginx').replace(/\/$/, '');
const HOTEL_ID = __ENV.HOTEL_ID;
const VUS = Number(__ENV.VUS || 500);
const DURATION = __ENV.DURATION || '30s';
const SCENARIO = __ENV.SCENARIO || 'sustained';
const THINK = Number(__ENV.THINK || 0.05);
const RESULTS_DIR = __ENV.RESULTS_DIR || 'results-lab8';
const OUTPUT = __ENV.OUTPUT || `k6-${__ENV.MODE || 'run'}.json`;

// Звідки прийшла відповідь (X-Cache): HIT / MISS / COALESCED / LOCK-WAIT / STALE / NEGATIVE / BYPASS
const STATUSES = ['HIT', 'MISS', 'COALESCED', 'LOCK-WAIT', 'STALE', 'NEGATIVE', 'BYPASS'];
const counters = Object.fromEntries(STATUSES.map((s) => [s, new Counter(`xcache_${s.replace('-', '_')}`)]));
const resp5xx = new Counter('resp_5xx');

export const options = {
    scenarios: {
        main:
            SCENARIO === 'burst'
                ? { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '60s' }
                : { executor: 'constant-vus', vus: VUS, duration: DURATION },
    },
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
};

export default function () {
    const res = http.get(`${BASE_URL}/hotels/${HOTEL_ID}/stats`, { tags: { name: 'stats' }, timeout: '30s' });
    const status = res.headers['X-Cache'];
    if (counters[status]) counters[status].add(1);
    if (res.status >= 500) resp5xx.add(1);
    if (SCENARIO !== 'burst' && THINK > 0) sleep(THINK);
}

const val = (data, metric, key, fallback = 0) =>
    data.metrics[metric] && data.metrics[metric].values[key] !== undefined ? data.metrics[metric].values[key] : fallback;

export function handleSummary(data) {
    const durationSec = data.state.testRunDurationMs / 1000;
    const requests = val(data, 'http_reqs', 'count');
    const out = {
        scenario: SCENARIO,
        vus: VUS,
        durationSec,
        requests,
        rps: requests / durationSec,
        avg: val(data, 'http_req_duration', 'avg'),
        p50: val(data, 'http_req_duration', 'med'),
        p95: val(data, 'http_req_duration', 'p(95)'),
        p99: val(data, 'http_req_duration', 'p(99)'),
        max: val(data, 'http_req_duration', 'max'),
        errorRate: val(data, 'http_req_failed', 'rate') * 100,
        errors5xx: val(data, 'resp_5xx', 'count'),
        byCache: Object.fromEntries(STATUSES.map((s) => [s, val(data, `xcache_${s.replace('-', '_')}`, 'count')]).filter(([, v]) => v > 0)),
    };
    return {
        [`${RESULTS_DIR}/${OUTPUT}`]: JSON.stringify(out, null, 2),
        stdout:
            `  ${SCENARIO}: ${requests} запитів, ${out.rps.toFixed(1)} RPS, p50 ${out.p50.toFixed(1)} / p95 ${out.p95.toFixed(1)} / ` +
            `p99 ${out.p99.toFixed(1)} мс, помилок ${out.errorRate.toFixed(2)} %, X-Cache ${JSON.stringify(out.byCache)}\n`,
    };
}
