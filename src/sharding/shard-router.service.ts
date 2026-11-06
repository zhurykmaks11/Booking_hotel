import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Consistency, DbRouter, isConnectionError } from '../database/db-router.service';
import { requestContext } from '../database/request-context';
import {
    BUCKETS,
    ShardStrategy,
    bucketForNewHotel,
    bucketOf,
    buildBucketMap,
    fnv1a,
    idInBucket,
    normalizeCity,
    parseStrategy,
    shardName,
} from './shard-key';

/**
 * Один шард з точки зору сервісів: «виконай читання / запис на цьому вузлі».
 * Фізичний шард — окремий PostgreSQL (власний пул Prisma).
 * Без шардингу єдиний шард "global" — це вузол з(Prim Лаб. №6 ary + Replica через DbRouter).
 */
export interface Shard {
    index: number;
    name: string;
    read<T>(query: (db: PrismaClient) => Promise<T>, consistency?: Consistency): Promise<T>;
    write<T>(mutation: (db: PrismaClient) => Promise<T>): Promise<T>;
}

export interface FanOutPart<T> {
    shard: string;
    ms: number;
    result: T;
}

export interface FanOutResult<T> {
    parts: FanOutPart<T>[];
    /** Шарди, що не відповіли (лише при allowPartial) */
    failed: string[];
    totalMs: number;
}

export interface ShardStats {
    reads: number;
    writes: number;
    fanOutQueries: number;
    errors: number;
}

const shortError = (err: unknown) => String((err as Error)?.message ?? err).trim().split('\n').pop()?.trim() ?? '';

/**
 * Shard Router — Application-Level Sharding у Data Access Layer (Лаб. №7, п. 2.2).
 *
 * Детермінований маршрут: ID → bucket (перші 2 hex-символи) → bucket map → шард.
 * Сервіси викликають:
 *   forKey(id).read/write(fn) — Shard-Local операція на шарді, що володіє ключем;
 *   fanOut(fn)                — Cross-Shard запит (Scatter-Gather) паралельно на всіх шардах;
 *   newHotelId(city), childId(parentId) — ID нових об'єктів у потрібному бакеті.
 *
 * SHARD_URLS (через кому) вмикає шардинг: shard-a, shard-b, … у порядку переліку.
 * Не задано — Single Node Topology: усе на вузлі "global" (поведінка Лаб. №6).
 */
