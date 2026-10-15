import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { CacheKeys, CacheTtl } from '../cache/cache-keys';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SearchRoomDto } from './dto/search-room.dto';
import { BookingStatus } from '@prisma/client';

@Injectable()
export class RoomsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly cache: CacheService,
    ) {}

    /** Скидає кеш, на який впливає зміна номерів: картки готелів і всі результати пошуку. */
    private async invalidateForRooms(...hotelIds: string[]) {
        const unique = [...new Set(hotelIds.filter(Boolean))];
        await this.cache.invalidate(...unique.map((id) => CacheKeys.hotel(id)));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
    }

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

        const room = await this.prisma.room.create({ data: createRoomDto });
        await this.invalidateForRooms(room.hotelId);
        return room;
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

    /**
     * GET /rooms/search через кеш (Cache-Aside).
     * Ключ містить поточну версію пошуку: після будь-якої мутації (бронювання, номери, готелі)
     * версія збільшується, і всі старі результати пошуку автоматично стають недосяжними.
     */
    async searchCached(dto: SearchRoomDto) {
        const version = await this.cache.getVersion(CacheKeys.searchVersion);
        return this.cache.getOrSet(CacheKeys.roomsSearch(version, dto), CacheTtl.roomsSearch, () =>
            this.search(dto),
        );
    }

    // Endpoint #4: пошук вільних номерів за критеріями (читання напряму з БД)
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
        const before = await this.findOne(id);
        const room = await this.prisma.room.update({
            where: { id },
            data: updateRoomDto,
        });
        // Номер міг переїхати в інший готель — скидаємо картки обох готелів.
        await this.invalidateForRooms(before.hotelId, room.hotelId);
        return room;
    }

    async remove(id: string) {
        await this.findOne(id);
        const room = await this.prisma.room.delete({ where: { id } });
        await this.invalidateForRooms(room.hotelId);
        return room;
    }
}