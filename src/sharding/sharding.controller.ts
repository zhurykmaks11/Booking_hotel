import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ShardingService } from './sharding.service';

@ApiTags('sharding')
@Controller('sharding')
export class ShardingController {
    constructor(private readonly sharding: ShardingService) {}

    @Get('status')
    @ApiOperation({ summary: 'Топологія шардів, стратегія, карта бакетів, стан вузлів і лічильники маршрутизації' })
    status() {
        return this.sharding.status();
    }

    @Get('route/:id')
    @ApiOperation({ summary: 'На який бакет і шард маршрутизується ID (готелю, номера або бронювання)' })
    route(@Param('id') id: string) {
        return this.sharding.route(id);
    }

    @Get('distribution')
    @ApiOperation({ summary: 'Dataset Distribution Matrix: записи, частка даних і частка Write Operations по шардах' })
    distribution() {
        return this.sharding.distribution();
    }

    @Get('analytics/hotels/:id')
    @ApiOperation({ summary: 'Shard-Local аналітика: номери, бронювання і виручка одного готелю (один шард)' })
    @ApiResponse({ status: 404, description: 'Готель не знайдено' })
    hotelStats(@Param('id') id: string) {
        return this.sharding.hotelStats(id);
    }

    @Get('analytics/cities')
    @ApiOperation({ summary: 'Cross-Shard аналітика (Scatter-Gather): готелі, бронювання і виручка за містами з усіх шардів' })
    cityAnalytics() {
        return this.sharding.cityAnalytics();
    }

    @Get('resharding')
    @ApiOperation({ summary: 'Модель решардингу: частка ключів, що переїжджає при N → M шардах (modulo / virtual buckets / consistent hashing)' })
    @ApiQuery({ name: 'keys', required: false, description: 'Кількість ключів у симуляції (1 000 – 500 000)', example: 100000 })
    resharding(@Query('keys') keys?: string) {
        return this.sharding.resharding(keys ? Number(keys) : undefined);
    }
}
