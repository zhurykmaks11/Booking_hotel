// Scenario D — Mixed Read/Write (Лаб. №6, п. 2.6).
// Типовий профіль системи бронювання: більшість відвідувачів переглядає каталог,
// невелика частина бронює. 85% ітерацій — читання (пошук 60% / картка готелю 40%),
// 15% — бронювання і його скасування (Serializable-транзакція + UPDATE на Primary).
//
// Read/Write Separation дає ефект саме тут: у Single Primary один вузол обслуговує і
// читання, і записи; у Primary + Replica читання йдуть на Replica, а Primary — лише записам.
//
// Кожна ітерація — окремий відвідувач зі своїм X-Session-Id: Sticky Routing діє в межах
// його візиту (запис → підтвердження), а не «прилипає» до Primary для всього VU.
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { BASE_URL, THINK, addDays, buildOptions, call, currentStage, pick, randInt } from './lib/config.js';
import { seed } from './lib/data.js';
import { buildSummary } from './lib/summary.js';

export const options = buildOptions();

const DATE_WINDOWS = 30;
const WRITE_SHARE = Number(__ENV.WRITE_SHARE || 0.15);

export function setup() {
    return seed();
}

export default function (data) {
    const stage = currentStage();
    const session = { 'X-Session-Id': `${data.runId}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}` };

    if (Math.random() >= WRITE_SHARE) {
        if (Math.random() < 0.6) {
            const checkIn = addDays('2031-01-06', randInt(DATE_WINDOWS) * 7);
            const url =
                `${BASE_URL}/rooms/search?city=${pick(data.cities)}` +
                `&checkIn=${checkIn}&checkOut=${addDays(checkIn, 3)}&guests=${1 + randInt(2)}`;
            const res = call('GET', url, null, 'GET /rooms/search', stage, session);
            check(res, { 'search → 200': (r) => r.status === 200 }, { stage });
        } else {
            const res = call('GET', `${BASE_URL}/hotels/${pick(data.hotelIds)}`, null, 'GET /hotels/:id', stage, session);
            check(res, { 'hotel → 200': (r) => r.status === 200 }, { stage });
        }
    } else {
        // Широкий діапазон дат (10 років) — конфлікти (409) рідкісні, навантаження створює саме запис
        const checkIn = addDays('2032-01-01', randInt(3650));
        const booking = call(
            'POST',
            `${BASE_URL}/bookings`,
            {
                roomId: pick(data.rooms).id,
                guestId: pick(data.guestIds),
                checkInDate: checkIn,
                checkOutDate: addDays(checkIn, 1 + randInt(5)),
            },
            'POST /bookings',
            stage,
            session,
        );
        check(booking, { 'booking → 201 або 409': (r) => r.status === 201 || r.status === 409 }, { stage });

        // Скасування звільняє дати, щоб база не «забивалася» бронюваннями
        if (booking.status === 201) {
            const cancel = call('PATCH', `${BASE_URL}/bookings/${booking.json('id')}/cancel`, null, 'PATCH /bookings/:id/cancel', stage, session);
            check(cancel, { 'cancel → 200': (r) => r.status === 200 }, { stage });
        }
    }

    sleep(THINK);
}

export function handleSummary(data) {
    return buildSummary(data, 'D', 'Scenario D — Mixed Read/Write');
}
