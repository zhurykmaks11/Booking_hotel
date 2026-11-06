-- Лаб. №7 (Sharding): гості — глобальний довідник, бронювання — на шардах готелів.
-- Зовнішній ключ між різними вузлами СУБД неможливий: цілісність bookings.guestId перевіряє застосунок.
-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_guestId_fkey";

-- Cross-Shard запит «бронювання гостя» виконується на кожному шарді — без індексу це Seq Scan
-- CreateIndex
CREATE INDEX "bookings_guestId_idx" ON "bookings"("guestId");

-- Пошук і аналітика за містом
-- CreateIndex
CREATE INDEX "hotels_city_idx" ON "hotels"("city");
