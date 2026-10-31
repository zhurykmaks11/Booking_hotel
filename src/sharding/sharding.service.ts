import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ShardRouter } from './shard-router.service';
import { ringBalance, simulateResharding } from './resharding';

const ACTIVE = Prisma.sql`('PENDING', 'CONFIRMED', 'COMPLETED')`;

/**
 * Діагностика і аналітика шардованого кластера (Лаб. №7, п. 2.3–2.5).
 * Запити йдуть через ShardRouter: Shard-Local — на один шард, Cross-Shard — fan-out на всі.
 */
@Injectable()
export class ShardingService {
    constructor(private readonly router: ShardRouter) {}

    async status() {
        await this.router.checkHealth();
        return { ...this.router.getState(), timestamp: new Date().toISOString() };
    }

    route(id: string) {
        return this.router.describe(id);
    }

    /**
     * Dataset Distribution Matrix: записи і частка даних на кожному шарді, частка Write Operations
     * (лічильники PostgreSQL n_tup_ins + n_tup_upd + n_tup_del — незалежні від інстансу API),
     * кількість зайнятих бакетів і розклад готелів за містами.
     */
    async distribution() {
        const { parts, failed } = await this.router.fanOut(
            async (db) => {
                const [hotels, rooms, bookings, [stat], [usage], cities] = await Promise.all([
                    db.hotel.count(),
                    db.room.count(),
                    db.booking.count(),
                    db.$queryRaw<{ writes: number }[]>`
                        SELECT COALESCE(SUM(n_tup_ins + n_tup_upd + n_tup_del), 0)::float8 AS writes
                        FROM pg_stat_user_tables WHERE relname IN ('hotels', 'rooms', 'bookings')`,
                    db.$queryRaw<{ buckets: number }[]>`
                        SELECT COUNT(DISTINCT substr(id, 1, 2))::int AS buckets FROM hotels`,
                    db.hotel.groupBy({ by: ['city'], _count: { _all: true } }),
                ]);
                return {
                    hotels,
                    rooms,
                    bookings,
                    records: hotels + rooms + bookings,
                    writeOps: stat.writes,
                    usedBuckets: usage.buckets,
                    hotelsByCity: Object.fromEntries(cities.map((c) => [c.city, c._count._all])),
                };
            },
            { allowPartial: true },
        );

        const totalRecords = sum(parts.map((p) => p.result.records));
        const totalWrites = sum(parts.map((p) => p.result.writeOps));
        return {
            strategy: this.router.strategy,
            shards: parts.map(({ shard, result }) => ({
                shard,
                ...result,
                dataPercent: pct(result.records, totalRecords),
                writePercent: pct(result.writeOps, totalWrites),
            })),
            totals: { records: totalRecords, writeOps: totalWrites },
            unavailable: failed,
        };
    }

    /**
     * Shard-Local аналітика: статистика одного готелю. Весь агрегат на одному шарді,
     * тому це один SQL-запит з JOIN на одному вузлі.
     */
    async hotelStats(id: string) {
        const t0 = performance.now();
        const shard = this.router.forKey(id);
        const [row] = await shard.read(
            (db) => db.$queryRaw<{ hotelId: string | null; city: string | null; rooms: number; bookings: number; revenue: number }[]>`
                SELECT h.id AS "hotelId", h.city,
                       COUNT(DISTINCT r.id)::int AS rooms,
                       COUNT(b.id)::int AS bookings,
                       COALESCE(SUM(b."totalPrice") FILTER (WHERE b.status IN ${ACTIVE}), 0)::float8 AS revenue
                FROM hotels h
                LEFT JOIN rooms r ON r."hotelId" = h.id
                LEFT JOIN bookings b ON b."roomId" = r.id
                WHERE h.id = ${id}
                GROUP BY h.id`,
        );
        if (!row) throw new NotFoundException(`Hotel with id ${id} not found`);
        return { ...row, mode: 'shard-local', shards: [shard.name], totalMs: round(performance.now() - t0) };
    }

    /**
     * Cross-Shard аналітика (Scatter-Gather): виручка і бронювання за містами.
     * Кожен шард рахує часткові агрегати (GROUP BY city) — по мережі йдуть лише підсумки,
     * а не сирі рядки; координатор (API) підсумовує їх. COUNT і SUM адитивні, бо кожен готель
     * лежить рівно на одному шарді; для AVG чи COUNT DISTINCT по всіх шардах так робити не можна.
     */
    async cityAnalytics() {
        const { parts, failed, totalMs } = await this.router.fanOut(
            (db) =>
                db.$queryRaw<{ city: string; hotels: number; bookings: number; revenue: number }[]>`
                    SELECT h.city,
                           COUNT(DISTINCT h.id)::int AS hotels,
                           COUNT(b.id)::int AS bookings,
                           COALESCE(SUM(b."totalPrice") FILTER (WHERE b.status IN ${ACTIVE}), 0)::float8 AS revenue
                    FROM hotels h
                    LEFT JOIN rooms r ON r."hotelId" = h.id
                    LEFT JOIN bookings b ON b."roomId" = r.id
                    GROUP BY h.city`,
            { allowPartial: true },
        );

        const merged = new Map<string, { city: string; hotels: number; bookings: number; revenue: number }>();
        for (const part of parts) {
            for (const row of part.result) {
                const acc = merged.get(row.city) ?? { city: row.city, hotels: 0, bookings: 0, revenue: 0 };
                acc.hotels += row.hotels;
                acc.bookings += row.bookings;
                acc.revenue += row.revenue;
                merged.set(row.city, acc);
            }
        }
        return {
            mode: 'cross-shard fan-out',
            cities: [...merged.values()].sort((a, b) => b.revenue - a.revenue),
            shards: parts.map((p) => ({ shard: p.shard, ms: p.ms, rows: p.result.length })),
            partial: failed.length > 0,
            unavailable: failed,
            totalMs,
        };
    }

    /** Модель решардингу: скільки ключів переїжджає при N → M для modulo / virtual buckets / consistent hashing. */
    resharding(keys = 100_000) {
        const keyCount = Math.min(Math.max(keys, 1_000), 500_000);
        return {
            keys: keyCount,
            transitions: simulateResharding(undefined, keyCount),
            ringBalance: ringBalance(4, keyCount),
        };
    }
}

function sum(values: number[]) {
    return values.reduce((acc, v) => acc + v, 0);
}

function pct(part: number, total: number) {
    return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function round(ms: number) {
    return Math.round(ms * 10) / 10;
}
