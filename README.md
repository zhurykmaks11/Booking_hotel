# Hotel Booking System

Прототип розподіленої/модульної системи бронювання номерів у готелі.
Лабораторна робота №1 — System Design.

## Зміст

- [Технологічний стек](#технологічний-стек)
- [Архітектура](#архітектура)
- [Доменна модель](#доменна-модель)
- [Специфікація API](#специфікація-api)
- [Інструкція із запуску](#інструкція-із-запуску)
- [Перевірка персистентності даних](#перевірка-персистентності-даних)
- [RACI-матриця](#raci-матриця--розподіл-відповідальності)
- [Bottleneck Analysis](#bottleneck-analysis)

---

## Технологічний стек

| Шар | Технологія |
|---|---|
| Backend Framework | NestJS (TypeScript) |
| ORM | Prisma 6 |
| СУБД | PostgreSQL 16 |
| Валідація | class-validator / class-transformer |
| API-документація | Swagger (OpenAPI 3.0) |
| Контейнеризація | Docker, docker-compose |

---

## Архітектура

### C4 Model — Container Diagram

```mermaid
flowchart TB
    Client["HTTP Client<br/>(Postman / Swagger UI / Browser)"]

    subgraph Docker["Docker-мережа: hotel_booking_net"]
        API["Backend Service<br/>(NestJS, порт 3000)<br/><br/>Модулі: Hotels, Rooms, Guests, Bookings"]
        DB[("PostgreSQL 16<br/>(порт 5432)<br/><br/>Volume: pgdata")]
    end

    Client -- "HTTP/REST + JSON<br/>(CRUD, пошук, бронювання)" --> API
    API -- "SQL (Prisma Client)<br/>TCP :5432" --> DB
    DB -. "дані persist на диск<br/>(volume mount)" .-> DB
```

### Опис компонентів

- **Backend Service (NestJS)** — сервісний шар, що обробляє HTTP-запити, виконує валідацію вхідних даних, бізнес-логіку (перевірку конфлікту бронювань, розрахунок вартості) та звертається до БД через Prisma Client.
- **PostgreSQL** — первинне реляційне сховище даних. Дані зберігаються на persistent volume (`pgdata`), що забезпечує збереження стану при перезапуску контейнера.
- **Мережа `hotel_booking_net`** — ізольована bridge-мережа Docker, через яку `api` звертається до `db` за іменем сервіса (`db:5432`), без прив'язки до `localhost`.
- Зовнішні інтеграції та черги повідомлень — відсутні в поточній версії (MVP-архітектура без асинхронної обробки).

### API-документація (Swagger/OpenAPI)

Після запуску доступна за адресою:
```
http://localhost:3000/api/docs
```

---

## Доменна модель

### Сутності та зв'язки

```mermaid
erDiagram
    HOTEL ||--o{ ROOM : "має"
    ROOM ||--o{ BOOKING : "бронюється"
    GUEST ||--o{ BOOKING : "робить"

    HOTEL {
        string id PK
        string name
        string address
        string city
        float rating
    }
    ROOM {
        string id PK
        string hotelId FK
        string roomNumber
        enum type
        decimal pricePerNight
        int capacity
    }
    GUEST {
        string id PK
        string fullName
        string email UK
        string phone
    }
    BOOKING {
        string id PK
        string roomId FK
        string guestId FK
        datetime checkInDate
        datetime checkOutDate
        enum status
        decimal totalPrice
    }
```

- **Hotel → Room**: один готель має багато номерів (1:N)
- **Room ↔ Guest через Booking**: фактичний зв'язок M:N — один номер може мати багато бронювань різних гостей у різні періоди, один гість може бронювати багато номерів
- **Бізнес-правило**: один `Room` не може мати два перетинних активних (`PENDING`/`CONFIRMED`) бронювання на одні й ті самі дати

### High-Load сценарій

Масовий паралельний `POST /bookings` на один і той самий `roomId` (наприклад, під час розпродажу/акції) — десятки-сотні одночасних запитів намагаються забронювати один номер на ті самі або перетинні дати. Це створює конкуренцію за рядки таблиці `bookings` і є основним джерелом навантаження, розглянутим у Bottleneck Analysis.

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

Повна інтерактивна специфікація — у Swagger UI (`/api/docs`).

---

## Інструкція із запуску

### Вимоги

- Docker Desktop (з увімкненим Docker Compose)

### Холодний старт (єдина команда)

```bash
git clone <URL_РЕПОЗИТОРІЮ>
cd backend
docker-compose up --build
```

Ця команда автоматично:
1. Збирає образ backend-застосунку (multi-stage build)
2. Піднімає PostgreSQL і дочікується його готовності (healthcheck)
3. Застосовує міграції бази даних (`prisma migrate deploy`)
4. Запускає NestJS-застосунок на порту `3000`

### Перевірка роботи

- API: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/api/docs`

### Зупинка

```bash
docker-compose down
```

*(без прапорця `-v` — том `pgdata` збережеться між запусками)*

---

## Перевірка персистентності даних

Продемонструвати, що дані зберігаються при перезапуску контейнера БД:

```bash
# 1. Створити готель через POST /hotels
# 2. Перезапустити тільки контейнер БД:
docker-compose restart db

# 3. Дочекатись статусу healthy:
docker ps

# 4. Повторити GET /hotels — раніше створені дані мають бути на місці
```

---

## RACI-матриця / Розподіл відповідальності

| Модуль / Компонент | Відповідальний | Роль (RACI) |
|---|---|---|
| Доменна модель, Prisma-схема, міграції | *Журик Максим* | R, A |
| Модуль `hotels` (CRUD) | *Журик Максим* | R, A |
| Модуль `rooms` + пошук вільних номерів | *Журик Максим* | R, A |
| Модуль `guests` | *Журик Максим* | R, A |
| Модуль `bookings` + бізнес-логіка конфлікту дат | *Журик Максим* | R, A |
| Docker / docker-compose / Dockerfile | *Журик Максим* | R, A |
| Swagger-документація | *Журик Максим* | R |
| Bottleneck Analysis | *Журик Максим* | R, A |
| Архітектурна схема (C4) | *Журик Максим* | R |
| README / оформлення | *Журик Максим* | C |


## Bottleneck Analysis

Теоретичний аналіз потенційних точок деградації системи під високим навантаженням (на основі спроєктованої архітектури).

### 1. Race Condition при паралельному бронюванні одного номера

- **Компонент / Операція / Запит:** `POST /bookings` — одночасні запити на бронювання одного й того самого `roomId` на дати, що перетинаються (High-Load сценарій).
- **Причина (Root Cause):** Незважаючи на використання транзакції з рівнем ізоляції `Serializable`, під високим навантаженням PostgreSQL при конфлікті серіалізації відхиляє одну з конкурентних транзакцій (`SerializationFailure`, SQLSTATE 40001), а не блокує її мовчки. Це Lock Contention на рівні рядків таблиці `bookings` — усі паралельні транзакції змагаються за один і той самий діапазон дат одного `roomId`.
- **Симптоматика та прояв:** Зростання Latency p99 для `POST /bookings` (транзакції очікують одна одну або відкатуються і потребують retry); падіння Throughput/RPS пропорційно кількості конкурентних запитів на один номер; сплеск помилок `could not serialize access due to concurrent update` у логах БД.

### 2. N+1 Problem та over-fetching при отриманні вкладених даних

- **Компонент / Операція / Запит:** `GET /bookings`, `GET /hotels/:id` (з `include: rooms`), `GET /guests/:id/bookings`.
- **Причина (Root Cause):** Prisma генерує ефективні JOIN-и через `include`, але при зростанні обсягу пов'язаних даних (готель із тисячами номерів, велика історія бронювань) один запит повертає надлишковий обсяг даних без пагінації (over-fetching). Це навантажує канал БД↔API та серіалізацію JSON на стороні Node.js.
- **Симптоматика та прояв:** Зростання Latency p99 пропорційно кількості пов'язаних записів; підвищене використання пам'яті процесом Node.js під час буферизації великого JSON; ризик деградації через відсутність пагінації при масштабуванні даних.

### 3. Відсутність індексів при масштабуванні пошуку

- **Компонент / Операція / Запит:** `GET /rooms/search` (фільтрація за `hotel.city`), `GET /guests/:id/bookings`.
- **Причина (Root Cause):** Індекс наявний лише на `[roomId, checkInDate, checkOutDate]` (для перевірки конфлікту бронювань). Фільтрація за `hotel.city` вимагає JOIN з таблицею `hotels`; без індексу на `city` PostgreSQL при зростанні кількості готелів переходить від Index Scan до Sequential Scan.
- **Симптоматика та прояв:** Нелінійне зростання латентності `GET /rooms/search` (з O(log n) до O(n)) зі збільшенням обсягу даних; підвищена утилізація CPU на стороні БД; у `EXPLAIN ANALYZE` — `Seq Scan` замість `Index Scan`.

### 4. Виснаження пулу з'єднань (Connection Pool Exhaustion)

- **Компонент / Операція / Запит:** Будь-який endpoint під час пікового навантаження (масове одночасне бронювання).
- **Причина (Root Cause):** Prisma Client використовує обмежений пул з'єднань до PostgreSQL (типово ~10–13). Транзакції `$transaction` з рівнем `Serializable` утримують з'єднання довше через можливі retry при конфліктах серіалізації. При сплеску паралельних запитів частина запитів очікує в черзі на вивільнення з'єднання.
- **Симптоматика та прояв:** Зростання Latency p99 через час очікування в черзі пулу; помилки timeout (`Timed out fetching a new connection from the pool`) у логах; Throughput/RPS виходить на плато навіть при подальшому зростанні навантаження.

### Можливі напрями оптимізації (поза межами MVP)

- Впровадження оптимістичних локів (`version`-поле) замість `Serializable`-транзакцій для зменшення відкатів
- Додавання індексу на `hotels.city` та пагінації для списків
- Збільшення розміру пулу з'єднань Prisma (`connection_limit`) і/або впровадження PgBouncer
- Кешування результатів пошуку вільних номерів (Redis) для read-heavy навантаження
