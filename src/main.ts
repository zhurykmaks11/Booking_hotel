import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { JsonLogger } from './observability/json-logger';
import { logFormat } from './observability/observability.constants';

async function bootstrap() {
    // DevOps, Лаб. №7: у Kubernetes (NODE_ENV=production або LOG_FORMAT=json) логи — JSON у stdout для Loki
    const app = await NestFactory.create(AppModule, logFormat() === 'json' ? { logger: new JsonLogger() } : {});

    // Коректне завершення по SIGTERM (Kubernetes при rolling update / видаленні пода)
    app.enableShutdownHooks();

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }),
    );

    const config = new DocumentBuilder()
        .setTitle('Hotel Booking API')
        .setDescription('API для системи бронювання номерів у готелі')
        .setVersion(process.env.APP_VERSION ?? 'dev')
        .addTag('hotels', 'Управління готелями')
        .addTag('rooms', 'Управління номерами та пошук')
        .addTag('guests', 'Управління гостями')
        .addTag('bookings', 'Бронювання номерів')
        .addTag('replication', 'Реплікація БД: Primary / Replica, Replication Lag')
        .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    await app.listen(parseInt(process.env.PORT ?? '3000', 10));
}
void bootstrap();
