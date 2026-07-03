#!/bin/bash
set -e

if [ -n "${DATABASE_URL:-}" ]; then
  eval "$(
    python - <<'PYEOF'
import os
import shlex
from urllib.parse import urlparse, unquote

url = os.environ.get("DATABASE_URL", "").strip()
if not url:
    raise SystemExit(0)

parsed = urlparse(url)
host = (parsed.hostname or "").strip().lower()
explicit_db_host = os.environ.get("DB_HOST", "").strip().lower()
local_hosts = {"localhost", "127.0.0.1", "::1"}

if host in local_hosts and explicit_db_host and explicit_db_host not in local_hosts:
    print("unset DATABASE_URL")
    print("export APPBI_IGNORED_LOCAL_DATABASE_URL=1")
    raise SystemExit(0)

derived = {
    "DB_HOST": parsed.hostname,
    "DB_PORT": str(parsed.port) if parsed.port else None,
    "DB_USER": unquote(parsed.username) if parsed.username else None,
    "DB_PASSWORD": unquote(parsed.password) if parsed.password else None,
    "DB_NAME": parsed.path.lstrip("/") or None,
}

for key, value in derived.items():
    if value:
        print(f"export {key}={shlex.quote(value)}")
PYEOF
  )"
fi

if [ "${APPBI_IGNORED_LOCAL_DATABASE_URL:-}" = "1" ]; then
  echo "==> Ignoring localhost DATABASE_URL inside container; falling back to DB_HOST/DB_PORT settings"
  unset APPBI_IGNORED_LOCAL_DATABASE_URL
fi

: "${DB_HOST:=appbi-db}"
: "${DB_PORT:=5432}"
: "${DB_USER:=appbi}"
: "${DB_PASSWORD:=appbi}"
: "${DB_NAME:=appbi}"

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="postgresql+psycopg2://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi

echo "==> Waiting for PostgreSQL to be ready..."
echo "==> Metadata DB target: ${DB_HOST}:${DB_PORT}/${DB_NAME}"

# Wait until pg_isready succeeds (uses DB_HOST / DB_PORT / DB_USER / DB_NAME)
until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -q; do
  >&2 echo "    PostgreSQL is unavailable — retrying in 2s"
  sleep 2
done

echo "==> PostgreSQL is up"

echo "==> Running Alembic migrations..."
alembic upgrade head

# Ensure DATA_DIR is set BEFORE seed so Parquet paths resolve correctly
export DATA_DIR="${DATA_DIR:-/app/.data}"

# Create all required data subdirectories so storage is ready on first boot.
mkdir -p \
  "${DATA_DIR}/synced" \
  "${DATA_DIR}/datasets"
echo "==> Data directory: ${DATA_DIR} (subdirs ready)"

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

# ── Seed admin user on first boot ──────────────────────────────────────────
# Reads ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME from env.
# Only inserts if the users table has 0 rows (idempotent).
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@appbi.io}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-123456}"
ADMIN_NAME="${ADMIN_NAME:-Admin}"

python - <<'PYEOF'
import os, sys, json
from sqlalchemy import create_engine, text
from passlib.context import CryptContext

db_url = os.environ["DATABASE_URL"]
engine = create_engine(db_url)
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)

email    = os.environ.get("ADMIN_EMAIL", "admin@appbi.io")
password = os.environ.get("ADMIN_PASSWORD", "123456")
name     = os.environ.get("ADMIN_NAME", "Admin")

full_perms = json.dumps({
    "data_sources": "full", "datasets": "full",
    "govern": "full", "observability": "full",
    "explore_charts": "full", "dashboards": "full",
    "workboards": "full", "settings": "full"
})

with engine.connect() as conn:
    count = conn.execute(text("SELECT COUNT(*) FROM users")).scalar()
    if count == 0:
        hashed = pwd.hash(password)
        conn.execute(text(
            "INSERT INTO users (email, password_hash, full_name, status, permissions) "
            "VALUES (:email, :pw, :name, 'active', cast(:perms AS jsonb))"
        ), {"email": email, "pw": hashed, "name": name, "perms": full_perms})
        conn.commit()
        print(f"==> Admin user created: {email}")
    else:
        # Fix legacy "workspaces" key → "datasets" in existing users' permissions
        fixed = conn.execute(text(
            "UPDATE users SET permissions = permissions - 'workspaces' "
            "|| jsonb_build_object('datasets', permissions->'workspaces') "
            "WHERE permissions ? 'workspaces'"
        )).rowcount
        conn.commit()
        if fixed:
            print(f"==> Fixed permissions key 'workspaces' → 'datasets' for {fixed} user(s).")
        print(f"==> Users table already has rows — skipping admin seed.")
PYEOF

# --proxy-headers + --forwarded-allow-ips="*" lets Uvicorn honour
# X-Forwarded-For / X-Real-IP from nginx so request.client.host reflects
# the real viewer IP. Without this, slowapi's get_remote_address() sees
# every public-link request as coming from 127.0.0.1 on prod, and one
# busy dashboard (e.g. an HTML-imported one with many tiles) exhausts
# the shared rate-limit bucket, making chart data silently fail to load.
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 \
    --proxy-headers --forwarded-allow-ips="*"
