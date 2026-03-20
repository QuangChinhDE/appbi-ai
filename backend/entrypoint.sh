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

# ------------------------------------------------------------------
# Optional demo seed (runs only on first boot, guarded by a flag file)
# Controlled by SEED_DEMO_DATA env var (set to "true" in .env)
# ------------------------------------------------------------------
SEED_FLAG="/app/.appbi_seeded"
if [ "${SEED_DEMO_DATA:-false}" = "true" ] && [ ! -f "$SEED_FLAG" ]; then
  echo "==> SEED_DEMO_DATA=true — loading Football/FIFA demo data..."
  # The seed script is copied into the container image (see Dockerfile COPY step)
  if python /app/seed_demo.py; then
    touch "$SEED_FLAG"
    echo "==> Demo data loaded successfully."
  else
    echo "==> WARNING: seed script failed — continuing without demo data."
  fi
else
  if [ -f "$SEED_FLAG" ]; then
    echo "==> Demo seed already ran on a previous boot — skipping."
  else
    echo "==> SEED_DEMO_DATA is not 'true' — starting with empty database."
  fi
fi

echo "==> Starting FastAPI application..."

# Ensure DATA_DIR is set (Parquet + DuckDB storage)
export DATA_DIR="${DATA_DIR:-/app/.data}"

# Create all required data subdirectories so storage is ready on first boot.
# These are created by the app on startup too, but doing it here guarantees
# they exist even if the volume is brand-new (e.g. after a fresh clone + docker up).
mkdir -p \
  "${DATA_DIR}/synced" \
  "${DATA_DIR}/datasets" \
  "${DATA_DIR}/workspaces"
echo "==> Data directory: ${DATA_DIR} (subdirs ready)"

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
