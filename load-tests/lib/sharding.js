// Лаб. №7: дані для сценаріїв шардингу — бронювання, щоб Cross-Shard запити
// (історія гостя, аналітика за містами) працювали з реальним обсягом рядків.
import http from 'k6/http';
import { BASE_URL, addDays, pick, randInt } from './config.js';

const SEED_BOOKINGS = Number(__ENV.SEED_BOOKINGS || 0);

/** Створює SEED_BOOKINGS бронювань (пакетами по 20). 409 (дати зайняті) — пропускається. */
export function seedBookings(data) {
    const ids = [];
    for (let i = 0; i < SEED_BOOKINGS; i += 20) {
        const requests = [];
        for (let j = i; j < Math.min(i + 20, SEED_BOOKINGS); j++) {
            const checkIn = addDays('2040-01-01', randInt(3650));
            requests.push([
                'POST',
                `${BASE_URL}/bookings`,
                JSON.stringify({
                    roomId: pick(data.rooms).id,
                    guestId: pick(data.guestIds),
                    checkInDate: checkIn,
                    checkOutDate: addDays(checkIn, 1 + randInt(4)),
                }),
                { headers: { 'Content-Type': 'application/json' }, tags: { name: 'setup', stage: 'setup' } },
            ]);
        }
        for (const res of http.batch(requests)) {
            if (res.status === 201) ids.push(res.json('id'));
            else if (res.status !== 409) throw new Error(`setup: POST /bookings → ${res.status} ${res.body}`);
        }
    }
    console.log(`setup: ${ids.length} бронювань`);
    return ids;
}

/** Номери «гарячого» міста і решта — для сценарію Hot Shard. */
export function splitByCity(rooms, hotCity) {
    const hot = rooms.filter((r) => r.city === hotCity);
    const cold = rooms.filter((r) => r.city !== hotCity);
    if (!hot.length) throw new Error(`setup: немає номерів у місті ${hotCity}`);
    return { hot, cold: cold.length ? cold : hot };
}
