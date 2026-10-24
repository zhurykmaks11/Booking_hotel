#!/bin/bash
# Replica Node (Лаб. №6, п. 2.1): при першому старті копіює Primary через pg_basebackup,
# далі працює як hot standby — read-only, асинхронно відтворює WAL, отриманий по streaming replication.
set -euo pipefail

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "replica: чекаю на Primary ${PRIMARY_HOST}:5432..."
    until pg_isready -h "$PRIMARY_HOST" -p 5432 -U "$REPLICATION_USER" -q; do sleep 1; done

    echo "replica: pg_basebackup з ${PRIMARY_HOST} (слот ${REPLICATION_SLOT})"
    mkdir -p "$PGDATA"
    chown postgres:postgres "$PGDATA"
    chmod 700 "$PGDATA"
    # -X stream: WAL копіюється паралельно з даними; -R: standby.signal + primary_conninfo
    PGPASSWORD="$REPLICATION_PASSWORD" gosu postgres pg_basebackup \
        -h "$PRIMARY_HOST" -p 5432 -U "$REPLICATION_USER" \
        -D "$PGDATA" -X stream -S "$REPLICATION_SLOT" -R -P
fi

# Каталог уже ініціалізований → стандартний entrypoint пропускає initdb і просто стартує сервер
exec docker-entrypoint.sh postgres \
    -c hot_standby=on \
    -c hot_standby_feedback=on \
    -c max_standby_streaming_delay=30s
