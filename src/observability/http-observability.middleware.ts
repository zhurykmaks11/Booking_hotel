import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';
import { writeJsonLine } from './json-logger';
import { isServicePath, logFormat, pathOf } from './observability.constants';

/**
 * Шаблон маршруту, який обробив запит: /hotels/:id. Express заповнює req.route, коли маршрут знайдено;
 * для неіснуючих шляхів (404) — одна мітка 'unmatched', щоб сканери URL не створювали нові часові ряди.
 */
export function routeTemplate(req: Request): string {
    const route = (req.route as { path?: unknown } | undefined)?.path;
    if (typeof route !== 'string') return 'unmatched';
    return `${req.baseUrl ?? ''}${route}` || '/';
}

/**
 * Метрики й лог кожного запиту (DevOps, Лаб. №7, пп. 2–3). Підписка на 'finish' — уже відомі статус,
 * тривалість і маршрут, включно з відповідями фільтрів винятків (404, 500 від FAIL_RATE).
 */
@Injectable()
export class HttpObservabilityMiddleware implements NestMiddleware {
    private readonly jsonLogs = logFormat() === 'json';

    constructor(private readonly metrics: MetricsService) {}

    use(req: Request, res: Response, next: NextFunction) {
        const path = pathOf(req.originalUrl);
        if (isServicePath(path)) return next();

        const start = process.hrtime.bigint();
        res.once('finish', () => {
            const seconds = Number(process.hrtime.bigint() - start) / 1e9;
            const route = routeTemplate(req);
            this.metrics.observe(req.method, route, res.statusCode, seconds);
            if (this.jsonLogs) {
                writeJsonLine({
                    level: res.statusCode >= 500 ? 'error' : 'info',
                    msg: 'request',
                    method: req.method,
                    route,
                    path,
                    status: res.statusCode,
                    duration_ms: Math.round(seconds * 10000) / 10,
                });
            }
        });
        next();
    }
}
