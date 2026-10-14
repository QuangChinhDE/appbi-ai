#!/usr/bin/env bash
# ============================================================================
# AppBI — roll an upgrade back to the state captured by prod-upgrade.sh.
#
#   bash prod-rollback.sh <backup-dir> [--yes]
#
# Restores, from <backup-dir>: the metadata database (db.dump), the file-storage
# volume (appbi_data.tgz), .env (env.backup), and the pre-upgrade images
# (rollback_image_* tags), then starts the OLD commit and proves it is the old
# image on the old schema.
#
# Database restore, by deployment model:
#   bundled local-db  restore into a STAGING database, then swap names (the upgraded
#                     database is kept as <db>_failed_<time> for forensics)
#   managed Postgres  ONE transaction: DROP OWNED BY the app role + replay the dump
#                     (extensions and ownership excluded). Any error rolls the whole
#                     thing back and leaves the database untouched. Needs no
#                     CREATEDB / rename / superuser. If the provider snapshot from
#                     deploy-record.txt is available, restoring THAT is preferred.
#
# DATA LOSS: everything written after the backup is discarded. Reverting git alone
# does NOT reverse a migration; the database restore is the rollback.
# ============================================================================
set -euo pipefail

BK="${1:-}"; ASSUME_YES=0; [ "${2:-}" = "--yes" ] && ASSUME_YES=1
[ -n "$BK" ] && [ -f "$BK/deploy-record.txt" ] || { echo "usage: $0 <backup-dir> [--yes]" >&2; exit 2; }
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){  printf '    [OK] %s\n' "$*"; }
die(){ printf '    [FAIL] %s\n' "$*" >&2; exit 1; }
rec(){ grep -m1 "^$1=" "$BK/deploy-record.txt" | cut -d= -f2-; }
envv(){ grep -m1 -E "^[[:space:]]*$1=" .env 2>/dev/null | sed -E "s/^[[:space:]]*$1=//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/" || true; }
PY_BIN="$(command -v python3 || command -v python)" || die "need python3 (or python)"

(cd "$BK" && sha256sum -c SHA256SUMS >/dev/null) || die "backup checksums do not match — refusing to restore"
OLD_SHA="$(rec old_checkout)"; OLD_REV="$(rec old_revision)"; PROJECT="$(rec project)"; DATA_VOL="$(rec data_volume)"
DATA_VOL="${DATA_VOL:-${PROJECT}_appbi_data}"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml)
for f in ${APPBI_COMPOSE_FILES:-}; do COMPOSE+=(-f "$f"); done
install -m 600 "$BK/env.backup" .env
LOCAL_DB=0; [ -n "$(envv DATABASE_URL)" ] || { COMPOSE+=(--profile local-db); LOCAL_DB=1; }

if [ "$LOCAL_DB" = "1" ]; then
  export PGUSER="$(envv DB_USER)"; PGUSER="${PGUSER:-appbi}"
  export PGDATABASE="$(envv DB_NAME)"; PGDATABASE="${PGDATABASE:-appbi}"
else
  eval "$(DATABASE_URL="$(envv DATABASE_URL)" "$PY_BIN" - <<'PY'
import os, shlex
from urllib.parse import urlparse, unquote, parse_qs
u = urlparse(os.environ["DATABASE_URL"].replace("+psycopg2", "").replace("+psycopg", ""))
q = parse_qs(u.query)
for k, v in {"PGHOST": u.hostname, "PGPORT": str(u.port or 5432), "PGUSER": unquote(u.username or ""),
             "PGPASSWORD": unquote(u.password or ""), "PGDATABASE": (u.path or "/").lstrip("/"),
             "PGSSLMODE": (q.get("sslmode") or [""])[0]}.items():
    if v: print(f"export {k}={shlex.quote(v)}")
PY
)"
fi
PG_CLIENT_IMAGE="pgvector/pgvector:pg16"
dbx(){
  if [ "$LOCAL_DB" = "1" ]; then "${COMPOSE[@]}" exec -T -e PGUSER="$PGUSER" -e PGDATABASE="$PGDATABASE" db "$@"
  else docker run --rm -i --network "${APPBI_DB_CLIENT_NETWORK:-host}" -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$PG_CLIENT_IMAGE" "$@"; fi
}
dbrev(){ dbx psql -Atc "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version" | tr -d '\r'; }
if [ "$LOCAL_DB" = "0" ]; then
  SERVER_NUM="$(dbx psql -Atc 'SHOW server_version_num' | tr -d '\r')"; PG_CLIENT_IMAGE="postgres:$(( SERVER_NUM / 10000 ))"
fi

