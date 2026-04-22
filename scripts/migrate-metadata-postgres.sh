#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# migrate-metadata-postgres.sh
#
# Dump AppBI metadata from an old PostgreSQL Docker container and
# restore it into the current metadata database on Ubuntu/Linux.
#
# Defaults:
#   - Source DB settings are auto-detected from the source container env
#     (POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB) when possible.
#   - Target DB settings are read from .env (DATABASE_URL or DB_* vars)
#     unless you override them with flags.
#   - Restore is destructive by default: existing target metadata objects
#     are dropped before recreating them from the source dump.
#
# Typical usage:
#   bash scripts/migrate-metadata-postgres.sh --source-container appbi-db-old
#   bash scripts/migrate-metadata-postgres.sh --source-container appbi-db-old --dump-only
#   bash scripts/migrate-metadata-postgres.sh --source-container appbi-db-old --target-host db.example.com --target-port 5432 --target-db-user appbi --target-db-password secret --target-db-name appbi
#
# Notes:
#   1. The target database must already exist.
#   2. If the restored DB is older than current code, start/restart backend
#      after restore so Alembic upgrades it to head.
#   3. If target DB resolves to localhost, the restore container uses
#      host.docker.internal via host-gateway so Docker on Linux can reach it.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/migrate-metadata-postgres.sh --source-container appbi-db-old
  bash scripts/migrate-metadata-postgres.sh --source-container appbi-db-old --dump-only
  bash scripts/migrate-metadata-postgres.sh --restore-only --dump-path .artifacts/appbi-metadata.sql

Options:
  --source-container <name>        Old PostgreSQL container to dump from.
  --source-db-name <name>          Override source database name.
  --source-db-user <name>          Override source database user.
  --source-db-password <password>  Override source database password.

  --target-host <host>             Override target PostgreSQL host.
  --target-port <port>             Override target PostgreSQL port.
  --target-db-name <name>          Override target database name.
  --target-db-user <name>          Override target database user.
  --target-db-password <password>  Override target database password.
  --target-database-url <url>      Override target DATABASE_URL.
  --target-sslmode <mode>          Override target SSL mode (example: require).
  --target-network <name>          Docker network for restore client. Default: appbi-net

  --dump-path <path>               Dump file path. Defaults to .artifacts/appbi-metadata-<timestamp>.sql
  --dump-only                      Stop after writing the dump file.
  --restore-only                   Restore from an existing --dump-path without dumping again.
  --skip-clean                     Disable destructive clean restore.
  -h, --help                       Show this help.

By default the restore is destructive: target metadata objects are dropped
before they are recreated from the source dump. Use --skip-clean only when
you intentionally want to preserve existing target objects.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 command not found in PATH."
}

