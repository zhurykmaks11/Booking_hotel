#!/bin/sh
# Старт контейнера API: міграції схеми на всіх вузлах СУБД, потім застосунок.
#   DATABASE_URL — глобальний вузол (Лаб. №6: Primary; гості, а без шардингу — усі дані);
#   SHARD_URLS   — Лаб. №7: шарди через кому; на кожному та сама схема (hotels, rooms, bookings).
# Конкурентний старт кількох інстансів безпечний: prisma migrate deploy бере advisory lock.
set -e

npx prisma migrate deploy

if [ -n "$SHARD_URLS" ]; then
    for url in $(echo "$SHARD_URLS" | tr ',' ' '); do
        echo "Міграції шарду: ${url%%\?*}"
        DATABASE_URL="$url" npx prisma migrate deploy
    done
fi

exec node dist/main
