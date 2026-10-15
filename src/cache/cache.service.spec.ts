import { CacheService } from './cache.service';
import { CacheKeys, normalizeSearchParams } from './cache-keys';

/** Мінімальна імітація ioredis-клієнта зі сховищем у Map. */
function createFakeRedis() {
    const store = new Map<string, string>();
    return {
        status: 'ready',
        store,
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        set: jest.fn(async (key: string, value: string) => {
            store.set(key, value);
            return 'OK';
        }),
        del: jest.fn(async (...keys: string[]) => {
            keys.forEach((k) => store.delete(k));
            return keys.length;
        }),
        incr: jest.fn(async (key: string) => {
            const next = Number(store.get(key) ?? 0) + 1;
            store.set(key, String(next));
            return next;
        }),
        disconnect: jest.fn(),
    };
}

describe('CacheService', () => {
    const ttl = { base: 60, jitter: 0 };
    let service: CacheService;
    let redis: ReturnType<typeof createFakeRedis>;

    beforeEach(() => {
        delete process.env.REDIS_URL;
        service = new CacheService();
        redis = createFakeRedis();
        (service as any).client = redis;
    });

    it('MISS: читає з БД і зберігає в Redis з TTL', async () => {
        const loader = jest.fn().mockResolvedValue({ id: 'h1', name: 'Hotel' });

        const result = await service.getOrSet('booking:hotel:h1', ttl, loader);

        expect(result.cache).toBe('MISS');
        expect(result.data).toEqual({ id: 'h1', name: 'Hotel' });
        expect(loader).toHaveBeenCalledTimes(1);
        expect(redis.set).toHaveBeenCalledWith('booking:hotel:h1', expect.any(String), 'EX', 60);
    });

    it('HIT: другий запит повертає дані з Redis без звернення до БД', async () => {
        const loader = jest.fn().mockResolvedValue({ id: 'h1' });

        await service.getOrSet('booking:hotel:h1', ttl, loader);
        const second = await service.getOrSet('booking:hotel:h1', ttl, loader);

        expect(second.cache).toBe('HIT');
        expect(second.data).toEqual({ id: 'h1' });
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('BYPASS: якщо Redis не підключений, дані беруться з БД', async () => {
        redis.status = 'reconnecting';
        const loader = jest.fn().mockResolvedValue({ id: 'h1' });

        const result = await service.getOrSet('booking:hotel:h1', ttl, loader);

        expect(result.cache).toBe('BYPASS');
        expect(result.data).toEqual({ id: 'h1' });
        expect(redis.get).not.toHaveBeenCalled();
    });

    it('BYPASS: помилка Redis не пробивається до клієнта', async () => {
        redis.get.mockRejectedValueOnce(new Error('Connection is closed.'));
        const loader = jest.fn().mockResolvedValue({ id: 'h1' });

        const result = await service.getOrSet('booking:hotel:h1', ttl, loader);

        expect(result.cache).toBe('BYPASS');
        expect(result.data).toEqual({ id: 'h1' });
    });

    it('без REDIS_URL кеш вимкнено, але сервіс працює', async () => {
        const disabled = new CacheService();
        const loader = jest.fn().mockResolvedValue([1, 2, 3]);

        const result = await disabled.getOrSet('k', ttl, loader);

        expect(result.cache).toBe('BYPASS');
        expect(disabled.getStats().redis).toBe('DISABLED');
    });

    it('інвалідація: після invalidate наступне читання — знову MISS', async () => {
        const loader = jest.fn().mockResolvedValue({ name: 'old' });
        await service.getOrSet('booking:hotel:h1', ttl, loader);

        await service.invalidate('booking:hotel:h1');
        loader.mockResolvedValue({ name: 'new' });
        const after = await service.getOrSet('booking:hotel:h1', ttl, loader);

        expect(after.cache).toBe('MISS');
        expect(after.data).toEqual({ name: 'new' });
    });

    it('bumpVersion змінює ключі пошуку (старі результати стають недосяжними)', async () => {
        const params = { city: 'Kyiv', checkIn: '2027-01-01', checkOut: '2027-01-04', guests: 2 };
        const before = CacheKeys.roomsSearch(await service.getVersion(CacheKeys.searchVersion), params);

        await service.bumpVersion(CacheKeys.searchVersion);
        const after = CacheKeys.roomsSearch(await service.getVersion(CacheKeys.searchVersion), params);

        expect(before).toContain(':v0:');
        expect(after).toContain(':v1:');
        expect(after).not.toBe(before);
    });
});

describe('Cache key design', () => {
    it('однакові за змістом параметри пошуку дають однаковий ключ', () => {
        const a = CacheKeys.roomsSearch(3, { city: 'Kyiv', checkIn: '2027-01-01', checkOut: '2027-01-04', guests: 2 });
        const b = CacheKeys.roomsSearch(3, { guests: 2, checkOut: '2027-01-04T00:00:00.000Z', checkIn: '2027-01-01', city: ' kyiv ' });
        expect(a).toBe(b);
    });

    it('різні параметри дають різні ключі', () => {
        const a = CacheKeys.roomsSearch(3, { city: 'Kyiv', checkIn: '2027-01-01', checkOut: '2027-01-04' });
        const b = CacheKeys.roomsSearch(3, { city: 'Lviv', checkIn: '2027-01-01', checkOut: '2027-01-04' });
        expect(a).not.toBe(b);
    });

    it('нормалізація прибирає регістр і пробіли міста', () => {
        expect(normalizeSearchParams({ city: '  LVIV ', checkIn: '2027-01-01', checkOut: '2027-01-02' }).city).toBe('lviv');
    });

    it('ключ готелю має префікс простору імен', () => {
        expect(CacheKeys.hotel('abc')).toBe('booking:hotel:abc');
    });
});
