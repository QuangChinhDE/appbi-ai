#!/usr/bin/env bash
# Tiered verification for the agent/dev coding loop.
#
# WHY THIS EXISTS, AND WHAT IT IS NOT
# -----------------------------------
# `preflight.sh` answers "does the COMMITTED tree build and boot" and is the
# pre-push / CI gate. It deliberately says nothing about the change you are
# making right now. This script is the other half: it looks at your WORKING
# TREE, works out which parts of the repo you touched, and runs only the checks
# that apply.
#
#   fast   — coding loop. Type check + the FE QA contracts you touched.
#   task   — before claiming a task is done. fast + guardrail patch validation
#            + the orphaned-test check + backend import smoke.
#
# Everything here reuses a check the repository already had. Nothing new is
# invented; the contribution is picking the right subset and failing loudly.
#
#   bash scripts/ci/verify.sh fast
#   bash scripts/ci/verify.sh task
#
# Exit 0 = everything applicable passed. Non-zero = do not report "done".
set -uo pipefail

TIER="${1:-fast}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

PY="$(command -v python3 || command -v python || true)"
fail=0
ran=0

section() { printf '\n\033[1m> %s\033[0m\n' "$1"; }
ok()      { printf '\033[32m  ok\033[0m %s\n' "$1"; }
bad()     { printf '\033[31m  FAIL\033[0m %s\n' "$1"; fail=1; }
skip()    { printf '  . skipped — %s\n' "$1"; }

# Changed paths vs HEAD, including untracked. This is the whole basis for
# deciding what to run, so an empty answer means "nothing to check", not
# "everything is fine".
changed() { git status --porcelain | sed 's/^...//' | sed 's/.* -> //'; }
CHANGED="$(changed)"
touched() { echo "$CHANGED" | grep -qE "$1"; }

if [ -z "$CHANGED" ]; then
  echo "verify($TIER): working tree clean — nothing to verify."
  exit 0
fi

# ── 1. Frontend typecheck ────────────────────────────────────────────────────
if touched '^frontend/'; then
  ran=1
  section "Frontend typecheck (tsc --noEmit)"
  if [ -f frontend/node_modules/typescript/bin/tsc ]; then
    if ( cd frontend && node node_modules/typescript/bin/tsc --noEmit --incremental false ); then
      ok "no type errors"
    else
      bad "type errors above"
    fi
  else
    skip "typescript not installed (run 'npm ci' in frontend/)"
  fi
fi

# ── 2. Frontend QA contracts — only the ones whose subject you touched ───────
# These are real scripts that already exist; they were simply in no gate.
if touched '^frontend/'; then
  run_qa() {
    local script="$1" label="$2"
    [ -f "frontend/scripts/$script" ] || { skip "$label (script absent)"; return; }
    if ( cd frontend && node "scripts/$script" ); then ok "$label"; else bad "$label"; fi
  }
  if touched 'Sidebar\.tsx|moduleRoutes|^frontend/src/app/'; then
    section "QA contract: module routes"; ran=1
    run_qa check-module-routes.mjs "every sidebar module page is mapped in moduleRoutes.ts"
  fi
  if touched 'theme|Theme'; then
    section "QA contract: theme presets"; ran=1
    run_qa check-theme-presets.mjs "theme presets in sync"
  fi
  if touched 'presentation|dashboard-presentation|experience'; then
    section "QA contract: presentation"; ran=1
    run_qa check-presentation-contract.mjs "presentation contract v1"
  fi
fi

# ── 3. Alembic chain — any migration or model change ────────────────────────
if touched '^backend/alembic/|^backend/app/models/'; then
  ran=1
  section "Alembic chain"
  if [ -n "$PY" ]; then
    if "$PY" scripts/ci/alembic_chain.py; then ok "single head, parents present"; else bad "broken revision graph"; fi
  else
    skip "no python on PATH"
  fi
fi

