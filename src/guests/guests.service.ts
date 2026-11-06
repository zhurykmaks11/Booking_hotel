import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Consistency, DbRouter } from '../database/db-router.service';
import { ShardRouter } from '../sharding/shard-router.service';
import { CreateGuestDto } from './dto/create-guest.dto';
import { UpdateGuestDto } from './dto/update-guest.dto';

/**
 * Гості — глобальний (нешардований) довідник на вузлі з Лаб. №6 (Primary + Replica):
 * невелика таблиця, що читається значно частіше, ніж змінюється, і потребує глобальної
 * унікальності email (UNIQUE працює лише в межах одного вузла).
 * Їхні бронювання лежать на шардах готелів — звідси Cross-Shard запити нижче.
 */
@Injectable()
export class GuestsService {
    constructor(
        private readonly db: DbRouter,
        private readonly shards: ShardRouter,
    ) {}

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

    /**
     * Лаб. №7: зовнішнього ключа bookings → guests між вузлами немає, тому ON DELETE RESTRICT
     * перевіряє застосунок: fan-out по всіх шардах. Відповідь потрібна від УСІХ шардів —
     * без allowPartial недоступний шард дасть 503, а не хибне «бронювань немає».
     */
    async remove(id: string) {
        await this.findOne(id, Consistency.STRONG);
        const { parts } = await this.shards.fanOut((db) => db.booking.count({ where: { guestId: id } }), {
            consistency: Consistency.STRONG,
        });
        const bookings = parts.reduce((total, part) => total + part.result, 0);
        if (bookings > 0) {
            throw new ConflictException(`Guest has ${bookings} booking(s) and cannot be deleted`);
        }
        return this.db.write((db) => db.guest.delete({ where: { id } }));
    }

    /**
     * Endpoint #9: історія бронювань гостя.
     * Лаб. №7: Cross-Shard запит (Scatter-Gather) — бронювання шардовані за готелем, а не за гостем,
     * тому запит іде на всі шарди паралельно, результати зливаються і сортуються в застосунку.
     * Готель і номер підтягуються локальним JOIN на кожному шарді (агрегат co-located).
     */
    async findBookings(id: string) {
        await this.findOne(id);
        const bookings = await this.shards.fanOutList(
            (db) =>
                db.booking.findMany({
                    where: { guestId: id },
                    include: { room: { include: { hotel: true } } },
                }),
            { allowPartial: true },
        );
        return bookings.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
}