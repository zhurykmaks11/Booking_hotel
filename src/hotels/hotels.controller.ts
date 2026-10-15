import { Controller, Get, Post, Body, Patch, Param, Delete, Res } from '@nestjs/common';
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
    @ApiResponse({ status: 200, description: 'Готель знайдено. Заголовок X-Cache: HIT (Redis) / MISS (БД) / BYPASS (Redis недоступний)' })
    @ApiResponse({ status: 404, description: 'Готель не знайдено' })
    async findOne(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
        const { data, cache, key } = await this.hotelsService.findOneCached(id);
        res.setHeader('X-Cache', cache);
        res.setHeader('X-Cache-Key', key);
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