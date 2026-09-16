import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RoomsService } from './rooms.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { SearchRoomDto } from './dto/search-room.dto';

@ApiTags('rooms')
@Controller('rooms')
export class RoomsController {
    constructor(private readonly roomsService: RoomsService) {}

    @Post()
    @ApiOperation({ summary: 'Додати номер до готелю' })
    @ApiResponse({ status: 201, description: 'Номер створено' })
    @ApiResponse({ status: 404, description: 'Готель не знайдено' })
    @ApiResponse({ status: 409, description: 'Номер з таким номером вже існує в готелі' })
    create(@Body() createRoomDto: CreateRoomDto) {
        return this.roomsService.create(createRoomDto);
    }

    @Get()
    @ApiOperation({ summary: 'Отримати список усіх номерів' })
    findAll() {
        return this.roomsService.findAll();
    }

    @Get('search')
    @ApiOperation({ summary: 'Пошук вільних номерів за критеріями (місто, дати, кількість гостей)' })
    @ApiResponse({ status: 200, description: 'Список вільних номерів' })
    search(@Query() searchRoomDto: SearchRoomDto) {
        return this.roomsService.search(searchRoomDto);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Отримати номер за id' })
    @ApiResponse({ status: 404, description: 'Номер не знайдено' })
    findOne(@Param('id') id: string) {
        return this.roomsService.findOne(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Оновити дані номера' })
    update(@Param('id') id: string, @Body() updateRoomDto: UpdateRoomDto) {
        return this.roomsService.update(id, updateRoomDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Видалити номер' })
    remove(@Param('id') id: string) {
        return this.roomsService.remove(id);
    }
}