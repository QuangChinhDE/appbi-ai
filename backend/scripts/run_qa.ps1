# AppBI QA — PowerShell variant for Windows dev boxes.
#
# Usage (from repo root):
#   pwsh backend/scripts/run_qa.ps1
# or
#   .\backend\scripts\run_qa.ps1

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $RepoRoot

Write-Host "════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  AppBI QA Suite — Phase 1-15"             -ForegroundColor Cyan
Write-Host "════════════════════════════════════════════" -ForegroundColor Cyan

# ── 1. Backend tests ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Backend pytest (core QA suite)..." -ForegroundColor Yellow
Set-Location "$RepoRoot/backend"
$env:DATABASE_URL = "sqlite:///./qa.db"
python -m pytest `
  tests/test_phase15_qa_user_journey.py `
  tests/test_phase15_error_contracts.py `
  tests/test_semantic_query_engine_measures.py `
  tests/test_dataset_relation_invariant.py `
  -v -p no:warnings
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# ── 2. Backend syntax check ───────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Backend syntax check (touched in Phase 12-15)..." -ForegroundColor Yellow
python -m py_compile `
  app/schemas/semantic.py `
  app/services/semantic_query_engine.py `
  app/services/chart_service.py `
  app/api/datasets.py `
  app/api/charts.py `
  app/api/public.py `
  app/routers/semantic.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "  ✓ All compile clean" -ForegroundColor Green

# ── 3. Frontend typecheck ─────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Frontend TypeScript check..." -ForegroundColor Yellow
Set-Location "$RepoRoot/frontend"

$TsConfig = @'
{
  "extends": "./tsconfig.json",
  "exclude": [
    "node_modules",
    "src/components/workboards/builder/CanvasOverview.tsx",
    "src/components/workboards/builder/ScreenSwitcherModal.tsx"
  ]
}
'@
Set-Content -Path "tsconfig.qa.json" -Value $TsConfig -Encoding utf8

try {
    & node node_modules/typescript/bin/tsc -p tsconfig.qa.json --noEmit --pretty false
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Remove-Item -Path "tsconfig.qa.json" -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "════════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✓ All automated QA tests passed"           -ForegroundColor Green
Write-Host ""
Write-Host "  Next: open backend/app/api/QA_CHECKLIST.md"
Write-Host "  and walk through the MANUAL test cases (B-H)"
Write-Host "  before handing off to DA."
Write-Host "════════════════════════════════════════════" -ForegroundColor Green
