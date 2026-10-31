import { randomUUID } from 'crypto';
import { BUCKETS, bucketForNewHotel, bucketOf, buildBucketMap, fnv1a, idInBucket } from './shard-key';
import { HashRing, rebalanceBuckets, simulateResharding } from './resharding';
import { ShardRouter } from './shard-router.service';

describe('Shard key (Virtual Buckets)', () => {
    it('FNV-1a детермінований', () => {
        expect(fnv1a('Kyiv')).toBe(fnv1a('Kyiv'));
        expect(fnv1a('Kyiv')).not.toBe(fnv1a('Lviv'));
    });

    it('бакет записується в ID і зчитується з нього', () => {
        for (let bucket = 0; bucket < BUCKETS; bucket++) {
            const id = idInBucket(bucket);
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            expect(bucketOf(id)).toBe(bucket);
        }
    });

    it('будь-який рядок маршрутизується детерміновано', () => {
        expect(bucketOf('not-a-uuid')).toBe(bucketOf('not-a-uuid'));
        expect(bucketOf('not-a-uuid')).toBeLessThan(BUCKETS);
    });

    it('стратегія city кладе всі готелі міста в один бакет, hash — розкидає', () => {
        const city = new Set(Array.from({ length: 200 }, () => bucketForNewHotel('city', randomUUID(), ' Kyiv ')));
        const hash = new Set(Array.from({ length: 200 }, () => bucketForNewHotel('hash', randomUUID(), 'Kyiv')));
        expect(city.size).toBe(1);
        expect(hash.size).toBeGreaterThan(50);
    });

    it('карта бакетів: за замовчуванням по колу, явна — з SHARD_BUCKET_MAP', () => {
        expect(buildBucketMap(2).slice(0, 4)).toEqual([0, 1, 0, 1]);
        const custom = buildBucketMap(2, '0-62:0,63:1');
        expect(custom.filter((s) => s === 1)).toHaveLength(1);
        expect(() => buildBucketMap(2, '0-64:0')).toThrow();
        expect(() => buildBucketMap(2, '5:2')).toThrow();
    });
});

describe('ShardRouter', () => {
    const OLD_ENV = process.env;
    const globalRouter = { read: jest.fn(), write: jest.fn() } as any;

    afterEach(() => {
        process.env = OLD_ENV;
    });

    function router(env: Record<string, string>) {
        process.env = { ...OLD_ENV, ...env };
        return new ShardRouter(globalRouter);
    }

    it('без SHARD_URLS — один вузол global (поведінка Лаб. №6)', () => {
        const r = router({ SHARD_URLS: '' });
        expect(r.sharded).toBe(false);
        expect(r.forKey(randomUUID()).name).toBe('global');
    });

    it('готель, його номери й бронювання потрапляють на один шард (co-location)', () => {
        const r = router({ SHARD_URLS: 'postgresql://a/db,postgresql://b/db' });
        for (let i = 0; i < 50; i++) {
            const hotelId = r.newHotelId('Lviv');
            const roomId = r.childId(hotelId);
            const bookingId = r.childId(roomId);
            expect(r.forKey(roomId)).toBe(r.forKey(hotelId));
            expect(r.forKey(bookingId)).toBe(r.forKey(hotelId));
        }
    });

    it('маршрут детермінований: однаковий на всіх інстансах API', () => {
        const env = { SHARD_URLS: 'postgresql://a/db,postgresql://b/db' };
        const ids = Array.from({ length: 100 }, () => randomUUID());
        const first = router(env);
        const second = router(env);
        for (const id of ids) expect(first.forKey(id).name).toBe(second.forKey(id).name);
    });

    it('стратегія city: місто відоме → шард відомий (Query Locality)', () => {
        const r = router({ SHARD_URLS: 'postgresql://a/db,postgresql://b/db', SHARD_STRATEGY: 'city' });
        const shard = r.shardForCity('Odesa');
        expect(shard).not.toBeNull();
        expect(r.forKey(r.newHotelId('Odesa'))).toBe(shard);
        expect(router({ SHARD_URLS: 'postgresql://a/db,postgresql://b/db' }).shardForCity('Odesa')).toBeNull();
    });
});

describe('Модель решардингу (п. 2.5)', () => {
    const rows = simulateResharding([[2, 3], [3, 4]], 20_000, 128);
    const moved = (scheme: string, from: number) => rows.find((r) => r.scheme === scheme && r.from === from)!.movedPercent;

    it('key % N переносить більшість ключів', () => {
        expect(moved('modulo', 2)).toBeGreaterThan(60); // теоретично 66.7%
        expect(moved('modulo', 3)).toBeGreaterThan(70); // теоретично 75%
    });

    it('Virtual Buckets і Consistent Hashing — близько до мінімуму (M − N) / M', () => {
        expect(moved('virtual-buckets', 2)).toBeLessThan(36); // ідеал 33.3%
        expect(moved('consistent-hash', 2)).toBeLessThan(42);
        expect(moved('virtual-buckets', 3)).toBeLessThan(28); // ідеал 25%
    });

    it('перепризначення бакетів мінімальне і рівномірне', () => {
        const before = buildBucketMap(2);
        const after = rebalanceBuckets(before, 3);
        const changed = after.filter((shard, bucket) => shard !== before[bucket]).length;
        expect(changed).toBe(21); // 64 / 3 ≈ 21 бакет переходить на новий шард
        expect(after.filter((s) => s === 2)).toHaveLength(21);
    });

    it('кільце повертає один і той самий шард для ключа', () => {
        const ring = new HashRing(3, 64);
        const h = fnv1a('hotel');
        expect(ring.shardOf(h)).toBe(ring.shardOf(h));
    });
});
