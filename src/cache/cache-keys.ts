import { createHash } from 'crypto';

/**
 * Схема ключів кешування (Лаб. №4, п. 2.4).
 *
 *   booking:hotel:{id}                              — готель разом із номерами
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

    searchVersion: `${PREFIX}:rooms:search:version`,

    roomsSearch: (version: number, params: SearchParams) => {
        const hash = createHash('sha1')
            .update(JSON.stringify(normalizeSearchParams(params)))
            .digest('hex');
        return `${PREFIX}:rooms:search:v${version}:${hash}`;
    },
};

export const CacheTtl = {
    hotel: { base: 600, jitter: 60 },
    roomsSearch: { base: 60, jitter: 10 },
};
