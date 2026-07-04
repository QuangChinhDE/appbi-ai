#!/usr/bin/env bash
# ============================================================================
# AppBI — one command to bring the whole stack up. Zero manual setup.
#
#   ./run.sh                 # sync env, build, start, wait until healthy
#   ./run.sh --pull          # also fast-forward the current git branch first
#   ./run.sh --no-build      # start without rebuilding images
#   ./run.sh --recreate      # force-recreate containers
#   ./run.sh --down          # stop the stack and exit
#   ./run.sh --logs          # follow logs after it's up
#
# What it does, in order:
#   1. Check the environment (docker, docker compose, running daemon).
#   2. (opt) git pull --ff-only the current branch.
#   3. Sync .env against .env.example + auto-generate secrets (bootstrap-env.sh).
#   4. docker compose up -d --build  (Docker builds deps/FE + entrypoint migrates
#      the DB, creates storage dirs, and seeds the admin user automatically).
#   5. Wait for every service to become healthy and validate the HTTP endpoints.
#      Exits NON-ZERO (never a false "success") if anything is unhealthy.
#
# Uses the bundled local-db Postgres container unless DATABASE_URL is set in .env
# (then that managed DB is used and the local container is skipped).
# ============================================================================
set -euo pipefail

# ── flags ────────────────────────────────────────────────────────────────────
DO_PULL=0; BUILD=1; RECREATE=0; DO_DOWN=0; FOLLOW_LOGS=0; VALIDATE=1
for a in "$@"; do case "$a" in
  --pull)          DO_PULL=1;;
  --no-build)      BUILD=0;;
  --recreate)      RECREATE=1;;
  --down)          DO_DOWN=1;;
  --logs)          FOLLOW_LOGS=1;;
  --skip-validate) VALIDATE=0;;
  -h|--help)       sed -n '2,20p' "$0"; exit 0;;
  *) echo "Unknown option: $a (see --help)" >&2; exit 2;;
esac; done

cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$0")"

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){  printf '    \033[1;32m[OK]\033[0m %s\n' "$*"; }
bad(){ printf '    \033[1;31m[FAIL]\033[0m %s\n' "$*"; }

# ── 1. environment preflight ──────────────────────────────────────────────────
say "Checking environment"
missing=0
if command -v docker >/dev/null 2>&1; then ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
else bad "docker not found — install Docker Desktop / Docker Engine"; missing=1; fi
if docker compose version >/dev/null 2>&1; then ok "docker compose v2"
else bad "'docker compose' (v2) not available — update Docker"; missing=1; fi
if [ "$missing" = "0" ] && ! docker info >/dev/null 2>&1; then
  bad "Docker daemon is not running — start Docker and re-run"; missing=1
fi
if command -v openssl >/dev/null 2>&1; then ok "openssl (secret generation)"
elif command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then ok "python (secret generation fallback)"
else bad "need openssl or python on PATH to generate secrets"; missing=1; fi
[ "$missing" = "0" ] || { echo; echo "Environment check failed — fix the [FAIL] items above and re-run."; exit 1; }

# ── choose compose profile: bundled local db unless an external DATABASE_URL ──
COMPOSE=(docker compose)
USE_LOCAL_DB=0
grep -qE '^[[:space:]]*DATABASE_URL=.+' .env 2>/dev/null || { COMPOSE+=(--profile local-db); USE_LOCAL_DB=1; }

# ── --down short-circuit ──────────────────────────────────────────────────────
if [ "$DO_DOWN" = "1" ]; then
  say "Stopping the stack"; "${COMPOSE[@]}" down; ok "stopped"; exit 0
fi

# ── 2. optional git sync (opt-in, fast-forward only — never auto-merges) ──────
if [ "$DO_PULL" = "1" ]; then
  say "Syncing git (fast-forward only)"
  branch="$(git rev-parse --abbrev-ref HEAD)"
  git fetch --quiet origin "$branch" || true
  if git merge-base --is-ancestor HEAD "origin/$branch" 2>/dev/null; then
    git merge --ff-only "origin/$branch" && ok "fast-forwarded $branch to origin/$branch"
  else
    bad "cannot fast-forward $branch (local commits or diverged) — pull/merge manually; continuing with current code"
  fi
