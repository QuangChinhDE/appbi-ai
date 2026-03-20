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
mkdir -p \
  "${DATA_DIR}/synced" \
  "${DATA_DIR}/datasets" \
  "${DATA_DIR}/workspaces"
echo "==> Data directory: ${DATA_DIR} (subdirs ready)"

# ── Seed admin user on first boot ──────────────────────────────────────────
# Reads ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME from env.
# Only inserts if the users table has 0 rows (idempotent).
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@appbi.io}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-change-me-on-first-login}"
ADMIN_NAME="${ADMIN_NAME:-Admin}"

python - <<'PYEOF'
import os, sys
from sqlalchemy import create_engine, text
from passlib.context import CryptContext

db_url = os.environ["DATABASE_URL"]
engine = create_engine(db_url)
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)

email    = os.environ.get("ADMIN_EMAIL", "admin@appbi.io")
password = os.environ.get("ADMIN_PASSWORD", "change-me-on-first-login")
name     = os.environ.get("ADMIN_NAME", "Admin")

with engine.connect() as conn:
    count = conn.execute(text("SELECT COUNT(*) FROM users")).scalar()
    if count == 0:
        hashed = pwd.hash(password)
        conn.execute(text(
            "INSERT INTO users (email, password_hash, full_name, role, status) "
            "VALUES (:email, :pw, :name, 'admin', 'active')"
        ), {"email": email, "pw": hashed, "name": name})
        conn.commit()
        print(f"==> Admin user created: {email}")
    else:
        print(f"==> Users table already has rows — skipping admin seed.")
PYEOF

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
