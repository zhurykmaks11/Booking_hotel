import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Окремий пул з'єднань до Read Replica (Multi-Pool Manager, Лаб. №6).
 * Якщо DATABASE_REPLICA_URL не задано — Replica вимкнена (Single Primary Topology).
 */
@Injectable()
export class ReplicaPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('Replica');
    readonly enabled: boolean;

    constructor() {
        const url = process.env.DATABASE_REPLICA_URL;
        // Без URL клієнт створюється з URL Primary, але маршрутизатор ним не користується
        super(url ? { datasourceUrl: url } : undefined);
        this.enabled = Boolean(url);
    }

    async onModuleInit() {
        if (!this.enabled) {
            this.logger.warn('DATABASE_REPLICA_URL не задано — усі запити йдуть на Primary');
            return;
        }
        // Недоступна Replica не повинна заважати старту: читання перейдуть на Primary
        try {
            await this.$connect();
        } catch (err) {
            this.logger.warn(`Replica недоступна під час старту: ${(err as Error).message.split('\n')[0]}`);
        }
    }

    async onModuleDestroy() {
        await this.$disconnect();
    }
}
