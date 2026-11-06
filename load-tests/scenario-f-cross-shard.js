// Scenario F — Cross-Shard запити (Fan-out / Scatter-Gather) (Лаб. №7, п. 2.4, 2.6).
// Жоден запит не містить ключа шардингу (hotelId), тому кожен іде на ВСІ шарди паралельно,
// а API зливає результати:
//   40% — пошук вільних номерів за містом   GET /rooms/search          (фільтр + NOT EXISTS на кожному шарді)
//   40% — історія бронювань гостя            GET /guests/:id/bookings   (бронювання шардовані за готелем, не за гостем)
//   20% — аналітика за містами               GET /sharding/analytics/cities (часткові агрегати + merge)
// Дані: SEED_BOOKINGS бронювань створюються в setup(), щоб запитам було що читати.
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { BASE_URL, THINK, addDays, buildOptions, call, currentStage, pick, randInt } from './lib/config.js';
import { seed } from './lib/data.js';
import { seedBookings } from './lib/sharding.js';
import { buildSummary } from './lib/summary.js';

export const options = buildOptions();

export function setup() {
    const data = seed();
    seedBookings(data);
    return data;
}

export default function (data) {
    const stage = currentStage();
    const session = { 'X-Session-Id': `${data.runId}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}` };
    const roll = Math.random();

    if (roll < 0.4) {
        const checkIn = addDays('2040-01-06', randInt(52) * 7);
        const url = `${BASE_URL}/rooms/search?city=${pick(data.cities)}&checkIn=${checkIn}&checkOut=${addDays(checkIn, 3)}&guests=${1 + randInt(2)}`;
        const res = call('GET', url, null, 'GET /rooms/search', stage, session);
        check(res, { 'search → 200': (r) => r.status === 200 }, { stage });
    } else if (roll < 0.8) {
        const res = call('GET', `${BASE_URL}/guests/${pick(data.guestIds)}/bookings`, null, 'GET /guests/:id/bookings', stage, session);
        check(res, { 'guest bookings → 200': (r) => r.status === 200 }, { stage });
    } else {
        const res = call('GET', `${BASE_URL}/sharding/analytics/cities`, null, 'GET /sharding/analytics/cities', stage, session);
        check(res, { 'analytics → 200': (r) => r.status === 200 }, { stage });
    }

    sleep(THINK);
}

export function handleSummary(data) {
    return buildSummary(data, 'F', 'Scenario F — Cross-Shard Fan-out');
}
