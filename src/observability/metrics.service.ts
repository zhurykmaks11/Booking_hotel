import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Метрики HTTP для Prometheus (DevOps, Лаб. №7):
 *  - http_requests_total{method, route, status} — лічильник запитів (RPS, частка 5xx);
 *  - http_request_duration_seconds{route}       — гістограма затримки (p95 через histogram_quantile).
 * route — ШАБЛОН маршруту (/hotels/:id), а не URL: з id у мітці кількість часових рядів росла б без меж.
 * Мітки namespace / pod / service додає сам Prometheus з ServiceMonitor.
 */
@Injectable()
export class MetricsService {
    readonly registry = new Registry();

    private readonly requests = new Counter({
        name: 'http_requests_total',
        help: 'Кількість HTTP-запитів',
        labelNames: ['method', 'route', 'status'] as const,
        registers: [this.registry],
    });

    private readonly duration = new Histogram({
        name: 'http_request_duration_seconds',
        help: 'Тривалість обробки HTTP-запиту, с',
        labelNames: ['route'] as const,
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
        registers: [this.registry],
    });

    constructor() {
        // Метрики процесу Node.js: CPU, пам'ять, event loop lag, GC
        collectDefaultMetrics({ register: this.registry });
    }

    observe(method: string, route: string, status: number, seconds: number) {
        this.requests.inc({ method, route, status: String(status) });
        this.duration.observe({ route }, seconds);
    }

    get contentType(): string {
        return this.registry.contentType;
    }

    metrics(): Promise<string> {
        return this.registry.metrics();
    }
}