get_first_non_empty() {
  local value=""
  for value in "$@"; do
    if [[ -n "${value//[[:space:]]/}" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done
  return 1
}

lookup_key_from_lines() {
  local lines="$1"
  local key="$2"
  printf '%s\n' "$lines" | grep -m1 -E "^${key}=" | cut -d= -f2- || true
}

read_env_file_value() {
  local key="$1"
  local file_path="$2"
  [[ -f "$file_path" ]] || return 0
  grep -m1 -E "^${key}=" "$file_path" | cut -d= -f2- || true
}

docker_container_env_lines() {
  local container_name="$1"
  docker inspect "$container_name" --format '{{range .Config.Env}}{{println .}}{{end}}'
}

docker_container_running() {
  local container_name="$1"
  docker inspect "$container_name" --format '{{.State.Running}}'
}

test_docker_network() {
  local network_name="$1"
  [[ -n "$network_name" ]] || return 1
  docker network inspect "$network_name" >/dev/null 2>&1
}

parse_database_url() {
  local raw_url="$1"
  [[ -n "${raw_url//[[:space:]]/}" ]] || return 0
  command -v python3 >/dev/null 2>&1 || return 0

  python3 - "$raw_url" <<'PY'
import sys
from urllib.parse import unquote, urlparse

raw_url = sys.argv[1].strip()
if not raw_url:
    raise SystemExit(0)

normalized = raw_url.replace("postgresql+psycopg2://", "postgresql://", 1)
parsed = urlparse(normalized)
query = dict(item.split("=", 1) for item in parsed.query.split("&") if "=" in item)

if parsed.hostname:
    print(f"Host={parsed.hostname}")
if parsed.port:
    print(f"Port={parsed.port}")
if parsed.username is not None:
    print(f"User={unquote(parsed.username)}")
if parsed.password is not None:
    print(f"Password={unquote(parsed.password)}")
if query.get("sslmode"):
  print(f"SslMode={query['sslmode']}")

db_name = parsed.path.lstrip("/")
if db_name:
    print(f"DbName={db_name}")
PY
}

ensure_absolute_path() {
  local base_dir="$1"
  local candidate_path="$2"
  if [[ "$candidate_path" = /* ]]; then
    printf '%s\n' "$candidate_path"
    return 0
  fi
  printf '%s\n' "$base_dir/$candidate_path"
}

wait_for_postgres_in_container() {
  local container_name="$1"
  local db_user="$2"
  local db_name="$3"
  local timeout_seconds="${4:-60}"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if docker exec "$container_name" pg_isready -U "$db_user" -d "$db_name" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  die "Timed out waiting for PostgreSQL in container '$container_name' to become ready."
}

new_restore_ready_dump() {
  local source_dump_path="$1"
  local filter_regex='^(DROP EXTENSION IF EXISTS vector;|CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;|COMMENT ON EXTENSION vector IS )'
  local removed_count="0"
  local base_path="$source_dump_path"
  local restore_dump_path=""

  removed_count=$(grep -Ec "$filter_regex" "$source_dump_path" || true)
  if [[ "$removed_count" == "0" ]]; then
    printf '%s\n' "$source_dump_path"
    return 0
  fi

  if [[ "$source_dump_path" == *.* ]]; then
    base_path="${source_dump_path%.*}"
  fi
  restore_dump_path="${base_path}.restore.sql"

  grep -Ev "$filter_regex" "$source_dump_path" > "$restore_dump_path"
  echo "Prepared restore-safe dump at $restore_dump_path (removed $removed_count pgvector extension statement(s))." >&2
  printf '%s\n' "$restore_dump_path"
}

SOURCE_CONTAINER=""
SOURCE_DB_NAME=""
SOURCE_DB_USER=""
SOURCE_DB_PASSWORD=""
TARGET_HOST=""
TARGET_PORT="0"
TARGET_DB_NAME=""
TARGET_DB_USER=""
TARGET_DB_PASSWORD=""
TARGET_DATABASE_URL=""
TARGET_SSLMODE=""
TARGET_NETWORK="appbi-net"
DUMP_PATH=""
DUMP_ONLY="false"
RESTORE_ONLY="false"
SKIP_CLEAN="false"
SOURCE_STARTED_HERE="false"

cleanup() {
  if [[ "$SOURCE_STARTED_HERE" == "true" && -n "${SOURCE_CONTAINER:-}" ]]; then
    docker stop "$SOURCE_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-container)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      SOURCE_CONTAINER="$2"
      shift 2
      ;;
    --source-db-name)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      SOURCE_DB_NAME="$2"
      shift 2
      ;;
    --source-db-user)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      SOURCE_DB_USER="$2"
      shift 2
      ;;
    --source-db-password)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      SOURCE_DB_PASSWORD="$2"
      shift 2
      ;;
    --target-host)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      TARGET_HOST="$2"
      shift 2
      ;;
    --target-port)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      TARGET_PORT="$2"
      shift 2
      ;;
    --target-db-name)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      TARGET_DB_NAME="$2"
      shift 2
      ;;
    --target-db-user)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      TARGET_DB_USER="$2"
      shift 2
      ;;
    --target-db-password)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      TARGET_DB_PASSWORD="$2"
      shift 2
      ;;
    --target-database-url)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      TARGET_DATABASE_URL="$2"
      shift 2
      ;;
    --target-sslmode)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      TARGET_SSLMODE="$2"
      shift 2
      ;;
    --target-network)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      TARGET_NETWORK="$2"
      shift 2
      ;;
    --dump-path)
      [[ $# -ge 2 ]] || die "Missing value for $1"
      DUMP_PATH="$2"
      shift 2
      ;;
    --dump-only)
      DUMP_ONLY="true"
      shift
      ;;
    --restore-only)
      RESTORE_ONLY="true"
      shift
      ;;
    --skip-clean)
      SKIP_CLEAN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown argument: $1"
      ;;
  esac
done

if [[ "$DUMP_ONLY" == "true" && "$RESTORE_ONLY" == "true" ]]; then
  die "Use either --dump-only or --restore-only, not both."
fi

if [[ "$RESTORE_ONLY" != "true" && -z "${SOURCE_CONTAINER//[[:space:]]/}" ]]; then
  usage >&2
  die "--source-container is required unless --restore-only is used."
fi

if [[ "$RESTORE_ONLY" == "true" && -z "${DUMP_PATH//[[:space:]]/}" ]]; then
  usage >&2
  die "--dump-path is required when --restore-only is used."
fi

require_cmd docker

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
cd "$REPO_ROOT"

if [[ -z "${DUMP_PATH//[[:space:]]/}" ]]; then
  mkdir -p "$REPO_ROOT/.artifacts"
  DUMP_PATH="$REPO_ROOT/.artifacts/appbi-metadata-$(date +%Y%m%d%H%M%S).sql"
fi

DUMP_PATH="$(ensure_absolute_path "$REPO_ROOT" "$DUMP_PATH")"
mkdir -p "$(dirname "$DUMP_PATH")"

if [[ "$RESTORE_ONLY" != "true" ]]; then
  SOURCE_ENV_LINES="$(docker_container_env_lines "$SOURCE_CONTAINER" 2>/dev/null)" || die "Could not inspect source container '$SOURCE_CONTAINER'."

  if [[ "$(docker_container_running "$SOURCE_CONTAINER" 2>/dev/null || true)" != "true" ]]; then
    echo "Source container is stopped; starting it temporarily..." >&2
    docker start "$SOURCE_CONTAINER" >/dev/null || die "Could not start source container '$SOURCE_CONTAINER'."
    SOURCE_STARTED_HERE="true"
  fi

  SOURCE_DB_USER="$(get_first_non_empty "$SOURCE_DB_USER" "$(lookup_key_from_lines "$SOURCE_ENV_LINES" POSTGRES_USER)" "$(lookup_key_from_lines "$SOURCE_ENV_LINES" DB_USER)" "appbi" || true)"
  SOURCE_DB_PASSWORD="$(get_first_non_empty "$SOURCE_DB_PASSWORD" "$(lookup_key_from_lines "$SOURCE_ENV_LINES" POSTGRES_PASSWORD)" "$(lookup_key_from_lines "$SOURCE_ENV_LINES" DB_PASSWORD)" || true)"
  SOURCE_DB_NAME="$(get_first_non_empty "$SOURCE_DB_NAME" "$(lookup_key_from_lines "$SOURCE_ENV_LINES" POSTGRES_DB)" "$(lookup_key_from_lines "$SOURCE_ENV_LINES" DB_NAME)" "appbi" || true)"

  echo "Waiting for PostgreSQL in '$SOURCE_CONTAINER' to become ready..." >&2
  wait_for_postgres_in_container "$SOURCE_CONTAINER" "$SOURCE_DB_USER" "$SOURCE_DB_NAME"

  TEMP_DUMP_IN_CONTAINER="/tmp/appbi-metadata-migrate.sql"
  echo "Dumping metadata from '$SOURCE_CONTAINER' ($SOURCE_DB_NAME)..." >&2

  DUMP_ARGS=(exec -e "PGPASSWORD=$SOURCE_DB_PASSWORD" "$SOURCE_CONTAINER" pg_dump)
  if [[ "$SKIP_CLEAN" != "true" ]]; then
    DUMP_ARGS+=(--clean --if-exists)
  fi
  DUMP_ARGS+=(--no-owner --no-privileges -U "$SOURCE_DB_USER" -d "$SOURCE_DB_NAME" -f "$TEMP_DUMP_IN_CONTAINER")

  "${DUMP_ARGS[@]}" || die "pg_dump failed."
  docker cp "${SOURCE_CONTAINER}:${TEMP_DUMP_IN_CONTAINER}" "$DUMP_PATH" >/dev/null || die "Could not copy dump file from source container."
  docker exec "$SOURCE_CONTAINER" rm -f "$TEMP_DUMP_IN_CONTAINER" >/dev/null 2>&1 || true

  echo "Dump file written to $DUMP_PATH" >&2
fi

if [[ "$DUMP_ONLY" == "true" ]]; then
  echo "Dump completed. No restore performed because --dump-only was supplied." >&2
  exit 0
fi

[[ -f "$DUMP_PATH" ]] || die "Dump file '$DUMP_PATH' does not exist."
RESTORE_DUMP_PATH="$(new_restore_ready_dump "$DUMP_PATH")"

TARGET_ENV_DATABASE_URL="$(get_first_non_empty "$TARGET_DATABASE_URL" "$(read_env_file_value DATABASE_URL "$ENV_FILE")" || true)"
TARGET_URL_PARTS="$(parse_database_url "$TARGET_ENV_DATABASE_URL" || true)"

TARGET_HOST="$(get_first_non_empty "$TARGET_HOST" "$(lookup_key_from_lines "$TARGET_URL_PARTS" Host)" "$(read_env_file_value DB_HOST "$ENV_FILE")" "appbi-db" || true)"
if [[ -z "${TARGET_PORT//[[:space:]]/}" || "$TARGET_PORT" == "0" ]]; then
  TARGET_PORT="$(get_first_non_empty "$(lookup_key_from_lines "$TARGET_URL_PARTS" Port)" "$(read_env_file_value DB_PORT "$ENV_FILE")" "5432" || true)"
fi
TARGET_DB_USER="$(get_first_non_empty "$TARGET_DB_USER" "$(lookup_key_from_lines "$TARGET_URL_PARTS" User)" "$(read_env_file_value DB_USER "$ENV_FILE")" "appbi" || true)"
TARGET_DB_PASSWORD="$(get_first_non_empty "$TARGET_DB_PASSWORD" "$(lookup_key_from_lines "$TARGET_URL_PARTS" Password)" "$(read_env_file_value DB_PASSWORD "$ENV_FILE")" || true)"
TARGET_DB_NAME="$(get_first_non_empty "$TARGET_DB_NAME" "$(lookup_key_from_lines "$TARGET_URL_PARTS" DbName)" "$(read_env_file_value DB_NAME "$ENV_FILE")" "appbi" || true)"
TARGET_SSLMODE="$(get_first_non_empty "$TARGET_SSLMODE" "$(lookup_key_from_lines "$TARGET_URL_PARTS" SslMode)" || true)"

[[ -n "${TARGET_HOST//[[:space:]]/}" ]] || die "Target host could not be resolved. Set DATABASE_URL in .env or pass --target-host explicitly."
[[ -n "${TARGET_DB_USER//[[:space:]]/}" ]] || die "Target DB user could not be resolved."
[[ -n "${TARGET_DB_NAME//[[:space:]]/}" ]] || die "Target DB name could not be resolved."
[[ "$TARGET_PORT" =~ ^[0-9]+$ ]] || die "Target port '$TARGET_PORT' is not a valid integer."

DOCKER_TARGET_HOST="$TARGET_HOST"
NETWORK_ARGS=()
EXTRA_DOCKER_ARGS=()

case "$TARGET_HOST" in
  localhost|127.0.0.1|::1)
    DOCKER_TARGET_HOST="host.docker.internal"
    EXTRA_DOCKER_ARGS+=(--add-host host.docker.internal:host-gateway)
    ;;
esac

if test_docker_network "$TARGET_NETWORK"; then
  NETWORK_ARGS=(--network "$TARGET_NETWORK")
elif [[ "$DOCKER_TARGET_HOST" == "appbi-db" ]]; then
  die "Docker network '$TARGET_NETWORK' was not found, so host '$DOCKER_TARGET_HOST' is unreachable from the restore client. Start the current stack first or pass --target-host to a reachable hostname."
fi

RESTORE_DUMP_DIR="$(dirname "$RESTORE_DUMP_PATH")"
RESTORE_DUMP_FILE="$(basename "$RESTORE_DUMP_PATH")"

echo "Restoring dump into ${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB_NAME} ..." >&2

RESTORE_ARGS=(run --rm)
if [[ ${#NETWORK_ARGS[@]} -gt 0 ]]; then
  RESTORE_ARGS+=("${NETWORK_ARGS[@]}")
fi
if [[ ${#EXTRA_DOCKER_ARGS[@]} -gt 0 ]]; then
  RESTORE_ARGS+=("${EXTRA_DOCKER_ARGS[@]}")
fi
RESTORE_ARGS+=(
  -e "PGPASSWORD=$TARGET_DB_PASSWORD"
  -v "$RESTORE_DUMP_DIR:/work"
  postgres:16
  psql
  -v ON_ERROR_STOP=1
  -h "$DOCKER_TARGET_HOST"
  -p "$TARGET_PORT"
  -U "$TARGET_DB_USER"
  -d "$TARGET_DB_NAME"
  -f "/work/$RESTORE_DUMP_FILE"
)

if [[ -n "${TARGET_SSLMODE//[[:space:]]/}" ]]; then
  RESTORE_ARGS=(run --rm)
  if [[ ${#NETWORK_ARGS[@]} -gt 0 ]]; then
    RESTORE_ARGS+=("${NETWORK_ARGS[@]}")
  fi
  if [[ ${#EXTRA_DOCKER_ARGS[@]} -gt 0 ]]; then
    RESTORE_ARGS+=("${EXTRA_DOCKER_ARGS[@]}")
  fi
  RESTORE_ARGS+=(
    -e "PGPASSWORD=$TARGET_DB_PASSWORD"
    -e "PGSSLMODE=$TARGET_SSLMODE"
    -v "$RESTORE_DUMP_DIR:/work"
    postgres:16
    psql
    -v ON_ERROR_STOP=1
    -h "$DOCKER_TARGET_HOST"
    -p "$TARGET_PORT"
    -U "$TARGET_DB_USER"
    -d "$TARGET_DB_NAME"
    -f "/work/$RESTORE_DUMP_FILE"
  )
fi

"${RESTORE_ARGS[@]}" || die "Restore failed."

echo "Restore completed successfully." >&2
if [[ "$SKIP_CLEAN" == "true" ]]; then
  echo "Target metadata database was restored without pre-drop cleanup because --skip-clean was supplied." >&2
else
  echo "Target metadata database was cleaned before import via pg_dump --clean --if-exists." >&2
fi
echo "Next step: start or restart backend so Alembic can upgrade the restored schema if needed." >&2
echo "Example: docker compose up -d --build backend" >&2