import { IsString, IsNotEmpty, IsEnum, IsNumber, Min, IsInt, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RoomType } from '@prisma/client';

export class CreateRoomDto {
    @ApiProperty({ example: 'b8b57876-a32f-4a00-8c34-fbec460de956', description: 'ID готелю' })
    @IsUUID()
    hotelId: string;

    @ApiProperty({ example: '101' })
    @IsString()
    @IsNotEmpty()
    roomNumber: string;

    @ApiProperty({ enum: RoomType, example: RoomType.DOUBLE })
    @IsEnum(RoomType)
    type: RoomType;

    @ApiProperty({ example: 1500, description: 'Ціна за ніч, грн' })
    @IsNumber()
    @Min(0)
    pricePerNight: number;

    @ApiProperty({ example: 2, description: 'Максимальна кількість гостей' })
    @IsInt()
    @Min(1)
    capacity: number;
}