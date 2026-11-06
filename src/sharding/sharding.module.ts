import { Global, Module } from '@nestjs/common';
import { ShardRouter } from './shard-router.service';
import { ShardingService } from './sharding.service';
import { ShardingController } from './sharding.controller';

/** Шардинг агрегату «Готель → Номери → Бронювання» (Лаб. №7): Shard Router, діагностика, аналітика. */
@Global()
@Module({
    providers: [ShardRouter, ShardingService],
    controllers: [ShardingController],
    exports: [ShardRouter],
})
export class ShardingModule {}
