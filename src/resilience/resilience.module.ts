import { Global, Module } from '@nestjs/common';
import { ResilienceConfigService } from './resilience-config.service';
import { ResilientCacheService } from './resilient-cache.service';
import { ResilienceController } from './resilience.controller';

/** Лаб. №8: кеш із захистом від Stampede / Avalanche / Penetration. Global — його використовують сервіси доменів. */
@Global()
@Module({
    controllers: [ResilienceController],
    providers: [ResilienceConfigService, ResilientCacheService],
    exports: [ResilienceConfigService, ResilientCacheService],
})
export class ResilienceModule {}
