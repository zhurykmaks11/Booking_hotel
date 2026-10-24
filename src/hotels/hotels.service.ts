import { Injectable, NotFoundException } from '@nestjs/common';
import { Consistency, DbRouter } from '../database/db-router.service';
import { CacheService } from '../cache/cache.service';
import { CacheKeys, CacheTtl } from '../cache/cache-keys';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';

@Injectable()
export class HotelsService {
    constructor(
        private readonly db: DbRouter,
        private readonly cache: CacheService,
    ) {}

    create(createHotelDto: CreateHotelDto) {
        // Новий готель ще не має номерів, тому на результати пошуку не впливає.
        return this.db.write((db) => db.hotel.create({ data: createHotelDto }));
    }

    /** Публічний каталог готелів: eventual consistency → Replica. */
    findAll() {
        return this.db.read((db) => db.hotel.findMany());
    }

    /**
     * Читання напряму з БД (loader для кешу і перевірка існування перед записом).
     * Перед записом — STRONG: на Replica щойно створений готель може ще не з'явитися.
     */
    async findOne(id: string, consistency = Consistency.EVENTUAL) {
        const hotel = await this.db.read(
            (db) => db.hotel.findUnique({ where: { id }, include: { rooms: true } }),
            consistency,
        );
        if (!hotel) {
            throw new NotFoundException(`Hotel with id ${id} not found`);
        }
        return hotel;
    }

    /**
     * GET /hotels/:id через кеш (Cache-Aside). Повертає дані і джерело (HIT / MISS / BYPASS).
     * 404 не кешується: NotFoundException з loader-а просто пробрасується далі.
     * Кеш заповнюється з Primary (інакше застаріла копія з Replica жила б увесь TTL;
     * у Read-Only Mode — з Replica, бо записів немає і вона актуальна),
     * а без Redis — eventual-читання з Replica.
     */
    findOneCached(id: string) {
        return this.cache.getOrSet(
            CacheKeys.hotel(id),
            CacheTtl.hotel,
            () => this.findOne(id, Consistency.PRIMARY_PREFERRED),
            () => this.findOne(id),
        );
    }

    async update(id: string, updateHotelDto: UpdateHotelDto) {
        await this.findOne(id, Consistency.STRONG);
        const hotel = await this.db.write((db) =>
            db.hotel.update({
                where: { id },
                data: updateHotelDto,
            }),
        );
        // Інвалідація після успішного запису: картка готелю + пошук (могло змінитися місто).
        await this.cache.invalidate(CacheKeys.hotel(id));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
        return hotel;
    }

    async remove(id: string) {
        await this.findOne(id, Consistency.STRONG);
        const hotel = await this.db.write((db) => db.hotel.delete({ where: { id } }));
        await this.cache.invalidate(CacheKeys.hotel(id));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
        return hotel;
    }
}
