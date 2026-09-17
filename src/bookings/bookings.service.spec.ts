import { Test, TestingModule } from '@nestjs/testing';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import {
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { BookingStatus } from '@prisma/client';

describe('BookingsService', () => {
    let service: BookingsService;
    let prisma: {
        booking: {
            findFirst: jest.Mock;
            findUnique: jest.Mock;
            findMany: jest.Mock;
            create: jest.Mock;
            update: jest.Mock;
            delete: jest.Mock;
        };
        room: {
            findUnique: jest.Mock;
        };
        guest: {
            findUnique: jest.Mock;
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
                delete: jest.fn(),
            },
            room: {
                findUnique: jest.fn(),
            },
            guest: {
                findUnique: jest.fn(),
            },
            $transaction: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BookingsService,
                { provide: PrismaService, useValue: prismaMock },
            ],
        }).compile();

        service = module.get<BookingsService>(BookingsService);
        prisma = module.get(PrismaService);
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
        it('should return a booking when it exists', async () => {
            prisma.booking.findUnique.mockResolvedValue(mockBooking);

            const result = await service.findOne('booking-1');

            expect(result).toEqual(mockBooking);
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

            expect(result).toEqual([mockBooking]);
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
        });

        it('should throw NotFoundException when booking does not exist', async () => {
            prisma.booking.findUnique.mockResolvedValue(null);

            await expect(service.remove('nonexistent-id')).rejects.toThrow(
                NotFoundException,
            );
        });
    });
});