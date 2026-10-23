// Scenario C — Complex Workflow (п. 2.1).
// Наскрізний сценарій користувача: пошук → картка готелю → реєстрація гостя →
// бронювання знайденого номера → скасування бронювання.
// Поєднує читання (кеш), бізнес-обчислення (ціна, перевірка дат) і запис з інвалідацією.
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { BASE_URL, THINK, addDays, buildOptions, call, currentStage, pick, randInt } from './lib/config.js';
import { seed } from './lib/data.js';
import { buildSummary } from './lib/summary.js';

export const options = buildOptions();

const DATE_WINDOWS = 30;

export function setup() {
    return seed();
}

export default function (data) {
    const stage = currentStage();
    const checkIn = addDays('2031-01-06', randInt(DATE_WINDOWS) * 7);
    const checkOut = addDays(checkIn, 3);

    // 1. Пошук вільних номерів
    const search = call(
        'GET',
        `${BASE_URL}/rooms/search?city=${pick(data.cities)}&checkIn=${checkIn}&checkOut=${checkOut}&guests=1`,
        null,
        'GET /rooms/search',
        stage,
    );
    check(search, { 'search → 200': (r) => r.status === 200 }, { stage });

    let room = null;
    if (search.status === 200) {
        const found = search.json();
        if (Array.isArray(found) && found.length > 0) room = found[randInt(found.length)];
    }
    if (!room) room = pick(data.rooms);

    // 2. Картка готелю
    const hotel = call('GET', `${BASE_URL}/hotels/${room.hotelId}`, null, 'GET /hotels/:id', stage);
    check(hotel, { 'hotel → 200': (r) => r.status === 200 }, { stage });

    // 3. Реєстрація гостя (унікальний email для кожної ітерації)
    const email = `lt-${data.runId}-${exec.vu.idInTest}-${exec.vu.iterationInInstance}@load.test`;
    const guest = call('POST', `${BASE_URL}/guests`, { fullName: 'Workflow Guest', email }, 'POST /guests', stage);
    if (!check(guest, { 'guest → 201': (r) => r.status === 201 }, { stage })) {
        sleep(THINK);
        return;
    }

    // 4. Бронювання на ті самі дати, що й у пошуку (конкуренція за популярні дати → можливі 409)
    const booking = call(
        'POST',
        `${BASE_URL}/bookings`,
        { roomId: room.id, guestId: guest.json('id'), checkInDate: checkIn, checkOutDate: checkOut },
        'POST /bookings',
        stage,
    );
    check(booking, { 'booking → 201 або 409': (r) => r.status === 201 || r.status === 409 }, { stage });

    // 5. Скасування (звільняє номер, щоб база не «забивалася» бронюваннями)
    if (booking.status === 201) {
        const cancel = call(
            'PATCH',
            `${BASE_URL}/bookings/${booking.json('id')}/cancel`,
            null,
            'PATCH /bookings/:id/cancel',
            stage,
        );
        check(cancel, { 'cancel → 200': (r) => r.status === 200 }, { stage });
    }

    sleep(THINK);
}

export function handleSummary(data) {
    return buildSummary(data, 'C', 'Scenario C — Complex Workflow');
}
