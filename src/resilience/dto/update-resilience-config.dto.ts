import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PROTECTIONS, Protection } from '../resilience-config.service';

/** Часткова зміна конфігурації захисту кешу (Лаб. №8). Незадані поля не змінюються. */
export class UpdateResilienceConfigDto {
    @ApiPropertyOptional({ enum: PROTECTIONS, example: 'lock', description: 'none / singleflight / lock / swr' })
    @IsOptional()
    @IsIn(PROTECTIONS)
    protection?: Protection;

    @ApiPropertyOptional({ example: true, description: 'TTL Jittering: TTL = base ± jitter' })
    @IsOptional()
    @IsBoolean()
    jitter?: boolean;

    @ApiPropertyOptional({ example: true, description: 'Negative Caching: кешувати «не знайдено»' })
    @IsOptional()
    @IsBoolean()
    negativeCache?: boolean;

    @ApiPropertyOptional({ example: 60 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(86400)
    statsTtlSec?: number;

    @ApiPropertyOptional({ example: 15 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(86400)
    statsJitterSec?: number;

    @ApiPropertyOptional({ example: 30 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(3600)
    negativeTtlSec?: number;

    @ApiPropertyOptional({ example: 60 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(86400)
    swrStaleSec?: number;

    @ApiPropertyOptional({ example: 5000 })
    @IsOptional()
    @IsInt()
    @Min(100)
    @Max(60000)
    lockTtlMs?: number;

    @ApiPropertyOptional({ example: 3000 })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(60000)
    lockWaitMs?: number;

    @ApiPropertyOptional({ example: 200, description: 'Модель коштовного запиту статистики (pg_sleep), мс' })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(5000)
    statsQueryCostMs?: number;
}
