import { CacheService } from '../cache/cache.service';
import { defaultConfig, ResilienceConfigService } from './resilience-config.service';

describe('ResilienceConfigService (Лаб. №8)', () => {
    it('значення за замовчуванням — зі змінних середовища, невідомий режим = lock', () => {
        expect(defaultConfig({ CACHE_PROTECTION: 'swr', STATS_QUERY_COST_MS: '200' })).toMatchObject({
            protection: 'swr',
            statsQueryCostMs: 200,
        });
        expect(defaultConfig({ CACHE_PROTECTION: 'magic' }).protection).toBe('lock');
        expect(defaultConfig({ CACHE_TTL_JITTER: 'false' }).jitter).toBe(false);
    });

    it('часткове оновлення не затирає незадані поля (DTO містить їх як undefined)', async () => {
        const saved: string[] = [];
        const cache = { redis: { set: async (_k: string, v: string) => saved.push(v) } } as unknown as CacheService;
        const service = new ResilienceConfigService(cache);
        await service.update({ protection: 'swr' });
        const next = await service.update({ protection: undefined, statsTtlSec: 2 });
        expect(next).toMatchObject({ protection: 'swr', statsTtlSec: 2 });
        expect(JSON.parse(saved[1])).toMatchObject({ protection: 'swr', statsTtlSec: 2 });
    });
});
