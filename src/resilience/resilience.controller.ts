import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import * as os from 'os';
import { CacheService } from '../cache/cache.service';
import { CacheKeys } from '../cache/cache-keys';
import { ResilienceConfigService } from './resilience-config.service';
import { ResilientCacheService } from './resilient-cache.service';
import { UpdateResilienceConfigDto } from './dto/update-resilience-config.dto';

export class ExpireDto {
    @ApiPropertyOptional({ enum: ['stats', 'hotel'], example: 'stats' })
    @IsOptional()
    @IsIn(['stats', 'hotel'])
    resource?: 'stats' | 'hotel';

    @ApiPropertyOptional({ type: [String], description: 'id готелів; без ids — усі ключі ресурсу' })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(1000)
    @IsString({ each: true })
    ids?: string[];
}

/**
 * Керування експериментом Лаб. №8: режим захисту, примусове вигасання ключів і лічильники.
 * Змінювати стан можна лише з RESILIENCE_ADMIN=true (як SAGA_FAULT_INJECTION у Лаб. №7).
 */
@ApiTags('resilience')
@Controller('resilience')
export class ResilienceController {
    constructor(
        private readonly config: ResilienceConfigService,
        private readonly resilientCache: ResilientCacheService,
        private readonly cache: CacheService,
    ) {}

    @Get()
    @ApiOperation({ summary: 'Поточна конфігурація захисту і лічильники (спільні для всіх інстансів)' })
    async status() {
        return { instanceId: os.hostname(), config: this.config.current, metrics: await this.config.metrics() };
    }

    @Put('config')
    @ApiOperation({ summary: 'Змінити режим захисту / jitter / negative caching без перезапуску' })
    update(@Body() dto: UpdateResilienceConfigDto) {
        this.assertAdmin();
        return this.config.update(dto);
    }

    @Post('config/reset')
    @HttpCode(200)
    @ApiOperation({ summary: 'Повернути конфігурацію зі змінних середовища' })
    resetConfig() {
        this.assertAdmin();
        return this.config.reset();
    }

    @Post('metrics/reset')
    @HttpCode(200)
    @ApiOperation({ summary: 'Обнулити лічильники' })
    async resetMetrics() {
        this.assertAdmin();
        await this.config.resetMetrics();
        return { reset: true };
    }

    @Post('expire')
    @HttpCode(200)
    @ApiOperation({ summary: 'Force Expire: видалити ключі кешу (і їхні блокування) — холодний кеш для експерименту' })
    async expire(@Body() dto: ExpireDto) {
        this.assertAdmin();
        const resource = dto.resource ?? 'stats';
        const keyOf = resource === 'stats' ? CacheKeys.hotelStats : CacheKeys.hotel;
        let keys = (dto.ids ?? []).map(keyOf);
        if (!dto.ids?.length) keys = await this.scan(resource === 'stats' ? CacheKeys.hotelStatsPattern : `${keyOf('')}*`);
        return { resource, deleted: await this.resilientCache.expire(keys) };
    }

    private async scan(pattern: string): Promise<string[]> {
        const redis = this.cache.redis;
        if (!redis) return [];
        const keys: string[] = [];
        let cursor = '0';
        do {
            const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
            cursor = next;
            keys.push(...batch.filter((k) => !k.endsWith(':lock')));
        } while (cursor !== '0');
        return keys;
    }

    private assertAdmin() {
        if (process.env.RESILIENCE_ADMIN !== 'true') {
            throw new ForbiddenException('Керування експериментом доступне лише з RESILIENCE_ADMIN=true');
        }
    }
}
