#!/usr/bin/env bash
# ============================================================================
# AppBI — controlled upgrade of an EXISTING production install to a tagged release.
#
#   bash prod-upgrade.sh <release-tag> [--yes]
#   (take this file from the tag: `git show <tag>:scripts/deploy/prod-upgrade.sh`)
#
# Fail-closed. Until the migration has run, ANY failure restores the old code,
# images and services automatically (the schema is untouched). After the
# migration, a failure stops and tells you to run prod-rollback.sh.
#
#   PRE     tag on origin/master · clean tree · discover the REAL compose project,
#           containers and volumes · validate .env · record secret fingerprints
#   BUILD   tag old images for rollback · checkout tag · build (old service still
#           serving) · image alembic head == tag head
#   GATE    source inventory with the NEW image + .env: every PostgreSQL/MySQL
#           source must be allowed by the outbound policy (or explicitly accepted)
#   FREEZE  stop backend/frontend/pdf-worker (the database stays up)
#   BACKUP  pg_dump (server-matched client) · appbi_data volume tar · .env copy ·
#           restore-test in a throwaway container · managed DB: provider snapshot
#   MIGRATE ONE runner, approved for exactly the target head
#   POST    served SHA · alembic head · secrets unchanged · health · login page ·
#           public link · containers · error scan
#
# Environment:
#   APPBI_COMPOSE_PROJECT      override the compose project (default: COMPOSE_PROJECT_NAME
#                              from .env, else the checkout directory name)
#   APPBI_COMPOSE_FILES        extra -f files, space separated
#   APPBI_BACKUP_DIR           default ../appbi-backups
#   APPBI_DB_CLIENT_NETWORK    docker network for the managed-DB client (default: host)
#   APPBI_PROVIDER_SNAPSHOT    managed Postgres only: the provider snapshot/backup id
#                              taken during the freeze (REQUIRED unless the next is set)
#   APPBI_ACCEPT_NO_PROVIDER_SNAPSHOT=yes   proceed on pg_dump alone
#   APPBI_ACCEPT_BLOCKED_SOURCES="12,31"    source ids the operator accepts will stop
#                              working (never a blanket switch)
# Never: --pull, `down -v`, prune, secret regeneration.
# ============================================================================
set -euo pipefail

TAG="${1:-}"; ASSUME_YES=0; [ "${2:-}" = "--yes" ] && ASSUME_YES=1
[ -n "$TAG" ] || { echo "usage: $0 <release-tag> [--yes]" >&2; exit 2; }

ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){  printf '    [OK] %s\n' "$*"; }
warn(){ printf '    [WARN] %s\n' "$*"; }
die(){ printf '    [FAIL] %s\n' "$*" >&2; exit 1; }
envv(){ grep -m1 -E "^[[:space:]]*$1=" .env 2>/dev/null | sed -E "s/^[[:space:]]*$1=//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/" || true; }
fp(){ printf '%s' "$1" | sha256sum | cut -c1-16; }   # fingerprint, never the value
PY_BIN="$(command -v python3 || command -v python)" || die "need python3 (or python) on PATH"

[ -f .env ] || die ".env missing — this script upgrades an existing install"
PROJECT="${APPBI_COMPOSE_PROJECT:-$(envv COMPOSE_PROJECT_NAME)}"; PROJECT="${PROJECT:-$(basename "$ROOT")}"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml)
for f in ${APPBI_COMPOSE_FILES:-}; do COMPOSE+=(-f "$f"); done
LOCAL_DB=0; [ -n "$(envv DATABASE_URL)" ] || { COMPOSE+=(--profile local-db); LOCAL_DB=1; }
BACKEND_PORT="$(envv BACKEND_PORT)"; BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="$(envv FRONTEND_PORT)"; FRONTEND_PORT="${FRONTEND_PORT:-3000}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BK="${APPBI_BACKUP_DIR:-$ROOT/../appbi-backups}/$STAMP-$TAG"

# ── metadata-DB access, credentials only via inherited env vars (never argv) ──
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
dbx(){  # dbx <client cmd...>   stdin passed through
  if [ "$LOCAL_DB" = "1" ]; then "${COMPOSE[@]}" exec -T -e PGUSER="$PGUSER" -e PGDATABASE="$PGDATABASE" db "$@"
  else docker run --rm -i --network "${APPBI_DB_CLIENT_NETWORK:-host}" -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE "$PG_CLIENT_IMAGE" "$@"; fi
}
dbrev(){ dbx psql -Atc "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version" 2>/dev/null | tr -d '\r'; }