say "ROLLBACK to $OLD_SHA (schema $OLD_REV) from $BK"
[ "$LOCAL_DB" = "1" ] || echo "    managed Postgres; provider snapshot on record: $(rec provider_snapshot)"
if [ "$ASSUME_YES" != "1" ]; then
  read -r -p "    This DISCARDS all writes since the backup. Type 'rollback' to continue: " a; [ "$a" = "rollback" ] || die "aborted"
fi

say "stop app services (database stays up)"
"${COMPOSE[@]}" --profile pdf stop backend frontend pdf-worker >/dev/null 2>&1 || "${COMPOSE[@]}" stop backend frontend

say "restore database"
DB="$PGDATABASE"
if [ "$LOCAL_DB" = "1" ]; then
  dbx psql -d postgres -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS ${DB}_rollback_tmp" -c "CREATE DATABASE ${DB}_rollback_tmp"
  dbx psql -d "${DB}_rollback_tmp" -qc 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null || true
  dbx pg_restore -d "${DB}_rollback_tmp" --no-owner --exit-on-error < "$BK/db.dump" \
    || die "restore into a staging database failed — the current database is untouched"
  # Swap only after the staging restore succeeded; keep the upgraded DB for forensics.
  dbx psql -d postgres -v ON_ERROR_STOP=1 -q \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB','${DB}_rollback_tmp') AND pid <> pg_backend_pid()" \
    -c "ALTER DATABASE \"$DB\" RENAME TO \"${DB}_failed_$(date +%Y%m%d%H%M%S)\"" \
    -c "ALTER DATABASE \"${DB}_rollback_tmp\" RENAME TO \"$DB\"" >/dev/null
  ok "database restored (upgraded copy kept as ${DB}_failed_*)"
else
  # pg_restore's own SQL, minus the objects the app role does not own (extensions,
  # their comments) — replayed after DROP OWNED in ONE transaction.
  BKA="$(cd "$BK" && pwd)"
  docker run --rm -v "$BKA:/bk:ro" "$PG_CLIENT_IMAGE" pg_restore -l /bk/db.dump | grep -vE ' EXTENSION | COMMENT - EXTENSION ' > "$BK/rollback.list"
  { echo "SET client_min_messages = warning;"; echo "DROP OWNED BY CURRENT_USER;"
    docker run --rm -v "$BKA:/bk:ro" "$PG_CLIENT_IMAGE" pg_restore --no-owner --no-acl -L /bk/rollback.list -f - /bk/db.dump
  } | dbx psql -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null \
    || die "atomic restore failed and was rolled back — the database is unchanged. Restore the provider snapshot $(rec provider_snapshot) instead."
  ok "database restored atomically"
fi
now="$(dbrev)"; [ "$now" = "$OLD_REV" ] || die "restored revision $now != $OLD_REV"
ok "schema at $OLD_REV"

say "restore file storage volume $DATA_VOL"
docker run --rm -v "$DATA_VOL:/data" -v "$(cd "$BK" && pwd):/bk:ro" alpine:3.20 \
  sh -c 'find /data -mindepth 1 -delete && tar -C /data -xzf /bk/appbi_data.tgz' || die "volume restore failed"
ok "file storage restored"

say "restore code + images"
git -c advice.detachedHead=false checkout --quiet "$OLD_SHA"
for svc in backend frontend; do
  img="$(rec "rollback_image_$svc")"
  docker image inspect "$img" >/dev/null 2>&1 || die "rollback image $img is missing"
  docker tag "$img" "${PROJECT}-${svc}:latest"
done
GIT_SHA="" "${COMPOSE[@]}" up -d --no-build backend frontend

say "verify"
BACKEND_PORT="$(envv BACKEND_PORT)"; BACKEND_PORT="${BACKEND_PORT:-8000}"
for _ in $(seq 60); do curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1 && break; sleep 3; done
serving="$(curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/api/v1/health" | sed -nE 's/.*"git_sha":"([^"]*)".*/\1/p')"
echo "    serving: ${serving:-unknown} (expected $(rec old_serving))"
[ "$serving" = "$(rec old_serving)" ] || die "serving commit does not match the pre-upgrade one"
# An old build may report "unknown"; then the commit check proves nothing, so
# also require the running containers to be the exact pre-upgrade images.
for svc in backend frontend; do
  want="$(rec "rollback_image_$svc")"; cid="$("${COMPOSE[@]}" ps -q "$svc" | head -1)"
  [ "$(docker inspect -f '{{.Image}}' "$cid")" = "$(docker image inspect -f '{{.Id}}' "$want")" ] \
    || die "$svc is not running the pre-upgrade image $want"
  ok "$svc runs the pre-upgrade image"
done
[ "$(dbrev)" = "$OLD_REV" ] || die "after start the schema is $(dbrev), expected $OLD_REV"
ok "ROLLBACK COMPLETE"