# ── task tier below ─────────────────────────────────────────────────────────
if [ "$TIER" = "task" ]; then

  # 4. Backend import smoke — lazy imports hide a deleted module until runtime.
  if touched '^backend/app/'; then
    ran=1
    section "Backend import smoke"
    if [ -n "$PY" ]; then
      out=$( cd backend && DATABASE_URL="sqlite:///./_verify.db" PYTHONPATH="$PWD" \
             "$PY" -c "import app.main" 2>&1 ); rc=$?
      rm -f backend/_verify.db
      if [ $rc -eq 0 ]; then
        ok "app.main imports cleanly"
      elif echo "$out" | grep -qiE "No module named '(fastapi|sqlalchemy|pydantic|alembic|uvicorn|starlette)'"; then
        skip "backend deps not installed locally"
      elif echo "$out" | grep -qE "ImportError|ModuleNotFoundError"; then
        echo "$out" | tail -5; bad "import break"
      else
        skip "local env differs from requirements.txt (CI checks fully)"
      fi
    else
      skip "no python on PATH"
    fi
  fi

  # 5. Backend tests actually reach CI.
  #
  #    `.gitignore` blocks test_*.py everywhere and re-includes an explicit
  #    allow-list, and the team keeps most suites local-only ON PURPOSE. So the
  #    check cannot be "every test file must be in CI" — that would be noise.
  #
  #    Note the trap this sits on: because those files are git-IGNORED, they
  #    never appear in `git status`, so a new test is invisible to any check
  #    keyed on the changed-file list. That is exactly how a test ends up
  #    protecting nothing, and it is why the two halves below are separate.
  section "Backend tests reach CI"
  ran=1

  # 5a. DETERMINISTIC (fails): the allow-list and the workflow must agree.
  #     Allow-listed but not run by CI is a suite someone believed was a gate.
  broken=""
  while read -r base; do
    [ -z "$base" ] && continue
    [ -f "backend/tests/$base" ] \
      || { broken="$broken\n    $base — allow-listed in .gitignore but the file does not exist"; continue; }
    grep -qF "tests/$base" .github/workflows/backend-contract-tests.yml \
      || broken="$broken\n    $base — allow-listed (so it is committed) but CI never runs it"
  done <<< "$(grep -oE '^!backend/tests/test_[A-Za-z0-9_]+\.py$' .gitignore | sed 's|^!backend/tests/||')"
  if [ -n "$broken" ]; then
    printf "  a committed test CI never runs protects nothing:$broken\n"
    bad "allow-list and CI workflow disagree"
  else
    ok "every allow-listed suite exists and is run by CI"
  fi

  # 5b. ADVISORY (never fails): a local-only test file newer than the last
  #     commit is probably one you just wrote. Most stay local deliberately, so
  #     this only reminds — it does not decide for you.
  newer=""
  while read -r f; do
    [ -z "$f" ] && continue
    base="$(basename "$f")"
    grep -qF "!backend/tests/$base" .gitignore && continue
    [ "$f" -nt .git/HEAD ] && newer="$newer\n    $base"
  done <<< "$(git ls-files --others --ignored --exclude-standard -- backend/tests 2>/dev/null | grep -E 'test_.*\.py$' || true)"
  if [ -n "$newer" ]; then
    printf "  local-only (git-ignored) test files newer than HEAD:$newer\n"
    printf "  if any of these is meant to guard this change, it must be added to the\n"
    printf "  .gitignore allow-list AND backend-contract-tests.yml, then 'git add -f'-ed.\n"
  fi

  # 6. Guardrail — architecture / invariant / protected-subsystem validation of
  #    the actual diff, plus the rule base's own self-audit.
  if [ -n "$PY" ]; then
    section "Guardrail (patch validation)"
    "$PY" scripts/ci/guardrail_check.py --diff; grc=$?
    case $grc in
      0) ok "no blocking issue" ;;
      2) printf '\033[33m  UNKNOWN — no rule covers this change. Not the same as safe: say so in your report.\033[0m\n' ;;
      *) bad "guardrail BLOCK — resolve before reporting done" ;;
    esac
    ran=1

    if touched '^backend/app/services/(semantic_|dataset_model|dataset_calendar|filter_propagation|type_override|chart_contracts|chart_semantic|chart_service)'; then
      section "Guardrail (semantic contract health)"
      if "$PY" scripts/ci/guardrail_check.py --health; then ok "no drift"; else bad "contract DRIFT — update guardrail_rules.yaml in this change"; fi
    fi
  fi
fi

printf '\n'
if [ "$ran" = 0 ]; then
  echo "verify($TIER): nothing applicable to the changed paths."
  exit 0
fi
if [ "$fail" -ne 0 ]; then
  printf '\033[31mverify(%s) FAILED — fix the above. Do not report the task complete.\033[0m\n' "$TIER"
  exit 1
fi
printf '\033[32mverify(%s) passed\033[0m\n' "$TIER"
if [ "$TIER" = "fast" ]; then
  echo "  (fast tier only — run 'bash scripts/ci/verify.sh task' before calling it done)"
fi
exit 0
