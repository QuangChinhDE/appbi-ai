#!/usr/bin/env bash
# ============================================================================
#  AppBI — ONE command to bring up the FULL system.
#
#    ./run.sh                 → AppBI core + OpenMetadata catalog (token auto-set)
#    CORE_ONLY=1 ./run.sh     → AppBI core only (catalog stays inert)
#
#  Pull the latest code yourself first (this script does NOT run git), then one
#  `bash run.sh` stands the whole system up — no going elsewhere to export tokens
#  or set vars. Idempotent (fresh host or existing VM); rebuilds + (re)bootstraps
#  only what's missing. AUTO-handled, no manual step: OM secrets (gen-secrets if
#  absent), OPENMETADATA_VERSION (defaulted if unset), openmetadata_db + role, the
#  ingestion-bot token (minted offline from the OM RSA key → written to .env, NO
#  hand-copy), backend restart.
#
#  NOT auto-fixed: a genuinely broken OM (bad image / OOM / crash) — run.sh waits
#  for health and, if it fails, prints the log command instead of hiding it.
#
#  Prereqs: docker + openssl on PATH. Managed Postgres: set DATABASE_URL in .env
#  (the local-db container is skipped automatically). Override the OM version:
#  OPENMETADATA_VERSION=1.x.y bash run.sh   (else it defaults the first time).
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$0")"

OM_DIR="open-metadata"
DB_CONTAINER="${APPBI_DB_CONTAINER:-appbi-ai-db-1}"
step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

# Idempotent upsert of KEY=VAL into an env file. Uses printf (NOT sed) so values
# with &, !, |, / etc. (e.g. JDBC params, passwords) are written verbatim.
envset() {
  local f="$1" k="$2" v="$3" tmp
  tmp="$(mktemp)"
  [ -f "$f" ] && grep -v "^$k=" "$f" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  mv "$tmp" "$f"
}

# This script does NOT touch git — pull the code yourself first, then run it.

# Local-db profile unless an external DATABASE_URL is configured.
CORE_PROFILE=()
grep -qE '^DATABASE_URL=.+' .env 2>/dev/null || CORE_PROFILE=(--profile local-db)

# ── 1. AppBI core (creates appbi-net + appbi-db) ────────────────────────────
step "AppBI core"
docker compose "${CORE_PROFILE[@]}" up -d --build

if [ "${CORE_ONLY:-0}" = "1" ]; then
  echo; echo "✓ Core up (catalog inert). Open http://localhost:${FRONTEND_PORT:-3000}"
  exit 0
fi

[ -d "$OM_DIR" ] || { echo "✗ $OM_DIR not found — catalog skipped."; exit 0; }
command -v openssl >/dev/null || { echo "✗ openssl needed for catalog (gen-secrets)"; exit 1; }

# ── 2. OM secrets (RSA JWT keys + DB password) — only if absent ─────────────
step "OM secrets"
if [ -f "$OM_DIR/secrets/jwt/private_key.der" ] && [ -f "$OM_DIR/.env" ]; then
  echo "· present — skipping (rerun $OM_DIR/gen-secrets.sh to rotate)"
else
  bash "$OM_DIR/gen-secrets.sh"
fi
# Be robust: the compose hard-requires OM_JWT_KEY_ID; ensure it (and the domain)
# are present even if a prior gen-secrets/.env.example didn't fill them.
grep -qE '^OM_JWT_KEY_ID=.+' "$OM_DIR/.env" 2>/dev/null || {
  envset "$OM_DIR/.env" OM_JWT_KEY_ID \
    "$(openssl rand -hex 4)-$(openssl rand -hex 2)-$(openssl rand -hex 2)-$(openssl rand -hex 2)-$(openssl rand -hex 6)"
  echo "· generated missing OM_JWT_KEY_ID"; }
grep -qE '^OM_PRINCIPAL_DOMAIN=.+' "$OM_DIR/.env" 2>/dev/null || envset "$OM_DIR/.env" OM_PRINCIPAL_DOMAIN "appbi.local"

# ── 3. Image tag — auto-default if unset (override: OPENMETADATA_VERSION env) ─
step "OM image tag"
if grep -qE '^OPENMETADATA_VERSION=.+' "$OM_DIR/.env"; then
  echo "· $(grep -E '^OPENMETADATA_VERSION=' "$OM_DIR/.env")"
