import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Consistency, DbRouter } from '../database/db-router.service';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';

@Injectable()
export class GuestsService {
    constructor(private readonly db: DbRouter) {}

    async create(createGuestDto: CreateGuestDto) {
        // Перевірка унікальності — STRONG: Replica може ще не мати щойно зареєстрованого гостя
        const existing = await this.db.read(
            (db) => db.guest.findUnique({ where: { email: createGuestDto.email } }),
            Consistency.STRONG,
        );
        if (existing) {
            throw new ConflictException(`Guest with email ${createGuestDto.email} already exists`);
        }
        return this.db.write((db) => db.guest.create({ data: createGuestDto }));
    }

    /** Адміністративний список гостей: eventual → Replica. */
    findAll() {
        return this.db.read((db) => db.guest.findMany());
    }

    /**
     * Профіль гостя: eventual → Replica, але з Read-Your-Own-Writes —
     * якщо ця сесія щойно змінила дані, Sticky Routing віддасть їх з Primary.
     */
    async findOne(id: string, consistency = Consistency.EVENTUAL) {
        const guest = await this.db.read((db) => db.guest.findUnique({ where: { id } }), consistency);
        if (!guest) {
            throw new NotFoundException(`Guest with id ${id} not found`);
        }
        return guest;
    }

    async update(id: string, updateGuestDto: UpdateGuestDto) {
        await this.findOne(id, Consistency.STRONG);
        return this.db.write((db) =>
            db.guest.update({
                where: { id },
                data: updateGuestDto,
            }),
        );
    }

    async remove(id: string) {
        await this.findOne(id, Consistency.STRONG);
        return this.db.write((db) => db.guest.delete({ where: { id } }));
    }

    // Endpoint #9: історія бронювань гостя (eventual + Read-Your-Own-Writes через Sticky Routing)
    async findBookings(id: string) {
        await this.findOne(id);
        return this.db.read((db) =>
            db.booking.findMany({
                where: { guestId: id },
                include: { room: { include: { hotel: true } } },
                orderBy: { createdAt: 'desc' },
            }),
        );
    }
}