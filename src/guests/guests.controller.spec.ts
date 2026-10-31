import { Test, TestingModule } from '@nestjs/testing';
import { GuestsController } from './guests.controller';
import { GuestsService } from './guests.service';
import { DbRouter } from '../database/db-router.service';
import { ShardRouter } from '../sharding/shard-router.service';

describe('GuestsController', () => {
  let controller: GuestsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GuestsController],
      providers: [GuestsService, { provide: DbRouter, useValue: {} }, { provide: ShardRouter, useValue: {} }],
    }).compile();

    controller = module.get<GuestsController>(GuestsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
