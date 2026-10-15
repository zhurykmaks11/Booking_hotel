import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';

/** Джерело даних для відповіді — повертається клієнту в заголовку X-Cache. */
export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

export interface CacheResult<T> {
    data: T;
    cache: CacheStatus;
    key: string;
}

export interface CacheStats {
    redis: 'CONNECTED' | 'DISCONNECTED' | 'DISABLED';
    hits: number;
    misses: number;
    bypasses: number;
    invalidations: number;
}

/**
 * Розподілений кеш на Redis (Лаб. №4).
 *
 * Один Redis спільний для всіх інстансів API, тому інвалідація, зроблена на api-1,
 * одразу діє для api-2 та api-3.
 *
 * Відмовостійкість (п. 2.6.3): будь-яка помилка Redis перетворюється на звичайне
 * звернення до БД (BYPASS) — клієнт ніколи не отримує 500 через кеш.
 *  - enableOfflineQueue: false — поки Redis недоступний, команди одразу падають,
 *    а не накопичуються в черзі;
 *  - commandTimeout / connectTimeout — короткі тайм-аути, щоб «зависання» Redis
 *    не додавало затримку до відповіді;
 *  - retryStrategy — клієнт сам перепідключається, коли Redis повертається.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('Cache');
    private client: Redis | null = null;
    private lastErrorLogAt = 0;

    private readonly stats = { hits: 0, misses: 0, bypasses: 0, invalidations: 0 };

    constructor() {
        const url = process.env.REDIS_URL;
        if (!url) {
            this.logger.warn('REDIS_URL не задано — кешування вимкнено, усі запити йдуть у БД');
            return;
        }

        this.client = new Redis(url, {
            connectTimeout: 1000,
            commandTimeout: 300,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            retryStrategy: (times: number) => Math.min(times * 200, 2000),
        });

        this.client.on('ready', () => this.logger.log(`Redis підключено (${url})`));
        this.client.on('error', (err: Error) => this.logRedisError('з\'єднання', err));
    }

    async onModuleInit() {
        // Коротко чекаємо на підключення, щоб перші запити після старту вже йшли через кеш.
        // Якщо Redis недоступний — застосунок стартує все одно (graceful degradation).
        await this.whenReady(1000);
    }

    async onModuleDestroy() {
        this.client?.disconnect();
    }

    get isReady(): boolean {
        return this.client?.status === 'ready';
    }

    /** Чекає на підключення до Redis не довше timeoutMs. Ніколи не кидає помилку. */
    whenReady(timeoutMs: number): Promise<boolean> {
        const client = this.client;
        if (!client) return Promise.resolve(false);
        if (client.status === 'ready') return Promise.resolve(true);

        return new Promise((resolve) => {
            const onReady = () => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                client.off('ready', onReady);
                resolve(false);
            }, timeoutMs);
            client.once('ready', onReady);
        });
    }

    /**
     * Паттерн Cache-Aside (п. 2.3):
     *  1. шукаємо ключ у Redis;
     *  2. HIT  — повертаємо збережений об'єкт, БД не чіпаємо;
     *  3. MISS — читаємо з БД (loader), кладемо в Redis з TTL і повертаємо.
     * Якщо Redis недоступний — BYPASS: просто читаємо з БД.
     */
    async getOrSet<T>(
        key: string,
        ttl: { base: number; jitter: number },
        loader: () => Promise<T>,
    ): Promise<CacheResult<T>> {
        if (!this.client || !this.isReady) {
            return this.bypass(key, loader);
        }

        let cached: string | null;
        try {
            cached = await this.client.get(key);
        } catch (err) {
            this.logRedisError('GET', err as Error);
            return this.bypass(key, loader);
        }

        if (cached !== null) {
            this.stats.hits++;
            this.logger.log(`HIT ${key}`);
            return { data: JSON.parse(cached) as T, cache: 'HIT', key };
        }

        const data = await loader();
        this.stats.misses++;
        const ttlSec = ttl.base + Math.floor(Math.random() * (ttl.jitter + 1));

        try {
            await this.client.set(key, JSON.stringify(data), 'EX', ttlSec);
            this.logger.log(`MISS ${key} → збережено на ${ttlSec}s`);
        } catch (err) {
            this.logRedisError('SET', err as Error);
        }

        return { data, cache: 'MISS', key };
    }

    /** Поточна версія («покоління») для групи ключів; 0, якщо ключа ще немає або Redis недоступний. */
    async getVersion(key: string): Promise<number> {
        if (!this.client || !this.isReady) return 0;
        try {
            return Number(await this.client.get(key)) || 0;
        } catch (err) {
            this.logRedisError('GET', err as Error);
            return 0;
        }
    }

    /** Інвалідація конкретних ключів (п. 2.5). */
    async invalidate(...keys: string[]): Promise<void> {
        if (!this.client || !this.isReady || keys.length === 0) return;
        try {
            await this.client.del(...keys);
            this.stats.invalidations += keys.length;
            this.logger.log(`INVALIDATE ${keys.join(', ')}`);
        } catch (err) {
            this.logRedisError('DEL', err as Error);
        }
    }

    /**
     * Інвалідація цілої групи ключів через збільшення версії: усі ключі зі старою
     * версією більше ніколи не читаються, а Redis прибере їх за TTL. Не потрібно
     * перебирати ключі через KEYS/SCAN, тому операція O(1).
     */
    async bumpVersion(key: string): Promise<void> {
        if (!this.client || !this.isReady) return;
        try {
            const version = await this.client.incr(key);
            this.stats.invalidations++;
            this.logger.log(`INVALIDATE ${key} → v${version}`);
        } catch (err) {
            this.logRedisError('INCR', err as Error);
        }
    }

    getStats(): CacheStats {
        let redis: CacheStats['redis'] = 'DISABLED';
        if (this.client) redis = this.isReady ? 'CONNECTED' : 'DISCONNECTED';
        return { redis, ...this.stats };
    }

    private async bypass<T>(key: string, loader: () => Promise<T>): Promise<CacheResult<T>> {
        const data = await loader();
        this.stats.bypasses++;
        this.logger.warn(`BYPASS ${key} (Redis недоступний — читання напряму з БД)`);
        return { data, cache: 'BYPASS', key };
    }

    /** Логуємо помилки Redis не частіше ніж раз на 10 с, щоб не засмічувати лог під час відмови. */
    private logRedisError(operation: string, err: Error) {
        const now = Date.now();
        if (now - this.lastErrorLogAt > 10_000) {
            this.lastErrorLogAt = now;
            this.logger.warn(`Redis ${operation}: ${err.message}`);
        }
    }
}
