import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ReplicationService } from './replication.service';

@ApiTags('replication')
@Controller('replication')
export class ReplicationController {
    constructor(private readonly replication: ReplicationService) {}

    @Get('status')
    @ApiOperation({ summary: 'Стан Primary / Replica, позиції WAL (LSN), Replication Lag і статистика маршрутизації' })
    @ApiResponse({ status: 200, description: 'Знімок стану реплікації (недоступний вузол позначається reachable: false)' })
    status() {
        return this.replication.status();
    }
}
