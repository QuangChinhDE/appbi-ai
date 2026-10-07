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

# ── Check the pgvector extension before migrations (check-only) ─────────────
# The application DB account is USE-ONLY — it must never create extensions. We
# only VERIFY that 'vector' (pgvector) is present. If it is missing, stop with a
# clear message asking a superuser/admin account to install it once, instead of
# crash-looping through a deep migration stacktrace. For the bundled local-db,
# the extension is provisioned by the db container's own init (as the postgres
# superuser) — see scripts/db-init/01-init-pgvector.sql — not by this app.
echo "==> Checking pgvector extension..."
python - <<'PYEOF'
import os, sys
from sqlalchemy import create_engine, text
try:
    with create_engine(os.environ["DATABASE_URL"]).connect() as c:
        present = c.execute(text("SELECT 1 FROM pg_extension WHERE extname='vector'")).scalar()
except Exception as e:
    print(f"==> WARNING: could not check pgvector ({e}); continuing to migrations.")
    sys.exit(0)
if present:
    print("==> pgvector present.")
    sys.exit(0)
sys.stderr.write(
    "\n" + "=" * 72 + "\n"
    "STOP: the 'vector' (pgvector) extension is not installed on this database.\n"
    "This application account is use-only and will NOT create it.\n\n"
    "Ask a Postgres SUPERUSER / admin account to run ONCE on this database:\n"
    "    CREATE EXTENSION vector;\n"
    "then restart:  ./run.sh --recreate\n"
    "(If the extension is unavailable server-side, install pgvector on the PG\n"
    " server / enable it in the managed instance first.)\n"
    + "=" * 72 + "\n")
sys.exit(1)
PYEOF

echo "==> Running Alembic migrations..."
alembic upgrade head

# ── Least-privilege runtime role, so row-level security actually runs ─────────
#
# Migration 0048 created `appbi_app` NOLOGIN and granted it SELECT/INSERT/UPDATE/
# DELETE on every table and sequence, then stopped — it cannot create a role with
# a password on a managed Postgres, and it must not crash-loop the container
# trying. So the last step lives here, where a failure is a warning and the app
# still starts.
#
# Without it the application connects as the schema owner, Postgres skips RLS for
# a SUPERUSER/BYPASSRLS role, and the policies on `govern_doc_chunk` are written,
# enabled, forced and never evaluated. `vector_store_health.rls_in_force` reports
# which state you are in, and the Knowledge Hub shows it.
#
# Opt-in on purpose: set APP_DB_PASSWORD *and* DATABASE_URL_APP together, or
# neither. Setting only the first provisions a role nothing connects as; that is
# harmless, and the health endpoint still says RLS is off.
if [ -n "${APP_DB_PASSWORD:-}" ]; then
  echo "==> Provisioning least-privilege role appbi_app..."
  python - <<'PYROLE' || echo "    (skipped: could not provision — RLS stays off, see /catalog/govern/vector-store-health)"
import os
import sys

from sqlalchemy import create_engine, text

from app.core.config import settings
from app.core.database import prepare_database_url

password = os.environ.get("APP_DB_PASSWORD", "")
if not password:
    sys.exit(0)
engine = create_engine(prepare_database_url(settings.DATABASE_URL))
with engine.begin() as conn:
    # Idempotent: the role already exists from migration 0048 on a normal
    # deployment, and CREATE covers the case where a DBA dropped it.
    conn.execute(text("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'appbi_app') THEN
                CREATE ROLE appbi_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
            END IF;
        END $$;
    """))
    conn.execute(text("ALTER ROLE appbi_app LOGIN PASSWORD :pw"), {"pw": password})
    conn.execute(text("GRANT USAGE ON SCHEMA public TO appbi_app"))
    conn.execute(text(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO appbi_app"))
    conn.execute(text(
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO appbi_app"))
print("    appbi_app ready (LOGIN, NOSUPERUSER, NOBYPASSRLS)")
PYROLE
fi

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
# Only while the users table is empty. There is NO default password: in
# production a missing/placeholder/weak ADMIN_PASSWORD stops startup here
# (app/core/bootstrap_admin.py); in development a random one-time password is
# printed once. The legacy "workspaces" -> "datasets" permission key fix runs
# for existing users as before.
python - <<'PYEOF' || { echo "==> FATAL: bootstrap administrator refused (see above)."; exit 1; }
import os, sys
from sqlalchemy import create_engine, text
from app.core.bootstrap_admin import BootstrapRefused, seed_first_admin

engine = create_engine(os.environ["DATABASE_URL"])
try:
    print("==> " + seed_first_admin(engine))
except BootstrapRefused as exc:
    print("==> " + str(exc), file=sys.stderr)
    sys.exit(1)
with engine.connect() as conn:
    fixed = conn.execute(text(
        "UPDATE users SET permissions = permissions - 'workspaces' "
        "|| jsonb_build_object('datasets', permissions->'workspaces') "
        "WHERE permissions ? 'workspaces'"
    )).rowcount
    conn.commit()
    if fixed:
        print(f"==> Fixed permissions key 'workspaces' -> 'datasets' for {fixed} user(s).")
PYEOF

# Client address: uvicorn's own proxy-header handling is OFF. With
# `--forwarded-allow-ips="*"` it took the LEFTMOST X-Forwarded-For entry — the
# one the client writes — so rotating that header defeated every per-IP rate
# limit (password guessing included). The app's TrustedProxyMiddleware
# (app/core/trusted_proxy.py) resolves the real viewer address instead: it
# honours forwarded headers only from TRUSTED_PROXY_CIDRS and takes the entry
# TRUSTED_PROXY_HOPS from the right (what nginx appended). Viewers still get
# separate buckets (one busy report does not exhaust a shared one); they can no
# longer choose theirs.
# Multiple workers so one slow/heavy request (or a background snapshot rebuild)
# can't block the whole app (single process = one GIL). Cross-worker request
# coalescing + the shared sqlite cache (query_cache) keep concurrent identical
# viewers from each hitting the warehouse. WEB_CONCURRENCY defaults to 1 (prior
# behaviour) — set it (e.g. 4) on the VM to scale concurrent report viewing.
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 \
    --workers "${WEB_CONCURRENCY:-1}" \
    --no-proxy-headers
