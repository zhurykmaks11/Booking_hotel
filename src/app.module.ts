import {MiddlewareConsumer, Module, NestMiddleware, NestModule} from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { HotelsModule } from './hotels/hotels.module';
import { RoomsModule } from './rooms/rooms.module';
import { GuestsModule } from './guests/guests.module';
import { BookingsModule } from './bookings/bookings.module';
import { InstanceIdMiddleware} from "./common/middleware/instance-id.middleware";

@Module({
    imports: [
        PrismaModule,
        HotelsModule,
        RoomsModule,
        GuestsModule,
        BookingsModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})

export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer){
        consumer.apply(InstanceIdMiddleware).forRoutes('*');
    }
}