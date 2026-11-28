import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Redis } from 'ioredis';
import { CacheService } from '../cache/cache.service';
import { ResilienceConfig, ResilienceConfigService } from './resilience-config.service';

/**
 * Звідки взялася відповідь (заголовок X-Cache):
 *  HIT / MISS / BYPASS — як у Лаб. №4;
 *  COALESCED — приєднався до запиту, який уже виконує цей інстанс (single-flight);
 *  LOCK-WAIT — дочекався значення, яке в кеш поклав власник розподіленого блокування;
 *  STALE     — застаріле значення, оновлення йде у фоні (SWR);
 *  NEGATIVE  — у кеші збережено «не знайдено», БД не зачеплена.
 */
export type ResilientStatus = 'HIT' | 'MISS' | 'BYPASS' | 'COALESCED' | 'LOCK-WAIT' | 'STALE' | 'NEGATIVE';

export interface ResilientResult<T> {
    /** null — сутності не існує (контролер віддає 404). */
    data: T | null;
    cache: ResilientStatus;
    key: string;
}

export interface TtlPolicy {
    base: number;
    jitter: number;
}

/**
 * Значення в Redis: d — дані (null = «не знайдено»), e — «м'який» час завершення (epoch мс).
 * Для SWR ключ у Redis живе довше за e (на swrStaleSec), і між e та фізичним видаленням
 * значення вважається застарілим, але придатним для віддачі.
 */
interface Envelope<T> {
    d: T | null;
    e: number;
}

/** Зняти блокування, лише якщо воно ще НАШЕ (порівняння токена і DEL атомарно в Lua). */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** TTL = base ± jitter (п. 2.5); jitter вимкнено — рівно base. */
export function jitteredTtl(policy: TtlPolicy, jitter: boolean, random = Math.random): number {
    if (!jitter || policy.jitter <= 0) return policy.base;
    const delta = Math.round((random() * 2 - 1) * policy.jitter);
    return Math.max(1, policy.base + delta);
}

/**
 * Кеш із захистом від Cache Stampede / Thundering Herd / Cache Avalanche / Cache Penetration (Лаб. №8).
 * Режим (none / singleflight / lock / swr), jitter і negative caching беруться з ResilienceConfigService
 * на кожен запит, тому перемикаються без перезапуску.
 */
@Injectable()
export class ResilientCacheService {
    private readonly logger = new Logger('ResilientCache');
    /** Single-flight: ключ → запит, що вже виконується в ЦЬОМУ інстансі. */
    private readonly inflight = new Map<string, Promise<ResilientResult<unknown>>>();
    /** Ключі, для яких цей інстанс уже запустив фонове оновлення (SWR). */
    private readonly refreshing = new Set<string>();

    constructor(
        private readonly cache: CacheService,
        private readonly resilience: ResilienceConfigService,
    ) {}

    /**
     * loader читає з БД і повертає null, якщо сутності немає.
     * bypassLoader — читання, коли Redis недоступний (як у CacheService.getOrSet).
     */
    async getOrLoad<T>(
        key: string,
        ttl: TtlPolicy,
        loader: () => Promise<T | null>,
        bypassLoader: () => Promise<T | null> = loader,
    ): Promise<ResilientResult<T>> {
        const cfg = this.resilience.current;
        const redis = this.cache.redis;
        if (!redis) {
            this.resilience.count('bypass');
            return { data: await this.load(bypassLoader), cache: 'BYPASS', key };
        }
        if (cfg.protection === 'none') {
            return this.lookup(redis, key, ttl, loader, cfg);
        }

        // Single-flight: поки перший запит до ключа виконується, решта запитів інстансу чекають його результат
        const running = this.inflight.get(key) as Promise<ResilientResult<T>> | undefined;
        if (running) {
            this.resilience.count('coalesced');
            const shared = await running;
            return { ...shared, cache: shared.cache === 'MISS' ? 'COALESCED' : shared.cache };
        }
        const promise = this.lookup(redis, key, ttl, loader, cfg).finally(() => this.inflight.delete(key));
        this.inflight.set(key, promise);
        return promise;
    }

    /** Примусово «вигасити» ключі (Force Expire, п. 2.2): разом із блокуваннями. */
    async expire(keys: string[]): Promise<number> {
        const redis = this.cache.redis;
        if (!redis || keys.length === 0) return 0;
        return redis.del(...keys, ...keys.map((k) => `${k}:lock`));
    }

    private async lookup<T>(
        redis: Redis,
        key: string,
        ttl: TtlPolicy,
        loader: () => Promise<T | null>,
        cfg: ResilienceConfig,
    ): Promise<ResilientResult<T>> {
        let entry: Envelope<T> | null;
        try {
            entry = await this.read<T>(redis, key);
        } catch (err) {
            this.logger.warn(`Redis GET: ${(err as Error).message}`);
            this.resilience.count('bypass');
            return { data: await this.load(loader), cache: 'BYPASS', key };
        }

        if (entry && entry.e > Date.now()) return this.fresh(entry, key);

        // Застаріле, але ще в Redis (SWR): віддаємо одразу, оновлюємо у фоні
        if (entry && cfg.protection === 'swr') {
            this.resilience.count('staleServed');
            void this.refreshInBackground(redis, key, ttl, loader, cfg);
            return { data: entry.d, cache: entry.d === null ? 'NEGATIVE' : 'STALE', key };
        }

        if (cfg.protection === 'lock' || cfg.protection === 'swr') {
            return this.loadWithLock(redis, key, ttl, loader, cfg);
        }
        this.resilience.count('misses');
        return this.loadAndStore(redis, key, ttl, loader, cfg);
    }

