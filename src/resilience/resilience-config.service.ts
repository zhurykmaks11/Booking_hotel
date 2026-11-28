import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';

/**
 * Режим захисту від Cache Stampede (Лаб. №8, п. 2.4):
 *  none         — звичайний Cache-Aside: кожен запит, що не знайшов ключ, іде в БД (Stampede);
 *  singleflight — однакові паралельні запити ОДНОГО інстансу API об'єднуються в одне звернення до БД;
 *  lock         — singleflight + розподілене блокування Redis (SET NX PX): одне звернення на весь кластер;
 *  swr          — lock + Stale-While-Revalidate: після «м'якого» TTL віддається застаріле значення,
 *                 а оновлення йде у фоні (лише один інстанс, під тим самим блокуванням).
 */
export type Protection = 'none' | 'singleflight' | 'lock' | 'swr';
export const PROTECTIONS: Protection[] = ['none', 'singleflight', 'lock', 'swr'];

export interface ResilienceConfig {
    protection: Protection;
    /** TTL Jittering (п. 2.5): TTL = base ± jitter. false — усі ключі живуть рівно base (для демонстрації Avalanche). */
    jitter: boolean;
    /** Negative Caching (п. 2.6): «не знайдено» теж кешується на negativeTtlSec. */
    negativeCache: boolean;
    /** TTL статистики готелю (ресурс п. 2.1), с. */
    statsTtlSec: number;
    statsJitterSec: number;
    negativeTtlSec: number;
    /** SWR: скільки після «м'якого» TTL ще можна віддавати застаріле значення, с. */
    swrStaleSec: number;
    /** Блокування: TTL самого lock-а (захист від deadlock, якщо власник «помер») і скільки чекають інші. */
    lockTtlMs: number;
    lockWaitMs: number;
    /** Модель «коштовного» запиту: pg_sleep у тому самому SQL-запиті статистики, мс. */
    statsQueryCostMs: number;
}

const num = (value: string | undefined, fallback: number) =>
    value === undefined || value === '' || Number.isNaN(Number(value)) ? fallback : Number(value);
const bool = (value: string | undefined, fallback: boolean) =>
    value === undefined || value === '' ? fallback : value === 'true';

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): ResilienceConfig {
    const protection = env.CACHE_PROTECTION as Protection;
    return {
        protection: PROTECTIONS.includes(protection) ? protection : 'lock',
        jitter: bool(env.CACHE_TTL_JITTER, true),
        negativeCache: bool(env.CACHE_NEGATIVE, true),
        statsTtlSec: num(env.STATS_TTL_SEC, 60),
        statsJitterSec: num(env.STATS_TTL_JITTER_SEC, 15),
        negativeTtlSec: num(env.NEGATIVE_TTL_SEC, 30),
        swrStaleSec: num(env.SWR_STALE_SEC, 60),
        lockTtlMs: num(env.LOCK_TTL_MS, 5000),
        lockWaitMs: num(env.LOCK_WAIT_MS, 3000),
        statsQueryCostMs: num(env.STATS_QUERY_COST_MS, 0),
    };
}

/** Лічильники стійкості — спільні для всіх інстансів API (Redis HINCRBY). */
export type ResilienceMetric =
    | 'hits' // свіже значення з кешу
    | 'misses' // ключа немає — запит пішов у БД сам
    | 'dbLoads' // скільки разів реально виконано запит до СУБД (loader)
    | 'coalesced' // приєднався до вже запущеного запиту свого інстансу (single-flight)
    | 'lockAcquired' // отримав розподілене блокування і пішов у БД
    | 'lockWaits' // дочекався значення, яке поклав власник блокування
    | 'lockTimeouts' // не дочекався за lockWaitMs — fallback у БД
    | 'staleServed' // віддано застаріле значення (SWR)
    | 'refreshes' // фонове оновлення SWR
    | 'negativeHits' // «не знайдено» з кешу, БД не зачеплена
    | 'negativeStored' // збережено «не знайдено»
    | 'notFound' // БД відповіла «не знайдено»
    | 'bypass'; // Redis недоступний — напряму в БД

const CONFIG_KEY = 'booking:resilience:config';
const METRICS_KEY = 'booking:resilience:metrics';

/**
 * Конфігурація захисту, яку можна змінити без перезапуску (PUT /resilience/config).
 * Зберігається в Redis, кожен інстанс API перечитує її раз на секунду — тож усі три інстанси
 * за nginx переходять у новий режим одночасно (з точністю до ~1 с).
 */
@Injectable()
export class ResilienceConfigService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('Resilience');
    private config: ResilienceConfig = defaultConfig();
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly cache: CacheService) {}

    async onModuleInit() {
        await this.reload();
        this.timer = setInterval(() => void this.reload(), 1000);
        this.timer.unref();
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    get current(): ResilienceConfig {
        return this.config;
    }

    async update(patch: Partial<ResilienceConfig>): Promise<ResilienceConfig> {
        // DTO (class-transformer) містить незадані поля як undefined — вони не мають затирати поточні значення
        const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        const next = { ...this.config, ...defined };
        this.config = next;
        await this.cache.redis?.set(CONFIG_KEY, JSON.stringify(next)).catch(() => undefined);
        this.logger.log(`Конфігурація: ${JSON.stringify(next)}`);
        return next;
    }

    /** Повернути значення зі змінних середовища (видалити перевизначення з Redis). */
    async reset(): Promise<ResilienceConfig> {
        this.config = defaultConfig();
        await this.cache.redis?.del(CONFIG_KEY).catch(() => undefined);
        return this.config;
    }

    /** Fire-and-forget: лічильник не повинен ні гальмувати, ні ламати запит. */
    count(metric: ResilienceMetric, by = 1) {
        this.cache.redis?.hincrby(METRICS_KEY, metric, by).catch(() => undefined);
    }

    async metrics(): Promise<Record<string, number>> {
        const raw = (await this.cache.redis?.hgetall(METRICS_KEY).catch(() => null)) ?? {};
        return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
    }

    async resetMetrics() {
        await this.cache.redis?.del(METRICS_KEY).catch(() => undefined);
    }

    private async reload() {
        const redis = this.cache.redis;
        if (!redis) return;
        try {
            const raw = await redis.get(CONFIG_KEY);
            this.config = raw ? { ...defaultConfig(), ...(JSON.parse(raw) as Partial<ResilienceConfig>) } : defaultConfig();
        } catch {
            // Redis недоступний — лишається остання відома конфігурація
        }
    }
}
