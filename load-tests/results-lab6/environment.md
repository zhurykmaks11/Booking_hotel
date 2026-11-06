# Baseline Environment Specification

Знято: 2026-10-24 18:35

| Параметр | Значення |
|---|---|
| Хост (CPU) | 12th Gen Intel(R) Core(TM) i7-12700H, 14 ядер / 20 потоків |
| Хост (RAM) | 31.6 ГБ |
| Docker Desktop | 20 CPU, 15.4 ГБ RAM |
| Ліміти контейнерів | load-tests/docker-compose.loadtest.yml: api 1 CPU / 512 МБ, db-primary 1 CPU / 1 ГБ, db-replica 1 CPU / 1 ГБ, redis 0.5 CPU / 256 МБ, nginx 1 CPU / 256 МБ |
| Backend | NestJS 10 (Node.js 24 у контейнері), 3 інстанси за Nginx (Round Robin), для Scaling — 1 інстанс |
| Пул з'єднань БД | connection_limit=10, pool_timeout=10 с на інстанс до кожного вузла БД |
| БД | PostgreSQL 16: Primary + Read Replica (асинхронна streaming replication); для Лаб. №5 і Single Primary читання йдуть на Primary |
| Кеш | Redis 7, maxmemory 128 МБ, allkeys-lru (для Caching — вимкнений / теплий) |
| Генератор навантаження | grafana/k6:1.0.0 в окремому контейнері, ліміт 2 CPU, мережа кластера (запити напряму до nginx) |
| Профіль | розігрів 30 с, ступені 10,25,50,100,200 VUs, перехід 10 с, утримання 60 с, пауза 0.1 с |
| Node.js на хості | v25.2.0 |

## Стан контейнерів

```
NAMES                 IMAGE                 STATUS
hotel_booking_api_2   backend-api-2         Up About an hour
hotel_booking_api_3   backend-api-3         Up About an hour
hotel_booking_api_1   backend-api-1         Up About an hour
hotel_booking_nginx   booking-hotel-nginx   Up 4 hours
database_replica      postgres:16           Up 4 hours (healthy)
database_primary      postgres:16           Up 4 hours (healthy)
hotel_booking_redis   redis:7-alpine        Up About a minute (healthy)
```
