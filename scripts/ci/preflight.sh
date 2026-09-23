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

# 2) Frontend typecheck — tsc --noEmit. Call the compiler binary directly (no
# npx resolution quirks) and force `--incremental false` so a stale .tsbuildinfo
# can't report a green pass after files changed. Skip cleanly if typescript
# isn't installed locally — CI's `npm ci` always has it.
if [ -f frontend/package.json ]; then
  section "Frontend typecheck (tsc --noEmit)"
  if [ -f frontend/node_modules/typescript/bin/tsc ]; then
    if ( cd frontend && node node_modules/typescript/bin/tsc --noEmit --incremental false ); then
      echo "✓ no type errors"
    else
      fail=1
    fi
  elif [ -d frontend/node_modules ]; then
    echo "· skipped (typescript not installed in node_modules here — CI checks fully)"
  else
    echo "· skipped (frontend/node_modules missing — run 'npm ci' in frontend/)"
  fi
fi

# 2b) Frontend QA contracts — three checks that already existed in
# frontend/scripts/ and were wired into no gate. Plain node, no dependencies,
# ~2s total, so there is no reason for them not to be here. The module-route one
# catches a sidebar page left out of moduleRoutes.ts, which fails OPEN and so is
# otherwise silent.
if [ -f frontend/package.json ]; then
  section "Frontend QA contracts"
  if command -v node >/dev/null 2>&1; then
    qa_fail=0
    for s in check-module-routes.mjs check-theme-presets.mjs check-presentation-contract.mjs; do
      [ -f "frontend/scripts/$s" ] || continue
      ( cd frontend && node "scripts/$s" >/dev/null ) || { echo "  ✗ $s"; qa_fail=1; }
    done
    [ "$qa_fail" -eq 0 ] && echo "✓ module routes · theme presets · presentation contract" || fail=1
  else
    echo "· skipped (no node on PATH)"
  fi
fi

# 2c) Claude workflow config. The rules' frontmatter used `globs:`, which Claude
# Code does not read, so every rule silently loaded in every session instead of
# being path-scoped. The YAML parsed, nothing warned. Only a schema-aware check
# finds that class, so it runs with the other commit-integrity gates.
if [ -d .claude ]; then
  section "Claude workflow config"
  if [ -n "$PY" ]; then
    "$PY" scripts/ci/check_agent_config.py || fail=1
    # The safety system itself: the Stop gate decision paths, and the meta-tests
    # proving a change cannot weaken the protection without being caught.
    if "$PY" -c "import pytest" >/dev/null 2>&1; then
      "$PY" -m pytest -q scripts/ci/test_stop_gate.py scripts/ci/test_agent_sdlc.py scripts/ci/test_guardrail_diff_range.py scripts/ci/test_ci_wiring_is_real.py scripts/ci/test_tool_bodies_are_guarded.py scripts/ci/test_protection_approval_is_one_commit.py scripts/ci/test_product_gate_is_a_real_boundary.py >/dev/null || {
        "$PY" -m pytest -q scripts/ci/test_stop_gate.py scripts/ci/test_agent_sdlc.py scripts/ci/test_guardrail_diff_range.py scripts/ci/test_ci_wiring_is_real.py scripts/ci/test_tool_bodies_are_guarded.py scripts/ci/test_protection_approval_is_one_commit.py scripts/ci/test_product_gate_is_a_real_boundary.py; fail=1; }
      [ "$fail" -eq 0 ] && echo "✓ safety-system tests (stop gate + SDLC meta)"
    else
      echo "· safety-system tests skipped (pytest not installed)"
    fi
  else
    echo "· skipped (no python on PATH)"
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
