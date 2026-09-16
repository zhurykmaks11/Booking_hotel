import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { BookingStatus, Prisma } from '@prisma/client';

@Injectable()
export class BookingsService {
    constructor(private readonly prisma: PrismaService) {}

    async create(dto: CreateBookingDto) {
        const checkIn = new Date(dto.checkInDate);
        const checkOut = new Date(dto.checkOutDate);

        if (checkOut <= checkIn) {
            throw new BadRequestException('checkOutDate must be after checkInDate');
        }

        const guest = await this.prisma.guest.findUnique({ where: { id: dto.guestId } });
        if (!guest) {
            throw new NotFoundException(`Guest with id ${dto.guestId} not found`);
        }

        /**
         * КРИТИЧНА ЗОНА (Bottleneck Analysis, п.2.5):
         * Перевірка доступності номера і створення бронювання виконуються
         * в одній транзакції з рівнем ізоляції Serializable, щоб уникнути
         * race condition при паралельних запитах на один і той самий номер.
         * Без цього між SELECT (перевірка) і INSERT (створення) є вікно,
         * у яке може "проскочити" паралельний запит — обидва запити побачать
         * номер вільним і обидва створять бронювання на ті самі дати.
         */
        return this.prisma.$transaction(
            async (tx) => {
                const room = await tx.room.findUnique({ where: { id: dto.roomId } });
                if (!room) {
                    throw new NotFoundException(`Room with id ${dto.roomId} not found`);
                }

                const overlapping = await tx.booking.findFirst({
                    where: {
                        roomId: dto.roomId,
                        status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
                        checkInDate: { lt: checkOut },
                        checkOutDate: { gt: checkIn },
                    },
                });

                if (overlapping) {
                    throw new ConflictException(
                        `Room is already booked for the selected dates`,
                    );
                }

                const nights = Math.ceil(
                    (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24),
                );
                const totalPrice = Number(room.pricePerNight) * nights;

                return tx.booking.create({
                    data: {
                        roomId: dto.roomId,
                        guestId: dto.guestId,
                        checkInDate: checkIn,
                        checkOutDate: checkOut,
                        totalPrice,
                        status: BookingStatus.PENDING,
                    },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    findAll() {
        return this.prisma.booking.findMany({
            include: { room: { include: { hotel: true } }, guest: true },
        });
    }

    async findOne(id: string) {
        const booking = await this.prisma.booking.findUnique({
            where: { id },
            include: { room: { include: { hotel: true } }, guest: true },
        });
        if (!booking) {
            throw new NotFoundException(`Booking with id ${id} not found`);
        }
        return booking;
    }

    async update(id: string, dto: UpdateBookingDto) {
        await this.findOne(id);
        return this.prisma.booking.update({ where: { id }, data: dto });
    }

    async remove(id: string) {
        await this.findOne(id);
        return this.prisma.booking.delete({ where: { id } });
    }

    // Endpoint #8: скасування бронювання
    async cancel(id: string) {
        const booking = await this.findOne(id);
        if (booking.status === BookingStatus.CANCELLED) {
            throw new ConflictException('Booking is already cancelled');
        }
        if (booking.status === BookingStatus.COMPLETED) {
            throw new ConflictException('Cannot cancel a completed booking');
        }
        return this.prisma.booking.update({
            where: { id },
            data: { status: BookingStatus.CANCELLED },
        });
    }
}