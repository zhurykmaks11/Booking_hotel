#!/bin/bash
# Primary Node (Лаб. №6, п. 2.1): користувач реплікації, фізичний слот і доступ у pg_hba.conf.
# Виконується офіційним образом postgres лише один раз — при ініціалізації порожнього volume.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE ${REPLICATION_USER} WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
    -- Слот гарантує, що Primary не видалить WAL, який Replica ще не отримала
    -- (після рестарту Replica догоняє Primary, а не потребує повного pg_basebackup).
    SELECT pg_create_physical_replication_slot('${REPLICATION_SLOT}');
EOSQL

# Підключення з типом "replication" не підпадає під правило "host all all all": додаємо окреме.
echo "host replication ${REPLICATION_USER} all scram-sha-256" >> "$PGDATA/pg_hba.conf"
