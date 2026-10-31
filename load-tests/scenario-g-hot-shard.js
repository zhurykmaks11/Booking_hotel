// Scenario G — Hot Shard (Лаб. №7, п. 2.3).
// Асиметричне навантаження: подія в одному місті (HOT_CITY, за замовчуванням Kyiv) —
// HOT_SHARE (90%) бронювань іде в готелі цього міста, решта — в інші міста.
//
//   SHARD_STRATEGY=city — усі готелі міста в одному бакеті → один шард приймає ~90% записів
//                         і насичується (Hot Shard), другий простоює;
//   SHARD_STRATEGY=hash — готелі міста розкидані по бакетах → записи діляться між шардами.
//
// Кожна ітерація: бронювання + скасування (Serializable-транзакція + UPDATE на шарді номера).
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { BASE_URL, THINK, addDays, buildOptions, call, currentStage, pick, randInt } from './lib/config.js';
import { seed } from './lib/data.js';
import { splitByCity } from './lib/sharding.js';
import { buildSummary } from './lib/summary.js';

export const options = buildOptions();

const HOT_CITY = __ENV.HOT_CITY || 'Kyiv';
const HOT_SHARE = Number(__ENV.HOT_SHARE || 0.9);

export function setup() {
    const data = seed();
    return { ...data, ...splitByCity(data.rooms, HOT_CITY) };
}

export default function (data) {
    const stage = currentStage();
    const session = { 'X-Session-Id': `${data.runId}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}` };
    const room = pick(Math.random() < HOT_SHARE ? data.hot : data.cold);
    const checkIn = addDays('2032-01-01', randInt(3650));

    const booking = call(
        'POST',
        `${BASE_URL}/bookings`,
        { roomId: room.id, guestId: pick(data.guestIds), checkInDate: checkIn, checkOutDate: addDays(checkIn, 1 + randInt(5)) },
        'POST /bookings',
        stage,
        session,
    );
    check(booking, { 'booking → 201 або 409': (r) => r.status === 201 || r.status === 409 }, { stage });
    if (booking.status === 201) {
        const cancel = call('PATCH', `${BASE_URL}/bookings/${booking.json('id')}/cancel`, null, 'PATCH /bookings/:id/cancel', stage, session);
        check(cancel, { 'cancel → 200': (r) => r.status === 200 }, { stage });
    }

    sleep(THINK);
}

export function handleSummary(data) {
    return buildSummary(data, 'G', `Scenario G — Hot Shard (${Math.round(HOT_SHARE * 100)}% записів у ${HOT_CITY})`);
}
