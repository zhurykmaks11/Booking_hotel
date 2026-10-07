import { Test, TestingModule } from '@nestjs/testing';
import { GuestsService } from './guests.service';
import { PrismaService } from '../prisma/prisma.service';

describe('GuestsService', () => {
  let service: GuestsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GuestsService, { provide: PrismaService, useValue: {} }],
    }).compile();

    service = module.get<GuestsService>(GuestsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
