# Final release closure — intent

**Status:** implementation and local verification complete — independent verification pending  
**Owner:** Codex  
**Date:** 2026-10-03

## Problem

Independent review of remediation candidate
`364f47645617f48d57e9367afa9989f772ac3fb9` found five release contracts that are
either still false or are not protected at the production boundary:

1. datasource driver exceptions can still place configured secrets in service returns,
   server logs, and BigQuery success-with-warning responses;
2. unsaved Dashboard theme or layout work can leave the editor through ordinary SPA
   navigation without the warning used by the header Back action;
3. the original APPBI-VERIFY-007 Builder mismatch has not been replayed with its exact
   fixture, so its classification is unresolved;
4. the relative-date batch fix has a regression that imitates a thread pool instead of
   invoking the production batch implementation; and
5. the new export `as_of` contract has not been exercised by the real PDF worker over a
   multi-page report.

The environment also defaults to UTC unless `APP_TIMEZONE` is configured. The intended
business timezone remains a product decision and must be reported rather than chosen in
this change.

## Goal

Make the confirmed R1–R5 production contracts true at their owning boundaries and add
regressions that fail at those same boundaries. Produce and push a release-candidate
branch for a different agent to verify independently, without merging or deploying it.

## Out of scope

- No semantic-layer redesign, query-engine change, or broad logging rewrite.
- No autosave redesign or router architecture rewrite.
- APPBI-VERIFY-007 was reproduced exactly (`685` KPI versus `610` scoped siblings), so
  its application change is limited to the owning saved-filter resolution helper.
- No product timezone-policy change.
- No dependency upgrade, API rename, general cleanup, demo merge, or production deploy.
- Unrelated P2/P3 UX debt found during the final sweep is recorded for follow-up rather
  than repaired in this closure.

## Constraints

- Start from remediation candidate
  `364f47645617f48d57e9367afa9989f772ac3fb9` on
  `cert/final-release-closure-codex`.
- Preserve Pair1–Pair5 and Foundation. The frozen semantic files remain untouched.
- `execution_plan.py` and `ChartService` receive no further runtime change unless a real
  production-boundary reproduction contradicts the candidate behavior.
- Public pages continue to use `publicClient` only.
- Tests use synthetic secrets and isolated deterministic data.
- Existing test files are extended where practical so new backend tests cannot be
  silently excluded by repository ignore/workflow rules.
- Actual PDF bytes and exported files, rather than HTTP status alone, are the evidence.
- The final unexplained `CORRECT -> DIFFERENT` count must be zero.

## Acceptance criteria

1. PostgreSQL, MySQL, BigQuery, and a testable Google connector preserve an actionable
   source error while configured secret forms are absent from the production service
   return, API response, and captured application logs.
2. BigQuery success-with-warning messages obey the same secret-redaction invariant.
3. Unsaved theme and layout work prompts before header Back, sidebar navigation,
   Dashboard A-to-B navigation, browser Back, and reload/close where the browser exposes
   a reliable event; dismissing preserves both the current Dashboard and local work.
4. Clean, successfully saved, and successfully published Dashboard states navigate
   without a stale warning.
5. The original APPBI-VERIFY-007 rows, page/filter scope, semantic binding, and visual
   configurations are replayed through the real browser and classified exactly as
   `CONFIRMED`, `FALSE POSITIVE`, or `UNPROVEN`.
6. A production `ChartService.get_charts_data_batch` or real batch-route test proves
   single equals batch equals the hand-computed value for two explicit anchors.
7. A real Dashboard/Public browser case checks both `X-AppBI-As-Of` and the visible
   relative-date value.
8. The real PDF worker creates and completes one multi-page job whose parsed PDF has the
   expected page count, order, titles, Unicode text, filters, and hand-computed values,
   with one export anchor used on every page.
9. The final report identifies the active `APP_TIMEZONE`, explains a Vietnam-local date
   boundary, and states `PRODUCT DECISION REQUIRED` without altering product policy.
10. Targeted headed Builder/Public/Export smoke, required Pair/Foundation gates, full
    committed Playwright, export content checks, canonical `verify.py task`, preflight,
    and relevant CI all have exact PASS/FAIL/NOT VERIFIED reporting.
11. The branch is pushed for independent verification and is neither merged into demo
    nor deployed.

## Open questions

- Product owner: which business timezone should define “Today” for the intended
  deployment? This does not block technical closure under the current UTC contract, but
  remains an explicit product decision.
- APPBI-VERIFY-007 classification: `CONFIRMED`. The recovered Builder replay sent no
  page filter for KPI/trend charts while bar/table siblings sent `region = North`.

