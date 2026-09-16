import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelDto } from './dto/update-hotel.dto';

@Injectable()
export class HotelsService {
    constructor(private readonly prisma: PrismaService) {}

    create(createHotelDto: CreateHotelDto) {
        return this.prisma.hotel.create({ data: createHotelDto });
    }

    findAll() {
        return this.prisma.hotel.findMany();
    }

    async findOne(id: string) {
        const hotel = await this.prisma.hotel.findUnique({
            where: { id },
            include: { rooms: true },
        });
        if (!hotel) {
            throw new NotFoundException(`Hotel with id ${id} not found`);
        }
        return hotel;
    }

    async update(id: string, updateHotelDto: UpdateHotelDto) {
        await this.findOne(id);
        return this.prisma.hotel.update({
            where: { id },
            data: updateHotelDto,
        });
    }

    async remove(id: string) {
        await this.findOne(id);
        return this.prisma.hotel.delete({ where: { id } });
    }
}