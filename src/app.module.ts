import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './cache/cache.module';
import { DatabaseModule } from './database/database.module';
import { RequestContextMiddleware } from './database/request-context';
import { HotelsModule } from './hotels/hotels.module';
import { RoomsModule } from './rooms/rooms.module';
import { GuestsModule } from './guests/guests.module';
import { BookingsModule } from './bookings/bookings.module';
import { HealthModule } from './health/health.module';
import { InstanceIdMiddleware } from './common/middleware/instance-id.middleware';
import { SyntheticDelayMiddleware } from './common/middleware/synthetic-delay.middleware';

@Module({
    imports: [
        PrismaModule,
        CacheModule,
        DatabaseModule,
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
            .apply(RequestContextMiddleware, InstanceIdMiddleware, SyntheticDelayMiddleware)
            .forRoutes('*');
    }
}