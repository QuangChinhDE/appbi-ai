#!/usr/bin/env bash
# ============================================================================
#  AppBI — ONE command to bring up the FULL system.
#
#    ./run.sh                 → AppBI core + OpenMetadata catalog (token auto-set)
#    CORE_ONLY=1 ./run.sh     → AppBI core only (catalog stays inert)
#
#  Idempotent: run on a fresh host OR an existing VM — it rebuilds to the latest
#  code and (re)bootstraps only what's missing. The OpenMetadata ingestion-bot
#  token is minted offline from the OM RSA key and written into .env — NO
#  hand-copy. It only orchestrates the hardened open-metadata/ pieces
#  (gen-secrets.sh, init-db/*.sql, docker-compose.openmetadata.yml).
#
#  Prereqs: docker + openssl on PATH; for catalog, set OPENMETADATA_VERSION in
#  open-metadata/.env (a verified stable tag). Managed Postgres: set DATABASE_URL
#  in .env (the local-db container is skipped automatically).
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$0")"

OM_DIR="open-metadata"
DB_CONTAINER="${APPBI_DB_CONTAINER:-appbi-ai-db-1}"
step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

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

# ── 3. Stable image tag required by the OM compose ──────────────────────────
step "OM image tag"
grep -qE '^OPENMETADATA_VERSION=.+' "$OM_DIR/.env" || {
  echo "✗ Set a verified STABLE tag in $OM_DIR/.env, e.g. OPENMETADATA_VERSION=1.7.6"
  exit 1; }
echo "· $(grep -E '^OPENMETADATA_VERSION=' "$OM_DIR/.env")"

# ── 4. openmetadata_db + least-priv role inside appbi-db (additive) ─────────
step "OM database + role (in $DB_CONTAINER)"
if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "✗ Postgres container '$DB_CONTAINER' not running."
  echo "  Managed PG: run $OM_DIR/init-db/*.sql yourself or set APPBI_DB_CONTAINER, then re-run."
  exit 1
fi
OM_PW="$(grep '^OM_DB_PASSWORD=' "$OM_DIR/.env" | cut -d= -f2-)"
[ -n "$OM_PW" ] || { echo "✗ OM_DB_PASSWORD empty — re-run $OM_DIR/gen-secrets.sh"; exit 1; }
docker exec -i "$DB_CONTAINER" psql -U appbi -d postgres \
  -v om_user="openmetadata_user" -v om_password="$OM_PW" \
  < "$OM_DIR/init-db/01-create-openmetadata-db.sql"
if [ "${SKIP_DB_HARDEN:-0}" != "1" ]; then
  docker exec -i "$DB_CONTAINER" psql -U appbi -d postgres \
    -v appbi_db="appbi" -v appbi_owner="appbi" \
    < "$OM_DIR/init-db/02-harden-appbi-isolation.sql"
fi

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

set_env() {  # idempotent upsert into repo-root .env
  if grep -q "^$1=" .env 2>/dev/null; then sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
  else echo "$1=$2" >> .env; fi
}

if [ -n "$TOKEN" ]; then
  set_env METADATA_CATALOG_ENABLED true
  set_env OPENMETADATA_API_URL "http://openmetadata-server:8585/api"
  set_env OPENMETADATA_BOT_TOKEN "$TOKEN"
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
