import { CacheService } from '../cache/cache.service';
import { defaultConfig, ResilienceConfig, ResilienceConfigService } from './resilience-config.service';
import { jitteredTtl, ResilientCacheService } from './resilient-cache.service';

/**
 * Мінімальний Redis у пам'яті: GET / SET (EX, PX, NX) / DEL / EVAL (скрипт зняття блокування).
 * Кожна команда асинхронна (як мережевий виклик), тож паралельні запити реально перемежовуються.
 */
class FakeRedis {
    private readonly store = new Map<string, { value: string; expiresAt: number }>();

    private alive(key: string) {
        const item = this.store.get(key);
        if (item && item.expiresAt <= Date.now()) this.store.delete(key);
        return this.store.get(key);
    }

    async get(key: string) {
        await Promise.resolve();
        return this.alive(key)?.value ?? null;
    }

    async set(key: string, value: string, ...args: (string | number)[]) {
        await Promise.resolve();
        let ttlMs = Infinity;
        for (let i = 0; i < args.length; i++) {
            if (args[i] === 'EX') ttlMs = Number(args[++i]) * 1000;
            else if (args[i] === 'PX') ttlMs = Number(args[++i]);
        }
        if (args.includes('NX') && this.alive(key)) return null;
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        return 'OK';
    }

    async del(...keys: string[]) {
        await Promise.resolve();
        return keys.filter((k) => this.store.delete(k)).length;
    }

    async eval(_script: string, _n: number, key: string, token: string) {
        await Promise.resolve();
        if (this.alive(key)?.value !== token) return 0;
        this.store.delete(key);
        return 1;
    }

