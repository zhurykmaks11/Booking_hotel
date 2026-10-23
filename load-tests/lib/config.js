// Спільна конфігурація навантажувальних тестів (Лаб. №5).
// Усі параметри задаються змінними середовища, тому той самий скрипт
// відтворювано запускається з різними профілями навантаження.
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';

const num = (value, fallback) =>
    value === undefined || value === '' ? fallback : Number(value);

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost').replace(/\/$/, '');
export const TEST_NAME = __ENV.TEST_NAME || 'run';

// Ступені навантаження (Virtual Users): 10 → 25 → 50 → 100 → 200
export const LEVELS = (__ENV.LEVELS || '10,25,50,100,200')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n > 0);

export const WARMUP = num(__ENV.WARMUP, 30); // тривалість розігріву, с
export const WARMUP_VUS = num(__ENV.WARMUP_VUS, 5); // VUs під час розігріву
export const RAMP = num(__ENV.RAMP, 10); // перехід між ступенями, с
export const HOLD = num(__ENV.HOLD, 60); // утримання кожного ступеня (вимірювання), с
export const THINK = num(__ENV.THINK, 0.1); // пауза між ітераціями VU, с

/**
 * Часова шкала тесту: розігрів → (перехід → утримання) для кожного ступеня → спад.
 * Метрики в підсумковій таблиці беруться ЛИШЕ з фаз утримання (тег stage = рівень VUs),
 * тому розігрів і перехідні процеси не спотворюють вимірювання.
 */
function buildTimeline() {
    const segments = [];
    let t = 0;
    const push = (duration, target, tag) => {
        segments.push({ from: t, to: t + duration, target, tag, duration: `${duration}s` });
        t += duration;
    };

    if (WARMUP > 0) {
        const rampIn = Math.min(5, WARMUP);
        push(rampIn, WARMUP_VUS, 'warmup');
        if (WARMUP > rampIn) push(WARMUP - rampIn, WARMUP_VUS, 'warmup');
    }
    for (const level of LEVELS) {
        if (RAMP > 0) push(RAMP, level, 'ramp');
        push(HOLD, level, String(level));
    }
    push(5, 0, 'rampdown');
    return segments;
}

export const TIMELINE = buildTimeline();

/**
 * Поточна фаза тесту (warmup / ramp / <рівень VUs> / rampdown) за часом від старту сценарію.
 * Тег stage ставиться на рівні VU, тому ним позначаються всі метрики ітерації
 * (http_*, iterations, checks, власні метрики).
 */
export function currentStage() {
    const elapsed = (Date.now() - exec.scenario.startTime) / 1000;
    let tag = 'rampdown';
    for (const segment of TIMELINE) {
        if (elapsed < segment.to) {
            tag = segment.tag;
            break;
        }
    }
    if (exec.vu && exec.vu.metrics && exec.vu.metrics.tags) exec.vu.metrics.tags.stage = tag;
    return tag;
}

// Додаткові метрики: структура помилок і ефективність кешу
export const resp5xx = new Counter('resp_5xx');
export const resp409 = new Counter('resp_409');
export const respNetwork = new Counter('resp_network_error');
export const cacheHit = new Rate('cache_hit');

// 409 Conflict (номер уже заброньовано) — коректна бізнес-відповідь, а не збій системи.
// Помилками (Error Rate) вважаються 5xx, 4xx крім 409 і мережеві збої.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

export function buildOptions() {
    // Порогові значення (завжди виконуються) потрібні, щоб k6 зібрав окремі
    // метрики для кожного ступеня навантаження — з них будується таблиця результатів.
    const thresholds = {};
    for (const level of LEVELS) {
        const tag = `stage:${level}`;
        thresholds[`http_req_duration{${tag}}`] = ['max>=0'];
        thresholds[`http_reqs{${tag}}`] = ['count>=0'];
        thresholds[`http_req_failed{${tag}}`] = ['rate>=0'];
        thresholds[`iterations{${tag}}`] = ['count>=0'];
        thresholds[`resp_5xx{${tag}}`] = ['count>=0'];
        thresholds[`resp_409{${tag}}`] = ['count>=0'];
        thresholds[`resp_network_error{${tag}}`] = ['count>=0'];
        thresholds[`cache_hit{${tag}}`] = ['rate>=0'];
    }

    return {
        scenarios: {
            main: {
                executor: 'ramping-vus',
                startVUs: 0,
                stages: TIMELINE.map((s) => ({ duration: s.duration, target: s.target })),
                gracefulRampDown: '10s',
                gracefulStop: '10s',
            },
        },
        thresholds,
        summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
        setupTimeout: '300s',
    };
}

/**
 * HTTP-запит з тегами: name — шаблон маршруту (щоб id не створювали тисячі окремих метрик),
 * stage — фаза тесту. Додатково фіксує 5xx / 409 / мережеві помилки і HIT кешу.
 */
export function call(method, url, body, name, stage) {
    const params = {
        headers: body ? { 'Content-Type': 'application/json' } : {},
        tags: { name, stage },
        timeout: '30s',
    };
    const res = http.request(method, url, body ? JSON.stringify(body) : null, params);

    const tags = { stage };
    if (res.status === 0) respNetwork.add(1, tags);
    else if (res.status >= 500) resp5xx.add(1, tags);
    else if (res.status === 409) resp409.add(1, tags);

    const xCache = res.headers['X-Cache'];
    if (xCache) cacheHit.add(xCache === 'HIT', tags);

    return res;
}

export function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

export function randInt(max) {
    return Math.floor(Math.random() * max);
}

export function addDays(isoDate, days) {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
