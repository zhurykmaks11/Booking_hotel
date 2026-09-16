import { IsString, IsNotEmpty, IsNumber, Min, Max, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateHotelDto {
    @ApiProperty({ example: 'Готель "Дніпро"' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ example: 'вул. Хрещатик, 1' })
    @IsString()
    @IsNotEmpty()
    address: string;

    @ApiProperty({ example: 'Kyiv' })
    @IsString()
    @IsNotEmpty()
    city: string;

    @ApiPropertyOptional({ example: 4.5, minimum: 0, maximum: 5 })
    @IsNumber()
    @Min(0)
    @Max(5)
    @IsOptional()
    rating?: number;
}