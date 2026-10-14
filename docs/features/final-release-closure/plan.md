# Final release closure — implementation plan

**Status:** implementation and local verification complete — independent verification pending

## Guardrail scoping

Scoping was run separately so the broad closure wording did not hide each gap:

```bash
python scripts/ci/guardrail_check.py --json --plan \
  "R1 make datasource connection diagnostics secret-safe at service, logs, and API boundaries" \
  --files backend/app/services/datasource_service.py backend/tests/test_core_product_contracts.py

python scripts/ci/guardrail_check.py --json --plan \
  "R2 cover all dashboard builder exits with the existing unsaved presentation guard and real browser regressions" \
  --files "frontend/src/app/(main)/dashboards/[id]/page.tsx" e2e/tests/unsaved-theme-nav.spec.ts

python scripts/ci/guardrail_check.py --json --plan \
  "R3 R4 R5 add deterministic golden dashboard and relative-date PDF fixtures with production batch and worker-path regressions" \
  --files backend/scripts/ci/seed_e2e_data_state.py backend/tests/test_core_product_contracts.py \
  e2e/tests/final-release-closure.spec.ts DA-Test/Regression-Catalog.md
```

- R1 verdict: `unknown`. The rule registry has no datasource-redaction feature match, so
  this is recorded as unknown coverage rather than safe coverage.
- R2 verdict: `warn`, matched `dashboard_build_render`. The runtime owner page is in
  scope. The E2E file is reported out-of-scope only because the registry does not model
  tests as owners; it is required to exercise real sidebar navigation.
- R3–R5 verdict: `warn`, matched `dashboard_build_render` by keyword but reported the
  fixture, core contract, E2E, and local regression catalog as out-of-scope. These files
  are evidence/fixture owners, not an attempted Dashboard runtime fix. No runtime owner is
  changed for R3 unless the exact replay proves a defect.
- Exact R3 replay did prove the defect. A follow-up plan against the Dashboard page
  returned `ok`; inspection located the owning rule in `frontend/src/lib/filters.ts`.
  The narrow correction resolves an older bare saved field against the chart's declared
  base-view/reachable semantic fields. The frozen semantic core remains untouched.
- The deliberate real-worker CI change in `.github/workflows/e2e.yml` returned
  `unknown`: the registry does not model this workflow scope. It strengthens the gate
  by starting the real worker and adds no skip, fail-open, or removed assertion.
- Protected subsystems reported by these three runs: none. The work still verifies the
  protected semantic/public contracts and avoids their frozen implementation files.
- Named tests: rebuilt running frontend plus Playwright browser verification and frontend
  `tsc`. The closure requirements add the production service, batch, worker, export,
  Pair/Foundation, preflight, canonical task, and CI gates listed below.

## Evidence already obtained before implementation

- The branch starts at the required candidate SHA; `origin/demo` remains at the stated
  baseline.
- Synthetic candidate probes reproduced R1 at the real service boundary: failure returns
  and captured logs exposed a synthetic marker for PostgreSQL, MySQL, BigQuery, Google
  Sheets, and Google Docs; BigQuery success-with-warning exposed it in the return value.
- Real candidate HTTP probes against the recovered fixture showed single/batch agreement
  for explicit anchors, which supports leaving `ChartService` runtime code unchanged and
  replacing only its hollow regression unless later evidence contradicts this.
- The current editor implementation guards `beforeunload` and its header Back link. The
  sidebar and Dashboard-to-Dashboard SPA paths do not share that guard.

## Files and layers, in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/app/services/datasource_service.py` | datasource service | Derive secret-safe diagnostics before logging or returning; apply the same boundary to BigQuery success warnings and directly reachable sibling paths for the same exception class. |
| 2 | `backend/tests/test_core_product_contracts.py` | tracked backend contracts | Invoke real datasource service/API boundaries with captured logs and replace the thread-pool imitation with the real production batch implementation using two explicit anchors. |
| 3 | `frontend/src/app/(main)/dashboards/[id]/page.tsx` | Dashboard editor | Route normal in-app exits and browser-history exits through one narrow guard backed by the existing current dirty-state refs; preserve unload handling and clear state after successful Save/Publish. |
| 4 | `e2e/tests/unsaved-theme-nav.spec.ts` | real-browser regression | Cover sidebar Dataset/Explore, layout changes, Dashboard A-to-B, header Back, browser Back, reload where reliable, prompt dismiss/accept, and clean/saved/published negative cases. |
| 5 | `backend/scripts/ci/seed_e2e_data_state.py` | deterministic E2E fixture | Add/reuse the exact 007 fixture and a three-page hand-computable relative-date/PDF fixture without changing schema or production semantics. |
| 6 | `e2e/tests/final-release-closure.spec.ts` | real-browser/worker regression | Lock exact mixed-shape page-filter parity, real public batch anchor plus visible values, and the real multi-page PDF worker/output contract. |
| 7 | `DA-Test/Regression-Catalog.md` | local regression registry | Record the reproduced causes, owning fixes, and durable tests. This tree is local/gitignored and is not claimed as CI coverage. |
| 8 | `docs/features/final-release-closure/{intent,spec,plan}.md` | change contract | Preserve approved scope and evidence for review. |
| 9 | `frontend/src/lib/filters.ts` | Dashboard filter composition | R3 confirmed-only fix: allow a bare saved page-filter field when it is reachable from the chart's declared base semantic view. |
| 10 | `.github/workflows/e2e.yml` | protected CI infrastructure | Install and start the existing real PDF worker so the committed multi-page export regression runs in CI. |

