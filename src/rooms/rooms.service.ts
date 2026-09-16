import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SearchRoomDto } from './dto/search-room.dto';
import { BookingStatus } from '@prisma/client';

@Injectable()
export class RoomsService {
    constructor(private readonly prisma: PrismaService) {}

    async create(createRoomDto: CreateRoomDto) {
        const hotel = await this.prisma.hotel.findUnique({
            where: { id: createRoomDto.hotelId },
        });
        if (!hotel) {
            throw new NotFoundException(`Hotel with id ${createRoomDto.hotelId} not found`);
        }

        const existing = await this.prisma.room.findUnique({
            where: {
                hotelId_roomNumber: {
                    hotelId: createRoomDto.hotelId,
                    roomNumber: createRoomDto.roomNumber,
                },
            },
        });
        if (existing) {
            throw new ConflictException(
                `Room ${createRoomDto.roomNumber} already exists in this hotel`,
            );
        }

        return this.prisma.room.create({ data: createRoomDto });
    }

    findAll() {
        return this.prisma.room.findMany({ include: { hotel: true } });
    }

    async findOne(id: string) {
        const room = await this.prisma.room.findUnique({
            where: { id },
            include: { hotel: true },
        });
        if (!room) {
            throw new NotFoundException(`Room with id ${id} not found`);
        }
        return room;
    }

    // Endpoint #4: пошук вільних номерів за критеріями
    async search(dto: SearchRoomDto) {
        const checkIn = new Date(dto.checkIn);
        const checkOut = new Date(dto.checkOut);

        return this.prisma.room.findMany({
            where: {
                capacity: dto.guests ? { gte: dto.guests } : undefined,
                hotel: dto.city ? { city: dto.city } : undefined,
                bookings: {
                    none: {
                        status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
                        AND: [
                            { checkInDate: { lt: checkOut } },
                            { checkOutDate: { gt: checkIn } },
                        ],
                    },
                },
            },
            include: { hotel: true },
        });
    }

    async update(id: string, updateRoomDto: UpdateRoomDto) {
        await this.findOne(id);
        return this.prisma.room.update({
            where: { id },
            data: updateRoomDto,
        });
    }

    async remove(id: string) {
        await this.findOne(id);
        return this.prisma.room.delete({ where: { id } });
    }
}