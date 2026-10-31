import { createHash, randomUUID } from 'crypto';
import { BUCKETS, buildBucketMap, fnv1a } from './shard-key';

/**
 * Модель решардингу (Лаб. №7, п. 2.5): яка частка ключів змінює шард при розширенні
 * кластера з N до M вузлів для трьох схем маршрутизації.
 *
 *  modulo           — shard = hash(key) mod N. Зміна N перераховує майже всі ключі:
 *                     залишається на місці лише ключ, для якого h mod N = h mod M.
 *  virtual-buckets  — bucket = hash(key) mod 64, карта bucket → shard. Новий шард забирає
 *                     у кожного старого рівно стільки бакетів, скільки потрібно для рівноваги;
 *                     решта бакетів не рухається. Переїжджає (M − N) / M даних — теоретичний мінімум.
 *  consistent-hash  — кільце 2^32 з V віртуальними вузлами на шард; ключ належить найближчому
 *                     вузлу за годинниковою стрілкою. Новий шард вставляє свої точки на кільце
 *                     і забирає лише сусідні відрізки ≈ (M − N) / M ключів.
 */

export type Scheme = 'modulo' | 'virtual-buckets' | 'consistent-hash';

/**
 * Позиція віртуального вузла на кільці: перші 4 байти MD5 (як у Ketama).
 * FNV-1a тут не годиться: для схожих коротких рядків ("shard-0#1", "shard-0#2", …)
 * він дає скупчені значення, і відрізки кільця виходять дуже нерівними.
 */
function ringPosition(label: string): number {
    return createHash('md5').update(label).digest().readUInt32BE(0);
}

/** Кільце Consistent Hashing з віртуальними вузлами. */
export class HashRing {
    private readonly points: { hash: number; shard: number }[];

    constructor(shardCount: number, readonly vnodes: number) {
        this.points = [];
        for (let shard = 0; shard < shardCount; shard++) {
            for (let v = 0; v < vnodes; v++) this.points.push({ hash: ringPosition(`shard-${shard}#${v}`), shard });
        }
        this.points.sort((a, b) => a.hash - b.hash);
    }

    /** Перший віртуальний вузол за годинниковою стрілкою від hash(key) (бінарний пошук). */
    shardOf(keyHash: number): number {
        const points = this.points;
        let lo = 0;
        let hi = points.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (points[mid].hash < keyHash) lo = mid + 1;
            else hi = mid;
        }
        return points[lo === points.length ? 0 : lo].shard;
    }
}

/**
 * Мінімальне перепризначення бакетів при переході з карти на `from` шардів до `to` шардів:
 * кожен шард зберігає свої бакети до цільової квоти, надлишок отримують нові шарди.
 */
export function rebalanceBuckets(map: number[], to: number): number[] {
    const next = [...map];
    const quota = (shard: number) => Math.floor(BUCKETS / to) + (shard < BUCKETS % to ? 1 : 0);
    const owned = Array.from({ length: to }, (_, shard) => next.filter((s) => s === shard).length);
    const spare: number[] = [];
    // Знімаємо надлишкові бакети з перевантажених шардів (з кінця, щоб решта лишилася на місці)
    for (let bucket = BUCKETS - 1; bucket >= 0; bucket--) {
        const shard = next[bucket];
        if (owned[shard] > quota(shard)) {
            owned[shard]--;
            spare.push(bucket);
        }
    }
    for (let shard = 0; shard < to; shard++) {
        while (owned[shard] < quota(shard)) {
            next[spare.pop() as number] = shard;
            owned[shard]++;
        }
    }
    return next;
}

function placement(scheme: Scheme, shardCount: number, vnodes: number, previousMap?: number[]) {
    if (scheme === 'modulo') return (hash: number) => hash % shardCount;
    if (scheme === 'virtual-buckets') {
        const map = previousMap ? rebalanceBuckets(previousMap, shardCount) : buildBucketMap(shardCount);
        return Object.assign((hash: number) => map[hash % BUCKETS], { map });
    }
    const ring = new HashRing(shardCount, vnodes);
    return (hash: number) => ring.shardOf(hash);
}

export interface ReshardingRow {
    scheme: Scheme;
    from: number;
    to: number;
    movedPercent: number;
    idealPercent: number;
    /** Нерівномірність після решардингу: найбільший шард / середній (1.00 = ідеально) */
    maxToAvg: number;
    loadPercent: number[];
}

/** Симуляція на `keyCount` випадкових hotelId: скільки ключів переїде і наскільки рівномірний результат. */
export function simulateResharding(
    transitions: [number, number][] = [
        [2, 3],
        [2, 4],
        [3, 4],
        [4, 5],
    ],
    keyCount = 100_000,
    vnodes = 128,
): ReshardingRow[] {
    const hashes = Array.from({ length: keyCount }, () => fnv1a(randomUUID()));
    const rows: ReshardingRow[] = [];

    for (const [from, to] of transitions) {
        for (const scheme of ['modulo', 'virtual-buckets', 'consistent-hash'] as Scheme[]) {
            const before = placement(scheme, from, vnodes);
            const after = placement(scheme, to, vnodes, (before as { map?: number[] }).map);
            const load: number[] = Array.from({ length: to }, () => 0);
            let moved = 0;
            for (const hash of hashes) {
                const target = after(hash);
                load[target]++;
                if (before(hash) !== target) moved++;
            }
            rows.push({
                scheme,
                from,
                to,
                movedPercent: pct(moved, keyCount),
                idealPercent: pct(to - from, to),
                maxToAvg: Math.round((Math.max(...load) / (keyCount / to)) * 100) / 100,
                loadPercent: load.map((count) => pct(count, keyCount)),
            });
        }
    }
    return rows;
}

/** Чому потрібні віртуальні вузли: рівномірність кільця з 1 / 16 / 128 / 512 точками на шард. */
export function ringBalance(shardCount = 4, keyCount = 100_000, vnodeOptions = [1, 16, 128, 512]) {
    const hashes = Array.from({ length: keyCount }, () => fnv1a(randomUUID()));
    return vnodeOptions.map((vnodes) => {
        const ring = new HashRing(shardCount, vnodes);
        const load: number[] = Array.from({ length: shardCount }, () => 0);
        for (const hash of hashes) load[ring.shardOf(hash)]++;
        return {
            vnodes,
            maxToAvg: Math.round((Math.max(...load) / (keyCount / shardCount)) * 100) / 100,
            loadPercent: load.map((count) => pct(count, keyCount)),
        };
    });
}

function pct(part: number, total: number) {
    return Math.round((part / total) * 1000) / 10;
}
