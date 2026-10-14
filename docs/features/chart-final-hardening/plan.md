# Chart final hardening — plan and verification

1. Reproduce. The seed `backend/scripts/ci/seed_e2e_chart_hardening.py` makes
   `preview-data` with base `bc_activity`, revenue (`bc_pfm`) and Date month return
   exactly the reported refusal, `bc_pfm → Date | bc_pfm → bc_owner → Date`.
2. Backend:
   - `chart_error_contract`: refusal body, sanitised 5xx, debug gating.
   - PUT final-state validation.
   - Enum required-role fix.
   - One aggregation vocabulary.
   - Query-mode resolver moved into schemas.
3. Frontend:
   - Base lifecycle: intent-only derive, seed gating, non-destructive base change with
     Undo, dataset reset.
   - Provenance chip.
   - `ChartFailurePanel`.
   - Tile and public tile classification.
4. Tests:
   - `backend/tests/test_chart_final_hardening_pg.py` (CI gate `chart_final_hardening`).
   - `frontend/scripts/check-chart-base-contract.mjs` (`qa:chart-base`).
   - `e2e/tests/chart-hardening.spec.ts` (project `chart-hardening`, retries 0, J1–J10).
5. Gates: `verify.py task`, guardrail diff, semantic golden suites, filter matrix, tsc.
