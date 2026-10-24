import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { ReplicaPrismaService } from './replica-prisma.service';
import { requestContext } from './request-context';

/**
 * Вимоги бізнес-операції до узгодженості читання (Лаб. №6, п. 2.3).
 *  EVENTUAL — допускає відставання на час Replication Lag: каталог, публічні списки, звіти → Replica.
 *  STRONG   — має бачити останній закомічений стан: підтвердження бронювання,
 *             перевірки перед записом (існування, унікальність, доступність) → Primary.
 *  PRIMARY_PREFERRED — свіжі дані з Primary, але при його відмові допустима Replica
 *             (наповнення кешу): у Read-Only Mode записів немає, тож Replica фактично актуальна.
 */
export enum Consistency {
    EVENTUAL = 'eventual',
    STRONG = 'strong',
    PRIMARY_PREFERRED = 'primary-preferred',
}

export type DbNode = 'primary' | 'replica';

/**
 * Чому запит пішов на конкретний вузол (заголовок X-DB-Route):
 *  eventual     — звичайне читання з Replica
 *  strong       — Explicit Primary Routing для критичних читань
 *  sticky       — Session Sticky Routing: сесія нещодавно писала, читаємо з Primary (Read-Your-Own-Writes)
 *  primary-preferred — наповнення кешу з Primary
 *  fallback     — Replica недоступна або конфлікт відтворення WAL → Primary Fallback
 *  primary-only — Replica не налаштована (Single Primary Topology)
 *  degraded     — Primary недоступний, sticky / primary-preferred читання віддане з Replica
 *  write        — мутуюча операція
 */
type Route = 'eventual' | 'strong' | 'sticky' | 'primary-preferred' | 'fallback' | 'primary-only' | 'degraded' | 'write';

interface NodeHealth {
    healthy: boolean;
    lastCheckAt: string | null;
    lastError: string | null;
}

// Помилки, що означають недоступність вузла (а не помилку в самому запиті).
// P2024 (немає вільного з'єднання в пулі) сюди НЕ входить: це перевантаження, а не відмова вузла.
const CONNECTION_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
const CONNECTION_RE =
    /can't reach database|server has closed the connection|connection (refused|reset|closed)|terminating connection|the database system is (shutting down|starting up|in recovery mode)|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i;
// Hot standby скасовує запит, якщо відтворення WAL конфліктує з ним (напр., VACUUM на Primary)
const RECOVERY_CONFLICT_RE = /conflict with recovery/i;

export function isConnectionError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientInitializationError) return true;
    if (err instanceof Prisma.PrismaClientKnownRequestError) return CONNECTION_CODES.has(err.code);
    if (err instanceof Prisma.PrismaClientUnknownRequestError || err instanceof Prisma.PrismaClientRustPanicError) {
        return CONNECTION_RE.test(err.message);
    }
    return false;
}

const HEALTH_WAIT_MS = 1500;

// Повідомлення Prisma багаторядкові; суть (напр. "Can't reach database server") — в останньому рядку
const shortError = (err: unknown) => String((err as Error)?.message ?? err).trim().split('\n').pop()?.trim() ?? '';

/**
 * Маршрутизатор Read/Write Separation на рівні Data Access Layer (Лаб. №6, п. 2.2–2.5).
 *
 * Два пули з'єднань (Multi-Pool Manager): PrismaService → Primary, ReplicaPrismaService → Replica.
 * Сервіси не обирають вузол самі — вони лише кажуть, що роблять:
 *   db.write(fn)                 — мутація, завжди Primary;
 *   db.read(fn)                  — eventual-читання, Replica (або Primary, якщо сесія щойно писала);
 *   db.read(fn, Consistency.STRONG) — строго узгоджене читання, завжди Primary.
 *
 * Відмовостійкість:
 *   Replica недоступна → читання автоматично йдуть на Primary (Primary Fallback);
 *   Primary недоступний → записи відхиляються з 503 (Read-Only Mode), eventual-читання працюють з Replica.
 */