fi

# ── 3. .env sync + secret generation ──────────────────────────────────────────
say "Preparing .env"
# Only allow regenerating a placeholder LOCAL db password on a genuinely fresh
# database (no existing db volume) — otherwise it would desync the stored password.
DB_FRESH=0
if [ "$USE_LOCAL_DB" = "1" ]; then
  docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qiE 'db_data$' || DB_FRESH=1
fi
APPBI_DB_FRESH="$DB_FRESH" bash scripts/bootstrap-env.sh

# ── 4. build + up ─────────────────────────────────────────────────────────────
UP=(up -d); [ "$BUILD" = "1" ] && UP+=(--build); [ "$RECREATE" = "1" ] && UP+=(--force-recreate)
say "Starting stack: ${COMPOSE[*]} ${UP[*]}"
"${COMPOSE[@]}" "${UP[@]}"

# ── 5. validate health ────────────────────────────────────────────────────────
if [ "$VALIDATE" = "0" ]; then
  ok "started (validation skipped)"; exit 0
fi

say "Validating services"
FRONTEND_PORT="$(grep -m1 -E '^FRONTEND_PORT=' .env | cut -d= -f2 2>/dev/null)"; FRONTEND_PORT="${FRONTEND_PORT:-3000}"
BACKEND_PORT="$(grep -m1 -E '^BACKEND_PORT=' .env | cut -d= -f2 2>/dev/null)"; BACKEND_PORT="${BACKEND_PORT:-8000}"

# Poll an HTTP endpoint until it answers 2xx/3xx, or timeout. $1=url $2=label $3=timeout_s
poll_http(){
  local url="$1" label="$2" timeout="${3:-120}" waited=0 code
  while [ "$waited" -lt "$timeout" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)"
    if [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 400 ] 2>/dev/null; then
      printf '\n'; ok "$label -> HTTP $code ($url)"; return 0
    fi
    sleep 3; waited=$((waited+3))
    printf '    ... waiting for %s (%ss, last=%s)\r' "$label" "$waited" "$code"
  done
  printf '\n'; bad "$label did not become healthy within ${timeout}s (last HTTP $code)"; return 1
}

fail=0
# backend /health (bound to 127.0.0.1:BACKEND_PORT). Migrations run in entrypoint,
# so backend answering /health implies the DB is connected + migrated.
poll_http "http://127.0.0.1:${BACKEND_PORT}/health" "backend + database" 180 || fail=1
poll_http "http://127.0.0.1:${FRONTEND_PORT}"       "frontend"           90  || fail=1

# container-state sanity: nothing exited/restarting
say "Container status"
"${COMPOSE[@]}" ps
if "${COMPOSE[@]}" ps --format '{{.Name}} {{.State}}' 2>/dev/null | grep -viE 'running|healthy' | grep -qiE 'exit|restart|dead'; then
  bad "one or more containers are not running (see status above)"; fail=1
fi

if [ "$fail" != "0" ]; then
  echo
  bad "Stack is NOT fully healthy. Recent backend logs:"
  "${COMPOSE[@]}" logs --tail 30 backend 2>/dev/null || true
  echo
  echo "Fix hints:"
  echo "  - migration/DB error    -> ${COMPOSE[*]} logs backend"
  echo "  - port already in use   -> change FRONTEND_PORT/BACKEND_PORT in .env"
  echo "  - re-run clean          -> ./run.sh --recreate"
  exit 1
fi

echo
say "AppBI is up and healthy"
echo "    Frontend : http://localhost:${FRONTEND_PORT}"
echo "    Backend  : http://localhost:${BACKEND_PORT}/health"
echo "    Login    : $(grep -m1 -E '^ADMIN_EMAIL=' .env | cut -d= -f2) / $(grep -m1 -E '^ADMIN_PASSWORD=' .env | cut -d= -f2)"

[ "$FOLLOW_LOGS" = "1" ] && { echo; say "Following logs (Ctrl-C to stop)"; exec "${COMPOSE[@]}" logs -f; }
exit 0
