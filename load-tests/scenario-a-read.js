// Scenario A — Read-Intensive (п. 2.1).
// Часті читання каталогу: пошук вільних номерів (60%) і картка готелю (40%).
// Навантажує шар кешу Redis і читання з PostgreSQL при промахах.
import { check, sleep } from 'k6';
import { BASE_URL, THINK, addDays, buildOptions, call, currentStage, pick, randInt } from './lib/config.js';
import { seed } from './lib/data.js';
import { buildSummary } from './lib/summary.js';

export const options = buildOptions();

// 30 тижневих вікон × 5 міст × 2 варіанти гостей = 300 різних пошуків:
// реалістичний простір ключів, у якому кеш має значення (популярні запити повторюються).
const DATE_WINDOWS = 30;

export function setup() {
    return seed();
}

export default function (data) {
    const stage = currentStage();

    if (Math.random() < 0.6) {
        const checkIn = addDays('2031-01-06', randInt(DATE_WINDOWS) * 7);
        const url =
            `${BASE_URL}/rooms/search?city=${pick(data.cities)}` +
            `&checkIn=${checkIn}&checkOut=${addDays(checkIn, 3)}&guests=${1 + randInt(2)}`;
        const res = call('GET', url, null, 'GET /rooms/search', stage);
        check(res, { 'search → 200': (r) => r.status === 200 }, { stage });
    } else {
        const res = call('GET', `${BASE_URL}/hotels/${pick(data.hotelIds)}`, null, 'GET /hotels/:id', stage);
        check(res, { 'hotel → 200': (r) => r.status === 200 }, { stage });
    }

    sleep(THINK);
}

export function handleSummary(data) {
    return buildSummary(data, 'A', 'Scenario A — Read-Intensive');
}