# ── automatic recovery for any failure BEFORE the migration ──────────────────
STAGE="pre"; OLD_SHA=""; RECOVER_IMAGES=0
recover(){
  rc=$?
  [ "$rc" = "0" ] && return
  case "$STAGE" in
    pre) return ;;                              # nothing changed yet
    migrated|done) echo; echo "    The schema is already migrated: NOT auto-recovering."
                   echo "    Fix forward, or: bash prod-rollback.sh $BK"; return ;;
  esac
  echo; say "RECOVERY: restoring the pre-upgrade service (schema untouched)"
  git -c advice.detachedHead=false checkout --quiet "$OLD_SHA" || true
  if [ "$RECOVER_IMAGES" = "1" ]; then
    for svc in backend frontend; do
      docker tag "${PROJECT}-${svc}:rollback-${OLD_SHA:0:12}" "${PROJECT}-${svc}:latest" 2>/dev/null || true
    done
  fi
  GIT_SHA="" "${COMPOSE[@]}" up -d --no-build backend frontend >/dev/null 2>&1 || true
  for _ in $(seq 40); do curl -fsS --max-time 3 "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1 && break; sleep 3; done
  now="$(curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/api/v1/health" 2>/dev/null | sed -nE 's/.*"git_sha":"([^"]*)".*/\1/p')"
  echo "    old service: $( [ -n "$now" ] && echo "serving '${now}'" || echo 'NOT answering — start it by hand' ), schema $(dbrev)"
}
trap recover EXIT

# ── PRE 1: release identity ──────────────────────────────────────────────────
say "PRE: release identity"
git fetch --quiet --tags origin || die "git fetch failed"
[ "$(git cat-file -t "refs/tags/$TAG" 2>/dev/null)" = "tag" ] || die "$TAG is not an annotated tag"
TAG_SHA="$(git rev-parse "$TAG^{commit}")"
git merge-base --is-ancestor "$TAG_SHA" origin/master || die "$TAG is not on origin/master"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree has local modifications — refuse to deploy an unverified tree"
OLD_SHA="$(git rev-parse HEAD)"
SERVING="$(curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/api/v1/health" 2>/dev/null | sed -nE 's/.*"git_sha":"([^"]*)".*/\1/p' || true)"
ok "release $TAG = $TAG_SHA ; checkout $OLD_SHA ; serving ${SERVING:-unreachable}"

# ── PRE 2: the real deployment (project, containers, volumes) ────────────────
say "PRE: deployment discovery (project '$PROJECT', $( [ "$LOCAL_DB" = 1 ] && echo 'bundled local-db' || echo 'external/managed Postgres'))"
BE_CID="$("${COMPOSE[@]}" ps -q backend 2>/dev/null | head -1)"
[ -n "$BE_CID" ] || die "no backend container in compose project '$PROJECT' — wrong project? set APPBI_COMPOSE_PROJECT (docker ps shows the real name)"
DATA_VOL="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/.data"}}{{.Name}}{{end}}{{end}}' "$BE_CID")"
[ -n "$DATA_VOL" ] || die "backend has no named volume at /app/.data — refusing: cannot back up file storage"
ok "backend $(docker inspect -f '{{.Name}}' "$BE_CID") ; file storage volume '$DATA_VOL'"
OTHER_MOUNTS="$(docker inspect -f '{{range .Mounts}}{{if ne .Destination "/app/.data"}}{{.Type}}:{{.Name}}{{.Source}}->{{.Destination}} {{end}}{{end}}' "$BE_CID")"
[ -z "$OTHER_MOUNTS" ] || warn "backend has other mounts NOT covered by this backup: $OTHER_MOUNTS"
if [ "$LOCAL_DB" = "1" ]; then
  DB_CID="$("${COMPOSE[@]}" ps -q db 2>/dev/null | head -1)"
  [ -n "$DB_CID" ] || die "DATABASE_URL is not set, but no 'db' container runs in project '$PROJECT'"
  ok "database container $(docker inspect -f '{{.Name}}' "$DB_CID")"
