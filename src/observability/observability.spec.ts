import { Controller, Get, INestApplication, MiddlewareConsumer, Module, NestModule, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ObservabilityModule } from './observability.module';
import { HttpObservabilityMiddleware, routeTemplate } from './http-observability.middleware';
import { FailureInjectionInterceptor } from './failure-injection.interceptor';
import { JsonLogger } from './json-logger';
import { failRate, isServicePath, logFormat, pathOf } from './observability.constants';

@Controller()
class DemoController {
    @Get('items/:id')
    item(@Param('id') id: string) {
        return { id };
    }
    @Get('health')
    health() {
        return { status: 'UP' };
    }
}

@Module({ imports: [ObservabilityModule], controllers: [DemoController] })
class DemoModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(HttpObservabilityMiddleware).forRoutes('*');
    }
}

async function createApp(env: Record<string, string> = {}) {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
        const moduleRef = await Test.createTestingModule({ imports: [DemoModule] }).compile();
        const app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        return app;
    } finally {
        process.env = saved;
    }
}

const scrape = async (app: INestApplication) => (await request(app.getHttpServer()).get('/metrics').expect(200)).text;

describe('Observability (DevOps, Лаб. №7)', () => {
    let app: INestApplication;
    let stdout: jest.SpyInstance;

    beforeEach(() => {
        stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });
    afterEach(async () => {
        stdout.mockRestore();
        await app?.close();
    });

    it('рахує запит із ШАБЛОНОМ маршруту, а не URL', async () => {
        app = await createApp();
        await request(app.getHttpServer()).get('/items/42?x=1').expect(200);
        await request(app.getHttpServer()).get('/items/43').expect(200);

        const text = await scrape(app);
        expect(text).toContain('http_requests_total{method="GET",route="/items/:id",status="200"} 2');
        expect(text).toContain('http_request_duration_seconds_count{route="/items/:id"} 2');
        expect(text).not.toContain('/items/42');
    });

    it('неіснуючий шлях — одна мітка unmatched (без росту кардинальності)', async () => {
        app = await createApp();
        await request(app.getHttpServer()).get('/random/a').expect(404);
        await request(app.getHttpServer()).get('/random/b').expect(404);

        expect(await scrape(app)).toContain('http_requests_total{method="GET",route="unmatched",status="404"} 2');
    });

    it('/metrics і /health не потрапляють у метрики', async () => {
        app = await createApp();
        await request(app.getHttpServer()).get('/health').expect(200);
        await scrape(app);

        const text = await scrape(app);
        expect(text).toContain('# TYPE http_requests_total counter');
        expect(text).not.toMatch(/http_requests_total\{/);
        expect(text).toContain('process_cpu_user_seconds_total');
    });

    it('JSON-лог запиту: один об\'єкт на рядок з route, status, duration_ms', async () => {
        app = await createApp({ LOG_FORMAT: 'json' });
        await request(app.getHttpServer()).get('/items/7').expect(200);

        const lines = stdout.mock.calls.map(([chunk]) => String(chunk)).filter((l) => l.includes('"msg":"request"'));
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]);
        expect(entry).toMatchObject({ level: 'info', method: 'GET', route: '/items/:id', path: '/items/7', status: 200 });
        expect(typeof entry.duration_ms).toBe('number');
        expect(entry.version).toBeDefined();
    });

    it('без LOG_FORMAT=json логи запитів не пишуться (локальна розробка)', async () => {
        app = await createApp({ LOG_FORMAT: 'text' });
        await request(app.getHttpServer()).get('/items/7').expect(200);
        expect(stdout.mock.calls.some(([chunk]) => String(chunk).includes('"msg":"request"'))).toBe(false);
    });

    it('FAIL_RATE=1: 500 на запити застосунку, але /health лишається 200', async () => {
        app = await createApp({ FAIL_RATE: '1', LOG_FORMAT: 'json' });
        await request(app.getHttpServer()).get('/items/1').expect(500);
        await request(app.getHttpServer()).get('/health').expect(200);

        expect(await scrape(app)).toContain('http_requests_total{method="GET",route="/items/:id",status="500"} 1');
        const errorLine = stdout.mock.calls.map(([c]) => String(c)).find((l) => l.includes('"status":500'));
        expect(JSON.parse(errorLine!)).toMatchObject({ level: 'error', route: '/items/:id' });
    });

});

describe('FailureInjectionInterceptor', () => {
    const ctxFor = (originalUrl: string) =>
        ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ originalUrl }) }) }) as never;
    const next = { handle: () => 'ok' } as never;

    const withFailRate = (value: string) => {
        process.env.FAIL_RATE = value;
        try {
            return new FailureInjectionInterceptor();
        } finally {
            delete process.env.FAIL_RATE;
        }
    };

    it('FAIL_RATE=0.5: збій лише коли random() < 0.5', () => {
        const interceptor = withFailRate('0.5');
        interceptor.random = () => 0.7;
        expect(interceptor.intercept(ctxFor('/items/1'), next)).toBe('ok');
        interceptor.random = () => 0.3;
        expect(() => interceptor.intercept(ctxFor('/items/1'), next)).toThrow('injected failure');
        expect(interceptor.intercept(ctxFor('/health/live'), next)).toBe('ok');
    });

    it('FAIL_RATE не задано — запити не зачіпаються', () => {
        const interceptor = new FailureInjectionInterceptor();
        interceptor.random = () => 0;
        expect(interceptor.intercept(ctxFor('/items/1'), next)).toBe('ok');
    });
});

describe('JsonLogger', () => {
    it('пише контекст, рівень і stack', () => {
        const lines: string[] = [];
        const logger = new JsonLogger((l) => lines.push(l));
        logger.log('Nest application successfully started', 'NestApplication');
        logger.error('boom', 'Error: boom\n    at x', 'ExceptionsHandler');

        const [info, error] = lines.map((l) => JSON.parse(l));
        expect(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true);
        expect(info).toMatchObject({ level: 'info', msg: 'Nest application successfully started', context: 'NestApplication' });
        expect(error).toMatchObject({ level: 'error', msg: 'boom', context: 'ExceptionsHandler', stack: 'Error: boom\n    at x' });
    });
});

describe('observability helpers', () => {
    it('службові шляхи', () => {
        expect(isServicePath('/metrics')).toBe(true);
        expect(isServicePath('/health/live')).toBe(true);
        expect(isServicePath('/healthy')).toBe(false);
        expect(pathOf('/hotels/1/?a=b')).toBe('/hotels/1');
        expect(pathOf('/')).toBe('/');
    });

    it('LOG_FORMAT і FAIL_RATE', () => {
        expect(logFormat({ NODE_ENV: 'production' })).toBe('json');
        expect(logFormat({ NODE_ENV: 'production', LOG_FORMAT: 'text' })).toBe('text');
        expect(logFormat({})).toBe('text');
        expect(failRate({ FAIL_RATE: '0.5' })).toBe(0.5);
        expect(failRate({ FAIL_RATE: 'abc' })).toBe(0);
        expect(failRate({ FAIL_RATE: '7' })).toBe(1);
    });

    it('routeTemplate без знайденого маршруту — unmatched', () => {
        expect(routeTemplate({ baseUrl: '' } as never)).toBe('unmatched');
        expect(routeTemplate({ baseUrl: '', route: { path: '/hotels/:id' } } as never)).toBe('/hotels/:id');
    });
});
