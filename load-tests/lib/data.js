// Підготовка тестових даних (виконується один раз у setup() перед тестом).
// Дані створюються через публічний API, тому тест не залежить від стану БД:
// якщо набір готелів для навантаження вже є — він перевикористовується.
import http from 'k6/http';
import { BASE_URL } from './config.js';

export const CITIES = ['Kyiv', 'Lviv', 'Odesa', 'Kharkiv', 'Chernivtsi'];
const HOTEL_PREFIX = 'LT Hotel';
const ROOM_TYPES = [
    { type: 'SINGLE', capacity: 1, price: 900 },
    { type: 'DOUBLE', capacity: 2, price: 1500 },
    { type: 'SUITE', capacity: 4, price: 3200 },
];

const json = (body) => ({
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'setup', stage: 'setup' },
    body: JSON.stringify(body),
});

function batchPost(path, bodies, chunk = 20) {
    const results = [];
    for (let i = 0; i < bodies.length; i += chunk) {
        const requests = bodies.slice(i, i + chunk).map((b) => {
            const p = json(b);
            return ['POST', `${BASE_URL}${path}`, p.body, { headers: p.headers, tags: p.tags }];
        });
        for (const res of http.batch(requests)) {
            if (res.status !== 201) {
                throw new Error(`setup: POST ${path} → ${res.status} ${res.body}`);
            }
            results.push(res.json());
        }
    }
    return results;
}

function loadExistingRooms() {
    const res = http.get(`${BASE_URL}/rooms`, { tags: { name: 'setup', stage: 'setup' } });
    if (res.status !== 200) throw new Error(`setup: GET /rooms → ${res.status}`);
    return res
        .json()
        .filter((r) => r.hotel && typeof r.hotel.name === 'string' && r.hotel.name.startsWith(HOTEL_PREFIX))
        .map((r) => ({ id: r.id, hotelId: r.hotelId, capacity: r.capacity }));
}

export function seed() {
    const hotelsTarget = Number(__ENV.SEED_HOTELS || 20);
    const roomsPerHotel = Number(__ENV.SEED_ROOMS_PER_HOTEL || 10);
    const guestsCount = Number(__ENV.SEED_GUESTS || 100);
    const runId = Date.now().toString(36);

    const health = http.get(`${BASE_URL}/health`, { tags: { name: 'setup', stage: 'setup' } });
    if (health.status !== 200) {
        throw new Error(`Система недоступна: GET /health → ${health.status}. Запустіть docker compose up -d`);
    }

    let rooms = loadExistingRooms();
    const needed = hotelsTarget * roomsPerHotel;
    if (rooms.length < needed) {
        const hotelBodies = [];
        for (let i = 0; i < hotelsTarget; i++) {
            hotelBodies.push({
                name: `${HOTEL_PREFIX} ${runId}-${i + 1}`,
                address: `Load Test St ${i + 1}`,
                city: CITIES[i % CITIES.length],
                rating: 3 + (i % 3),
            });
        }
        const hotels = batchPost('/hotels', hotelBodies);

        const roomBodies = [];
        for (const hotel of hotels) {
            for (let r = 0; r < roomsPerHotel; r++) {
                const kind = ROOM_TYPES[r % ROOM_TYPES.length];
                roomBodies.push({
                    hotelId: hotel.id,
                    roomNumber: String(100 + r),
                    type: kind.type,
                    pricePerNight: kind.price,
                    capacity: kind.capacity,
                });
            }
        }
        batchPost('/rooms', roomBodies);
        rooms = loadExistingRooms();
    }

    const guestBodies = [];
    for (let i = 0; i < guestsCount; i++) {
        guestBodies.push({ fullName: `Load Guest ${i + 1}`, email: `lt-${runId}-${i}@load.test` });
    }
    const guests = batchPost('/guests', guestBodies);

    const hotelIds = [...new Set(rooms.map((r) => r.hotelId))];
    console.log(
        `setup: ${hotelIds.length} готелів, ${rooms.length} номерів, ${guests.length} гостей (runId=${runId})`,
    );

    return { runId, rooms, hotelIds, guestIds: guests.map((g) => g.id), cities: CITIES };
}
