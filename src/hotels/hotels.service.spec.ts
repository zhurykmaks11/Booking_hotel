import { Test, TestingModule } from '@nestjs/testing';
import { HotelsService } from './hotels.service';
import { DbRouter } from '../database/db-router.service';
import { CacheService } from '../cache/cache.service';

describe('HotelsService', () => {
  let service: HotelsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HotelsService, { provide: DbRouter, useValue: {} }, { provide: CacheService, useValue: {} }],
    }).compile();

    service = module.get<HotelsService>(HotelsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
