#!/usr/bin/env bash
# ============================================================================
# AppBI — controlled upgrade of an EXISTING production install to a tagged release.
#
#   scripts/deploy/prod-upgrade.sh <release-tag> [--yes]
#
# Run on the production host, from the repository checkout that `./run.sh` serves.
# Fail-closed: any failed step stops the upgrade with the old schema intact
# (before migration) or with a verified backup to restore from (after).
#
#   PRE    tag + clean tree · record serving SHA, DB revision, secret fingerprints ·
#          validate .env · write-freeze (stop backend/frontend/pdf-worker) ·
#          pg_dump + appbi_data tar + .env copy · RESTORE-TEST the dump in a
#          throwaway container · keep the old images under a rollback tag
#   DEPLOY checkout tag · build with GIT_SHA=<tag commit> · ONE migration runner
#          (`backend migrate`, approved for exactly this head) · start services
#   POST   served SHA == tag commit · alembic == head · secrets unchanged ·
#          containers healthy · HTTP smoke incl. a public link · error-log scan
#
# Never: --pull, `down -v`, volume/image prune, secret regeneration.
# Env overrides: APPBI_COMPOSE_PROJECT (default: directory name), APPBI_COMPOSE_FILES
# (extra -f files, space separated), APPBI_BACKUP_DIR (default: ../appbi-backups).
# Rollback: scripts/deploy/prod-rollback.sh <backup-dir>
# ============================================================================
set -euo pipefail

TAG="${1:-}"; ASSUME_YES=0; [ "${2:-}" = "--yes" ] && ASSUME_YES=1
[ -n "$TAG" ] || { echo "usage: $0 <release-tag> [--yes]" >&2; exit 2; }

ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){  printf '    [OK] %s\n' "$*"; }
die(){ printf '    [FAIL] %s\n' "$*" >&2; exit 1; }
envv(){ grep -m1 -E "^[[:space:]]*$1=" .env 2>/dev/null | sed -E "s/^[[:space:]]*$1=//" || true; }
fp(){ printf '%s' "$1" | sha256sum | cut -c1-16; }   # fingerprint, never the value

PROJECT="${APPBI_COMPOSE_PROJECT:-$(basename "$ROOT")}"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml)
for f in ${APPBI_COMPOSE_FILES:-}; do COMPOSE+=(-f "$f"); done
LOCAL_DB=0; grep -qE '^[[:space:]]*DATABASE_URL=.+' .env || { COMPOSE+=(--profile local-db); LOCAL_DB=1; }
BACKEND_PORT="$(envv BACKEND_PORT)"; BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="$(envv FRONTEND_PORT)"; FRONTEND_PORT="${FRONTEND_PORT:-3000}"
DB_USER="$(envv DB_USER)"; DB_USER="${DB_USER:-appbi}"
DB_NAME="$(envv DB_NAME)"; DB_NAME="${DB_NAME:-appbi}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BK="${APPBI_BACKUP_DIR:-$ROOT/../appbi-backups}/$STAMP-$TAG"

# psql/pg_dump against the metadata DB, wherever it lives.
dbx(){  # dbx <cmd...>  (stdin passed through)
  if [ "$LOCAL_DB" = "1" ]; then "${COMPOSE[@]}" exec -T db "$@"
  else docker run --rm -i --network host pgvector/pgvector:pg16 "$@"; fi
}
DB_ARGS=(-U "$DB_USER" -d "$DB_NAME"); [ "$LOCAL_DB" = "1" ] || DB_ARGS=(-d "$(envv DATABASE_URL | sed -E 's#\+psycopg2##')")
dbrev(){ dbx psql "${DB_ARGS[@]}" -Atc "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version" 2>/dev/null | tr -d '\r'; }