    /**
     * Distributed Lock (SET NX PX): у БД іде лише власник блокування, решта чекають, поки значення
     * з'явиться в кеші. Захист від deadlock — TTL блокування (lockTtlMs): якщо власник впав,
     * Redis сам зніме lock і його отримає наступний. Чекання обмежене lockWaitMs — далі fallback у БД.
     */
    private async loadWithLock<T>(
        redis: Redis,
        key: string,
        ttl: TtlPolicy,
        loader: () => Promise<T | null>,
        cfg: ResilienceConfig,
    ): Promise<ResilientResult<T>> {
        const lockKey = `${key}:lock`;
        const token = randomUUID();
        const deadline = Date.now() + cfg.lockWaitMs;

        for (;;) {
            let acquired: string | null;
            try {
                acquired = await redis.set(lockKey, token, 'PX', cfg.lockTtlMs, 'NX');
            } catch {
                this.resilience.count('bypass');
                return { data: await this.load(loader), cache: 'BYPASS', key };
            }

            if (acquired) {
                this.resilience.count('lockAcquired');
                try {
                    // Double-check: між нашим GET і SET NX значення міг покласти попередній власник
                    const again = await this.read<T>(redis, key).catch(() => null);
                    if (again && again.e > Date.now()) return this.fresh(again, key);
                    this.resilience.count('misses');
                    return await this.loadAndStore(redis, key, ttl, loader, cfg);
                } finally {
                    await redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => undefined);
                }
            }

            // Блокування в іншого запиту (іншого інстансу) — чекаємо значення в кеші
            await sleep(20 + Math.floor(Math.random() * 30));
            const entry = await this.read<T>(redis, key).catch(() => null);
            if (entry && entry.e > Date.now()) {
                this.resilience.count('lockWaits');
                return { data: entry.d, cache: entry.d === null ? 'NEGATIVE' : 'LOCK-WAIT', key };
            }
            if (Date.now() > deadline) {
                // Fail-open: краще одне зайве звернення до БД, ніж помилка клієнту
                this.resilience.count('lockTimeouts');
                this.resilience.count('misses');
                return this.loadAndStore(redis, key, ttl, loader, cfg);
            }
            // Якщо власник зняв lock без значення (помилка БД) — наступна ітерація спробує взяти його самі
        }
    }

    private async refreshInBackground<T>(
        redis: Redis,
        key: string,
        ttl: TtlPolicy,
        loader: () => Promise<T | null>,
        cfg: ResilienceConfig,
    ) {
        if (this.refreshing.has(key)) return;
        this.refreshing.add(key);
        const lockKey = `${key}:lock`;
        const token = randomUUID();
        try {
            // Оновлює лише той, хто взяв блокування; інші інстанси просто віддають застаріле значення
            if (!(await redis.set(lockKey, token, 'PX', cfg.lockTtlMs, 'NX'))) return;
            try {
                // Інший інстанс міг щойно оновити ключ і зняти lock — тоді повторне оновлення зайве
                const current = await this.read<T>(redis, key).catch(() => null);
                if (current && current.e > Date.now()) return;
                this.resilience.count('refreshes');
                await this.loadAndStore(redis, key, ttl, loader, cfg);
            } finally {
                await redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => undefined);
            }
        } catch (err) {
            this.logger.warn(`SWR refresh ${key}: ${(err as Error).message}`);
        } finally {
            this.refreshing.delete(key);
        }
    }

    private async loadAndStore<T>(
        redis: Redis,
        key: string,
        ttl: TtlPolicy,
        loader: () => Promise<T | null>,
        cfg: ResilienceConfig,
    ): Promise<ResilientResult<T>> {
        const data = await this.load(loader);
        if (data === null && !cfg.negativeCache) return { data, cache: 'MISS', key };

        const ttlSec = data === null ? cfg.negativeTtlSec : jitteredTtl(ttl, cfg.jitter);
        // SWR: ключ фізично живе довше на swrStaleSec — це вікно, коли можна віддавати застаріле
        const redisTtl = cfg.protection === 'swr' && data !== null ? ttlSec + cfg.swrStaleSec : ttlSec;
        const envelope: Envelope<T> = { d: data, e: Date.now() + ttlSec * 1000 };
        try {
            await redis.set(key, JSON.stringify(envelope), 'EX', redisTtl);
            if (data === null) this.resilience.count('negativeStored');
        } catch (err) {
            this.logger.warn(`Redis SET: ${(err as Error).message}`);
        }
        return { data, cache: 'MISS', key };
    }

    private async load<T>(loader: () => Promise<T | null>): Promise<T | null> {
        this.resilience.count('dbLoads');
        const data = await loader();
        if (data === null) this.resilience.count('notFound');
        return data;
    }

    private fresh<T>(entry: Envelope<T>, key: string): ResilientResult<T> {
        this.resilience.count(entry.d === null ? 'negativeHits' : 'hits');
        return { data: entry.d, cache: entry.d === null ? 'NEGATIVE' : 'HIT', key };
    }

    private async read<T>(redis: Redis, key: string): Promise<Envelope<T> | null> {
        const raw = await redis.get(key);
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as Envelope<T> | T;
        // Значення у старому форматі (Лаб. №4, без конверта) — вважаємо свіжим до його TTL у Redis
        if (parsed && typeof parsed === 'object' && 'e' in parsed && 'd' in parsed) return parsed;
        return { d: parsed as T, e: Number.MAX_SAFE_INTEGER };
    }
}
