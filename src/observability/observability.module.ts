import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { FailureInjectionInterceptor } from './failure-injection.interceptor';
import { HttpObservabilityMiddleware } from './http-observability.middleware';

/**
 * Observability (DevOps, Лаб. №7): /metrics, метрики й JSON-лог кожного запиту, FAIL_RATE.
 * HttpObservabilityMiddleware підключається в AppModule.configure() першим — щоб тривалість
 * включала всі інші middleware (у т. ч. SYNTHETIC_DELAY_MS).
 */
@Global()
@Module({
    controllers: [MetricsController],
    providers: [MetricsService, HttpObservabilityMiddleware, { provide: APP_INTERCEPTOR, useClass: FailureInjectionInterceptor }],
    exports: [MetricsService],
})
export class ObservabilityModule {}
