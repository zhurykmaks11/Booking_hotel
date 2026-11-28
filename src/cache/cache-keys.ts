import { createHash } from 'crypto';

/**
 * Схема ключів кешування (Лаб. №4, п. 2.4).
 *
 *   booking:hotel:{id}                              — готель разом із номерами
 *   booking:hotel-stats:{id}                        — агрегована статистика готелю (Лаб. №8)
 *   booking:...:{id}:lock                           — розподілене блокування заповнення ключа (Лаб. №8)
 *   booking:rooms:search:version                    — лічильник «покоління» пошуку
 *   booking:rooms:search:v{version}:{sha1(params)}  — результат пошуку вільних номерів
 *
 * Префікс `booking:` — простір імен застосунку, далі тип даних і ідентифікатор.
 * Параметри пошуку нормалізуються перед хешуванням, тому однакові за змістом запити
 * (інший порядок полів, регістр міста, дата без часу або з часом) дають той самий ключ,
 * а різні — різні ключі (колізій немає).
 */
const PREFIX = 'booking';

export interface SearchParams {
    city?: string;
    checkIn: string;
    checkOut: string;
    guests?: number;
}

export function normalizeSearchParams(params: SearchParams) {
    return {
        city: params.city ? params.city.trim().toLowerCase() : '',
        checkIn: new Date(params.checkIn).toISOString(),
        checkOut: new Date(params.checkOut).toISOString(),
        guests: params.guests ? Number(params.guests) : 0,
    };
}

export const CacheKeys = {
    hotel: (id: string) => `${PREFIX}:hotel:${id}`,

    hotelStats: (id: string) => `${PREFIX}:hotel-stats:${id}`,
    hotelStatsPattern: `${PREFIX}:hotel-stats:*`,

    searchVersion: `${PREFIX}:rooms:search:version`,

    roomsSearch: (version: number, params: SearchParams) => {
        const hash = createHash('sha1')
            .update(JSON.stringify(normalizeSearchParams(params)))
            .digest('hex');
        return `${PREFIX}:rooms:search:v${version}:${hash}`;
    },
};

// Лаб. №8: jitter симетричний — TTL = base ± jitter (раніше base + [0..jitter]).
// TTL статистики готелю задається в ResilienceConfig (statsTtlSec ± statsJitterSec).
export const CacheTtl = {
    hotel: { base: 600, jitter: 60 },
    roomsSearch: { base: 60, jitter: 10 },
};
