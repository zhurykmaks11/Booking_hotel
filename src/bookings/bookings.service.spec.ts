import { Test, TestingModule } from '@nestjs/testing';
import { BookingsService } from './bookings.service';
import { DbRouter } from '../database/db-router.service';
import { ShardRouter } from '../sharding/shard-router.service';
import { CacheService } from '../cache/cache.service';
import { CacheKeys } from '../cache/cache-keys';
import {
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
// @ts-ignore
import { BookingStatus, Prisma } from '@prisma/client';

describe('BookingsService', () => {
    let service: BookingsService;
    let cache: { bumpVersion: jest.Mock; invalidate: jest.Mock };
    let prisma: {
        booking: {
            findFirst: jest.Mock;
            findUnique: jest.Mock;
            findMany: jest.Mock;
            create: jest.Mock;
            update: jest.Mock;
            updateMany: jest.Mock;
            delete: jest.Mock;
        };
        room: {
            findUnique: jest.Mock;
        };
        guest: {
            findUnique: jest.Mock;
            findMany: jest.Mock;
        };
        $transaction: jest.Mock;
    };

    const mockRoom = {
        id: 'room-1',
        hotelId: 'hotel-1',
        roomNumber: '101',
        type: 'DOUBLE',
        pricePerNight: 1500,
        capacity: 2,
        createdAt: new Date(),
    };

    const mockGuest = {
        id: 'guest-1',
        fullName: 'Іван Петренко',
        email: 'ivan@test.com',
        phone: null,
        createdAt: new Date(),
    };

    const mockBooking = {
        id: 'booking-1',
        roomId: 'room-1',
        guestId: 'guest-1',
        checkInDate: new Date('2026-10-01'),
        checkOutDate: new Date('2026-10-05'),
        status: BookingStatus.PENDING,
        totalPrice: 6000,
        createdAt: new Date(),
    };

    beforeEach(async () => {
        const prismaMock = {
            booking: {
                findFirst: jest.fn(),
                findUnique: jest.fn(),
                findMany: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
                updateMany: jest.fn(),
                delete: jest.fn(),
            },
            room: {
                findUnique: jest.fn(),
            },
            guest: {
                findUnique: jest.fn(),
                findMany: jest.fn().mockResolvedValue([]),
            },
            $transaction: jest.fn(),
        };

        // У юніт-тестах обидва «шарди» — той самий мок Prisma; ID на 'other' маршрутизуються на shard-b
        const shard = {
            index: 0,
            name: 'shard-a',
            read: (query: (db: unknown) => unknown) => query(prismaMock),
            write: (mutation: (db: unknown) => unknown) => mutation(prismaMock),
        };
        const otherShard = { ...shard, index: 1, name: 'shard-b' };

        const cacheMock = {
            bumpVersion: jest.fn().mockResolvedValue(undefined),
            invalidate: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BookingsService,
                // Маршрутизатор у юніт-тестах просто віддає мок Prisma (вузол тут не важливий)
                {
                    provide: DbRouter,
                    useValue: {
                        read: (query: (db: unknown) => unknown) => query(prismaMock),
                        write: (mutation: (db: unknown) => unknown) => mutation(prismaMock),
                    },
                },
                {
                    provide: ShardRouter,
                    useValue: {
                        forKey: (id: string) => (id.startsWith('other') ? otherShard : shard),
                        childId: () => 'booking-new',
                        fanOutList: async (query: (db: unknown) => Promise<unknown[]>) => query(prismaMock),
                    },
                },
                { provide: CacheService, useValue: cacheMock },
            ],
        }).compile();

        service = module.get<BookingsService>(BookingsService);
        prisma = prismaMock;
        cache = module.get(CacheService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('create', () => {
        const dto = {
            roomId: 'room-1',
            guestId: 'guest-1',
            checkInDate: '2026-10-01',
            checkOutDate: '2026-10-05',
        };

        it('should create a booking when room is available', async () => {
            prisma.guest.findUnique.mockResolvedValue(mockGuest);

            // Мокуємо $transaction так, щоб він виконував переданий callback
            // з "tx" об'єктом, що імітує поведінку всередині транзакції
            prisma.$transaction.mockImplementation(async (callback) => {
                const tx = {
                    room: { findUnique: jest.fn().mockResolvedValue(mockRoom) },
                    booking: {
                        findFirst: jest.fn().mockResolvedValue(null), // немає конфлікту
                        create: jest.fn().mockResolvedValue(mockBooking),
                    },
                };
                return callback(tx);
            });

            const result = await service.create(dto);

            expect(result).toEqual(mockBooking);
            expect(prisma.guest.findUnique).toHaveBeenCalledWith({
                where: { id: dto.guestId },
            });
            // Нове бронювання змінює доступність — кеш пошуку інвалідовано
            expect(cache.bumpVersion).toHaveBeenCalledWith(CacheKeys.searchVersion);
        });

        it('should throw BadRequestException when checkOutDate is before checkInDate', async () => {
            const invalidDto = {
                ...dto,
                checkInDate: '2026-10-05',
                checkOutDate: '2026-10-01',
            };

            await expect(service.create(invalidDto)).rejects.toThrow(
                BadRequestException,
            );
        });

        it('should throw NotFoundException when guest does not exist', async () => {
            prisma.guest.findUnique.mockResolvedValue(null);

            await expect(service.create(dto)).rejects.toThrow(NotFoundException);
        });

        it('should throw NotFoundException when room does not exist', async () => {
            prisma.guest.findUnique.mockResolvedValue(mockGuest);

            prisma.$transaction.mockImplementation(async (callback) => {
                const tx = {
                    room: { findUnique: jest.fn().mockResolvedValue(null) },
                    booking: { findFirst: jest.fn(), create: jest.fn() },
                };
                return callback(tx);
            });

            await expect(service.create(dto)).rejects.toThrow(NotFoundException);
            // Невдалий запис не повинен скидати кеш
            expect(cache.bumpVersion).not.toHaveBeenCalled();
        });

        it('should throw ConflictException when dates overlap with an existing booking', async () => {
            prisma.guest.findUnique.mockResolvedValue(mockGuest);

            prisma.$transaction.mockImplementation(async (callback) => {
                const tx = {
                    room: { findUnique: jest.fn().mockResolvedValue(mockRoom) },
                    booking: {
                        findFirst: jest.fn().mockResolvedValue(mockBooking), // конфлікт знайдено
                        create: jest.fn(),
                    },
                };
                return callback(tx);
            });

            await expect(service.create(dto)).rejects.toThrow(ConflictException);
        });

        it('should retry a serialization failure (P2034) and then succeed', async () => {
            prisma.guest.findUnique.mockResolvedValue(mockGuest);
            const conflict = new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' });
            prisma.$transaction.mockRejectedValueOnce(conflict).mockImplementation(async (callback) =>
                callback({
                    room: { findUnique: jest.fn().mockResolvedValue(mockRoom) },
                    booking: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(mockBooking) },
                }),
            );

            await expect(service.create(dto)).resolves.toEqual(mockBooking);
            expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        });

        it('should answer 409 (not 500) when serialization conflicts persist', async () => {
            prisma.guest.findUnique.mockResolvedValue(mockGuest);
            prisma.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' }));

            await expect(service.create(dto)).rejects.toThrow(ConflictException);
            expect(prisma.$transaction).toHaveBeenCalledTimes(5);
        });

        it('should calculate totalPrice correctly based on nights and price per night', async () => {
            prisma.guest.findUnique.mockResolvedValue(mockGuest);
            let capturedData: any;

            prisma.$transaction.mockImplementation(async (callback) => {
                const tx = {
                    room: { findUnique: jest.fn().mockResolvedValue(mockRoom) },
                    booking: {
                        findFirst: jest.fn().mockResolvedValue(null),
                        create: jest.fn().mockImplementation(({ data }) => {
                            capturedData = data;
                            return { ...mockBooking, ...data };
                        }),
                    },
                };
                return callback(tx);
            });

            // 4 ночі (01.10 - 05.10) * 1500 = 6000
            await service.create(dto);

            expect(capturedData.totalPrice).toBe(6000);
        });
    });

    describe('findOne', () => {
        it('should return a booking with its guest (application-side join)', async () => {
            prisma.booking.findUnique.mockResolvedValue(mockBooking);
            prisma.guest.findMany.mockResolvedValue([mockGuest]);

            const result = await service.findOne('booking-1');

            expect(result).toEqual({ ...mockBooking, guest: mockGuest });
            expect(prisma.guest.findMany).toHaveBeenCalledWith({ where: { id: { in: ['guest-1'] } } });
        });

        it('should throw NotFoundException when booking does not exist', async () => {
            prisma.booking.findUnique.mockResolvedValue(null);

            await expect(service.findOne('nonexistent-id')).rejects.toThrow(
                NotFoundException,
            );
        });
    });

    describe('cancel', () => {
        it('should cancel a PENDING booking', async () => {
            prisma.booking.findUnique.mockResolvedValue(mockBooking);
            prisma.booking.update.mockResolvedValue({
                ...mockBooking,
                status: BookingStatus.CANCELLED,
            });

            const result = await service.cancel('booking-1');

            expect(result.status).toBe(BookingStatus.CANCELLED);
            expect(prisma.booking.update).toHaveBeenCalledWith({
                where: { id: 'booking-1' },
                data: { status: BookingStatus.CANCELLED },
            });
            expect(cache.bumpVersion).toHaveBeenCalledWith(CacheKeys.searchVersion);
        });

        it('should throw ConflictException when booking is already cancelled', async () => {
            prisma.booking.findUnique.mockResolvedValue({
                ...mockBooking,
                status: BookingStatus.CANCELLED,
            });

            await expect(service.cancel('booking-1')).rejects.toThrow(
                ConflictException,
            );
        });

        it('should throw ConflictException when booking is already completed', async () => {
            prisma.booking.findUnique.mockResolvedValue({
                ...mockBooking,
                status: BookingStatus.COMPLETED,
            });

            await expect(service.cancel('booking-1')).rejects.toThrow(
                ConflictException,
            );
        });

        it('should throw NotFoundException when booking does not exist', async () => {
            prisma.booking.findUnique.mockResolvedValue(null);

            await expect(service.cancel('nonexistent-id')).rejects.toThrow(
                NotFoundException,
            );
        });
    });

    describe('findAll', () => {
        it('should return an array of bookings', async () => {
            prisma.booking.findMany.mockResolvedValue([mockBooking]);

            const result = await service.findAll();

            expect(result).toEqual([{ ...mockBooking, guest: null }]);
            expect(prisma.booking.findMany).toHaveBeenCalled();
        });
    });

    describe('remove', () => {
        it('should delete an existing booking', async () => {
            prisma.booking.findUnique.mockResolvedValue(mockBooking);
            prisma.booking.delete.mockResolvedValue(mockBooking);

            const result = await service.remove('booking-1');

            expect(result).toEqual(mockBooking);
            expect(prisma.booking.delete).toHaveBeenCalledWith({
                where: { id: 'booking-1' },
            });
            expect(cache.bumpVersion).toHaveBeenCalledWith(CacheKeys.searchVersion);
        });

        it('should throw NotFoundException when booking does not exist', async () => {
            prisma.booking.findUnique.mockResolvedValue(null);

            await expect(service.remove('nonexistent-id')).rejects.toThrow(
                NotFoundException,
            );
        });
    });

    describe('relocate (Cross-Shard Write)', () => {
        const txFor = (overlap: unknown = null) => ({
            room: { findUnique: jest.fn().mockResolvedValue(mockRoom) },
            booking: {
                findFirst: jest.fn().mockResolvedValue(overlap),
                create: jest.fn().mockImplementation(({ data }) => ({ ...mockBooking, ...data })),
                update: jest.fn().mockImplementation(({ where, data }) => ({ ...mockBooking, id: where.id, ...data })),
            },
        });

        beforeEach(() => {
            prisma.booking.findUnique.mockResolvedValue(mockBooking);
            prisma.$transaction.mockImplementation(async (callback) => callback(txFor()));
        });

        it('той самий шард → одна локальна ACID-транзакція', async () => {
            const result = await service.relocate('booking-1', { roomId: 'room-2' });

            expect(result.mode).toBe('local-transaction');
            expect(prisma.$transaction).toHaveBeenCalledTimes(1);
            expect(result.previous.status).toBe(BookingStatus.CANCELLED);
        });

        it('різні шарди → Saga: T1 резерв, T2 скасування, T3 підтвердження', async () => {
            prisma.booking.updateMany.mockResolvedValue({ count: 1 });
            prisma.booking.update.mockImplementation(({ data }) => ({ ...mockBooking, id: 'booking-new', ...data }));

            const result = await service.relocate('booking-1', { roomId: 'other-room' });

            expect(result.mode).toBe('saga');
            expect(result.from).toBe('shard-a');
            expect(result.to).toBe('shard-b');
            expect(result.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
            expect(result.booking.status).toBe(mockBooking.status);
        });

        it('збій T2 → компенсація резерву (C1) і 409 зі списком кроків', async () => {
            process.env.SAGA_FAULT_INJECTION = 'true';
            prisma.booking.updateMany.mockResolvedValue({ count: 1 });

            const error = await service.relocate('booking-1', { roomId: 'other-room', simulateFailure: true }).catch((e) => e);
            delete process.env.SAGA_FAULT_INJECTION;

            expect(error.getStatus()).toBe(409);
            const steps = error.getResponse().steps.map((s: { step: string; status: string }) => `${s.step.split(' ')[0]}:${s.status}`);
            expect(steps).toEqual(['T1:done', 'T2:failed', 'C1:compensated']);
            // Компенсація скасовує лише PENDING-резерв (ідемпотентно)
            expect(prisma.booking.updateMany).toHaveBeenCalledWith({
                where: { id: 'booking-new', status: BookingStatus.PENDING },
                data: { status: BookingStatus.CANCELLED },
            });
        });

        it('новий номер зайнятий → сага зупиняється на T1, компенсувати нічого', async () => {
            prisma.$transaction.mockImplementation(async (callback) => callback(txFor(mockBooking)));

            const error = await service.relocate('booking-1', { roomId: 'other-room' }).catch((e) => e);

            expect(error.getStatus()).toBe(409);
            expect(error.getResponse().steps).toHaveLength(1);
            expect(prisma.booking.updateMany).not.toHaveBeenCalled();
        });

        it('скасоване бронювання переселити не можна', async () => {
            prisma.booking.findUnique.mockResolvedValue({ ...mockBooking, status: BookingStatus.CANCELLED });

            await expect(service.relocate('booking-1', { roomId: 'room-2' })).rejects.toThrow(ConflictException);
        });
    });
});
