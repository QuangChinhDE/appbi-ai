#!/usr/bin/env bash
# AppBI QA — run all automated tests + typechecks in one shot.
#
# Usage (from repo root):
#   bash backend/scripts/run_qa.sh
#
# Exits non-zero on any failure so CI / pre-push hooks can gate on it.
# Manual test cases live in `backend/app/api/QA_CHECKLIST.md`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "════════════════════════════════════════════"
echo "  AppBI QA Suite — Phase 1-15"
echo "════════════════════════════════════════════"

# ── 1. Backend tests ──────────────────────────────────────────────────────
echo ""
echo "▶ Backend pytest (core QA suite)..."
cd "$REPO_ROOT/backend"
DATABASE_URL=sqlite:///./qa.db python -m pytest \
  tests/test_phase15_qa_user_journey.py \
  tests/test_phase15_error_contracts.py \
  tests/test_semantic_query_engine_measures.py \
  tests/test_dataset_relation_invariant.py \
  -v -p no:warnings

# ── 2. Backend syntax check on touched files ─────────────────────────────
echo ""
echo "▶ Backend syntax check (touched in Phase 12-15)..."
python -m py_compile \
  app/schemas/semantic.py \
  app/services/semantic_query_engine.py \
  app/services/chart_service.py \
  app/api/datasets.py \
  app/api/charts.py \
  app/api/public.py \
  app/routers/semantic.py
echo "  ✓ All compile clean"

# ── 3. Frontend typecheck ────────────────────────────────────────────────
echo ""
echo "▶ Frontend TypeScript check..."
cd "$REPO_ROOT/frontend"

# Pre-existing broken workboards files predate this work — exclude them
# so we measure ONLY what Phase 12-15 touches. Restore your own list as
# needed for a different gate.
cat > tsconfig.qa.json <<'EOF'
{
  "extends": "./tsconfig.json",
  "exclude": [
    "node_modules",
    "src/components/workboards/builder/CanvasOverview.tsx",
    "src/components/workboards/builder/ScreenSwitcherModal.tsx"
  ]
}
EOF
trap 'rm -f "$REPO_ROOT/frontend/tsconfig.qa.json"' EXIT

node node_modules/typescript/bin/tsc -p tsconfig.qa.json --noEmit --pretty false

echo ""
echo "════════════════════════════════════════════"
echo "  ✓ All automated QA tests passed"
echo ""
echo "  Next: open backend/app/api/QA_CHECKLIST.md"
echo "  and walk through the MANUAL test cases (B-H)"
echo "  before handing off to DA."
echo "════════════════════════════════════════════"
