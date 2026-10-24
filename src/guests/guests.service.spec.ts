import { Test, TestingModule } from '@nestjs/testing';
import { GuestsService } from './guests.service';
import { DbRouter } from '../database/db-router.service';

describe('GuestsService', () => {
  let service: GuestsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GuestsService, { provide: DbRouter, useValue: {} }],
    }).compile();

    service = module.get<GuestsService>(GuestsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
