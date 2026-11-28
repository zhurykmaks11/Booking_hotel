import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Consistency } from '../database/db-router.service';
import { ShardRouter } from '../sharding/shard-router.service';
import { CacheService } from '../cache/cache.service';
import { CacheKeys, CacheTtl } from '../cache/cache-keys';
import { ResilientCacheService } from '../resilience/resilient-cache.service';
import { ResilienceConfigService } from '../resilience/resilience-config.service';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';

const ACTIVE = Prisma.sql`('PENDING', 'CONFIRMED', 'COMPLETED')`;

export interface HotelStatsRow {
    hotelId: string | null;
    name: string;
    city: string;
    rating: number;
    rooms: number;
    avgPrice: number;
    bookings: number;
    active: number;
    cancelled: number;
    upcoming: number;
    revenue: number;
}

@Injectable()
export class HotelsService {
    constructor(
        private readonly shards: ShardRouter,
        private readonly cache: CacheService,
        private readonly resilientCache: ResilientCacheService,
        private readonly resilience: ResilienceConfigService,
    ) {}

    /**
     * Лаб. №7: ID готелю генерує застосунок — у ньому закодовано бакет (див. shard-key.ts),
     * тому готель одразу пишеться на свій шард, а всі подальші запити знаходять його за ID.
     */
    create(createHotelDto: CreateHotelDto) {
        // Новий готель ще не має номерів, тому на результати пошуку не впливає.
        const id = this.shards.newHotelId(createHotelDto.city);
        return this.shards.forKey(id).write((db) => db.hotel.create({ data: { id, ...createHotelDto } }));
    }

    /**
     * Публічний каталог готелів: Cross-Shard fan-out (готелі розкидані по шардах).
     * Недоступний шард не ламає каталог — повертаються готелі решти шардів (X-Shard-Partial).
     */
    findAll() {
        return this.shards.fanOutList((db) => db.hotel.findMany(), { allowPartial: true });
    }

    /**
     * Читання напряму з БД (loader для кешу і перевірка існування перед записом).
     * Перед записом — STRONG: на Replica щойно створений готель може ще не з'явитися.
     */
    async findOne(id: string, consistency = Consistency.EVENTUAL) {
        // Shard-Local: готель і його номери лежать на одному шарді — include (JOIN) працює локально
        const hotel = await this.shards.forKey(id).read(
            (db) => db.hotel.findUnique({ where: { id }, include: { rooms: true } }),
            consistency,
        );
        if (!hotel) {
            throw new NotFoundException(`Hotel with id ${id} not found`);
        }
        return hotel;
    }

    /**
     * GET /hotels/:id через кеш (Cache-Aside). Повертає дані і джерело (HIT / MISS / BYPASS / ...).
     * Кеш заповнюється з Primary (інакше застаріла копія з Replica жила б увесь TTL;
     * у Read-Only Mode — з Replica, бо записів немає і вона актуальна),
     * а без Redis — eventual-читання з Replica.
     * Лаб. №8: кеш із захистом від Stampede, а «не знайдено» кешується (Negative Caching) —
     * запити до неіснуючих id не пробивають кеш до СУБД.
     */
    findOneCached(id: string) {
        return this.resilientCache.getOrLoad(
            CacheKeys.hotel(id),
            CacheTtl.hotel,
            () => this.findOrNull(id, Consistency.PRIMARY_PREFERRED),
            () => this.findOrNull(id),
        );
    }