else
  SERVER_NUM="$(dbx psql -Atc 'SHOW server_version_num' 2>/dev/null | tr -d '\r')" || true
  [ -n "$SERVER_NUM" ] || die "cannot reach the managed database from this host with DATABASE_URL"
  PG_CLIENT_IMAGE="postgres:$(( SERVER_NUM / 10000 ))"
  ok "managed Postgres server $SERVER_NUM ; dump client $PG_CLIENT_IMAGE"
  if [ -z "${APPBI_PROVIDER_SNAPSHOT:-}" ] && [ "${APPBI_ACCEPT_NO_PROVIDER_SNAPSHOT:-}" != "yes" ]; then
    die "managed Postgres: take a provider snapshot during the window and pass APPBI_PROVIDER_SNAPSHOT=<id> (or APPBI_ACCEPT_NO_PROVIDER_SNAPSHOT=yes)"
  fi
fi

# ── PRE 3: environment ───────────────────────────────────────────────────────
say "PRE: environment (names only, never values)"
for k in SECRET_KEY DATASOURCE_ENCRYPTION_KEY ADMIN_PASSWORD; do
  v="$(envv "$k")"; case "$v" in ""|CHANGE_ME*|change-this-in-production) die "$k missing or placeholder";; esac
done
ADMIN_PW="$(envv ADMIN_PASSWORD)"
[ "${#ADMIN_PW}" -ge 12 ] || die "ADMIN_PASSWORD shorter than 12 chars: this release refuses to boot with it in production"
unset ADMIN_PW
[ "$(envv SOURCE_ALLOW_PRIVATE_NETWORK)" != "true" ] || warn "SOURCE_ALLOW_PRIVATE_NETWORK=true opens EVERY private range to user-chosen sources — prefer ALLOWED_PRIVATE_SOURCE_CIDRS"
[ -n "$(envv CORS_ORIGINS)" ] || warn "CORS_ORIGINS unset — defaults to localhost only"
[ -z "$(envv APPBI_MIGRATE_APPROVED)" ] || die "APPBI_MIGRATE_APPROVED is set in .env — remove it; it would approve every future migration on any restart"
SECRET_KEYS="SECRET_KEY DATASOURCE_ENCRYPTION_KEY DB_PASSWORD DATABASE_URL APP_DB_PASSWORD"
secrets_fp(){ for k in $SECRET_KEYS; do printf '%s=%s ' "$k" "$(fp "$(envv "$k")")"; done; }
SECRETS_FP="$(secrets_fp)"
ok "required secrets present; fingerprints recorded"

# ── PRE 4: schema state ──────────────────────────────────────────────────────
say "PRE: schema state"
OLD_REV="$(dbrev)"; [ -n "$OLD_REV" ] || die "cannot read alembic_version — is the database up?"
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
  read -r -p "    Proceed: build, source gate, write-freeze, backup, migrate $OLD_REV -> $TARGET_HEAD ? [type yes] " a; [ "$a" = "yes" ] || die "aborted by operator"
fi

# ── BUILD (the old service keeps serving) ────────────────────────────────────
say "BUILD: keep the old images under a rollback tag, then build $TAG"
mkdir -p "$BK"; chmod 700 "$BK"
for svc in backend frontend; do
  cid="$("${COMPOSE[@]}" ps -q "$svc" | head -1)"; [ -n "$cid" ] || die "$svc is not running — cannot capture its image for rollback"
  docker tag "$(docker inspect -f '{{.Image}}' "$cid")" "${PROJECT}-${svc}:rollback-${OLD_SHA:0:12}"
done
RECOVER_IMAGES=1; STAGE="built"
git -c advice.detachedHead=false checkout --quiet "$TAG_SHA"
export GIT_SHA="$TAG_SHA"
"${COMPOSE[@]}" build backend frontend || die "build failed"
IMG_HEADS="$("${COMPOSE[@]}" run --rm --no-deps --entrypoint alembic backend heads 2>/dev/null | grep -oE '^[0-9A-Za-z_]+' | sort | paste -sd, -)"
[ "$IMG_HEADS" = "$TARGET_HEAD" ] || die "built image reports alembic heads '$IMG_HEADS', expected $TARGET_HEAD"
ok "images built for $TAG_SHA ; image head $IMG_HEADS"

