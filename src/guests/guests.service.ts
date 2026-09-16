import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';

@Injectable()
export class GuestsService {
    constructor(private readonly prisma: PrismaService) {}

    async create(createGuestDto: CreateGuestDto) {
        const existing = await this.prisma.guest.findUnique({
            where: { email: createGuestDto.email },
        });
        if (existing) {
            throw new ConflictException(`Guest with email ${createGuestDto.email} already exists`);
        }
        return this.prisma.guest.create({ data: createGuestDto });
    }

    findAll() {
        return this.prisma.guest.findMany();
    }

    async findOne(id: string) {
        const guest = await this.prisma.guest.findUnique({ where: { id } });
        if (!guest) {
            throw new NotFoundException(`Guest with id ${id} not found`);
        }
        return guest;
    }

    async update(id: string, updateGuestDto: UpdateGuestDto) {
        await this.findOne(id);
        return this.prisma.guest.update({
            where: { id },
            data: updateGuestDto,
        });
    }

    async remove(id: string) {
        await this.findOne(id);
        return this.prisma.guest.delete({ where: { id } });
    }

    // Endpoint #9: історія бронювань гостя
    async findBookings(id: string) {
        await this.findOne(id);
        return this.prisma.booking.findMany({
            where: { guestId: id },
            include: { room: { include: { hotel: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }
}