@Injectable()
export class ShardRouter implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('ShardRouter');
    readonly sharded: boolean;
    readonly strategy: ShardStrategy;
    readonly shards: Shard[];
    readonly bucketMap: number[];

    private readonly clients: PrismaClient[] = [];
    private readonly health: { healthy: boolean; lastError: string | null }[];
    private readonly stats: ShardStats[];
    private readonly totals = { local: 0, fanOut: 0, partialFanOut: 0 };

    constructor(private readonly global: DbRouter) {
        const urls = (process.env.SHARD_URLS ?? '')
            .split(',')
            .map((url) => url.trim())
            .filter(Boolean);
        this.sharded = urls.length > 0;
        this.strategy = parseStrategy(process.env.SHARD_STRATEGY);

        if (this.sharded) {
            this.shards = urls.map((url, index) => this.physicalShard(index, url));
        } else {
            this.shards = [this.globalShard()];
        }
        this.health = this.shards.map(() => ({ healthy: true, lastError: null }));
        this.stats = this.shards.map(() => ({ reads: 0, writes: 0, fanOutQueries: 0, errors: 0 }));
        this.bucketMap = buildBucketMap(this.shards.length, process.env.SHARD_BUCKET_MAP);
    }

    async onModuleInit() {
        if (!this.sharded) return;
        this.logger.log(`Шардинг увімкнено: ${this.shards.map((s) => s.name).join(', ')}, стратегія "${this.strategy}", ${BUCKETS} бакетів`);
        // Недоступний шард не заважає старту: решта ключового простору продовжує працювати
        await Promise.all(
            this.clients.map((client, index) =>
                client.$connect().catch((err) => this.markDown(index, err)),
            ),
        );
    }

    async onModuleDestroy() {
        await Promise.all(this.clients.map((client) => client.$disconnect()));
    }

    // ------------------------------------------------------------------ Маршрутизація

    /** Шард, якому належить ключ (hotelId, roomId або bookingId — бакет однаковий для всього агрегату). */
    forKey(id: string): Shard {
        const bucket = bucketOf(id);
        const shard = this.shards[this.bucketMap[bucket]];
        this.annotate({ shard: shard.name, bucket });
        return shard;
    }

    /** Де лежить (або буде створено) об'єкт — для GET /sharding/route/:id і демонстрацій. */
    describe(id: string) {
        const bucket = bucketOf(id);
        return { id, bucket, shard: this.shards[this.bucketMap[bucket]].name, strategy: this.strategy };
    }

    /** Шард, де лежать готелі міста, — відомий лише для стратегії city (Query Locality). */
    shardForCity(city: string): Shard | null {
        if (this.strategy !== 'city') return null;
        const bucket = fnv1a(normalizeCity(city)) % BUCKETS;
        return this.shards[this.bucketMap[bucket]];
    }

    /** ID нового готелю: бакет обирається стратегією і записується в сам ID. */
    newHotelId(city: string): string {
        const uuid = randomUUID();
        return idInBucket(bucketForNewHotel(this.strategy, uuid, city), uuid);
    }

    /** ID номера / бронювання — у тому ж бакеті, що й батьківський готель (co-location агрегату). */
    childId(parentId: string): string {
        return idInBucket(bucketOf(parentId));
    }

    /**
     * Cross-Shard запит (Fan-out / Scatter-Gather): паралельно на всіх шардах, результати
     * збирає викликач (merge, сортування, агрегування). Час відповіді ≈ найповільніший шард
     * + накладні витрати на злиття.
     * allowPartial — повернути відповіді живих шардів, якщо якийсь недоступний
     * (каталоги, звіти). Без нього недоступний шард = 503 (перевірки цілісності).
     */
    async fanOut<T>(
        query: (db: PrismaClient, shard: Shard) => Promise<T>,
        options: { allowPartial?: boolean; consistency?: Consistency } = {},
    ): Promise<FanOutResult<T>> {
        const started = performance.now();
        const settled = await Promise.allSettled(
            this.shards.map(async (shard) => {
                const t0 = performance.now();
                const result = await shard.read((db) => query(db, shard), options.consistency);
                this.stats[shard.index].fanOutQueries++;
                return { shard: shard.name, ms: round(performance.now() - t0), result };
            }),
        );

        const parts: FanOutPart<T>[] = [];
        const failed: string[] = [];
        settled.forEach((outcome, index) => {
            if (outcome.status === 'fulfilled') parts.push(outcome.value);
            else {
                if (!options.allowPartial) throw outcome.reason;
                failed.push(this.shards[index].name);
            }
        });

        this.totals.fanOut++;
        if (failed.length) this.totals.partialFanOut++;
        this.annotate({ fanOut: this.shards.length, partial: failed });
        return { parts, failed, totalMs: round(performance.now() - started) };
    }

    /** Fan-out, що повертає один злитий масив (списки). */
    async fanOutList<T>(query: (db: PrismaClient) => Promise<T[]>, options?: { allowPartial?: boolean; consistency?: Consistency }) {
        const { parts } = await this.fanOut(query, options);
        return parts.flatMap((part) => part.result);
    }

    // ------------------------------------------------------------------ Шарди

    private globalShard(): Shard {
        return {
            index: 0,
            name: 'global',
            read: (query, consistency) => {
                this.count(0, 'reads');
                return this.global.read(query, consistency);
            },
            write: (mutation) => {
                this.count(0, 'writes');
                return this.global.write(mutation);
            },
        };
    }

    /** Фізичний шард: один Primary. Обидва типи операцій — на ньому; збій з'єднання → 503 лише для його ключів. */
    private physicalShard(index: number, url: string): Shard {
        const client = new PrismaClient({ datasourceUrl: url });
        this.clients.push(client);
        const name = shardName(index);
        const run = async <T>(fn: (db: PrismaClient) => Promise<T>, kind: 'reads' | 'writes') => {
            try {
                const result = await fn(client);
                this.count(index, kind);
                this.markUp(index);
                return result;
            } catch (err) {
                if (!isConnectionError(err)) throw err;
                this.markDown(index, err);
                throw new ServiceUnavailableException({
                    statusCode: 503,
                    error: 'Shard Unavailable',
                    message: `Шард ${name} недоступний: дані інших шардів продовжують обслуговуватися`,
                    shard: name,
                });
            }
        };
        return {
            index,
            name,
            read: (query) => run(query, 'reads'),
            write: (mutation) => run(mutation, 'writes'),
        };
    }

    // ------------------------------------------------------------------ Стан і діагностика

    private count(index: number, kind: 'reads' | 'writes') {
        this.stats[index][kind]++;
        this.totals.local++;
    }

    private markDown(index: number, err: unknown) {
        const state = this.health[index];
        state.lastError = shortError(err);
        this.stats[index].errors++;
        if (state.healthy) {
            state.healthy = false;
            this.logger.warn(`${this.shards[index].name} НЕДОСТУПНИЙ (${state.lastError})`);
        }
    }

    private markUp(index: number) {
        const state = this.health[index];
        if (!state.healthy) {
            state.healthy = true;
            this.logger.log(`${this.shards[index].name} знову доступний`);
        }
        state.lastError = null;
    }

    /** Активна перевірка шардів (SELECT 1 з тайм-аутом) — для /health і /sharding/status. */
    async checkHealth(timeoutMs = 1500) {
        if (!this.sharded) return this.getHealth();
        await Promise.all(
            this.clients.map(async (client, index) => {
                try {
                    await Promise.race([
                        client.$queryRaw`SELECT 1`,
                        new Promise((_, reject) => setTimeout(() => reject(new Error('health check timeout')), timeoutMs).unref()),
                    ]);
                    this.markUp(index);
                } catch (err) {
                    if (isConnectionError(err)) this.markDown(index, err);
                    else this.health[index].lastError = shortError(err);
                }
            }),
        );
        return this.getHealth();
    }

    getHealth() {
        return this.shards.map((shard) => ({ shard: shard.name, ...this.health[shard.index] }));
    }

    getState() {
        const bucketsPerShard = this.shards.map((shard) => this.bucketMap.filter((s) => s === shard.index).length);
        return {
            topology: this.sharded ? `sharded (${this.shards.length} shards)` : 'single node (global)',
            strategy: this.strategy,
            buckets: BUCKETS,
            shards: this.shards.map((shard) => ({
                name: shard.name,
                buckets: bucketsPerShard[shard.index],
                ...this.health[shard.index],
                stats: this.stats[shard.index],
            })),
            bucketMap: this.bucketMap,
            totals: this.totals,
        };
    }

    /** Заголовки відповіді: куди пішов запит (X-Shard, X-Shard-Bucket, X-Shard-Fanout, X-Shard-Partial). */
    private annotate(info: { shard?: string; bucket?: number; fanOut?: number; partial?: string[] }) {
        const ctx = requestContext.getStore();
        if (!ctx || ctx.res.headersSent) return;
        const res = ctx.res;
        if (info.shard) {
            const current = String(res.getHeader('X-Shard') ?? '');
            const shards = new Set(current ? current.split(',') : []);
            shards.add(info.shard);
            res.setHeader('X-Shard', [...shards].join(','));
            res.setHeader('X-Shard-Bucket', String(info.bucket));
        }
        if (info.fanOut) {
            res.setHeader('X-Shard', this.shards.map((s) => s.name).join(','));
            res.setHeader('X-Shard-Fanout', String(info.fanOut));
            if (info.partial?.length) res.setHeader('X-Shard-Partial', info.partial.join(','));
        }
    }
}

function round(ms: number) {
    return Math.round(ms * 10) / 10;
}
