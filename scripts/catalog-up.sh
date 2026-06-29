#!/usr/bin/env bash
# One-command bring-up for the hidden OpenMetadata catalog backend.
#
# Collapses the 6 manual first-time steps in open-metadata/README.md into a
# single idempotent command. It ONLY orchestrates the deploy team's existing,
# hardened pieces (gen-secrets.sh, init-db/*.sql, docker-compose.openmetadata.yml)
# — it does NOT rewrite them or weaken the security posture.
#
#   bash scripts/catalog-up.sh
#
# Prereqs: core stack already up (so network `appbi-net` + the appbi Postgres
# exist), openssl + docker on PATH. Override the appbi Postgres container with
# APPBI_DB_CONTAINER=... (default: appbi-ai-db-1) when not using the local-db
# profile; for a MANAGED Postgres run open-metadata/init-db/*.sql yourself.
#
# NOTE: not yet run against the multi-GB OM image in this environment — verify on
# the test system. The final bot-token step is server-to-server and stays manual
# (printed at the end): OM must be healthy before its ingestion-bot JWT exists.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
OM_DIR="open-metadata"
DB_CONTAINER="${APPBI_DB_CONTAINER:-appbi-ai-db-1}"
COMPOSE=(docker compose -f "$OM_DIR/docker-compose.openmetadata.yml" --env-file "$OM_DIR/.env")

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

[ -d "$OM_DIR" ] || { echo "✗ $OM_DIR not found — are you in the repo root?"; exit 1; }
command -v openssl >/dev/null || { echo "✗ openssl not on PATH (needed by gen-secrets.sh)"; exit 1; }

# 1) Secrets (RSA JWT keys + strong OM DB password) — only if absent (don't rotate silently).
step "Secrets"
if [ -f "$OM_DIR/secrets/jwt/private_key.der" ] && [ -f "$OM_DIR/.env" ]; then
  echo "· already present — skipping gen-secrets (rerun gen-secrets.sh to rotate)"
else
  bash "$OM_DIR/gen-secrets.sh"
fi

# 2) Stable image tag must be set (compose hard-requires OPENMETADATA_VERSION).
step "Image tag"
if ! grep -qE '^OPENMETADATA_VERSION=.+' "$OM_DIR/.env"; then
  echo "✗ Set a verified STABLE tag in $OM_DIR/.env, e.g. OPENMETADATA_VERSION=1.7.6"
  echo "  (verify: docker manifest inspect docker.getcollate.io/openmetadata/server:1.7.6)"
  exit 1
fi
echo "· $(grep -E '^OPENMETADATA_VERSION=' "$OM_DIR/.env")"

# 3) Create openmetadata_db + least-priv role inside the appbi Postgres (additive).
step "OM database + role (in $DB_CONTAINER)"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "✗ Postgres container '$DB_CONTAINER' not running."
  echo "  Local-db: start core stack first. Managed PG: run $OM_DIR/init-db/*.sql manually,"
  echo "  set APPBI_DB_CONTAINER, or apply via your DB console, then re-run."
  exit 1
fi
OM_PW="$(grep '^OM_DB_PASSWORD=' "$OM_DIR/.env" | cut -d= -f2-)"
[ -n "$OM_PW" ] || { echo "✗ OM_DB_PASSWORD empty in $OM_DIR/.env — re-run gen-secrets.sh"; exit 1; }
docker exec -i "$DB_CONTAINER" psql -U appbi -d postgres \
  -v om_user="openmetadata_user" -v om_password="$OM_PW" \
  < "$OM_DIR/init-db/01-create-openmetadata-db.sql"

# 4) (recommended) lock the appbi DB so OM's role can never connect to it.
if [ "${SKIP_DB_HARDEN:-0}" != "1" ]; then
  step "Harden appbi DB isolation"
  docker exec -i "$DB_CONTAINER" psql -U appbi -d postgres \
    -v appbi_db="appbi" -v appbi_owner="appbi" \
    < "$OM_DIR/init-db/02-harden-appbi-isolation.sql"
else
  echo "· skipped DB hardening (SKIP_DB_HARDEN=1)"
fi

# 5) Bring up OM + opensearch + run migrate (first pull is several GB).
step "Bring up OM stack"
"${COMPOSE[@]}" up -d

# 6) Wait for OM server health (migrate runs first; server ~1–2 min).
step "Waiting for OM health (up to ~4 min)"
ok=0
for i in $(seq 1 48); do
  if docker exec appbi-om-server wget -q --spider http://localhost:8586/healthcheck 2>/dev/null; then
    ok=1; echo "✓ OM server healthy"; break
  fi
  sleep 5
done
[ "$ok" = 1 ] || { echo "✗ OM not healthy yet — check: docker logs -f appbi-om-server"; exit 1; }

cat <<'EONOTE'

────────────────────────────────────────────────────────────────────────
✓ OM stack is up. ONE manual step remains (server-to-server auth):

  1) Fetch the ingestion-bot JWT from OM (see open-metadata/README.md §Bot token).
  2) In the repo-root .env set:
        METADATA_CATALOG_ENABLED=true
        OPENMETADATA_API_URL=http://openmetadata-server:8585/api
        OPENMETADATA_BOT_TOKEN=<ingestion-bot JWT>
  3) Rebuild the AppBI backend:  docker compose up -d --build backend

Until METADATA_CATALOG_ENABLED=true the catalog is inert; the core app is unaffected.
────────────────────────────────────────────────────────────────────────
EONOTE
