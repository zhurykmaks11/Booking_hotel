// Scenario B — Write-Intensive (п. 2.1).
// Масове створення бронювань: кожне — Serializable-транзакція в PostgreSQL
// (перевірка перетину дат + INSERT) та інвалідація кешу пошуку в Redis.
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

    // Випадковий номер і дати в широкому діапазоні (10 років): конфлікти дат (409) рідкісні,
    // тож навантаження створює саме запис, а не відмови бізнес-логіки.
    const room = pick(data.rooms);
    const checkIn = addDays('2032-01-01', randInt(3650));
    const body = {
        roomId: room.id,
        guestId: pick(data.guestIds),
        checkInDate: checkIn,
        checkOutDate: addDays(checkIn, 1 + randInt(5)),
    };

    const res = call('POST', `${BASE_URL}/bookings`, body, 'POST /bookings', stage);
    check(res, { 'booking → 201 або 409': (r) => r.status === 201 || r.status === 409 }, { stage });

    sleep(THINK);
}

export function handleSummary(data) {
    return buildSummary(data, 'B', 'Scenario B — Write-Intensive');
}
