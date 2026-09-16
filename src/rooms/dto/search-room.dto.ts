import { IsString, IsOptional, IsDateString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';

export class SearchRoomDto {
    @ApiPropertyOptional({ example: 'Kyiv' })
    @IsString()
    @IsOptional()
    city?: string;

    @ApiProperty({ example: '2026-10-01' })
    @IsDateString()
    checkIn: string;

    @ApiProperty({ example: '2026-10-05' })
    @IsDateString()
    checkOut: string;

    @ApiPropertyOptional({ example: 2 })
    @IsInt()
    @Min(1)
    @IsOptional()
    @Type(() => Number)
    guests?: number;
}