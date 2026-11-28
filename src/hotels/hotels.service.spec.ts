import { Test, TestingModule } from '@nestjs/testing';
import { HotelsService } from './hotels.service';
import { DbRouter } from '../database/db-router.service';
import { ShardRouter } from '../sharding/shard-router.service';
import { CacheService } from '../cache/cache.service';
import { ResilientCacheService } from '../resilience/resilient-cache.service';
import { ResilienceConfigService } from '../resilience/resilience-config.service';

describe('HotelsService', () => {
  let service: HotelsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HotelsService, { provide: DbRouter, useValue: {} }, { provide: ShardRouter, useValue: {} }, { provide: CacheService, useValue: {} }, { provide: ResilientCacheService, useValue: {} }, { provide: ResilienceConfigService, useValue: {} }],
    }).compile();

    service = module.get<HotelsService>(HotelsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