    raw(key: string) {
        return this.alive(key)?.value ?? null;
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TTL = { base: 60, jitter: 0 };

function setup(redis: FakeRedis, patch: Partial<ResilienceConfig> = {}) {
    const metrics: Record<string, number> = {};
    const config = {
        current: { ...defaultConfig({}), ...patch },
        count: (name: string, by = 1) => (metrics[name] = (metrics[name] ?? 0) + by),
    } as unknown as ResilienceConfigService;
    const cache = { redis } as unknown as CacheService;
    return { service: new ResilientCacheService(cache, config), metrics, config };
}

/** «Коштовний» запит до БД: лічильник викликів + затримка. */
function slowLoader(ms = 30, value: unknown = { revenue: 100 }) {
    const loader = jest.fn(async () => {
        await sleep(ms);
        return value;
    });
    return loader;
}

describe('ResilientCacheService (Лаб. №8)', () => {
    it('none: холодний ключ + 50 паралельних запитів = 50 звернень до БД (Cache Stampede)', async () => {
        const { service } = setup(new FakeRedis(), { protection: 'none' });
        const loader = slowLoader();
        await Promise.all(Array.from({ length: 50 }, () => service.getOrLoad('k', TTL, loader)));
        expect(loader).toHaveBeenCalledTimes(50);
    });

    it('singleflight: 50 паралельних запитів одного інстансу = 1 звернення до БД', async () => {
        const { service } = setup(new FakeRedis(), { protection: 'singleflight' });
        const loader = slowLoader();
        const results = await Promise.all(Array.from({ length: 50 }, () => service.getOrLoad('k', TTL, loader)));
        expect(loader).toHaveBeenCalledTimes(1);
        expect(results.filter((r) => r.cache === 'MISS')).toHaveLength(1);
        expect(results.filter((r) => r.cache === 'COALESCED')).toHaveLength(49);
    });

    it('singleflight не координує різні інстанси: 3 інстанси = 3 звернення', async () => {
        const redis = new FakeRedis();
        const instances = [1, 2, 3].map(() => setup(redis, { protection: 'singleflight' }).service);
        const loader = slowLoader();
        await Promise.all(instances.flatMap((s) => Array.from({ length: 20 }, () => s.getOrLoad('k', TTL, loader))));
        expect(loader).toHaveBeenCalledTimes(3);
    });

    it('lock: 3 інстанси × 20 запитів = 1 звернення до БД на весь кластер', async () => {
        const redis = new FakeRedis();
        const instances = [1, 2, 3].map(() => setup(redis, { protection: 'lock' }).service);
        const loader = slowLoader(50);
        const results = await Promise.all(
            instances.flatMap((s) => Array.from({ length: 20 }, () => s.getOrLoad('k', TTL, loader))),
        );
        expect(loader).toHaveBeenCalledTimes(1);
        expect(results.every((r) => (r.data as { revenue: number }).revenue === 100)).toBe(true);
        expect(redis.raw('k:lock')).toBeNull(); // блокування знято
    });

    it('lock: власник «помер» — блокування саме зникає за lockTtlMs, наступний запит іде в БД (немає deadlock)', async () => {
        const redis = new FakeRedis();
        await redis.set('k:lock', 'dead-owner', 'PX', 150);
        const { service, metrics } = setup(redis, { protection: 'lock', lockTtlMs: 150, lockWaitMs: 2000 });
        const loader = slowLoader(10);
        const result = await service.getOrLoad('k', TTL, loader);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(result.cache).toBe('MISS');
        expect(metrics.lockTimeouts).toBeUndefined();
    });

    it('lock: не дочекався за lockWaitMs — fail-open, запит іде в БД сам', async () => {
        const redis = new FakeRedis();
        await redis.set('k:lock', 'slow-owner', 'PX', 10_000);
        const { service, metrics } = setup(redis, { protection: 'lock', lockWaitMs: 100 });
        const loader = slowLoader(5);
        const started = Date.now();
        await service.getOrLoad('k', TTL, loader);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(metrics.lockTimeouts).toBe(1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });

    it('lock: власник, чий lock прострочився, не знімає чужого блокування (перевірка токена)', async () => {
        const redis = new FakeRedis();
        const { service } = setup(redis, { protection: 'lock', lockTtlMs: 50 });
        const loader = jest.fn(async () => {
            await sleep(100); // довше за lockTtlMs: lock прострочився під час запиту
            await redis.set('k:lock', 'another-owner', 'PX', 10_000);
            return { revenue: 1 };
        });
        await service.getOrLoad('k', TTL, loader);
        expect(redis.raw('k:lock')).toBe('another-owner');
    });

    it('swr: застаріле значення віддається одразу, оновлення — одне, у фоні', async () => {
        const redis = new FakeRedis();
        await redis.set('k', JSON.stringify({ d: { revenue: 1 }, e: Date.now() - 1000 }), 'EX', 60);
        const { service, metrics } = setup(redis, { protection: 'swr' });
        const loader = slowLoader(30, { revenue: 2 });

        const results = await Promise.all(Array.from({ length: 30 }, () => service.getOrLoad('k', TTL, loader)));
        expect(results.every((r) => r.cache === 'STALE' && (r.data as { revenue: number }).revenue === 1)).toBe(true);

        await sleep(80);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(metrics.refreshes).toBe(1);
        const next = await service.getOrLoad('k', TTL, loader);
        expect(next).toMatchObject({ cache: 'HIT', data: { revenue: 2 } });
    });

    it('negative caching: «не знайдено» кешується — повторні запити не доходять до БД (Cache Penetration)', async () => {
        const { service, metrics } = setup(new FakeRedis(), { protection: 'lock', negativeCache: true });
        const loader = jest.fn(async () => null);
        const first = await service.getOrLoad('missing', TTL, loader);
        const rest = [];
        for (let i = 0; i < 20; i++) rest.push(await service.getOrLoad('missing', TTL, loader));
        expect(first).toMatchObject({ data: null, cache: 'MISS' });
        expect(rest.every((r) => r.data === null && r.cache === 'NEGATIVE')).toBe(true);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(metrics.negativeHits).toBe(20);
    });

    it('без negative caching кожен запит до неіснуючого id іде в БД', async () => {
        const { service } = setup(new FakeRedis(), { protection: 'lock', negativeCache: false });
        const loader = jest.fn(async () => null);
        for (let i = 0; i < 5; i++) await service.getOrLoad('missing', TTL, loader);
        expect(loader).toHaveBeenCalledTimes(5);
    });

    it('Redis недоступний — BYPASS: читання напряму з БД (graceful degradation)', async () => {
        const { service } = setup(null as unknown as FakeRedis);
        const loader = jest.fn(async () => ({ revenue: 5 }));
        await expect(service.getOrLoad('k', TTL, loader)).resolves.toMatchObject({ cache: 'BYPASS' });
    });

    it('TTL Jittering: TTL = base ± jitter, без jitter — рівно base', () => {
        const values = Array.from({ length: 1000 }, () => jitteredTtl({ base: 60, jitter: 15 }, true));
        expect(Math.min(...values)).toBeGreaterThanOrEqual(45);
        expect(Math.max(...values)).toBeLessThanOrEqual(75);
        expect(new Set(values).size).toBeGreaterThan(20);
        expect(jitteredTtl({ base: 60, jitter: 15 }, false)).toBe(60);
        expect(jitteredTtl({ base: 60, jitter: 15 }, true, () => 0)).toBe(45);
        expect(jitteredTtl({ base: 60, jitter: 15 }, true, () => 1)).toBe(75);
    });
});
