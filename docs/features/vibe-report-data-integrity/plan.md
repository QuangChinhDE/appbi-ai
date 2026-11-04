# Vibe Report data integrity — implementation plan

## Guardrail scoping

`guardrail_check.py --plan "Vibe report data integrity" --files type_override_service.py
api/report_artifacts.py report_code/runtime.js …`

- Verdict: **unknown** (no feature keyword) — treated as needing extra care, not safe.
- Protected: `semantic_layer` via `type_override_service.py` → surgical change, golden
  gates (`chart_config_write_validation*`, `chart_final_hardening`, …) required.
- `report_artifacts.py` / public report data → public-link security reviewed by tests.

## Order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | services/type_override_service.py | semantic | S1 DuckDB integer regex guard |
| 2 | tests/test_type_override_duckdb_integer.py | test | decimals never round; probe prefers float |
| 3 | api/report_artifacts.py | api | S2 binding access on export/duplicate/publish/links |
| 4 | services/report_code/bindings.py | service | S3 `default: latest` resolution in one place |
| 5 | services/report_code/runtime.js | runtime | S3 filter-text, S4 repeat/cell/bar/tone, S6 sample marker |
| 6 | services/report_code/importer.py | service | S5 list slots, S6 sample wrap |
| 7 | services/report_code/lifecycle.py | service | S6 publish guard |
| 8 | frontend PasteCodeWizard / ReportStudio | FE | list-slot mapping, publish refusal UI |
| 9 | tests (contract + HTTP PG) | test | importer, repeat, filter propagation, negative rights |
| 10 | e2e headed acceptance | e2e | benchmark copy of #33 |

## Data repair

Existing local tables typed `integer` over decimals: re-run type inference
(`column_type_inference_service`) through the product API after S1; benchmark
dataset 221 is re-inferred and re-reconciled against the source file.

## Risks

- S1 turns rounded-wrong values into NULL on tables already mis-typed until re-inferred;
  intentional (a visible gap beats a wrong number) and named in the report.
- S2 makes a shared editor without data rights unable to publish; that is the point.
