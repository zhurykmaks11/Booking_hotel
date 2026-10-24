import { Global, Module } from '@nestjs/common';
import { ReplicaPrismaService } from './replica-prisma.service';
import { DbRouter } from './db-router.service';
import { ReplicationService } from './replication.service';
import { ReplicationController } from './replication.controller';

/** Read/Write Separation (Лаб. №6): пул Replica, маршрутизатор запитів і діагностика реплікації. */
@Global()
@Module({
    providers: [ReplicaPrismaService, DbRouter, ReplicationService],
    controllers: [ReplicationController],
    exports: [ReplicaPrismaService, DbRouter],
})
export class DatabaseModule {}
