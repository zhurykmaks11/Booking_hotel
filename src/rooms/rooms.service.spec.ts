import { Test, TestingModule } from '@nestjs/testing';
import { RoomsService } from './rooms.service';
import { DbRouter } from '../database/db-router.service';
import { CacheService } from '../cache/cache.service';

describe('RoomsService', () => {
  let service: RoomsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RoomsService, { provide: DbRouter, useValue: {} }, { provide: CacheService, useValue: {} }],
    }).compile();

    service = module.get<RoomsService>(RoomsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
