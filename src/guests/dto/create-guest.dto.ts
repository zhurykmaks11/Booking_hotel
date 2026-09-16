import { IsString, IsNotEmpty, IsEmail, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGuestDto {
    @ApiProperty({ example: 'Іван Петренко' })
    @IsString()
    @IsNotEmpty()
    fullName: string;

    @ApiProperty({ example: 'ivan@test.com' })
    @IsEmail()
    email: string;

    @ApiPropertyOptional({ example: '+380991234567' })
    @IsString()
    @IsOptional()
    phone?: string;
}