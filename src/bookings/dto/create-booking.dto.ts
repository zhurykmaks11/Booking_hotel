import { IsUUID, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateBookingDto {
    @ApiProperty({ example: 'dea739ab-4589-449b-a40c-652ceb900840', description: 'ID номера' })
    @IsUUID()
    roomId: string;

    @ApiProperty({ example: '911485c7-6240-45c0-a6f5-19218a37d1f0', description: 'ID гостя' })
    @IsUUID()
    guestId: string;

    @ApiProperty({ example: '2026-10-01' })
    @IsDateString()
    checkInDate: string;

    @ApiProperty({ example: '2026-10-05' })
    @IsDateString()
    checkOutDate: string;
}