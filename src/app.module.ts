import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './cache/cache.module';
import { DatabaseModule } from './database/database.module';
import { RequestContextMiddleware } from './database/request-context';
import { ShardingModule } from './sharding/sharding.module';
import { ResilienceModule } from './resilience/resilience.module';
import { HotelsModule } from './hotels/hotels.module';
import { RoomsModule } from './rooms/rooms.module';
import { GuestsModule } from './guests/guests.module';
import { BookingsModule } from './bookings/bookings.module';
import { HealthModule } from './health/health.module';
import { InstanceIdMiddleware } from './common/middleware/instance-id.middleware';
import { SyntheticDelayMiddleware } from './common/middleware/synthetic-delay.middleware';
import { ObservabilityModule } from './observability/observability.module';
import { HttpObservabilityMiddleware } from './observability/http-observability.middleware';

@Module({
    imports: [
        ObservabilityModule,
        PrismaModule,
        CacheModule,
        DatabaseModule,
        ShardingModule,
        ResilienceModule,
        HotelsModule,
        RoomsModule,
        GuestsModule,
        BookingsModule,
        HealthModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer
            // HttpObservabilityMiddleware першим: тривалість у метриках включає всі інші middleware
            .apply(HttpObservabilityMiddleware, RequestContextMiddleware, InstanceIdMiddleware, SyntheticDelayMiddleware)
            .forRoutes('*');
    }
}