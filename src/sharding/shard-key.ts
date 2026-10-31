import { randomUUID } from 'crypto';

/**
 * Ключ шардингу і Virtual Buckets (Лаб. №7, п. 2.1, 2.3).
 *
 * Шардується агрегат «Готель → Номери → Бронювання» за ключем hotelId.
 * Між ключем і фізичним шардом є проміжний рівень — 64 віртуальні бакети:
 *
 *     hotelId ──hash──▶ bucket (0..63) ──bucket map──▶ shard (A, B, …)
 *
 * Бакет записується в перші два hex-символи ID (Shard-aware ID), причому однаковий
 * для готелю і всіх його номерів та бронювань. Тому маршрут для будь-якого ID
 * (/hotels/:id, /rooms/:id, /bookings/:id) обчислюється за O(1), без таблиці-довідника
 * і без звернення до БД.
 */

/** Кількість віртуальних бакетів. Фіксована: входить у формат ID, змінювати не можна. */
export const BUCKETS = 64;

/**
 * Політика розміщення нових готелів (SHARD_STRATEGY):
 *  hash — бакет = FNV-1a(hotelId) mod 64: ключ високої потужності, рівномірний розподіл;
 *  city — бакет = FNV-1a(city) mod 64: «наївний» геошардинг за ключем низької потужності
 *         (кілька міст) — використовується для моделювання Hot Shard.
 */
export type ShardStrategy = 'hash' | 'city';

export function parseStrategy(value: string | undefined): ShardStrategy {
    return value === 'city' ? 'city' : 'hash';
}

/** 32-бітний FNV-1a: простий, швидкий і детермінований (однаковий результат на всіх інстансах). */
export function fnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function normalizeCity(city: string): string {
    return city.trim().toLowerCase();
}

const HEX_PREFIX = /^[0-9a-f]{2}/i;

/**
 * Бакет, до якого належить ID. Для ID, створених цим застосунком, — значення з префікса.
 * Будь-який інший рядок теж маршрутизується детерміновано (через хеш), тому
 * неіснуючий або «чужий» ID просто дасть 404 на своєму шарді.
 */
export function bucketOf(id: string): number {
    return HEX_PREFIX.test(id) ? parseInt(id.slice(0, 2), 16) % BUCKETS : fnv1a(id) % BUCKETS;
}

/** UUID v4, у якому перший байт замінено номером бакета (решта 120 біт — випадкові). */
export function idInBucket(bucket: number, uuid: string = randomUUID()): string {
    return bucket.toString(16).padStart(2, '0') + uuid.slice(2);
}

/** Бакет для нового готелю відповідно до стратегії. */
export function bucketForNewHotel(strategy: ShardStrategy, uuid: string, city: string): number {
    return strategy === 'city' ? fnv1a(normalizeCity(city)) % BUCKETS : fnv1a(uuid) % BUCKETS;
}

/**
 * Карта «бакет → шард». За замовчуванням бакети розкладаються по колу (bucket mod N).
 * SHARD_BUCKET_MAP дозволяє задати карту явно, напр. "0-31:0,32-63:1" або винести
 * «гарячий» бакет на окремий шард: "0-62:0,63:1". Решардинг = перепризначення частини
 * бакетів і перенесення лише їхніх рядків.
 */
export function buildBucketMap(shardCount: number, spec?: string): number[] {
    const map = Array.from({ length: BUCKETS }, (_, bucket) => bucket % shardCount);
    if (!spec?.trim()) return map;

    for (const part of spec.split(',')) {
        const match = part.trim().match(/^(\d+)(?:-(\d+))?:(\d+)$/);
        if (!match) throw new Error(`SHARD_BUCKET_MAP: некоректний фрагмент "${part}"`);
        const from = Number(match[1]);
        const to = Number(match[2] ?? match[1]);
        const shard = Number(match[3]);
        if (from > to || to >= BUCKETS || shard >= shardCount) {
            throw new Error(`SHARD_BUCKET_MAP: "${part}" виходить за межі (бакети 0..${BUCKETS - 1}, шарди 0..${shardCount - 1})`);
        }
        for (let bucket = from; bucket <= to; bucket++) map[bucket] = shard;
    }
    return map;
}

/** Назва шарду за порядковим номером: 0 → shard-a, 1 → shard-b, … */
export function shardName(index: number): string {
    return `shard-${String.fromCharCode(97 + index)}`;
}
