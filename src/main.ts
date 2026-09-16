import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

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
        .setVersion('1.0')
        .addTag('hotels', 'Управління готелями')
        .addTag('rooms', 'Управління номерами та пошук')
        .addTag('guests', 'Управління гостями')
        .addTag('bookings', 'Бронювання номерів')
        .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    await app.listen(3000);
}
bootstrap();