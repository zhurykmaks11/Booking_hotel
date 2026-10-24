import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Consistency, DbRouter } from '../database/db-router.service';
import { CacheService } from '../cache/cache.service';
import { CacheKeys, CacheTtl } from '../cache/cache-keys';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SearchRoomDto } from './dto/search-room.dto';
import { BookingStatus } from '@prisma/client';

@Injectable()
export class RoomsService {
    constructor(
        private readonly db: DbRouter,
        private readonly cache: CacheService,
    ) {}

    /** Скидає кеш, на який впливає зміна номерів: картки готелів і всі результати пошуку. */
    private async invalidateForRooms(...hotelIds: string[]) {
        const unique = [...new Set(hotelIds.filter(Boolean))];
        await this.cache.invalidate(...unique.map((id) => CacheKeys.hotel(id)));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
    }

    async create(createRoomDto: CreateRoomDto) {
        // Перевірки перед записом — STRONG (Primary): готель міг бути створений щойно
        const hotel = await this.db.read(
            (db) => db.hotel.findUnique({ where: { id: createRoomDto.hotelId } }),
            Consistency.STRONG,
        );
        if (!hotel) {
            throw new NotFoundException(`Hotel with id ${createRoomDto.hotelId} not found`);
        }

        const existing = await this.db.read(
            (db) =>
                db.room.findUnique({
                    where: {
                        hotelId_roomNumber: {
                            hotelId: createRoomDto.hotelId,
                            roomNumber: createRoomDto.roomNumber,
                        },
                    },
                }),
            Consistency.STRONG,
        );
        if (existing) {
            throw new ConflictException(
                `Room ${createRoomDto.roomNumber} already exists in this hotel`,
            );
        }

        const room = await this.db.write((db) => db.room.create({ data: createRoomDto }));
        await this.invalidateForRooms(room.hotelId);
        return room;
    }

    /** Публічний каталог номерів: eventual → Replica. */
    findAll() {
        return this.db.read((db) => db.room.findMany({ include: { hotel: true } }));
    }

    async findOne(id: string, consistency = Consistency.EVENTUAL) {
        const room = await this.db.read(
            (db) => db.room.findUnique({ where: { id }, include: { hotel: true } }),
            consistency,
        );
        if (!room) {
            throw new NotFoundException(`Room with id ${id} not found`);
        }
        return room;
    }

    /**
     * GET /rooms/search через кеш (Cache-Aside).
     * Ключ містить поточну версію пошуку: після будь-якої мутації (бронювання, номери, готелі)
     * версія збільшується, і всі старі результати пошуку автоматично стають недосяжними.
     * Кеш заповнюється з Primary, без Redis — eventual-читання з Replica (див. CacheService.getOrSet).
     */
    async searchCached(dto: SearchRoomDto) {
        const version = await this.cache.getVersion(CacheKeys.searchVersion);
        return this.cache.getOrSet(
            CacheKeys.roomsSearch(version, dto),
            CacheTtl.roomsSearch,
            () => this.search(dto, Consistency.PRIMARY_PREFERRED),
            () => this.search(dto),
        );
    }

    /**
     * Endpoint #4: пошук вільних номерів (читання напряму з БД).
     * Eventual: застарілий результат безпечний — доступність остаточно перевіряється
     * в Serializable-транзакції на Primary під час бронювання (у гіршому разі 409).
     */
    async search(dto: SearchRoomDto, consistency = Consistency.EVENTUAL) {
        const checkIn = new Date(dto.checkIn);
        const checkOut = new Date(dto.checkOut);

        return this.db.read(
            (db) =>
                db.room.findMany({
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
                }),
            consistency,
        );
    }

    async update(id: string, updateRoomDto: UpdateRoomDto) {
        const before = await this.findOne(id, Consistency.STRONG);
        const room = await this.db.write((db) =>
            db.room.update({
                where: { id },
                data: updateRoomDto,
            }),
        );
        // Номер міг переїхати в інший готель — скидаємо картки обох готелів.
        await this.invalidateForRooms(before.hotelId, room.hotelId);
        return room;
    }

    async remove(id: string) {
        await this.findOne(id, Consistency.STRONG);
        const room = await this.db.write((db) => db.room.delete({ where: { id } }));
        await this.invalidateForRooms(room.hotelId);
        return room;
    }
}