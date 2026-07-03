#!/usr/bin/env bash
# AppBI — one command to build + start the stack.
#
#   ./run.sh
#
# Pull the latest code yourself first; this script does NOT touch git.
# Uses the bundled local-db Postgres container unless an external DATABASE_URL is
# set in .env (then that managed DB is used and the local container is skipped).
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$0")"

PROFILE=()
grep -qE '^DATABASE_URL=.+' .env 2>/dev/null || PROFILE=(--profile local-db)

docker compose "${PROFILE[@]}" up -d --build
echo "✓ AppBI up. Open http://localhost:${FRONTEND_PORT:-3000}"