@Injectable()
export class DbRouter implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('DbRouter');
    private readonly stickyTtlMs = Number(process.env.RYW_STICKY_TTL_MS ?? 5000);
    private readonly healthIntervalMs = Number(process.env.DB_HEALTH_INTERVAL_MS ?? 2000);
    private timer: NodeJS.Timeout | null = null;
    private probing: Promise<void> | null = null;

    private readonly health: Record<DbNode, NodeHealth> = {
        primary: { healthy: true, lastCheckAt: null, lastError: null },
        replica: { healthy: false, lastCheckAt: null, lastError: null },
    };

    // Локальна копія sticky-сесій: інстанс, що прийняв запис, знає про нього без звернення до Redis
    // і продовжує працювати, якщо Redis недоступний.
    private readonly localSticky = new Map<string, number>();

    private readonly stats = {
        reads: { primary: 0, replica: 0 },
        writes: 0,
        rejectedWrites: 0,
        routes: { eventual: 0, strong: 0, sticky: 0, 'primary-preferred': 0, fallback: 0, 'primary-only': 0, degraded: 0, write: 0 } as Record<
            Route,
            number
        >,
    };

    constructor(
        private readonly primary: PrismaService,
        private readonly replica: ReplicaPrismaService,
        private readonly cache: CacheService,
    ) {
        this.health.replica.healthy = replica.enabled;
    }

    async onModuleInit() {
        await this.checkHealth();
        this.timer = setInterval(() => void this.checkHealth(), this.healthIntervalMs);
        this.timer.unref();
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
    }

    // ------------------------------------------------------------------ API для сервісів

    /** Мутуюча операція (INSERT / UPDATE / DELETE, транзакції) — виключно на Primary. */
    async write<T>(mutation: (db: PrismaClient) => Promise<T>): Promise<T> {
        if (!this.health.primary.healthy) {
            this.stats.rejectedWrites++;
            throw this.readOnlyError();
        }
        let result: T;
        try {
            result = await mutation(this.primary);
        } catch (err) {
            if (!isConnectionError(err)) throw err;
            this.markDown('primary', err);
            this.stats.rejectedWrites++;
            throw this.readOnlyError();
        }
        this.stats.writes++;
        this.track('primary', 'write');
        await this.rememberWrite();
        return result;
    }

    /** Читання з урахуванням вимог до узгодженості, sticky-сесії і стану вузлів. */
    async read<T>(query: (db: PrismaClient) => Promise<T>, consistency = Consistency.EVENTUAL): Promise<T> {
        if (consistency === Consistency.STRONG) return this.readPrimary(query, 'strong');
        if (consistency === Consistency.PRIMARY_PREFERRED) return this.readPrimary(query, 'primary-preferred');
        if (!this.replica.enabled) return this.readPrimary(query, 'primary-only');
        if (await this.isSticky()) return this.readPrimary(query, 'sticky');
        if (!this.health.replica.healthy) return this.readPrimary(query, 'fallback');

        try {
            const result = await query(this.replica);
            this.track('replica', 'eventual');
            return result;
        } catch (err) {
            if (isConnectionError(err)) {
                this.markDown('replica', err);
                return this.readPrimary(query, 'fallback');
            }
            if (RECOVERY_CONFLICT_RE.test(String((err as Error)?.message))) return this.readPrimary(query, 'fallback');
            throw err;
        }
    }

    // ------------------------------------------------------------------ Маршрутизація

    private async readPrimary<T>(query: (db: PrismaClient) => Promise<T>, route: Route): Promise<T> {
        if (this.health.primary.healthy) {
            try {
                const result = await query(this.primary);
                this.track('primary', route);
                return result;
            } catch (err) {
                if (!isConnectionError(err)) throw err;
                this.markDown('primary', err);
            }
        }
        // Primary недоступний. Sticky / primary-preferred читання краще віддати з Replica, ніж відмовити;
        // strong-читання без Primary гарантувати неможливо.
        if ((route === 'sticky' || route === 'primary-preferred') && this.replica.enabled && this.health.replica.healthy) {
            const result = await query(this.replica);
            this.track('replica', 'degraded');
            return result;
        }
        throw new ServiceUnavailableException({
            statusCode: 503,
            error: 'Primary Unavailable',
            message:
                route === 'strong'
                    ? 'Primary Node недоступний: строго узгоджене читання неможливе'
                    : 'Жоден вузол БД недоступний',
        });
    }

    private readOnlyError() {
        return new ServiceUnavailableException({
            statusCode: 503,
            error: 'Read-Only Mode',
            message: 'Primary Node недоступний: операції запису тимчасово заблоковані, читання каталогу доступне',
        });
    }

    private track(node: DbNode, route: Route) {
        this.stats.reads[node] += route === 'write' ? 0 : 1;
        this.stats.routes[route]++;
        const ctx = requestContext.getStore();
        if (!ctx) return;
        ctx.nodes.add(node);
        ctx.routes.add(route);
        if (!ctx.res.headersSent) {
            ctx.res.setHeader('X-DB-Node', [...ctx.nodes].join(','));
            ctx.res.setHeader('X-DB-Route', [...ctx.routes].join(','));
        }
    }

    // ------------------------------------------------------------------ Read-After-Write (Sticky Routing)

    private stickyKey(sessionId: string) {
        return `booking:ryw:${sessionId}`;
    }

    /** Після запису сесія «прилипає» до Primary на RYW_STICKY_TTL_MS (спільно для всіх інстансів через Redis). */
    private async rememberWrite() {
        const ctx = requestContext.getStore();
        if (!ctx || !this.replica.enabled || this.stickyTtlMs <= 0) return;
        this.localSticky.set(ctx.sessionId, Date.now() + this.stickyTtlMs);
        await this.cache.setFlag(this.stickyKey(ctx.sessionId), this.stickyTtlMs);
    }

    private async isSticky(): Promise<boolean> {
        const ctx = requestContext.getStore();
        if (!ctx || this.stickyTtlMs <= 0) return false;
        const localUntil = this.localSticky.get(ctx.sessionId);
        if (localUntil && localUntil > Date.now()) return true;
        // Запис міг обробити інший інстанс API — перевіряємо спільний прапорець у Redis
        return (await this.cache.hasFlag(this.stickyKey(ctx.sessionId))) === true;
    }

    // ------------------------------------------------------------------ Health Checking

    private markDown(node: DbNode, err: unknown) {
        const state = this.health[node];
        state.lastError = shortError(err);
        if (state.healthy) {
            state.healthy = false;
            this.logger.warn(
                node === 'primary'
                    ? `Primary НЕДОСТУПНИЙ → Read-Only Mode (${state.lastError})`
                    : `Replica НЕДОСТУПНА → Primary Fallback (${state.lastError})`,
            );
        }
    }

    private markUp(node: DbNode) {
        const state = this.health[node];
        if (!state.healthy) {
            state.healthy = true;
            this.logger.log(node === 'primary' ? 'Primary знову доступний → Read-Write' : 'Replica знову доступна → читання на Replica');
        }
        state.lastError = null;
    }

    /**
     * Активна перевірка вузлів. Перевірки не накладаються одна на одну, а відповідь не чекає довше
     * HEALTH_WAIT_MS: якщо вузол «висить» (connect_timeout), повертається останній відомий стан.
     */
    async checkHealth() {
        this.probing ??= this.probeNodes().finally(() => (this.probing = null));
        await Promise.race([this.probing, new Promise((resolve) => setTimeout(resolve, HEALTH_WAIT_MS).unref())]);
        return this.getState();
    }

    /** Тайм-аут під навантаженням не вважається відмовою — вузол виключається лише при помилці з'єднання. */
    private async probeNodes() {
        const now = Date.now();
        for (const [key, until] of this.localSticky) if (until <= now) this.localSticky.delete(key);

        const nodes: [DbNode, PrismaClient][] = [['primary', this.primary]];
        if (this.replica.enabled) nodes.push(['replica', this.replica]);

        await Promise.all(
            nodes.map(async ([node, client]) => {
                try {
                    await client.$queryRaw`SELECT 1`;
                    this.markUp(node);
                } catch (err) {
                    if (isConnectionError(err)) this.markDown(node, err);
                    else this.health[node].lastError = shortError(err);
                } finally {
                    this.health[node].lastCheckAt = new Date().toISOString();
                }
            }),
        );
    }

    getState() {
        const primaryUp = this.health.primary.healthy;
        const replicaUp = this.replica.enabled && this.health.replica.healthy;
        return {
            topology: this.replica.enabled ? 'primary+replica' : 'single-primary',
            // read-write: усе працює; read-only: записи заблоковані; unavailable: немає жодного вузла
            mode: primaryUp ? 'read-write' : replicaUp ? 'read-only' : 'unavailable',
            readsFrom: !this.replica.enabled ? 'primary' : replicaUp ? 'replica' : 'primary (fallback)',
            stickyTtlMs: this.stickyTtlMs,
            nodes: {
                primary: { ...this.health.primary },
                replica: this.replica.enabled ? { ...this.health.replica } : { enabled: false },
            },
            stats: this.stats,
        };
    }
}
