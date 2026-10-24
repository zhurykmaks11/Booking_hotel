import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DbRouter } from '../database/db-router.service';
import { CacheService } from '../cache/cache.service';
import * as os from 'os';

@ApiTags('health')
@Controller('health')
export class HealthController {
    private readonly instanceId = os.hostname();
    private readonly startTime = Date.now();

    constructor(
        private readonly db: DbRouter,
        private readonly cache: CacheService,
    ) {}

    // Liveness-проба Kubernetes: лише "процес живий і відповідає".
    // НЕ звертається до БД — інакше збій Postgres призвів би до рестарту всіх подів API.
    @Get('live')
    @ApiOperation({ summary: 'Liveness: процес працює (без перевірки залежностей)' })
    @ApiResponse({ status: 200, description: 'Процес живий' })
    live() {
        return { status: 'UP', instanceId: this.instanceId };
    }

    // Readiness-проба Kubernetes: под отримує трафік, поки доступний хоча б один вузол БД.
    // Лаб. №6: без Primary сервіс працює в Read-Only Mode (DEGRADED), без Replica — читає з Primary.
    @Get()
    @ApiOperation({ summary: 'Перевірка готовності сервісу та доступності вузлів БД (Primary / Replica)' })
    @ApiResponse({ status: 200, description: 'UP — усе працює; DEGRADED — недоступна Replica (Primary Fallback) або Primary (Read-Only Mode)' })
    @ApiResponse({ status: 503, description: 'Сервіс недоступний (немає жодного вузла БД)' })
    async checkHealth(@Res() res: Response) {
        const start = Date.now();
        // Активна перевірка Primary і Replica (оновлює стан маршрутизатора)
        const db = await this.db.checkHealth();

        const dbResponseMs = Date.now() - start;
        const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
        const primaryUp = db.nodes.primary.healthy;
        const replicaDown = db.topology === 'primary+replica' && !db.nodes.replica['healthy'];
        const isHealthy = db.mode !== 'unavailable';

        const payload = {
            status: !isHealthy ? 'DOWN' : !primaryUp || replicaDown ? 'DEGRADED' : 'UP',
            instanceId: this.instanceId,
            database: primaryUp ? 'CONNECTED' : 'DISCONNECTED',
            dbMode: db.mode,
            dbTopology: db.topology,
            readsFrom: db.readsFrom,
            replica: db.topology === 'primary+replica' ? (replicaDown ? 'DISCONNECTED' : 'CONNECTED') : 'DISABLED',
            dbResponseMs: `${dbResponseMs}ms`,
            uptime: `${uptimeSec}s`,
            timestamp: new Date().toISOString(),
            // Стан кешу не впливає на status: без Redis сервіс працює напряму з БД
            cache: this.cache.getStats(),
        };

        return res
            .status(isHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
            .json(payload);
    }
}
