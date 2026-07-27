#!/bin/sh
# Entrypoint for the PDF render worker.
#
# The API image's entrypoint derives DATABASE_URL from the DB_* variables when it
# is empty (the stock .env ships `DATABASE_URL=` blank and fills DB_HOST/…).
# The worker imports the same `app.core.database`, so it needs the same
# derivation — without it SQLAlchemy is handed an empty URL and the container
# crash-loops on startup.
set -e

: "${DB_HOST:=appbi-db}"
: "${DB_PORT:=5432}"
: "${DB_USER:=appbi}"
: "${DB_PASSWORD:=appbi}"
: "${DB_NAME:=appbi}"

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="postgresql+psycopg2://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi

echo "==> pdf-worker starting (db=${DB_HOST}:${DB_PORT}/${DB_NAME}, render=${PDF_RENDER_BASE_URL:-unset})"

# Wait for the metadata DB so a cold `docker compose up` doesn't crash-loop
# while Postgres is still initialising.
until pg_isready -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -q; do
  >&2 echo "    metadata DB unavailable — retrying in 2s"
  sleep 2
done

exec python -m app.scripts.pdf_worker
