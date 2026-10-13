import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CacheService } from '../src/cache/cache.service';

describe('Hotel Booking API (e2e)', () => {
    let app: INestApplication;
    let prisma: PrismaService;

    let hotelId: string;
    let roomId: string;
    let guestId: string;
    let bookingId: string;

    // Якщо Redis налаштований (REDIS_URL), очікуємо HIT/MISS; без нього — BYPASS.
    let cacheEnabled = false;
    const expectCache = (res: { headers: Record<string, unknown> }, whenEnabled: 'HIT' | 'MISS') =>
        expect(res.headers['x-cache']).toBe(cacheEnabled ? whenEnabled : 'BYPASS');

    const searchQuery = { city: 'Kyiv', checkIn: '2027-01-01', checkOut: '2027-01-04', guests: 2 };

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(
            new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
            }),
        );
        await app.init();

        prisma = app.get(PrismaService);
        cacheEnabled = await app.get(CacheService).whenReady(2000);
    });

    afterAll(async () => {
        // Прибираємо за собою тестові дані, щоб прогони не накопичувались
        if (bookingId) await prisma.booking.deleteMany({ where: { id: bookingId } });
        if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
        if (hotelId) await prisma.hotel.deleteMany({ where: { id: hotelId } });
        if (guestId) await prisma.guest.deleteMany({ where: { id: guestId } });
        await app.close();
    });

    it('POST /hotels — creates a hotel', async () => {
        const res = await request(app.getHttpServer())
            .post('/hotels')
            .send({ name: 'E2E Test Hotel', address: 'Test St 1', city: 'Kyiv' })
            .expect(201);

        expect(res.body.id).toBeDefined();
        hotelId = res.body.id;
    });

    it('POST /rooms — creates a room in the hotel', async () => {
        const res = await request(app.getHttpServer())
            .post('/rooms')
            .send({
                hotelId,
                roomNumber: 'E2E-101',
                type: 'DOUBLE',
                pricePerNight: 1000,
                capacity: 2,
            })
            .expect(201);

        expect(res.body.id).toBeDefined();
        roomId = res.body.id;
    });

    // ---------------- Лаб. №4: розподілений кеш ----------------

    it('GET /hotels/:id — перший запит MISS, повторний HIT', async () => {
        const first = await request(app.getHttpServer()).get(`/hotels/${hotelId}`).expect(200);
        expectCache(first, 'MISS');
        expect(first.headers['x-cache-key']).toBe(`booking:hotel:${hotelId}`);

        const second = await request(app.getHttpServer()).get(`/hotels/${hotelId}`).expect(200);
        expectCache(second, 'HIT');
        expect(second.body).toEqual(first.body);
        expect(second.body.rooms).toHaveLength(1);
    });

    it('PATCH /hotels/:id — інвалідація: наступне читання MISS зі свіжими даними', async () => {
        await request(app.getHttpServer())
            .patch(`/hotels/${hotelId}`)
            .send({ name: 'E2E Test Hotel (renamed)' })
            .expect(200);

        const res = await request(app.getHttpServer()).get(`/hotels/${hotelId}`).expect(200);
        expectCache(res, 'MISS');
        expect(res.body.name).toBe('E2E Test Hotel (renamed)');
    });

    it('GET /rooms/search — MISS, потім HIT для тих самих параметрів', async () => {
        const first = await request(app.getHttpServer()).get('/rooms/search').query(searchQuery).expect(200);
        expectCache(first, 'MISS');
        expect(first.body.map((r: { id: string }) => r.id)).toContain(roomId);

        // Ті самі параметри в іншому порядку і регістрі → той самий ключ
        const second = await request(app.getHttpServer())
            .get('/rooms/search')
            .query({ guests: 2, checkOut: '2027-01-04', checkIn: '2027-01-01', city: 'kyiv' })
            .expect(200);
        expect(second.headers['x-cache-key']).toBe(first.headers['x-cache-key']);
        expectCache(second, 'HIT');
    });

    it('POST /guests — registers a guest', async () => {
        const res = await request(app.getHttpServer())
            .post('/guests')
            .send({ fullName: 'E2E Guest', email: `e2e-${Date.now()}@test.com` })
            .expect(201);

        expect(res.body.id).toBeDefined();
        guestId = res.body.id;
    });

    it('POST /bookings — creates a booking with correct totalPrice', async () => {
        const res = await request(app.getHttpServer())
            .post('/bookings')
            .send({
                roomId,
                guestId,
                checkInDate: '2027-01-01',
                checkOutDate: '2027-01-04',
            })
            .expect(201);

        expect(res.body.totalPrice).toBe('3000'); // 3 ночі * 1000
        bookingId = res.body.id;
    });

    it('GET /rooms/search після бронювання — MISS, заброньований номер зник із результатів', async () => {
        const res = await request(app.getHttpServer()).get('/rooms/search').query(searchQuery).expect(200);
        expectCache(res, 'MISS');
        expect(res.body.map((r: { id: string }) => r.id)).not.toContain(roomId);
    });

    it('POST /bookings — rejects overlapping dates with 409', async () => {
        await request(app.getHttpServer())
            .post('/bookings')
            .send({
                roomId,
                guestId,
                checkInDate: '2027-01-02',
                checkOutDate: '2027-01-05',
            })
            .expect(409);
    });

    it('PATCH /bookings/:id/cancel — cancels the booking', async () => {
        const res = await request(app.getHttpServer())
            .patch(`/bookings/${bookingId}/cancel`)
            .expect(200);

        expect(res.body.status).toBe('CANCELLED');
    });

    it('PATCH /bookings/:id/cancel — rejects double cancellation with 409', async () => {
        await request(app.getHttpServer())
            .patch(`/bookings/${bookingId}/cancel`)
            .expect(409);
    });

    it('every response includes X-Instance-ID header', async () => {
        const res = await request(app.getHttpServer()).get('/hotels').expect(200);
        expect(res.headers['x-instance-id']).toBeDefined();
    });
});