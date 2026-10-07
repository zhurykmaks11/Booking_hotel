import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class SyntheticDelayMiddleware implements NestMiddleware {
    use(req: Request, res: Response, next: NextFunction) {
        // Отримуємо затримку зі змінної середовища або HTTP-заголовка
        const envDelay = parseInt(process.env.SYNTHETIC_DELAY_MS || '0', 10);
        const headerDelay = parseInt((req.headers['x-synthetic-delay'] as string) || '0', 10);
        const delay = headerDelay > 0 ? headerDelay : envDelay;

        if (delay > 0) {
            setTimeout(next, delay);
        } else {
            next();
        }
    }
}
