import { CallHandler, ExecutionContext, Injectable, InternalServerErrorException, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { failRate, isServicePath, pathOf } from './observability.constants';

/**
 * Впорскування збоїв (DevOps, Лаб. №7, п. 6): з імовірністю FAIL_RATE под відповідає 500 замість обробки.
 * Імітує «погану версію» для перевірки автоматичного відкату Argo Rollouts за метриками.
 * Інтерсептор, а не middleware: маршрут уже знайдено, тож у метриках і логах буде /hotels/:id, а не 'unmatched'.
 * /health і /metrics не зачіпаються — под лишається Ready, Prometheus його скрейпить.
 */
@Injectable()
export class FailureInjectionInterceptor implements NestInterceptor {
    private readonly rate = failRate();
    /** Підміняється в тестах. */
    random: () => number = Math.random;

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (this.rate > 0 && context.getType() === 'http') {
            const req = context.switchToHttp().getRequest<Request>();
            if (!isServicePath(pathOf(req.originalUrl)) && this.random() < this.rate) {
                throw new InternalServerErrorException('injected failure (FAIL_RATE)');
            }
        }
        return next.handle();
    }
}