# ── PRE 1: release identity ──────────────────────────────────────────────────
say "PRE: release identity"
git fetch --quiet --tags origin || die "git fetch failed"
[ "$(git cat-file -t "refs/tags/$TAG" 2>/dev/null)" = "tag" ] || die "$TAG is not an annotated tag"
TAG_SHA="$(git rev-parse "$TAG^{commit}")"
git merge-base --is-ancestor "$TAG_SHA" origin/master || die "$TAG is not on origin/master"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has local modifications — refuse to deploy an unverified tree"
OLD_SHA="$(git rev-parse HEAD)"
SERVING="$(curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/api/v1/health" 2>/dev/null | sed -nE 's/.*"git_sha":"([^"]*)".*/\1/p')"
ok "release $TAG = $TAG_SHA ; checkout $OLD_SHA ; serving ${SERVING:-unreachable}"

# ── PRE 2: environment ───────────────────────────────────────────────────────
say "PRE: environment (names only, never values)"
[ -f .env ] || die ".env missing — this script upgrades an existing install"
for k in SECRET_KEY DATASOURCE_ENCRYPTION_KEY ADMIN_PASSWORD; do
  v="$(envv "$k")"; case "$v" in ""|CHANGE_ME*|change-this-in-production) die "$k missing or placeholder";; esac
done
[ "${#ADMIN_PW:=$(envv ADMIN_PASSWORD)}" -ge 12 ] || die "ADMIN_PASSWORD shorter than 12 chars: this release refuses to boot with it in production"
unset ADMIN_PW
[ -n "$(envv CORS_ORIGINS)" ] || echo "    [WARN] CORS_ORIGINS unset — defaults to localhost only"
[ -n "$(envv ALLOWED_PRIVATE_SOURCE_CIDRS)" ] || [ "$(envv SOURCE_ALLOW_PRIVATE_NETWORK)" = "true" ] \
  || echo "    [WARN] no ALLOWED_PRIVATE_SOURCE_CIDRS: Postgres/MySQL sources on private hosts will be refused after upgrade"
SECRETS_FP="$(for k in SECRET_KEY DATASOURCE_ENCRYPTION_KEY DB_PASSWORD; do printf '%s=%s ' "$k" "$(fp "$(envv "$k")")"; done)"
ok "required secrets present; fingerprints recorded"

# ── PRE 3: schema state ──────────────────────────────────────────────────────
say "PRE: schema state"
OLD_REV="$(dbrev)"; [ -n "$OLD_REV" ] || die "cannot read alembic_version — is the database up?"
PY_BIN="$(command -v python3 || command -v python)" || die "need python3 (or python) on PATH"
TARGET_HEAD="$("$PY_BIN" - "$TAG_SHA" <<'PY'
import re, subprocess, sys
sha = sys.argv[1]
names = subprocess.run(["git", "ls-tree", "--name-only", sha, "backend/alembic/versions/"], capture_output=True, text=True, encoding="utf-8", check=True).stdout.split()
revs, downs = set(), set()
for n in names:
    if not n.endswith(".py"): continue
    src = subprocess.run(["git", "show", f"{sha}:{n}"], capture_output=True, text=True, encoding="utf-8", errors="replace", check=True).stdout
    # Line-bound: a docstring line such as "down_revision: X" has no "=" and must
    # not let the pattern run on into the next lines.
    m = re.search(r'^revision[ \t]*(?::[^=\n]*)?=[ \t]*["\']([^"\']+)', src, re.M)
    d = re.search(r'^down_revision[ \t]*(?::[^=\n]*)?=[ \t]*(.+)$', src, re.M)
    if m: revs.add(m.group(1))
    if d: downs.update(re.findall(r'["\']([^"\']+)["\']', d.group(1)))
heads = sorted(revs - downs)
print(",".join(heads)); sys.exit(0 if len(heads) == 1 else 1)
PY
)" || die "release does not have exactly one alembic head"
ok "database at $OLD_REV ; release head $TARGET_HEAD"

if [ "$ASSUME_YES" != "1" ]; then
  read -r -p "    Proceed: write-freeze, backup, migrate $OLD_REV -> $TARGET_HEAD ? [type yes] " a; [ "$a" = "yes" ] || die "aborted by operator"