# ── GATE: production data sources must keep working ──────────────────────────
say "GATE: database-source inventory under the NEW image's outbound policy"
set +e
INV="$("${COMPOSE[@]}" run --rm --no-deps -T backend source-inventory --probe --json 2>"$BK/source-inventory.err")"; inv_rc=$?
set -e
# The entrypoint prints its own "==>" banner lines first; the inventory is the JSON line.
INV="$(printf '%s\n' "$INV" | grep -E '^\[' | tail -n1 || true)"
printf '%s\n' "$INV" > "$BK/source-inventory.json"
[ "$inv_rc" = "0" ] || [ "$inv_rc" = "4" ] || { cat "$BK/source-inventory.err" >&2; die "source inventory could not run (exit $inv_rc)"; }
NOT_OK="$(printf '%s' "$INV" | "$PY_BIN" -c "
import json, os, sys
acc = {s.strip() for s in os.environ.get('APPBI_ACCEPT_BLOCKED_SOURCES', '').split(',') if s.strip()}
for v in json.loads(sys.stdin.read() or '[]'):
    if v['verdict'] == 'ALLOWED':
        continue
    mark = 'accepted' if str(v['id']) in acc else 'BLOCKING'
    print('|'.join([mark, str(v['id']), v['type'], '%s:%s' % (v['host'], v['port']), v['verdict'], v['name'], v.get('reason') or '']))
")"
tail -n1 "$BK/source-inventory.err" | sed 's/^/    /'
if [ -n "$NOT_OK" ]; then
  printf '%s\n' "$NOT_OK" | awk -F'|' '{printf "    %-9s #%s %s %s %s  %s  %s\n",$1,$2,$3,$4,$5,$6,$7}'
  if printf '%s\n' "$NOT_OK" | grep -q '^BLOCKING|'; then
    die "existing sources would stop working: add their CIDRs to ALLOWED_PRIVATE_SOURCE_CIDRS (narrowest range, e.g. /32), or list ids you accept in APPBI_ACCEPT_BLOCKED_SOURCES"
  fi
fi
ok "every database source is allowed (or explicitly accepted)"

# ── FREEZE ───────────────────────────────────────────────────────────────────
say "FREEZE: stop app services (the database stays up)"
STAGE="frozen"
"${COMPOSE[@]}" --profile pdf stop backend frontend pdf-worker >/dev/null 2>&1 || "${COMPOSE[@]}" stop backend frontend
ok "backend/frontend stopped"

# ── BACKUP ───────────────────────────────────────────────────────────────────
say "BACKUP -> $BK"
dbx pg_dump -Fc > "$BK/db.dump" || die "pg_dump failed"
docker run --rm -v "$DATA_VOL:/data:ro" -v "$BK:/bk" alpine:3.20 tar -C /data -czf /bk/appbi_data.tgz . || die "file-storage volume backup failed"
install -m 600 .env "$BK/env.backup"
{ echo "old_checkout=$OLD_SHA"; echo "old_serving=$SERVING"; echo "old_revision=$OLD_REV"
  echo "release_tag=$TAG"; echo "release_sha=$TAG_SHA"; echo "target_head=$TARGET_HEAD"
  echo "project=$PROJECT"; echo "data_volume=$DATA_VOL"; echo "local_db=$LOCAL_DB"
  echo "provider_snapshot=${APPBI_PROVIDER_SNAPSHOT:-none}"; echo "secrets_fp=$SECRETS_FP"
  for svc in backend frontend; do echo "rollback_image_$svc=${PROJECT}-${svc}:rollback-${OLD_SHA:0:12}"; done
} > "$BK/deploy-record.txt"
(cd "$BK" && sha256sum db.dump appbi_data.tgz env.backup > SHA256SUMS)
ok "db.dump $(du -h "$BK/db.dump" | cut -f1), appbi_data.tgz $(du -h "$BK/appbi_data.tgz" | cut -f1), .env copy, record"

say "BACKUP: restore-test the dump in a throwaway container"
RT="appbi-restore-test-$STAMP"
RT_IMAGE="pgvector/pgvector:pg$( [ "$LOCAL_DB" = 1 ] && echo 16 || echo $(( SERVER_NUM / 10000 )) )"
docker run -d --rm --name "$RT" -e POSTGRES_USER=restoretest -e POSTGRES_PASSWORD=restoretest -e POSTGRES_DB=restoretest "$RT_IMAGE" >/dev/null || die "cannot start $RT_IMAGE for the restore test"
for _ in $(seq 60); do docker exec "$RT" pg_isready -U restoretest -q 2>/dev/null && break; sleep 2; done
docker exec -i "$RT" pg_restore -U restoretest -d restoretest --no-owner --no-acl --exit-on-error < "$BK/db.dump" \
  || { docker rm -f "$RT" >/dev/null 2>&1; die "the backup does NOT restore"; }
