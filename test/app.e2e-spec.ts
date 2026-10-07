import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Hotel Booking API (e2e)', () => {
    let app: INestApplication;
    let prisma: PrismaService;

    let hotelId: string;
    let roomId: string;
    let guestId: string;
    let bookingId: string;

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