fi

# ── PRE 4: write-freeze ──────────────────────────────────────────────────────
say "PRE: write-freeze (stop app services; the database stays up)"
"${COMPOSE[@]}" --profile pdf stop backend frontend pdf-worker >/dev/null 2>&1 || "${COMPOSE[@]}" stop backend frontend
ok "backend/frontend stopped — readers see the nginx error page until DEPLOY ends"

# ── PRE 5: backup ────────────────────────────────────────────────────────────
say "PRE: backup -> $BK"
mkdir -p "$BK"; chmod 700 "$BK"
dbx pg_dump "${DB_ARGS[@]}" -Fc > "$BK/db.dump" || die "pg_dump failed"
docker run --rm -v "${PROJECT}_appbi_data:/data:ro" -v "$BK:/bk" alpine:3.20 \
  tar -C /data -czf /bk/appbi_data.tgz . || die "appbi_data volume backup failed"
install -m 600 .env "$BK/env.backup"
{ echo "old_checkout=$OLD_SHA"; echo "old_serving=$SERVING"; echo "old_revision=$OLD_REV"
  echo "release_tag=$TAG"; echo "release_sha=$TAG_SHA"; echo "target_head=$TARGET_HEAD"
  echo "project=$PROJECT"; echo "secrets_fp=$SECRETS_FP"; } > "$BK/deploy-record.txt"
for svc in backend frontend; do
  img="$("${COMPOSE[@]}" images -q "$svc" 2>/dev/null | head -1)"
  [ -n "$img" ] && docker tag "$img" "${PROJECT}-${svc}:rollback-${OLD_SHA:0:12}" && echo "rollback_image_$svc=${PROJECT}-${svc}:rollback-${OLD_SHA:0:12}" >> "$BK/deploy-record.txt"
done
(cd "$BK" && sha256sum db.dump appbi_data.tgz > SHA256SUMS)
ok "db.dump $(du -h "$BK/db.dump" | cut -f1), appbi_data.tgz $(du -h "$BK/appbi_data.tgz" | cut -f1), .env copy (600), rollback images tagged"

# ── PRE 6: prove the backup restores ─────────────────────────────────────────
say "PRE: restore-test the dump in a throwaway container"
RT="appbi-restore-test-$STAMP"
docker run -d --rm --name "$RT" -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD=restoretest -e POSTGRES_DB="$DB_NAME" pgvector/pgvector:pg16 >/dev/null
trap 'docker rm -f "$RT" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 60); do docker exec "$RT" pg_isready -U "$DB_USER" -q 2>/dev/null && break; sleep 2; done
docker exec "$RT" psql -U "$DB_USER" -d "$DB_NAME" -qc "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
docker exec -i "$RT" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl --exit-on-error < "$BK/db.dump" || die "backup does NOT restore — stop here, services stay down, nothing migrated"
src_rows="$(dbx psql "${DB_ARGS[@]}" -Atc "SELECT count(*) FROM users")|$(dbx psql "${DB_ARGS[@]}" -Atc "SELECT count(*) FROM dashboards")"
rt_rows="$(docker exec "$RT" psql -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT count(*) FROM users")|$(docker exec "$RT" psql -U "$DB_USER" -d "$DB_NAME" -Atc "SELECT count(*) FROM dashboards")"
[ "$(echo "$src_rows" | tr -d '\r')" = "$(echo "$rt_rows" | tr -d '\r')" ] || die "restored counts differ (users|dashboards: $src_rows vs $rt_rows)"
docker rm -f "$RT" >/dev/null; trap - EXIT
ok "restored cleanly; users|dashboards $rt_rows match"

# ── DEPLOY ───────────────────────────────────────────────────────────────────
say "DEPLOY: checkout + build $TAG"
git -c advice.detachedHead=false checkout --quiet "$TAG_SHA"
export GIT_SHA="$TAG_SHA"
"${COMPOSE[@]}" build backend frontend || die "build failed — old images still tagged; run prod-rollback.sh $BK"