else
  VER="${OPENMETADATA_VERSION:-1.7.6}"
  if grep -qE '^OPENMETADATA_VERSION=' "$OM_DIR/.env"; then
    sed -i.bak "s|^OPENMETADATA_VERSION=.*|OPENMETADATA_VERSION=$VER|" "$OM_DIR/.env" && rm -f "$OM_DIR/.env.bak"
  else
    echo "OPENMETADATA_VERSION=$VER" >> "$OM_DIR/.env"
  fi
  echo "· defaulted OPENMETADATA_VERSION=$VER (override: OPENMETADATA_VERSION=1.x.y bash run.sh, or edit $OM_DIR/.env)"
fi

# ── 4. OM lives in the SAME AppBI Postgres + database, in its OWN schema ────
#    `open_metadata` (never the `public` schema). Works for the external/managed
#    AppBI DB (DATABASE_URL) or a local appbi-db container. Reads the connection
#    from .env — the password is NEVER written to a tracked file.
step "OM schema (open_metadata) in the AppBI database"

# Parse the AppBI DB connection from .env (DATABASE_URL preferred, else DB_*).
PGHOST=""; PGPORT=""; PGUSER=""; PGPW=""; PGDB=""; PGSSL=""
_url="$(grep '^DATABASE_URL=' .env 2>/dev/null | cut -d= -f2-)"
if [ -n "$_url" ]; then
  _rest="${_url#*://}"; _creds="${_rest%%@*}"; _hpd="${_rest#*@}"
  PGUSER="${_creds%%:*}"; PGPW="${_creds#*:}"
  _hp="${_hpd%%/*}"; PGHOST="${_hp%%:*}"; PGPORT="${_hp#*:}"; [ "$PGPORT" = "$_hp" ] && PGPORT=5432
  _db="${_hpd#*/}"; PGDB="${_db%%\?*}"
  case "$_url" in *sslmode=require*|*ssl=true*) PGSSL=1;; esac
else
  PGHOST="$(grep '^DB_HOST=' .env|cut -d= -f2-)"; PGPORT="$(grep '^DB_PORT=' .env|cut -d= -f2-)"
  PGUSER="$(grep '^DB_USER=' .env|cut -d= -f2-)"; PGPW="$(grep '^DB_PASSWORD=' .env|cut -d= -f2-)"
  PGDB="$(grep '^DB_NAME=' .env|cut -d= -f2-)"; PGPORT="${PGPORT:-5432}"
fi
[ -n "$PGHOST" ] && [ -n "$PGDB" ] && [ -n "$PGUSER" ] || { echo "✗ Can't read DB connection from .env"; exit 1; }

# Create the schema against the AppBI DB — via the local container if present,
# else a one-off psql container connecting over the network (SSL if required).
SCHEMA_SQL='CREATE SCHEMA IF NOT EXISTS open_metadata AUTHORIZATION "'"$PGUSER"'";'
if docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "$SCHEMA_SQL" | docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -f -
else
  echo "$SCHEMA_SQL" | docker run --rm -i --network appbi-net \
    -e PGPASSWORD="$PGPW" ${PGSSL:+-e PGSSLMODE=require} postgres:16 \
    psql -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -f -
fi
echo "· schema open_metadata ready in $PGDB @ $PGHOST"

# Point OM at the same DB/user, in that schema, matching SSL (never touches public).
envset "$OM_DIR/.env" OM_DB_HOST "$PGHOST"; envset "$OM_DIR/.env" OM_DB_PORT "$PGPORT"
envset "$OM_DIR/.env" OM_DB_NAME "$PGDB"; envset "$OM_DIR/.env" OM_DB_USER "$PGUSER"
envset "$OM_DIR/.env" OM_DB_PASSWORD "$PGPW"
if [ -n "$PGSSL" ]; then
  envset "$OM_DIR/.env" OM_DB_PARAMS "ssl=true&sslmode=require&currentSchema=open_metadata"
else
  envset "$OM_DIR/.env" OM_DB_PARAMS "currentSchema=open_metadata&useSSL=false"
