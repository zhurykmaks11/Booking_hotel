// Scenario E — Shard-Local операції (Лаб. №7, п. 2.6).
// Кожен запит містить ключ шардингу (ID готелю / номера / бронювання), тому Shard Router
// відправляє його рівно на один шард:
//   55% — картка готелю з номерами          GET  /hotels/:id                (JOIN в межах шарду)
//   15% — статистика готелю                 GET  /sharding/analytics/hotels/:id
//   30% — бронювання + скасування           POST /bookings, PATCH /bookings/:id/cancel
//                                           (Serializable-транзакція на шарді номера)
// Single Node vs Sharded: та сама логіка, але навантаження ділиться між шардами.
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { BASE_URL, THINK, addDays, buildOptions, call, currentStage, pick, randInt } from './lib/config.js';
import { seed } from './lib/data.js';
import { buildSummary } from './lib/summary.js';

export const options = buildOptions();

export function setup() {
    return seed();
}

export default function (data) {
    const stage = currentStage();
    const session = { 'X-Session-Id': `${data.runId}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}` };
    const roll = Math.random();

    if (roll < 0.55) {
        const res = call('GET', `${BASE_URL}/hotels/${pick(data.hotelIds)}`, null, 'GET /hotels/:id', stage, session);
        check(res, { 'hotel → 200': (r) => r.status === 200 }, { stage });
    } else if (roll < 0.7) {
        const res = call(
            'GET',
            `${BASE_URL}/sharding/analytics/hotels/${pick(data.hotelIds)}`,
            null,
            'GET /sharding/analytics/hotels/:id',
            stage,
            session,
        );
        check(res, { 'hotel stats → 200': (r) => r.status === 200 }, { stage });
    } else {
        const checkIn = addDays('2032-01-01', randInt(3650));
        const booking = call(
            'POST',
            `${BASE_URL}/bookings`,
            { roomId: pick(data.rooms).id, guestId: pick(data.guestIds), checkInDate: checkIn, checkOutDate: addDays(checkIn, 1 + randInt(5)) },
            'POST /bookings',
            stage,
            session,
        );
        check(booking, { 'booking → 201 або 409': (r) => r.status === 201 || r.status === 409 }, { stage });
        if (booking.status === 201) {
            const cancel = call('PATCH', `${BASE_URL}/bookings/${booking.json('id')}/cancel`, null, 'PATCH /bookings/:id/cancel', stage, session);
            check(cancel, { 'cancel → 200': (r) => r.status === 200 }, { stage });
        }
    }

    sleep(THINK);
}

export function handleSummary(data) {
    return buildSummary(data, 'E', 'Scenario E — Shard-Local операції');
}
