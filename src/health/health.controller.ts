import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import * as os from 'os';

@ApiTags('health')
@Controller('health')
export class HealthController {
    private readonly instanceId = os.hostname();
    private readonly startTime = Date.now();

    constructor(
        private readonly prisma: PrismaService,
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

    // Readiness-проба Kubernetes: под отримує трафік лише коли доступна БД.
    @Get()
    @ApiOperation({ summary: 'Перевірка готовності сервісу та доступності бази даних' })
    @ApiResponse({ status: 200, description: 'Сервіс працює коректно' })
    @ApiResponse({ status: 503, description: 'Сервіс недоступний (помилка БД)' })
    async checkHealth(@Res() res: Response) {
        const start = Date.now();
        let dbStatus = 'CONNECTED';
        let isHealthy = true;

        try {
            // Перевіряємо реальне з'єднання з PostgreSQL через Prisma
            await this.prisma.$queryRaw`SELECT 1`;
        } catch {
            dbStatus = 'DISCONNECTED';
            isHealthy = false;
        }

        const dbResponseMs = Date.now() - start;
        const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);

        const payload = {
            status: isHealthy ? 'UP' : 'DOWN',
            instanceId: this.instanceId,
            database: dbStatus,
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
