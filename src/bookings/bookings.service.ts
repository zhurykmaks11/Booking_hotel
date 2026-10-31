import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { Consistency, DbRouter } from '../database/db-router.service';
import { ShardRouter } from '../sharding/shard-router.service';
import { bucketOf } from '../sharding/shard-key';
import { CacheService } from '../cache/cache.service';
import { CacheKeys } from '../cache/cache-keys';
import { CreateBookingDto } from './dto/create-booking.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { RelocateBookingDto } from './dto/relocate-booking.dto';
// @ts-ignore
import { Booking, BookingStatus, Prisma, PrismaClient } from '@prisma/client';

const ACTIVE_STATUSES: BookingStatus[] = [BookingStatus.PENDING, BookingStatus.CONFIRMED];
const SERIALIZATION_RETRIES = 5;

type TxClient = Prisma.TransactionClient;

export interface SagaStep {
    step: string;
    shard: string;
    status: 'done' | 'failed' | 'compensated' | 'skipped';
    detail?: string;
}

/**
 * Лаб. №7: бронювання шардовані разом зі своїм готелем (ключ hotelId, бакет у ID номера).
 * Гості — глобальний довідник на вузлі з Лаб. №6 (DbRouter), тому зв'язок booking → guest
 * не є зовнішнім ключем у БД, а перевіряється застосунком, і «JOIN» з гостем — це
 * Application-Side Join (другий запит у глобальний вузол).
 */
@Injectable()
export class BookingsService {
    private readonly logger = new Logger('BookingsSaga');

    constructor(
        private readonly shards: ShardRouter,
        private readonly global: DbRouter,
        private readonly cache: CacheService,
    ) {}

    /**
     * Будь-яка зміна бронювань змінює доступність номерів, тому всі закешовані
     * результати пошуку стають застарілими: збільшуємо версію пошуку (п. 2.5).
     * Викликається лише ПІСЛЯ успішного запису в БД.
     */
    private invalidateSearch() {
        return this.cache.bumpVersion(CacheKeys.searchVersion);
    }

    async create(dto: CreateBookingDto) {
        const checkIn = new Date(dto.checkInDate);
        const checkOut = new Date(dto.checkOutDate);

        if (checkOut <= checkIn) {
            throw new BadRequestException('checkOutDate must be after checkInDate');
        }

        // STRONG: гостя зазвичай реєструють щойно перед бронюванням (сценарій C) —
        // на Replica його ще може не бути, і бронювання впало б з хибним 404.
        await this.assertGuestExists(dto.guestId);

        /**
         * КРИТИЧНА ЗОНА (Bottleneck Analysis, п.2.5):
         * Перевірка доступності номера і створення бронювання виконуються
         * в одній транзакції з рівнем ізоляції Serializable, щоб уникнути
         * race condition при паралельних запитах на один і той самий номер.
         * Без цього між SELECT (перевірка) і INSERT (створення) є вікно,
         * у яке може "проскочити" паралельний запит — обидва запити побачать
         * номер вільним і обидва створять бронювання на ті самі дати.
         *
         * Лаб. №7: номер і всі його бронювання лежать на одному шарді (той самий бакет),
         * тому транзакція залишається локальною і зберігає повні ACID-гарантії.
         */
        const shard = this.shards.forKey(dto.roomId);
        const booking = await shard.write((db) =>
            this.serializable(db, (tx) =>
                this.reserve(tx, {
                    id: this.shards.childId(dto.roomId),
                    roomId: dto.roomId,
                    guestId: dto.guestId,
                    checkIn,
                    checkOut,
                    status: BookingStatus.PENDING,
                }),
            ),
        );

        await this.invalidateSearch();
        return booking;
    }