cnt(){ printf '%s|%s' "$($1 psql $2 -Atc 'SELECT count(*) FROM users' | tr -d '\r')" "$($1 psql $2 -Atc 'SELECT count(*) FROM dashboards' | tr -d '\r')"; }
src_rows="$(cnt dbx "")"; rt_rows="$(cnt "docker exec $RT" "-U restoretest -d restoretest")"
docker rm -f "$RT" >/dev/null
[ "$src_rows" = "$rt_rows" ] || die "restored counts differ (users|dashboards: $src_rows vs $rt_rows)"
ok "restored cleanly; users|dashboards $rt_rows match"

# ── MIGRATE (single approved runner) ─────────────────────────────────────────
say "MIGRATE: $OLD_REV -> $TARGET_HEAD"
STAGE="migrating"
if ! "${COMPOSE[@]}" run --rm --no-deps -e APPBI_MIGRATE_APPROVED="$TARGET_HEAD" backend migrate; then
  [ "$(dbrev)" = "$OLD_REV" ] && { STAGE="frozen"; die "migration failed and rolled back; schema still $OLD_REV"; }
  STAGE="migrated"; die "migration failed part-way (schema now $(dbrev))"
fi
STAGE="migrated"
[ "$(dbrev)" = "$TARGET_HEAD" ] || die "alembic_version is $(dbrev), expected $TARGET_HEAD"
ok "schema at $TARGET_HEAD"

say "START"
"${COMPOSE[@]}" up -d --no-build backend frontend

# ── POST ─────────────────────────────────────────────────────────────────────
say "POST: verification"
fail=0
for _ in $(seq 60); do curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1 && break; sleep 3; done
NOW="$(curl -fsS --max-time 5 "http://127.0.0.1:$BACKEND_PORT/api/v1/health" 2>/dev/null | sed -nE 's/.*"git_sha":"([^"]*)".*/\1/p' || true)"
[ "$NOW" = "$TAG_SHA" ] && ok "serving $NOW" || { echo "    [FAIL] serving '${NOW:-?}' != $TAG_SHA"; fail=1; }
[ "$(dbrev)" = "$TARGET_HEAD" ] && ok "alembic $TARGET_HEAD" || { echo "    [FAIL] alembic $(dbrev)"; fail=1; }
[ "$(secrets_fp)" = "$SECRETS_FP" ] && ok "secrets unchanged (fingerprints)" || { echo "    [FAIL] a secret changed in .env"; fail=1; }
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$FRONTEND_PORT/login" || true)"
[ "$code" = "200" ] && ok "frontend /login 200" || { echo "    [FAIL] frontend /login $code"; fail=1; }
TOK="$(dbx psql -Atc "SELECT token FROM dashboard_public_links WHERE is_active AND password_hash IS NULL ORDER BY id LIMIT 1" 2>/dev/null | tr -d '\r' || true)"
if [ -n "$TOK" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:$BACKEND_PORT/api/v1/public/dashboards/$TOK" || true)"
  [ "$code" = "200" ] && ok "a public link answers 200" || { echo "    [FAIL] public link answered $code"; fail=1; }
else warn "no unprotected active public link to probe"; fi
bad="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.State}}' backend frontend | grep -viE ' running' || true)"
[ -z "$bad" ] && ok "containers running" || { echo "    [FAIL] $bad"; fail=1; }
errs="$("${COMPOSE[@]}" logs --since 5m backend 2>&1 | grep -cE 'Traceback|" 5[0-9][0-9] ' || true)"
[ "$errs" = "0" ] && ok "no tracebacks / 5xx in backend log (5m)" || warn "$errs traceback/5xx lines in the last 5m — read them"
echo "new_serving=$NOW" >> "$BK/deploy-record.txt"
STAGE="done"

if [ "$fail" != "0" ]; then
  echo; echo "POST verification FAILED. Decide: fix forward, or bash prod-rollback.sh $BK"; exit 1
fi
say "UPGRADE COMPLETE: $TAG ($TAG_SHA), schema $TARGET_HEAD. Backup: $BK"
echo "    Now run the manual acceptance checklist in docs/production-release-runbook.md."
