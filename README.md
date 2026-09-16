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

---

## Специфікація API

| # | Метод | Endpoint | Опис | Успіх | Помилки |
|---|-------|----------|------|-------|---------|
| 1 | POST | `/hotels` | Створити готель | 201 | 400 |
| 2 | GET | `/hotels/:id` | Отримати готель з номерами | 200 | 404 |
| 3 | POST | `/rooms` | Додати номер до готелю | 201 | 400, 404, 409 |
| 4 | GET | `/rooms/search?city=&checkIn=&checkOut=&guests=` | Пошук вільних номерів | 200 | 400 |
| 5 | POST | `/guests` | Реєстрація гостя | 201 | 400, 409 |
| 6 | POST | `/bookings` | Створити бронювання (перевірка доступності) | 201 | 400, 404, 409 |
| 7 | GET | `/bookings/:id` | Деталі бронювання | 200 | 404 |
| 8 | PATCH | `/bookings/:id/cancel` | Скасувати бронювання | 200 | 404, 409 |
| 9 | GET | `/guests/:id/bookings` | Історія бронювань гостя | 200 | 404 |

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