fi
echo "· OM → $PGUSER@$PGHOST:$PGPORT/$PGDB (schema open_metadata)"

# ── 5. OM + opensearch up (first pull is several GB) ────────────────────────
step "OM stack up"
docker compose -f "$OM_DIR/docker-compose.openmetadata.yml" --env-file "$OM_DIR/.env" up -d

# ── 6. Wait for OM health (migrate first; server ~1–2 min) ──────────────────
step "Waiting for OM health (up to ~4 min)"
ok=0
for _ in $(seq 1 48); do
  if docker exec appbi-om-server wget -q --spider http://localhost:8586/healthcheck 2>/dev/null; then
    ok=1; echo "✓ OM healthy"; break
  fi
  sleep 5
done
[ "$ok" = 1 ] || { echo "✗ OM not healthy yet — check: docker logs -f appbi-om-server"; exit 1; }

# ── 7. Mint ingestion-bot token offline (OM trusts our key via JWKS) → .env ──
step "Bot token → .env"
KID="$(grep '^OM_JWT_KEY_ID=' "$OM_DIR/.env" | cut -d= -f2-)"
DOMAIN="$(grep '^OM_PRINCIPAL_DOMAIN=' "$OM_DIR/.env" | cut -d= -f2-)"; DOMAIN="${DOMAIN:-appbi.local}"
KEY_DER="$OM_DIR/secrets/jwt/private_key.der"
BACKEND_CID="$(docker compose ps -q backend 2>/dev/null || true)"
TOKEN=""
if [ -n "$KID" ] && [ -f "$KEY_DER" ] && [ -n "$BACKEND_CID" ]; then
  docker cp "$KEY_DER" "$BACKEND_CID:/tmp/_om_priv.der" >/dev/null 2>&1 || true
  TOKEN="$(docker exec -i "$BACKEND_CID" python - "$KID" "$DOMAIN" "ingestion-bot@$DOMAIN" /tmp/_om_priv.der <<'PY' 2>/dev/null || true
import sys, base64, json, time
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
kid, issuer, email, der = sys.argv[1:5]
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=')
key = serialization.load_der_private_key(open(der, 'rb').read(), password=None)
hdr = {'alg': 'RS256', 'typ': 'JWT', 'kid': kid}
cl = {'sub': 'ingestion-bot', 'email': email, 'isBot': True,
      'tokenType': 'BOT', 'iss': issuer, 'iat': int(time.time())}
si = b64u(json.dumps(hdr, separators=(',', ':')).encode()) + b'.' + \
     b64u(json.dumps(cl, separators=(',', ':')).encode())
sig = key.sign(si, padding.PKCS1v15(), hashes.SHA256())
sys.stdout.write((si + b'.' + b64u(sig)).decode())
PY
)"
  docker exec "$BACKEND_CID" rm -f /tmp/_om_priv.der >/dev/null 2>&1 || true
fi

if [ -n "$TOKEN" ]; then
  envset .env METADATA_CATALOG_ENABLED true
  envset .env OPENMETADATA_API_URL "http://openmetadata-server:8585/api"
  envset .env OPENMETADATA_BOT_TOKEN "$TOKEN"
  echo "✓ ingestion-bot token minted + written to .env — restarting backend…"
  docker compose "${CORE_PROFILE[@]}" up -d --build backend
  echo
  echo "✓ FULL stack up (AppBI core + OM + catalog). Verify token (expect 200):"
  echo "  docker exec $BACKEND_CID python -c \"import os,urllib.request as u;\\"
  echo "    r=u.Request('http://openmetadata-server:8585/api/v1/users',\\"
  echo "    headers={'Authorization':'Bearer '+os.environ['OPENMETADATA_BOT_TOKEN']});print(u.urlopen(r).status)\""
  echo "  (401 ⇒ JWT claims need a per-OM-version tweak in this file's minter)"
else
  echo "· could not auto-mint (backend container or OM key not found). Fallback:"
  echo "    open-metadata/README.md §Bot token → set OPENMETADATA_BOT_TOKEN +"
  echo "    METADATA_CATALOG_ENABLED=true in .env → docker compose up -d --build backend"
fi
