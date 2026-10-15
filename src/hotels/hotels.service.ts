import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { CacheKeys, CacheTtl } from '../cache/cache-keys';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';

@Injectable()
export class HotelsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly cache: CacheService,
    ) {}

    create(createHotelDto: CreateHotelDto) {
        // Новий готель ще не має номерів, тому на результати пошуку не впливає.
        return this.prisma.hotel.create({ data: createHotelDto });
    }

    findAll() {
        return this.prisma.hotel.findMany();
    }

    /** Читання напряму з БД (використовується як loader для кешу і для перевірки існування). */
    async findOne(id: string) {
        const hotel = await this.prisma.hotel.findUnique({
            where: { id },
            include: { rooms: true },
        });
        if (!hotel) {
            throw new NotFoundException(`Hotel with id ${id} not found`);
        }
        return hotel;
    }

    /**
     * GET /hotels/:id через кеш (Cache-Aside). Повертає дані і джерело (HIT / MISS / BYPASS).
     * 404 не кешується: NotFoundException з loader-а просто пробрасується далі.
     */
    findOneCached(id: string) {
        return this.cache.getOrSet(CacheKeys.hotel(id), CacheTtl.hotel, () => this.findOne(id));
    }

    async update(id: string, updateHotelDto: UpdateHotelDto) {
        await this.findOne(id);
        const hotel = await this.prisma.hotel.update({
            where: { id },
            data: updateHotelDto,
        });
        // Інвалідація після успішного запису: картка готелю + пошук (могло змінитися місто).
        await this.cache.invalidate(CacheKeys.hotel(id));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
        return hotel;
    }

    async remove(id: string) {
        await this.findOne(id);
        const hotel = await this.prisma.hotel.delete({ where: { id } });
        await this.cache.invalidate(CacheKeys.hotel(id));
        await this.cache.bumpVersion(CacheKeys.searchVersion);
        return hotel;
    }
}
