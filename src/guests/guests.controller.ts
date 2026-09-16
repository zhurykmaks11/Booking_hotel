import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { GuestsService } from './guests.service';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';

@ApiTags('guests')
@Controller('guests')
export class GuestsController {
    constructor(private readonly guestsService: GuestsService) {}

    @Post()
    @ApiOperation({ summary: 'Зареєструвати гостя' })
    @ApiResponse({ status: 201, description: 'Гостя зареєстровано' })
    @ApiResponse({ status: 409, description: 'Email вже використовується' })
    create(@Body() createGuestDto: CreateGuestDto) {
        return this.guestsService.create(createGuestDto);
    }

    @Get()
    @ApiOperation({ summary: 'Отримати список усіх гостей' })
    findAll() {
        return this.guestsService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Отримати гостя за id' })
    @ApiResponse({ status: 404, description: 'Гостя не знайдено' })
    findOne(@Param('id') id: string) {
        return this.guestsService.findOne(id);
    }

    @Get(':id/bookings')
    @ApiOperation({ summary: 'Отримати історію бронювань гостя' })
    findBookings(@Param('id') id: string) {
        return this.guestsService.findBookings(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Оновити дані гостя' })
    update(@Param('id') id: string, @Body() updateGuestDto: UpdateGuestDto) {
        return this.guestsService.update(id, updateGuestDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Видалити гостя' })
    remove(@Param('id') id: string) {
        return this.guestsService.remove(id);
    }
}