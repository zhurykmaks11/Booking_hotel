import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RelocateBookingDto {
    @ApiProperty({ example: '1fa739ab-4589-449b-a40c-652ceb900840', description: 'ID нового номера (може бути в готелі на іншому шарді)' })
    @IsUUID()
    roomId: string;

    @ApiPropertyOptional({
        example: false,
        description: 'Демонстрація компенсації Saga: збій перед кроком T2 (лише при SAGA_FAULT_INJECTION=true)',
    })
    @IsOptional()
    @IsBoolean()
    simulateFailure?: boolean;
}
