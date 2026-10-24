import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Consistency, DbRouter } from './db-router.service';
import { requestContext, RequestContext } from './request-context';

describe('DbRouter (Read/Write Separation)', () => {
    let primary: { name: string; $queryRaw: jest.Mock };
    let replica: { name: string; enabled: boolean; $queryRaw: jest.Mock };
    let cache: { setFlag: jest.Mock; hasFlag: jest.Mock };
    let router: DbRouter;

    // Запит, що повертає назву вузла, на якому він виконався
    const whichNode = (db: any) => Promise.resolve(db.name as string);

    const connectionError = () =>
        new Prisma.PrismaClientKnownRequestError("Can't reach database server at `db-replica:5432`", {
            code: 'P1001',
            clientVersion: 'test',
        });

    const makeContext = (sessionId: string): RequestContext => ({
        sessionId,
        res: { headersSent: false, setHeader: jest.fn() } as any,
        nodes: new Set(),
        routes: new Set(),
    });

    const inSession = <T>(sessionId: string, fn: () => Promise<T>) => requestContext.run(makeContext(sessionId), fn);

    const build = (replicaEnabled = true) => {
        primary = { name: 'primary', $queryRaw: jest.fn().mockResolvedValue([1]) };
        replica = { name: 'replica', enabled: replicaEnabled, $queryRaw: jest.fn().mockResolvedValue([1]) };
        cache = { setFlag: jest.fn().mockResolvedValue(undefined), hasFlag: jest.fn().mockResolvedValue(false) };
        router = new DbRouter(primary as any, replica as any, cache as any);
    };

    beforeEach(() => build());

    it('eventual-читання йде на Replica, strong — на Primary', async () => {
        await expect(router.read(whichNode)).resolves.toBe('replica');
        await expect(router.read(whichNode, Consistency.STRONG)).resolves.toBe('primary');
    });

    it('запис завжди виконується на Primary', async () => {
        await expect(router.write(whichNode)).resolves.toBe('primary');
    });

    it('Sticky Routing: після запису сесія читає з Primary, інші сесії — з Replica', async () => {
        await inSession('alice', () => router.write(whichNode));

        await expect(inSession('alice', () => router.read(whichNode))).resolves.toBe('primary');
        await expect(inSession('bob', () => router.read(whichNode))).resolves.toBe('replica');
        expect(cache.setFlag).toHaveBeenCalledWith('booking:ryw:alice', 5000);
    });

    it('Sticky Routing працює між інстансами через прапорець у Redis', async () => {
        cache.hasFlag.mockResolvedValue(true); // запис обробив інший інстанс API
        await expect(inSession('alice', () => router.read(whichNode))).resolves.toBe('primary');
    });

    it('заголовки X-DB-Node / X-DB-Route показують, куди пішов запит', async () => {
        const ctx = makeContext('carol');
        await requestContext.run(ctx, () => router.read(whichNode));
        expect(ctx.res.setHeader).toHaveBeenCalledWith('X-DB-Node', 'replica');
        expect(ctx.res.setHeader).toHaveBeenCalledWith('X-DB-Route', 'eventual');
    });

    it('Primary Fallback: помилка з\'єднання з Replica → читання з Primary, Replica виключається', async () => {
        const query = jest.fn((db: any) => (db.name === 'replica' ? Promise.reject(connectionError()) : whichNode(db)));

        await expect(router.read(query)).resolves.toBe('primary');
        expect(router.getState().readsFrom).toBe('primary (fallback)');

        // Наступне читання одразу йде на Primary, не чекаючи на помилку Replica
        query.mockClear();
        await expect(router.read(query)).resolves.toBe('primary');
        expect(query).toHaveBeenCalledTimes(1);
    });

    it('health check повертає Replica в ротацію після відновлення', async () => {
        replica.$queryRaw.mockRejectedValueOnce(connectionError());
        await router.checkHealth();
        await expect(router.read(whichNode)).resolves.toBe('primary');

        await router.checkHealth(); // Replica знову відповідає
        await expect(router.read(whichNode)).resolves.toBe('replica');
    });

    it('Read-Only Mode: без Primary записи → 503, eventual-читання з Replica працюють', async () => {
        await expect(router.write(() => Promise.reject(connectionError()))).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(router.getState().mode).toBe('read-only');

        // Подальші записи відхиляються одразу, без звернення до БД
        const mutation = jest.fn(whichNode);
        await expect(router.write(mutation)).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect(mutation).not.toHaveBeenCalled();

        await expect(router.read(whichNode)).resolves.toBe('replica');
        await expect(router.read(whichNode, Consistency.STRONG)).rejects.toBeInstanceOf(ServiceUnavailableException);
        // Наповнення кешу (primary-preferred) деградує до Replica замість помилки
        await expect(router.read(whichNode, Consistency.PRIMARY_PREFERRED)).resolves.toBe('replica');
    });

    it('перевантаження пулу (P2024) не вважається відмовою вузла', async () => {
        const poolTimeout = new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection', {
            code: 'P2024',
            clientVersion: 'test',
        });
        await expect(router.read(() => Promise.reject(poolTimeout))).rejects.toBe(poolTimeout);
        expect(router.getState().readsFrom).toBe('replica');
    });

    it('Single Primary Topology: без DATABASE_REPLICA_URL усе читається з Primary', async () => {
        build(false);
        await expect(router.read(whichNode)).resolves.toBe('primary');
        expect(router.getState().topology).toBe('single-primary');
    });
});