    /**
     * Лаб. №8, п. 2.1: агрегована статистика готелю — номери, бронювання за статусами, виручка,
     * майбутні заїзди. Читається на кожному відкритті картки готелю (популярний ресурс), а сам запит
     * агрегує всі бронювання всіх номерів готелю (коштовний). Один SQL-запит на шарді готелю.
     *
     * statsQueryCostMs моделює «важку» аналітику на великому обсязі даних: pg_sleep виконується
     * в тому самому запиті (CTE MATERIALIZED стоїть першим у LEFT JOIN, тому виконується завжди,
     * навіть для неіснуючого id). Маркер stats_cost — щоб знайти запит у pg_stat_statements.
     */
    async stats(id: string, consistency = Consistency.PRIMARY_PREFERRED) {
        const costSec = Math.max(0, this.resilience.current.statsQueryCostMs) / 1000;
        const [row] = await this.shards.forKey(id).read(
            (db) => db.$queryRaw<HotelStatsRow[]>`
                WITH stats_cost AS MATERIALIZED (SELECT pg_sleep(${costSec}::float8))
                SELECT h.id AS "hotelId", h.name, h.city, h.rating::float8 AS rating,
                       COALESCE(rs.rooms, 0) AS rooms, COALESCE(rs."avgPrice", 0) AS "avgPrice",
                       COALESCE(bs.bookings, 0) AS bookings, COALESCE(bs.active, 0) AS active,
                       COALESCE(bs.cancelled, 0) AS cancelled, COALESCE(bs.upcoming, 0) AS upcoming,
                       COALESCE(bs.revenue, 0) AS revenue
                FROM stats_cost
                LEFT JOIN hotels h ON h.id = ${id}
                LEFT JOIN LATERAL (
                    SELECT COUNT(*)::int AS rooms, AVG(r."pricePerNight")::float8 AS "avgPrice"
                    FROM rooms r WHERE r."hotelId" = h.id
                ) rs ON true
                LEFT JOIN LATERAL (
                    SELECT COUNT(*)::int AS bookings,
                           COUNT(*) FILTER (WHERE b.status IN ${ACTIVE})::int AS active,
                           COUNT(*) FILTER (WHERE b.status = 'CANCELLED')::int AS cancelled,
                           COUNT(*) FILTER (WHERE b.status IN ${ACTIVE} AND b."checkInDate" > now())::int AS upcoming,
                           COALESCE(SUM(b."totalPrice") FILTER (WHERE b.status IN ${ACTIVE}), 0)::float8 AS revenue
                    FROM bookings b JOIN rooms r ON r.id = b."roomId"
                    WHERE r."hotelId" = h.id
                ) bs ON true`,
            consistency,
        );
        if (!row || row.hotelId === null) return null;
        return { ...row, calculatedAt: new Date().toISOString() };
    }

    /** GET /hotels/:id/stats через кеш із захистом (Лаб. №8). TTL = statsTtlSec ± statsJitterSec. */
    statsCached(id: string) {
        const cfg = this.resilience.current;
        return this.resilientCache.getOrLoad(
            CacheKeys.hotelStats(id),
            { base: cfg.statsTtlSec, jitter: cfg.statsJitterSec },
            () => this.stats(id),
            () => this.stats(id, Consistency.EVENTUAL),
        );
    }

    private findOrNull(id: string, consistency?: Consistency) {
        return this.findOne(id, consistency).catch((err: unknown) => {
            if (err instanceof NotFoundException) return null;
            throw err;
        });
    }

    async update(id: string, updateHotelDto: UpdateHotelDto) {
        await this.findOne(id, Consistency.STRONG);
        const hotel = await this.shards.forKey(id).write((db) =>
            db.hotel.update({
                where: { id },
                data: updateHotelDto,
            }),
        );
        // Інвалідація після успішного запису: картка готелю, статистика + пошук (могло змінитися місто).
        await this.cache.invalidate(CacheKeys.hotel(id), CacheKeys.hotelStats(id));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
        return hotel;
    }

    async remove(id: string) {
        await this.findOne(id, Consistency.STRONG);
        const hotel = await this.shards.forKey(id).write((db) => db.hotel.delete({ where: { id } }));
        await this.cache.invalidate(CacheKeys.hotel(id), CacheKeys.hotelStats(id));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
        return hotel;
    }
}
