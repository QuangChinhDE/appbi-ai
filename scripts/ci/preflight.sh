#!/usr/bin/env bash
# Preflight gate — the single source of truth for "does the COMMITTED tree
# actually build / boot". Run against $1 (default cwd): the pre-push hook points
# it at a clean worktree of the commit being pushed; CI points it at its
# checkout. Each check degrades gracefully when its toolchain is absent so the
# local hook stays fast on a FE-only or BE-only machine; CI installs everything
# and runs the full set.
#
# Catches exactly the three deploy-breakers we've hit:
#   1. Alembic parent migration not committed     -> KeyError at boot -> 502
#   2. FE imports a provider left uncommitted      -> next build type error
#   3. BE imports a deleted module                 -> ImportError at boot
set -uo pipefail

ROOT="${1:-$(pwd)}"
cd "$ROOT" || { echo "preflight: cannot cd to $ROOT"; exit 2; }

PY="$(command -v python3 || command -v python || true)"
fail=0
section() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

# 1) Alembic revision graph — stdlib only, no DB.
if [ -d backend/alembic/versions ]; then
  section "Alembic chain"
  if [ -n "$PY" ]; then
    "$PY" scripts/ci/alembic_chain.py || fail=1
  else
    echo "· skipped (no python on PATH)"
  fi
fi

# 2) Frontend typecheck — tsc --noEmit (tsconfig already sets noEmit). Resolve
# tsc via the local install; distinguish "tsc not installed here" (skip — CI's
# `npm ci` always has it) from a genuine type error (fail).
if [ -f frontend/package.json ]; then
  section "Frontend typecheck (tsc --noEmit)"
  if [ -d frontend/node_modules ]; then
    out=$( cd frontend && npx --no-install tsc --noEmit 2>&1 ); rc=$?
    if [ $rc -eq 0 ]; then
      echo "✓ no type errors"
    elif echo "$out" | grep -qiE "not the tsc command|could not determine|command not found|installed locally"; then
      echo "· skipped (typescript not installed in node_modules here — CI checks fully)"
    else
      echo "$out"
      fail=1
    fi
  else
    echo "· skipped (frontend/node_modules missing — run 'npm ci' in frontend/)"
  fi
fi

# 3) Backend import smoke — catches imports of deleted/renamed modules.
if [ -f backend/app/main.py ] && [ -z "${PREFLIGHT_SKIP_BACKEND_IMPORT:-}" ]; then
  section "Backend import smoke"
  if [ -n "$PY" ]; then
    out=$( cd backend && DATABASE_URL="sqlite:///./_preflight.db" PYTHONPATH="$PWD" \
           "$PY" -c "import app.main" 2>&1 ); rc=$?
    rm -f backend/_preflight.db
    if [ $rc -eq 0 ]; then
      echo "✓ app.main imports cleanly"
    elif echo "$out" | grep -qiE "No module named '(fastapi|sqlalchemy|pydantic|alembic|uvicorn|starlette)'"; then
      echo "· skipped (backend deps not installed locally)"
    elif [ -n "${CI:-}" ]; then
      # CI installs the pinned requirements.txt → any failure is real.
      echo "$out"; fail=1
    elif echo "$out" | grep -qE "ImportError|ModuleNotFoundError"; then
      # Local: only the bug class we care about (deleted/renamed module) blocks.
      echo "$out"; fail=1
    else
      # Local env mismatch (e.g. a newer FastAPI than requirements.txt) — not an
      # import break. CI checks this strictly; don't block the local push.
      echo "· skipped — local env differs from requirements.txt (CI checks fully):"
      echo "$out" | tail -2 | sed 's/^/     /'
    fi
  else
    echo "· skipped (no python on PATH)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31m✗ preflight FAILED — fix the above before pushing\033[0m\n'
  printf '   (bypass for emergencies only: git push --no-verify)\n'
  exit 1
fi
printf '\n\033[32m✓ preflight passed\033[0m\n'
