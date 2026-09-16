import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';

@ApiTags('bookings')
@Controller('bookings')
export class BookingsController {
    constructor(private readonly bookingsService: BookingsService) {}

    @Post()
    @ApiOperation({ summary: 'Створити бронювання (з перевіркою доступності номера)' })
    @ApiResponse({ status: 201, description: 'Бронювання створено' })
    @ApiResponse({ status: 400, description: 'checkOutDate раніше за checkInDate' })
    @ApiResponse({ status: 404, description: 'Номер або гостя не знайдено' })
    @ApiResponse({ status: 409, description: 'Номер вже заброньовано на ці дати' })
    create(@Body() createBookingDto: CreateBookingDto) {
        return this.bookingsService.create(createBookingDto);
    }

    @Get()
    @ApiOperation({ summary: 'Отримати список усіх бронювань' })
    findAll() {
        return this.bookingsService.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Отримати бронювання за id' })
    @ApiResponse({ status: 404, description: 'Бронювання не знайдено' })
    findOne(@Param('id') id: string) {
        return this.bookingsService.findOne(id);
    }

    @Patch(':id/cancel')
    @ApiOperation({ summary: 'Скасувати бронювання' })
    @ApiResponse({ status: 200, description: 'Бронювання скасовано' })
    @ApiResponse({ status: 409, description: 'Бронювання вже скасовано або завершено' })
    cancel(@Param('id') id: string) {
        return this.bookingsService.cancel(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Оновити бронювання' })
    update(@Param('id') id: string, @Body() updateBookingDto: UpdateBookingDto) {
        return this.bookingsService.update(id, updateBookingDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Видалити бронювання' })
    remove(@Param('id') id: string) {
        return this.bookingsService.remove(id);
    }
}