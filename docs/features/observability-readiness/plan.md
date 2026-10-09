# Observability production readiness — plan

## Guardrail scoping

`python scripts/ci/guardrail_check.py --plan "Observability production readiness" --files <below>`

- Verdict: **warn**
- Features: `data_state` (Pair #5), `metadata_catalog`
- Protected subsystems: none
- Required tests: `alembic_chain`, `import_smoke`, `pair5_data_state`
- Its "out of scope" list (notifier, model, migration, page) is a rules-file gap: these
  are Observability's own files and are not yet listed as owner files for the feature.
  Proposed: add them to `guardrail_rules.yaml` in this change (declared).

## Audit verdicts (runtime evidence in `.artifacts/obs-audit/`, repro tests in
`backend/tests/test_observability_lifecycle_pg.py`, all failing before the fix)

| ID | Verdict | Evidence |
|---|---|---|
| H01 | CONFIRMED BUG (P0) | no runtime path creates a monitor; live usage `monitors: 0` after setup |
| H02 | CONFIRMED BUG (P1) | resolved incident reopened from the same alert; never auto-resolves (repro x3) |
| H03 | CONFIRMED BUG (P1) | every open incident re-sent each scan; failed channel has no own state (repro x2) |
| H04 | CONFIRMED BUG (P1) | 40 scans of 0 rows → breached once, then ok x39 |
| H05 | CONFIRMED BUG (P2) | browser: `?incident=1` stays on the generic list |
| H06 | CONFIRMED DESIGN PROBLEM (P2) | Resolve silently records a new schema baseline |
| H07 | CONFIRMED UX PROBLEM (P2) | overview has no cross-dataset incident list |
| H08 | CONFIRMED BUG (P1) | browser: failing unscanned dataset hidden by "Only issues", shows green 0 |
| H09 | CONFIRMED BUG (P1, security) | view share → acknowledge 200; Scan Now shown to non-admins |
| H10 | CONFIRMED BUG (P2) | form never sends dataset_id → non-admin always 403; manage buttons ignore capabilities |
| H11 | CONFIRMED BUG (P0) | browser, API down: "No open incidents · All monitors are healthy" |
| H12 | CONFIRMED BUG (P2) | quality rule counted as "1 monitors"; no pass/fail/not-run split |
| H13 | CONFIRMED BUG (P2) | hard limit 200/500, no total, no paging, no search |
| H14 | PARTIALLY CONFIRMED | graph works one level; field usage is inferred but unlabelled; see N4 |
| H15 | CONFIRMED BUG (P1) | failed commit → normal result; no run record; manual scan unlocked |
| H16 | CONFIRMED GAP | only `test_authz_observability_http_pg.py`; zero Observability E2E |

New findings:

| ID | Sev | Problem |
|---|---|---|
| N1 | P1 | duplicate open incidents per dedup_key (autoflush=False, no unique index) |
| N2 | P2 | email alert HTML built from unescaped title/detail (HTML injection) |
| N3 | P2 | channel pause/delete/test failures are unhandled (no toast, unhandled rejection) |
| N4 | P1 security | lineage names charts/dashboards the caller cannot open |
| N5 | P2 | overview/usage call `semantic_state` per dataset (N+1); measured in load test |
| N6 | P3 | incident filters/types omit the `semantic` pillar |
| N7 | P3 | router mounted even when the module flag is off (UI says no access, API serves) |
| N8 | P2 | check history grows unbounded |

## Files and layers, in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/alembic/versions/…_observability_readiness.py` | migration | additive: `observability_alert_deliveries`, `observability_scan_runs`; merge duplicate open incidents, then partial unique index |
| 2 | `backend/app/models/observability.py` | model | the two models + index |
| 3 | `backend/app/services/observability_service.py` | service | flush upsert, anomaly fold, volume baseline, accept_* actions, scan runs + lock, dataset scan, monitor CRUD, overview incidents, lineage filtering, retention |
| 4 | `backend/app/services/observability_notifier.py` | service | delivery ledger dispatcher, escaping |
| 5 | `backend/app/services/anomaly_scheduler.py` | scheduler | delivery retry job, run recording |
| 6 | `backend/app/api/observability.py` | router | new endpoints, paging, capabilities, dataset-edit lifecycle |
| 7 | `frontend/src/lib/observability.ts` | client | new contracts |
| 8 | `frontend/src/components/observability/*`, `observability/page.tsx`, i18n | UI | states, deep link, needs-attention, automatic checks, channel scope, capabilities |
| 9 | tests + `.gitignore` + workflow | tests | backend PG suites, E2E `e2e/tests/observability-*.spec.ts` |

## Tests decided before coding

- Backend PG (wired into `backend-contract-tests.yml`): `test_observability_lifecycle_pg.py`
  (H02–H04, H09, H15, N1, N4 — red today), plus `test_observability_monitors_pg.py` (CRUD,
  freshness/volume/schema against a real PG source, deletion), `test_observability_delivery_pg.py`
  (ledger: partial failure, recovery, dead, crash, disable/enable, resolved cancel), and a
  migration test on a database with duplicate incidents.
- Existing: `test_authz_observability_http_pg.py`, `test_pair5_data_state_pg.py`, quality and
  anomaly suites, `verify.py task`.
- E2E (real browser + real backend + PG source), journeys O01–O24, retries=0.
- Load: 200 datasets / 2,000 monitors / 5,000 incidents. Overview and usage p95 measured
  before and after. Proposed budget: overview < 1.5 s, scan per monitor dominated by the
  source.

## Not verifiable here (stated now, not later)

- **MySQL / BigQuery** monitor SQL: no credentials in this environment. These stay
  NOT VERIFIED unless credentials are provided. Postgres is verified against a real source.
- **Real SMTP / Slack delivery**: verified against a local webhook receiver and a fake SMTP
  server only.

## Rollback

The migration is additive (two tables plus one partial index). Downgrade drops them. Merged
duplicates stay resolved (data-preserving). The old code ignores the new tables.
