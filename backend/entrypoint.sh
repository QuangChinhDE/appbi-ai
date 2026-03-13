#!/bin/bash
set -e

echo "==> Waiting for PostgreSQL to be ready..."

# Wait until pg_isready succeeds (uses DB_HOST / POSTGRES_USER / POSTGRES_DB)
until pg_isready -h "${DB_HOST:-db}" -U "${POSTGRES_USER:-appbi}" -d "${POSTGRES_DB:-appbi}" -q; do
  >&2 echo "    PostgreSQL is unavailable — retrying in 2s"
  sleep 2
done

echo "==> PostgreSQL is up"

echo "==> Running Alembic migrations..."
alembic upgrade head

echo "==> Starting FastAPI application..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
