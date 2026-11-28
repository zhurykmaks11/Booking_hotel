import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

/** GET /metrics — формат Prometheus; скрейпить ServiceMonitor кожні 15 с (DevOps, Лаб. №7). */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
    constructor(private readonly metrics: MetricsService) {}

    @Get()
    async scrape(@Res() res: Response) {
        res.setHeader('Content-Type', this.metrics.contentType);
        res.send(await this.metrics.metrics());
    }
}
