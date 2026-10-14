#!/usr/bin/env bash
# ============================================================================
# AppBI — roll an upgrade back to the state captured by prod-upgrade.sh.
#
#   scripts/deploy/prod-rollback.sh <backup-dir> [--yes]
#
# Restores, from <backup-dir>: the metadata database (db.dump), the appbi_data
# volume (appbi_data.tgz), .env (env.backup), and the previous images
# (rollback_image_* tags) — then starts the OLD commit.
#
# DATA LOSS: everything written after the backup was taken (new dashboards,
# grants, runs, uploaded files, synced data) is discarded. Reverting git alone
# does NOT reverse a migration; this script restores the database instead.
# ============================================================================
set -euo pipefail

BK="${1:-}"; ASSUME_YES=0; [ "${2:-}" = "--yes" ] && ASSUME_YES=1
[ -n "$BK" ] && [ -f "$BK/deploy-record.txt" ] || { echo "usage: $0 <backup-dir> [--yes]" >&2; exit 2; }
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){  printf '    [OK] %s\n' "$*"; }
die(){ printf '    [FAIL] %s\n' "$*" >&2; exit 1; }
rec(){ grep -m1 "^$1=" "$BK/deploy-record.txt" | cut -d= -f2-; }
envv(){ grep -m1 -E "^[[:space:]]*$1=" .env 2>/dev/null | sed -E "s/^[[:space:]]*$1=//" || true; }

(cd "$BK" && sha256sum -c SHA256SUMS >/dev/null) || die "backup checksums do not match — refusing to restore"
OLD_SHA="$(rec old_checkout)"; OLD_REV="$(rec old_revision)"; PROJECT="$(rec project)"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml)
for f in ${APPBI_COMPOSE_FILES:-}; do COMPOSE+=(-f "$f"); done
install -m 600 "$BK/env.backup" .env
LOCAL_DB=0; grep -qE '^[[:space:]]*DATABASE_URL=.+' .env || { COMPOSE+=(--profile local-db); LOCAL_DB=1; }
[ "$LOCAL_DB" = "1" ] || die "external DATABASE_URL: restore db.dump with your managed-DB tooling, then re-run with the DB restored"
DB_USER="$(envv DB_USER)"; DB_USER="${DB_USER:-appbi}"; DB_NAME="$(envv DB_NAME)"; DB_NAME="${DB_NAME:-appbi}"

say "ROLLBACK to $OLD_SHA (schema $OLD_REV) from $BK"
if [ "$ASSUME_YES" != "1" ]; then
  read -r -p "    This DISCARDS all writes since the backup. Type 'rollback' to continue: " a; [ "$a" = "rollback" ] || die "aborted"
fi

say "stop app services (database stays up)"
"${COMPOSE[@]}" --profile pdf stop backend frontend pdf-worker >/dev/null 2>&1 || "${COMPOSE[@]}" stop backend frontend

say "restore database"
"${COMPOSE[@]}" exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS ${DB_NAME}_rollback_tmp" \
  -c "CREATE DATABASE ${DB_NAME}_rollback_tmp"
"${COMPOSE[@]}" exec -T db sh -c "psql -U '$DB_USER' -d '${DB_NAME}_rollback_tmp' -qc 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null" || true
"${COMPOSE[@]}" exec -T db pg_restore -U "$DB_USER" -d "${DB_NAME}_rollback_tmp" --no-owner --exit-on-error < "$BK/db.dump" \
  || die "restore into a staging database failed — the current database is untouched"
# Swap only after the staging restore succeeded; keep the upgraded DB for forensics.
"${COMPOSE[@]}" exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DB_NAME','${DB_NAME}_rollback_tmp') AND pid <> pg_backend_pid()" \
  -c "ALTER DATABASE \"$DB_NAME\" RENAME TO \"${DB_NAME}_failed_$(date +%Y%m%d%H%M%S)\"" \
  -c "ALTER DATABASE \"${DB_NAME}_rollback_tmp\" RENAME TO \"$DB_NAME\"" >/dev/null
now="$("${COMPOSE[@]}" exec -T db psql -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version" | tr -d '\r')"
[ "$now" = "$OLD_REV" ] || die "restored revision $now != $OLD_REV"
ok "database restored at $OLD_REV (upgraded copy kept as ${DB_NAME}_failed_*)"

say "restore appbi_data volume"
docker run --rm -v "${PROJECT}_appbi_data:/data" -v "$(cd "$BK" && pwd):/bk:ro" alpine:3.20 \
  sh -c 'find /data -mindepth 1 -delete && tar -C /data -xzf /bk/appbi_data.tgz' || die "volume restore failed"
ok "appbi_data restored"

say "restore code + images"
git -c advice.detachedHead=false checkout --quiet "$OLD_SHA"
for svc in backend frontend; do
  img="$(rec "rollback_image_$svc")"
  if [ -n "$img" ] && docker image inspect "$img" >/dev/null 2>&1; then docker tag "$img" "${PROJECT}-${svc}:latest"
  else echo "    [WARN] no rollback image for $svc — rebuilding at $OLD_SHA"; GIT_SHA="$OLD_SHA" "${COMPOSE[@]}" build "$svc"; fi
done
GIT_SHA="" "${COMPOSE[@]}" up -d --no-build backend frontend

say "verify"
BACKEND_PORT="$(envv BACKEND_PORT)"; BACKEND_PORT="${BACKEND_PORT:-8000}"
for _ in $(seq 60); do curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1 && break; sleep 3; done
serving="$(curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/api/v1/health" | sed -nE 's/.*"git_sha":"([^"]*)".*/\1/p')"
echo "    serving: ${serving:-unknown} (expected $(rec old_serving))"
[ "$serving" = "$(rec old_serving)" ] || die "serving commit does not match the pre-upgrade one"
ok "ROLLBACK COMPLETE"