The conditional rule was satisfied: exact APPBI-VERIFY-007 replay is `CONFIRMED`, the
Dashboard/filter-composition owner was identified, its guardrail plan was run, this plan
was amended, and the smallest owning-layer correction was made. Frozen semantic files
remain excluded because the browser was dropping the filter before the backend call.

No listed row crosses a model/service or public/authed-client boundary. The seed and test
files are included because they drive actual production routes; they do not substitute
for runtime fixes.

## Risks

| Risk | Observable failure | Catch |
|---|---|---|
| Redaction removes all useful diagnostics | generic/non-actionable test-connection error | provider-specific production-boundary assertions retain safe source context |
| A secret leaks before the scrub point | synthetic marker in captured application log | log-capture regression around actual `test_connection` and API call |
| Navigation interception loops or double-prompts | route does not change after accept, or clean navigation prompts | headed Playwright for accept, dismiss, clean, saved, and published states |
| Browser history guard corrupts history | Back returns to wrong page or repeats prompt after acceptance | real browser Back and A-to-B tests |
| 007 fixture drifts from original | totals/config differ from archived evidence | fixture assertions for rows, totals, bindings, filters, and request payload |
| Batch test still bypasses production | removing worker propagation does not fail test | call `ChartService.get_charts_data_batch` or real route directly |
| PDF proof checks only a URL/status | wrong/blank page still passes | run worker, download bytes, parse text/page order, and render/inspect pages |
| Time-dependent test flakes | value changes with wall-clock date | explicit anchors/test clock confined to deterministic fixtures |
| Public surface accidentally calls auth API | public view requires session or leaks data | public authoritative-bounds and headed public journey |
| Existing correct semantic results change | Pair/Foundation or golden value delta | full named semantic contracts and explicit compatibility accounting |

## Tests — decided now, not afterwards

| Test | New or existing | What it locks |
|---|---|---|
| Actual datasource service/API plus log capture in `test_core_product_contracts.py` | existing, extended | R1 response/service/log and success-warning invariant across named providers |
| Actual `ChartService.get_charts_data_batch` contract | existing hollow test replaced | R4 worker context propagation, single/batch/hand calculation, two anchors |
| `unsaved-theme-nav.spec.ts` | existing, extended | R2 real SPA/history/unload exits and clean/saved/published negative cases |
| `final-release-closure.spec.ts` | new E2E | R3 exact mixed-shape parity, R4 browser batch value/header, R5 real worker and parsed PDF |
| Existing CSV/XLSX/PDF product routes | existing plus artifact inspection | file content and workbook/PDF structure, not HTTP status |
| Pair1, Pair2, Pair3, Foundation, Pair4, Pair5 | existing | frozen semantic/data/security behavior remains green |
| Golden SQL, semantic value matrix, surface parity, filter matrix, relationship contract, public bounds | existing | no unexplained correct-result change |
| Full committed Playwright | existing plus changed specs | realistic application integration |

- Guardrail-named suites: running rebuilt frontend browser verification and
  `cd frontend && npx tsc --noEmit`.
- A new backend test file is deliberately avoided; tracked
  `backend/tests/test_core_product_contracts.py` is extended.
- The new E2E spec will be explicitly included in the committed Playwright discovery and
  CI run; its execution count will be reported.

## Verification

1. Run focused backend and Playwright cases in isolated Docker services built from the
   working tree.
2. Replay the exact 007 Builder page in a visible browser; capture KPI/bar/table values,
   request payload, response diagnostics, and public output where useful.
3. Execute the production batch path for anchor 1 and its next logical anchor; compare
   single, batch, browser, and hand-computed values.
4. Submit one real three-page PDF export job, run the actual worker, download the result,
   parse it, render every page, and preserve artifacts under `.artifacts/`.
5. Run a headed Builder/Public journey with representative editing, filtering, pages,
   Save Draft, reload, Publish, CSV/XLSX/PDF, and viewport checks.
6. Run all named semantic, public, export, backend, frontend, and full Playwright suites;
   then `python scripts/ci/guardrail_check.py --diff`,
   `python scripts/ci/verify.py task`, and `bash scripts/ci/preflight.sh`.
7. Push the closure branch without force. Verify supported branch CI: Preflight, Backend
   semantic-contract, and full-stack Playwright. Report exact PASS/FAIL/NOT VERIFIED.
8. Produce the required A–R implementation report and all 28 YES/NO/UNPROVEN answers
   using Git-derived counts and evidence paths. Do not call the candidate certified.

## Rollback

No data rollback is required because there is no schema or migration change. Revert the
closure commits to restore candidate `364f47645617f48d57e9367afa9989f772ac3fb9`.
Test/seed additions can be reverted with the runtime changes; generated evidence stays in
`.artifacts/` and is not production state.