say "DEPLOY: migrate (single runner, approved for $TARGET_HEAD only)"
IMG_HEADS="$("${COMPOSE[@]}" run --rm --no-deps --entrypoint alembic backend heads 2>/dev/null | grep -oE '^[0-9A-Za-z_]+' | sort | paste -sd, -)"
[ "$IMG_HEADS" = "$TARGET_HEAD" ] || die "built image reports alembic heads '$IMG_HEADS', expected $TARGET_HEAD"
"${COMPOSE[@]}" run --rm --no-deps -e APPBI_MIGRATE_APPROVED="$TARGET_HEAD" backend migrate \
  || die "migration failed — services stay down; restore with: scripts/deploy/prod-rollback.sh $BK"
[ "$(dbrev)" = "$TARGET_HEAD" ] || die "alembic_version is $(dbrev), expected $TARGET_HEAD"
ok "schema at $TARGET_HEAD"

say "DEPLOY: start services"
"${COMPOSE[@]}" up -d --no-build backend frontend

# ── POST ─────────────────────────────────────────────────────────────────────
say "POST: verification"
fail=0
for i in $(seq 60); do curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1 && break; sleep 3; done
NOW="$(curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/api/v1/health" | sed -nE 's/.*"git_sha":"([^"]*)".*/\1/p')"
[ "$NOW" = "$TAG_SHA" ] && ok "serving $NOW" || { echo "    [FAIL] serving '${NOW:-?}' != $TAG_SHA"; fail=1; }
[ "$(dbrev)" = "$TARGET_HEAD" ] && ok "alembic $TARGET_HEAD" || { echo "    [FAIL] alembic $(dbrev)"; fail=1; }
NEW_FP="$(for k in SECRET_KEY DATASOURCE_ENCRYPTION_KEY DB_PASSWORD; do printf '%s=%s ' "$k" "$(fp "$(envv "$k")")"; done)"
[ "$NEW_FP" = "$SECRETS_FP" ] && ok "secrets unchanged (fingerprints)" || { echo "    [FAIL] a secret changed in .env"; fail=1; }
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$FRONTEND_PORT/login")"
[ "$code" = "200" ] && ok "frontend /login 200" || { echo "    [FAIL] frontend /login $code"; fail=1; }
TOK="$(dbx psql "${DB_ARGS[@]}" -Atc "SELECT token FROM dashboard_public_links WHERE is_active AND password_hash IS NULL ORDER BY id LIMIT 1" 2>/dev/null | tr -d '\r' || true)"
if [ -n "$TOK" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:$BACKEND_PORT/api/v1/public/dashboards/$TOK")"
  [ "$code" = "200" ] && ok "a public link answers 200" || { echo "    [FAIL] public link answered $code"; fail=1; }
else echo "    [SKIP] no unprotected active public link to probe"; fi
bad="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' backend frontend | grep -viE ' running' || true)"
[ -z "$bad" ] && ok "containers running" || { echo "    [FAIL] $bad"; fail=1; }
errs="$("${COMPOSE[@]}" logs --since 5m backend 2>&1 | grep -cE 'Traceback|" 5[0-9][0-9] ' || true)"
[ "$errs" = "0" ] && ok "no tracebacks / 5xx in backend log (5m)" || echo "    [WARN] $errs traceback/5xx lines in the last 5m — read them"
echo "new_serving=$NOW" >> "$BK/deploy-record.txt"

if [ "$fail" != "0" ]; then
  echo; echo "POST verification FAILED. Decide: fix forward, or scripts/deploy/prod-rollback.sh $BK"; exit 1
fi
say "UPGRADE COMPLETE: $TAG ($TAG_SHA), schema $TARGET_HEAD. Backup: $BK"
echo "    Now run the manual acceptance checklist in docs/production-release-runbook.md."
