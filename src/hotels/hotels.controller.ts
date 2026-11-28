import { Controller, Get, Post, Body, Patch, Param, Delete, Res, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HotelsService } from './hotels.service';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';

@ApiTags('hotels')
@Controller('hotels')
export class HotelsController {
    constructor(private readonly hotelsService: HotelsService) {}

    @Post()
    @ApiOperation({ summary: 'Створити готель' })
    @ApiResponse({ status: 201, description: 'Готель успішно створено' })
    @ApiResponse({ status: 400, description: 'Невалідні вхідні дані' })
    create(@Body() createHotelDto: CreateHotelDto) {
        return this.hotelsService.create(createHotelDto);
    }

    @Get()
    @ApiOperation({ summary: 'Отримати список усіх готелів' })
    findAll() {
        return this.hotelsService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Отримати готель за id (з номерами)' })
    @ApiResponse({ status: 200, description: 'Готель знайдено. Заголовок X-Cache: HIT / MISS / BYPASS / COALESCED / LOCK-WAIT / STALE' })
    @ApiResponse({ status: 404, description: 'Готель не знайдено (X-Cache: NEGATIVE — відповідь з кешу, БД не зачеплена)' })
    async findOne(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
        const { data, cache, key } = await this.hotelsService.findOneCached(id);
        res.setHeader('X-Cache', cache);
        res.setHeader('X-Cache-Key', key);
        if (data === null) throw new NotFoundException(`Hotel with id ${id} not found`);
        return data;
    }

    @Get(':id/stats')
    @ApiOperation({ summary: 'Агрегована статистика готелю (Лаб. №8: кеш із захистом від Stampede)' })
    @ApiResponse({ status: 200, description: 'Статистика. X-Cache: HIT / MISS / COALESCED / LOCK-WAIT / STALE / BYPASS' })
    @ApiResponse({ status: 404, description: 'Готель не знайдено (X-Cache: NEGATIVE — з кешу)' })
    async stats(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
        const { data, cache, key } = await this.hotelsService.statsCached(id);
        res.setHeader('X-Cache', cache);
        res.setHeader('X-Cache-Key', key);
        if (data === null) throw new NotFoundException(`Hotel with id ${id} not found`);
        return data;
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Оновити дані готелю' })
    update(@Param('id') id: string, @Body() updateHotelDto: UpdateHotelDto) {
        return this.hotelsService.update(id, updateHotelDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Видалити готель' })
    remove(@Param('id') id: string) {
        return this.hotelsService.remove(id);
    }
}