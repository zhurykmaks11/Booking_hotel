import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Consistency } from '../database/db-router.service';
import { ShardRouter } from '../sharding/shard-router.service';
import { bucketOf } from '../sharding/shard-key';
import { CacheService } from '../cache/cache.service';
import { CacheKeys, CacheTtl } from '../cache/cache-keys';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SearchRoomDto } from './dto/search-room.dto';
import { BookingStatus, PrismaClient } from '@prisma/client';

@Injectable()
export class RoomsService {
    constructor(
        private readonly shards: ShardRouter,
        private readonly cache: CacheService,
    ) {}

    /** Скидає кеш, на який впливає зміна номерів: картки готелів і всі результати пошуку. */
    private async invalidateForRooms(...hotelIds: string[]) {
        const unique = [...new Set(hotelIds.filter(Boolean))];
        await this.cache.invalidate(...unique.map((id) => CacheKeys.hotel(id)));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
    }

    async create(createRoomDto: CreateRoomDto) {
        // Лаб. №7: номер живе на шарді свого готелю (co-location агрегату), тож перевірки
        // існування готелю й унікальності (hotelId, roomNumber) — локальні для одного шарду.
        const shard = this.shards.forKey(createRoomDto.hotelId);

        // Перевірки перед записом — STRONG (Primary): готель міг бути створений щойно
        const hotel = await shard.read(
            (db) => db.hotel.findUnique({ where: { id: createRoomDto.hotelId } }),
            Consistency.STRONG,
        );
        if (!hotel) {
            throw new NotFoundException(`Hotel with id ${createRoomDto.hotelId} not found`);
        }

        const existing = await shard.read(
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

        // ID номера в тому ж бакеті, що й готель: GET /rooms/:id маршрутизується без пошуку
        const id = this.shards.childId(createRoomDto.hotelId);
        const room = await shard.write((db) => db.room.create({ data: { id, ...createRoomDto } }));
        await this.invalidateForRooms(room.hotelId);
        return room;
    }

    /** Публічний каталог номерів: Cross-Shard fan-out (готель підтягується локально на кожному шарді). */
    findAll() {
        return this.shards.fanOutList((db) => db.room.findMany({ include: { hotel: true } }), { allowPartial: true });
    }

    async findOne(id: string, consistency = Consistency.EVENTUAL) {
        const room = await this.shards.forKey(id).read(
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
     *
     * Лаб. №7: пошук за містом не містить ключа шардингу (hotelId), тому це Cross-Shard
     * fan-out: той самий запит паралельно на всіх шардах, результати зливаються.
     * Виняток — стратегія city: усі готелі міста на одному шарді (Query Locality), запит локальний.
     */
    async search(dto: SearchRoomDto, consistency = Consistency.EVENTUAL) {
        const checkIn = new Date(dto.checkIn);
        const checkOut = new Date(dto.checkOut);

        const query = (db: PrismaClient) =>
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
            });

        const local = dto.city ? this.shards.shardForCity(dto.city) : null;
        if (local) return local.read(query, consistency);
        return this.shards.fanOutList(query, { allowPartial: true, consistency });
    }

    async update(id: string, updateRoomDto: UpdateRoomDto) {
        // Ключ шардингу незмінний: номер не може «переїхати» в готель з іншого бакета —
        // його бронювання опинилися б не на тому шарді. Такий перенос = новий номер + міграція.
        if (updateRoomDto.hotelId && bucketOf(updateRoomDto.hotelId) !== bucketOf(id)) {
            throw new BadRequestException('Room cannot be moved to a hotel in another shard bucket');
        }
        const before = await this.findOne(id, Consistency.STRONG);
        const room = await this.shards.forKey(id).write((db) =>
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
        const room = await this.shards.forKey(id).write((db) => db.room.delete({ where: { id } }));
        await this.invalidateForRooms(room.hotelId);
        return room;
    }
}