    /**
     * Serializable-транзакція з повтором. PostgreSQL (SSI) скасовує одну з транзакцій, що могли б
     * дати несеріалізований результат (P2034), — навіть для різних номерів, якщо predicate lock
     * взято на всю сторінку / таблицю (типово для малих таблиць свіжого шарду, де план — Seq Scan).
     * Стандартна відповідь — повторити транзакцію; після вичерпання спроб — 409, а не 500.
     */
    private async serializable<T>(db: PrismaClient, fn: (tx: TxClient) => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await db.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
            } catch (err) {
                const conflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
                if (!conflict) throw err;
                if (attempt >= SERIALIZATION_RETRIES) {
                    throw new ConflictException('Concurrent booking conflict, please retry');
                }
                // Випадкова пауза (jitter), щоб конкуруючі транзакції не зіткнулися знову
                await new Promise((resolve) => setTimeout(resolve, attempt * (5 + Math.random() * 20)));
            }
        }
    }

    /** Перевірка доступності + створення бронювання всередині транзакції одного шарду. */
    private async reserve(
        tx: TxClient,
        data: { id: string; roomId: string; guestId: string; checkIn: Date; checkOut: Date; status: BookingStatus },
        excludeBookingId?: string,
    ) {
        const room = await tx.room.findUnique({ where: { id: data.roomId } });
        if (!room) {
            throw new NotFoundException(`Room with id ${data.roomId} not found`);
        }

        const overlapping = await tx.booking.findFirst({
            where: {
                roomId: data.roomId,
                id: excludeBookingId ? { not: excludeBookingId } : undefined,
                status: { in: ACTIVE_STATUSES },
                checkInDate: { lt: data.checkOut },
                checkOutDate: { gt: data.checkIn },
            },
        });

        if (overlapping) {
            throw new ConflictException(`Room is already booked for the selected dates`);
        }

        const nights = Math.ceil((data.checkOut.getTime() - data.checkIn.getTime()) / (1000 * 60 * 60 * 24));
        const totalPrice = Number(room.pricePerNight) * nights;

        return tx.booking.create({
            data: {
                id: data.id,
                roomId: data.roomId,
                guestId: data.guestId,
                checkInDate: data.checkIn,
                checkOutDate: data.checkOut,
                totalPrice,
                status: data.status,
            },
        });
    }

    /**
     * Загальний список / звітність по бронюваннях: Cross-Shard fan-out + Application-Side Join
     * з гостями глобального вузла (eventual → Replica). Distributed JOIN у БД неможливий:
     * бронювання і гості живуть на різних вузлах.
     */
    async findAll() {
        const bookings = await this.shards.fanOutList(
            (db) => db.booking.findMany({ include: { room: { include: { hotel: true } } } }),
            { allowPartial: true },
        );
        return this.attachGuests(bookings, Consistency.EVENTUAL);
    }

    /**
     * Підтвердження бронювання (статус, сума): STRONG → Explicit Primary Routing.
     * Клієнт відкриває його одразу після POST /bookings, тож застаріле читання
     * показало б 404 або старий статус (напр. ще не скасоване).
     * Лаб. №7: бронювання — Shard-Local (бакет в ID), гість — з глобального вузла.
     */
    async findOne(id: string) {
        const booking = await this.findLocal(id, true);
        const [withGuest] = await this.attachGuests([booking], Consistency.STRONG);
        return withGuest;
    }

    /** Лише рядок бронювання з його шарду (для перевірок перед записом). */
    private async findLocal(id: string, includeRoom = false) {
        const booking = await this.shards
            .forKey(id)
            .read(
                (db) =>
                    db.booking.findUnique({
                        where: { id },
                        include: includeRoom ? { room: { include: { hotel: true } } } : undefined,
                    }),
                Consistency.STRONG,
            );
        if (!booking) {
            throw new NotFoundException(`Booking with id ${id} not found`);
        }
        return booking;
    }

    async update(id: string, dto: UpdateBookingDto) {
        // Зміна номера на номер іншого бакета — це переїзд між шардами: лише через relocate (Saga)
        if (dto.roomId && bucketOf(dto.roomId) !== bucketOf(id)) {
            throw new BadRequestException('Booking cannot be moved to another shard with PATCH; use POST /bookings/:id/relocate');
        }
        if (dto.guestId) await this.assertGuestExists(dto.guestId);
        await this.findLocal(id);
        const booking = await this.shards.forKey(id).write((db) => db.booking.update({ where: { id }, data: dto }));
        await this.invalidateSearch();
        return booking;
    }

    async remove(id: string) {
        await this.findLocal(id);
        const booking = await this.shards.forKey(id).write((db) => db.booking.delete({ where: { id } }));
        await this.invalidateSearch();
        return booking;
    }

    // Endpoint #8: скасування бронювання
    async cancel(id: string) {
        const booking = await this.findLocal(id);
        if (booking.status === BookingStatus.CANCELLED) {
            throw new ConflictException('Booking is already cancelled');
        }
        if (booking.status === BookingStatus.COMPLETED) {
            throw new ConflictException('Cannot cancel a completed booking');
        }
        const cancelled = await this.shards.forKey(id).write((db) =>
            db.booking.update({
                where: { id },
                data: { status: BookingStatus.CANCELLED },
            }),
        );
        await this.invalidateSearch();
        return cancelled;
    }

    /**
     * Cross-Shard Write (Лаб. №7, п. 2.4): переселення гостя в інший номер на ті самі дати.
     *
     * Той самий шард → одна локальна Serializable-транзакція: перевірка + нове бронювання +
     * скасування старого атомарні (ACID).
     *
     * Різні шарди → локальна транзакція неможлива (кожен PostgreSQL комітить лише свої дані),
     * тому виконується Saga (оркестрація) з компенсаціями:
     *   T1 (шард цілі)    — зарезервувати новий номер зі статусом PENDING (семантичне блокування);
     *   T2 (шард джерела) — скасувати старе бронювання, лише якщо воно ще активне;
     *   T3 (шард цілі)    — перевести нове бронювання у статус старого (CONFIRMED / PENDING).
     * Якщо T2 не вдався — компенсація C1: скасувати резерв T1. Проміжний стан (два активні
     * бронювання) короткочасно видно іншим запитам — це ціна відмови від 2PC (немає ізоляції).
     */
    async relocate(id: string, dto: RelocateBookingDto) {
        if (dto.simulateFailure && process.env.SAGA_FAULT_INJECTION !== 'true') {
            throw new BadRequestException('simulateFailure is available only with SAGA_FAULT_INJECTION=true');
        }

        const source = this.shards.forKey(id);
        const target = this.shards.forKey(dto.roomId);
        const original = await this.findLocal(id);
        if (!ACTIVE_STATUSES.includes(original.status)) {
            throw new ConflictException(`Only active bookings can be relocated (status: ${original.status})`);
        }
        if (original.roomId === dto.roomId) {
            throw new BadRequestException('Booking is already in this room');
        }

        const reservation = {
            id: this.shards.childId(dto.roomId),
            roomId: dto.roomId,
            guestId: original.guestId,
            checkIn: original.checkInDate,
            checkOut: original.checkOutDate,
        };

        if (source === target) {
            const result = await source.write((db) =>
                this.serializable(db, async (tx) => {
                    const created = await this.reserve(tx, { ...reservation, status: original.status }, id);
                    const previous = await tx.booking.update({ where: { id }, data: { status: BookingStatus.CANCELLED } });
                    return { created, previous };
                }),
            );
            await this.invalidateSearch();
            return {
                mode: 'local-transaction',
                from: source.name,
                to: target.name,
                booking: result.created,
                previous: result.previous,
                steps: [{ step: 'reserve + cancel (one ACID transaction)', shard: source.name, status: 'done' }] as SagaStep[],
            };
        }

        const steps: SagaStep[] = [];

        // T1: резерв на шарді цілі (локальна Serializable-транзакція). Невдача → компенсувати нічого.
        let created: Booking;
        try {
            created = await target.write((db) =>
                this.serializable(db, (tx) => this.reserve(tx, { ...reservation, status: BookingStatus.PENDING })),
            );
            steps.push({ step: 'T1 reserve new room (PENDING)', shard: target.name, status: 'done', detail: created.id });
        } catch (err) {
            steps.push({ step: 'T1 reserve new room (PENDING)', shard: target.name, status: 'failed', detail: (err as Error).message });
            throw this.sagaAborted(steps, err, source.name, target.name);
        }

        // T2: скасування старого бронювання (умовне: лише якщо воно все ще активне)
        try {
            if (dto.simulateFailure) throw new Error('Injected failure before T2 (SAGA_FAULT_INJECTION)');
            const { count } = await source.write((db) =>
                db.booking.updateMany({
                    where: { id, status: { in: ACTIVE_STATUSES } },
                    data: { status: BookingStatus.CANCELLED },
                }),
            );
            if (count === 0) throw new ConflictException('Original booking is no longer active');
            steps.push({ step: 'T2 cancel original booking', shard: source.name, status: 'done', detail: id });
        } catch (err) {
            steps.push({ step: 'T2 cancel original booking', shard: source.name, status: 'failed', detail: (err as Error).message });
            // C1: компенсація T1 — ідемпотентне скасування резерву
            await this.compensate(target.name, () =>
                target.write((db) =>
                    db.booking.updateMany({ where: { id: created.id, status: BookingStatus.PENDING }, data: { status: BookingStatus.CANCELLED } }),
                ),
                steps,
                created.id,
            );
            await this.invalidateSearch();
            throw this.sagaAborted(steps, err, source.name, target.name);
        }

        // T3: фіксація — новий запис отримує статус старого
        const confirmed = await target.write((db) => db.booking.update({ where: { id: created.id }, data: { status: original.status } }));
        steps.push({ step: `T3 set status ${original.status}`, shard: target.name, status: 'done', detail: created.id });

        await this.invalidateSearch();
        return {
            mode: 'saga',
            from: source.name,
            to: target.name,
            booking: confirmed,
            previous: { ...original, status: BookingStatus.CANCELLED },
            steps,
        };
    }

    private async compensate(shard: string, action: () => Promise<unknown>, steps: SagaStep[], detail: string) {
        try {
            await action();
            steps.push({ step: 'C1 cancel reservation (compensation)', shard, status: 'compensated', detail });
        } catch (err) {
            // Компенсацію треба повторювати, доки не вдасться (у продакшні — журнал саги / outbox)
            steps.push({ step: 'C1 cancel reservation (compensation)', shard, status: 'failed', detail: (err as Error).message });
            this.logger.error(`Компенсація резерву ${detail} не вдалася: ${(err as Error).message}`);
        }
    }

    private sagaAborted(steps: SagaStep[], err: unknown, from: string, to: string) {
        const status = err instanceof HttpException ? err.getStatus() : HttpStatus.CONFLICT;
        return new HttpException(
            {
                statusCode: status,
                error: 'Saga Aborted',
                message: (err as Error).message,
                mode: 'saga',
                from,
                to,
                steps,
            },
            status,
        );
    }

    // ------------------------------------------------------------------ Гості (глобальний вузол)

    private async assertGuestExists(guestId: string) {
        const guest = await this.global.read((db) => db.guest.findUnique({ where: { id: guestId } }), Consistency.STRONG);
        if (!guest) {
            throw new NotFoundException(`Guest with id ${guestId} not found`);
        }
    }

    /** Application-Side Join: один запит IN (...) у глобальний вузол замість JOIN між вузлами. */
    private async attachGuests<T extends { guestId: string }>(bookings: T[], consistency: Consistency) {
        const ids = [...new Set(bookings.map((b) => b.guestId))];
        const guests = ids.length
            ? await this.global.read((db: PrismaClient) => db.guest.findMany({ where: { id: { in: ids } } }), consistency)
            : [];
        const byId = new Map(guests.map((g) => [g.id, g]));
        return bookings.map((b) => ({ ...b, guest: byId.get(b.guestId) ?? null }));
    }
}
