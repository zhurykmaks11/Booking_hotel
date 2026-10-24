import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReplicaPrismaService } from './replica-prisma.service';
import { DbRouter } from './db-router.service';

/**
 * Діагностика реплікації (Лаб. №6, п. 2.1, 2.3): стан WAL на обох вузлах і Replication Lag.
 * Запити йдуть напряму в конкретний пул, оминаючи DbRouter, — щоб бачити кожен вузол окремо.
 * LSN приводиться до text, інтервали й numeric — до float8 (Prisma не десеріалізує pg_lsn / interval).
 */
@Injectable()
export class ReplicationService {
    constructor(
        private readonly primary: PrismaService,
        private readonly replica: ReplicaPrismaService,
        private readonly router: DbRouter,
    ) {}

    async status() {
        const [primary, replica] = await Promise.all([
            this.primaryStatus(),
            this.replica.enabled ? this.replicaStatus() : Promise.resolve({ enabled: false }),
        ]);

        // Наскільки Replica відстає від поточної позиції WAL на Primary
        const primaryLsn = 'currentLsn' in primary ? primary.currentLsn : null;
        const replicaLsn = 'replayLsn' in replica ? replica.replayLsn : null;
        const behindBytes =
            primaryLsn && replicaLsn ? Math.max(0, this.lsnToNumber(primaryLsn) - this.lsnToNumber(replicaLsn)) : null;

        return {
            router: this.router.getState(),
            replicationLag: {
                behindBytes,
                caughtUp: behindBytes === null ? null : behindBytes <= 0,
            },
            primary,
            replica,
            timestamp: new Date().toISOString(),
        };
    }

    private async primaryStatus() {
        return this.safe(this.primary, async (db) => {
            const [node] = await db.$queryRaw<{ inRecovery: boolean; currentLsn: string }[]>`
                SELECT pg_is_in_recovery() AS "inRecovery", pg_current_wal_lsn()::text AS "currentLsn"`;
            const replicas = await db.$queryRaw<unknown[]>`
                SELECT application_name AS "applicationName",
                       client_addr::text AS "clientAddr",
                       state,
                       sync_state AS "syncState",
                       sent_lsn::text AS "sentLsn",
                       replay_lsn::text AS "replayLsn",
                       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::float8 AS "replayLagBytes",
                       (EXTRACT(EPOCH FROM write_lag) * 1000)::float8 AS "writeLagMs",
                       (EXTRACT(EPOCH FROM flush_lag) * 1000)::float8 AS "flushLagMs",
                       (EXTRACT(EPOCH FROM replay_lag) * 1000)::float8 AS "replayLagMs"
                FROM pg_stat_replication`;
            const slots = await db.$queryRaw<unknown[]>`
                SELECT slot_name AS "slotName", active, restart_lsn::text AS "restartLsn"
                FROM pg_replication_slots`;
            return { role: 'primary', ...node, replicas, slots };
        });
    }

    private async replicaStatus() {
        return this.safe(this.replica, async (db) => {
            const [node] = await db.$queryRaw<{ replayLsn: string | null }[]>`
                SELECT pg_is_in_recovery() AS "inRecovery",
                       current_setting('transaction_read_only') AS "readOnly",
                       pg_last_wal_receive_lsn()::text AS "receiveLsn",
                       pg_last_wal_replay_lsn()::text AS "replayLsn",
                       pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::float8 AS "receivedNotAppliedBytes",
                       pg_last_xact_replay_timestamp() AS "lastReplayedTxAt",
                       pg_is_wal_replay_paused() AS "replayPaused",
                       current_setting('recovery_min_apply_delay') AS "applyDelay",
                       (SELECT status FROM pg_stat_wal_receiver) AS "walReceiver"`;
            return { role: 'replica', ...node };
        });
    }

    private async safe<T>(client: PrismaClient, fn: (db: PrismaClient) => Promise<T>) {
        try {
            return { reachable: true as const, ...(await fn(client)) };
        } catch (err) {
            return { reachable: false as const, error: String((err as Error).message).trim().split('\n').pop() };
        }
    }

    /** LSN вигляду "0/3000148" → номер байта в журналі WAL. */
    private lsnToNumber(lsn: string) {
        const [hi, lo] = lsn.split('/').map((part) => parseInt(part, 16));
        return hi * 2 ** 32 + lo;
    }
}
