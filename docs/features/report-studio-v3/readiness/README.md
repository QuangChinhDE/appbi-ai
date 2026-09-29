# Report Studio V3 — final production readiness

PR #7 (Draft), branch `feat/report-studio-v3`. The previous round ended at `72c20643` (code `7b247fa8`). This round
adds two code commits:

- `1df4d379`: authority, lifecycle, copy, concurrency, labels, legend and PDF.
- `98976b8b`: viewer gate, catalog trim, conflict fix and auto-scroll bound.

The evidence is in [`evidence/`](evidence/) (`results.json`, screenshots, the PDF and its rendered pages, and
`perf-baseline.json`).

## A. Status

**BLOCKED.** These are the blockers:

| Blocker | Owner |
|---|---|
| **The BigQuery gates cannot run here**. Two guardrail gates are required: `galaxy_golden` and `distinct_cascade_bq`. Their harnesses (`backend/scripts/verify_galaxy_golden.py`, `verify_distinct_cascade_bigquery.py`, the golden SQL harness) are not in this repository, and no ds113/BigQuery connection is available. This round adds warehouse-reaching SQL: page and author bounds are ANDed; the hard bounds on the dropdown's own field use every operator. None of it has run on BigQuery. | Data platform owner, who holds ds113 and the harness. |
| **A pre-existing BigQuery defect is now reachable from one more place.** Every SQL builder renders text operators as `LIKE '%x%' ESCAPE '\'` (chart engine, live query, distinct). BigQuery rejects that syntax. So a `contains` / `starts_with` / `not_contains` filter on a BigQuery source already fails in charts. A text-operator author bound on a dropdown's own field now reaches the distinct query too. There it fails closed: the dropdown is empty and nothing leaks. | Semantic-engine owner. The fix is in the protected SQL builders and needs BigQuery to verify. |
| **`browser_verify` is a human gate**, run on the deployed build. | Release owner |
| **Human product acceptance** | Product owner |

Everything else below was implemented, tested and exercised on a production build.

## B. DoD matrix

Legend: ✅ done and evidenced · ◐ partial (see remaining) · ✗ not done.

| DoD | Implementation | Focused tests | Integrated runtime | Evidence | Remaining |
|---|---|---|---|---|---|
| 01 Public boundaries authoritative | ✅ link lock/kill ANDs with page + 🔒/🚫 filters; scope ANDs with a lock; malformed → 409/422/400 | ✅ `test_public_filter_authority` (link-vs-page, kill-marker, scope-vs-lock, visible default still overridable) | ✅ R3: a lock outside the page scope returns no rows; crafted page/filter/operator stay in scope | R3 (16 assertions) | BigQuery typing (A) |
| 02 One filter meaning everywhere | ✅ one merge (`_build_public_chart_filters`) for chart, batch, distinct, AI; distinct keeps every hard bound on its own field in SQL, fails closed if one cannot apply | ✅ strip test through the real `_distinct_values_full` (mutation-checked); endpoint fail-closed test | ✅ R3 dropdown = page scope, search cannot escape; R9 parity | R3, R9 | distinct on BigQuery (A) |
| 03 Hidden metadata | ✅ hidden entries never served; public model, chart binding catalogs and the viewer's field inventory list only fields the report exposes; a viewer filter may name only exposed fields; `_`-markers stripped | ✅ model/catalog trim, 4 bypass shapes, raw-header names, linkedFields, inventory | ✅ R4: no public response (structure, data, distinct, error, recon, rendered DOM) carries a hidden label or value, no SQL | R4 (7) | narrow-only residuals (below) |
| 04 Role isolation | ✅ an unappliable workboard role slot refuses the link (was: every row); unmapped role → 403 (existing) | ✅ two roles, exclusion, invalid slot, unmapped role, audit | ✅ R3: two embed claims = two scopes; crafted request stays in its claim; malformed / missing / foreign-field claims refused | R3 | workboard runtime not driven in a browser |
| 05 One Draft/Publish lifecycle | ✅ tile title, appearance, highlight, date-grain lock, HAVING via the draft buffer; chart-instance parameters get a per-author draft bucket | ✅ parameters draft (A/B isolation, Publish, Discard) | ✅ R5 (drafts of both authors invisible until Publish), smoke A | R5 | direct live API paths kept for non-builder API clients (documented) |
| 06 Report-only chart edit | ✅ one transaction (copy + metadata + parameters + swap); marked `reportCopy`; labelled in the library; edited in place while unpublished; deleted when unused (Discard, newer copy published, report deleted) | ✅ fork lifecycle (6 tests incl. failure, in-place, delete, Explore save keeps marker) | ✅ R6: injected failure leaves nothing; one labelled copy; Discard deletes it; shared chart untouched | R6 (9), R6-library screenshot | — |
| 07 Co-authoring | ✅ base_rev required; row lock on every draft writer; same-tile conflict is a 409 (was a 500) | ✅ missing revision, row lock SQL, same-tile conflict with real presence (mutation-checked) | ✅ R5 with **two accounts**: different tiles both land; same tile → conflict dialog, live keeps the first; stale shared edit refused; missing revision refused; Publish/Discard choice names the other author; 6 rounds of simultaneous writes lose nothing | R5 (20), 3 screenshots | — |
| 08 Manual Builder | ✅ auto-scroll bounded at the report's end; drop persists; locked tiles fixed; frames, "next to", arrange (earlier rounds) | ✅ unified-grid contract | ✅ R7: auto-scroll to the end, drop directly under the last row, reload keeps it, draft stores it, locked tile does not move, drop onto a tile → no overlap, 820px builder | R7 (11) | no new element types |
| 09 Slicer Freedom | ✅ (unified-grid round) | ✅ unified-grid 41 | regression suite (E) | unified-grid evidence | — |
| 10 AI designs a report | ✅ directions differ structurally; no hardcoding | ✅ presentation 128 | ✅ R11 on an **independent dataset**: Executive vs Operations compose differently, numbers unchanged, nothing Olist-specific, edited by hand, published; smoke B on Olist | R11 (7), previews | — |
| 11 Structure and narrative | ✅ findings are computations | ✅ report-experience 40 | ✅ R11: filtered to North, the finding is recomputed (101.8K → 29.6K) | R11-public-filtered-North | — |
| 12 Manual and AI share one report | ✅ | — | ✅ R11/smoke B: AI result edited with the manual tools and published | R11 | — |
| 13 Responsive 1440/820/390 | ✅ bar value labels only where they fit; pie legend wraps | ✅ report-experience | ✅ R8: no label over another bar, every pie slice in a visible legend, tables not clipped and not tall-empty, no KPI cut, no sideways scroll, no render defect — at all three widths | R8 (18), 3 screenshots | pie slice labels truncate (full text on hover); category axis tight but legible at 390 |
| 14 PDF professional | ✅ scale-aware pagination (fewest, fullest sheets) | ✅ sheet-plan contract | ✅ R10 exported; every page rendered and inspected | R10 PDF + pages, fill report | — |
| 15 Performance | ✅ baseline + budgets (below) | — | ✅ measured on the production build | `perf-baseline.json` | BigQuery latency not measured |
| 16 Compatibility and operations | ✅ stored-link audit (`backend/scripts/audit_public_links.py`), compatibility + rollout/rollback (F) | ✅ audit tests | ✅ audit run on the local DB: 0 findings | — | audit must be run on production data |

## C. Source → behaviour

| Behaviour | Source |
|---|---|
| Link lock / kill never removes an author boundary | `filter_layered_merge.enforce_author_bounds`, `apply_link_scope_bounds`; `public._build_public_chart_filters` |
| Link-managed field: no viewer control, page filter read-only | `public._shaped_public_config` |
| Dropdown keeps hard bounds on its own field, fails closed | `filter_layered_merge.hard_bounds_on_field`, `HARD_BOUND_KEY`; `dataset_model_service._distinct_values_full` (self-strip); `public.get_public_filter_distinct_values` |
| Exposed fields; viewer gate; catalog/model trim | `public._public_field_refs(exact=)`, `_viewer_allowed`, `_trim_served_binding_catalogs`, `_trim_model_for_public`; `_build_public_filter_fields(legacy_scan=False)`; the rule: `filter_layered_merge.filter_names_only_exposed_fields`, `without_server_owned_keys` |
| The public AI's own filters | `ToolContext.exposed_fields` (set by every public AI context), `agent_flows/tools/context._fetch_chart_data` (refused with a ToolError) |
| Role slot fails closed | `workboards/services/dashboard_link_service._build_filters_config` |
| Tile edits are drafts | `ChartTile` / `ChartDetailModal` `onPatchLayout` → `page.tsx handlePatchTileLayout`; `DashboardGrid` |
| Parameters draft | `dashboards.update_chart_parameters(?draft=true)`, `_draft_user_parameters`, publish apply, `_other_authors_drafts` |
| Report-only copy | `dashboard_service.fork_chart_for_report`, `drop_unreferenced_report_copies`, `DashboardService.delete`; `dashboards.fork_tile_chart_for_report`; `chart_service.update` (marker kept); FE `ExploreEditor` → `forkChartForReport`; library badge |
| Revisions + row lock | `dashboards.update_dashboard_draft_filters` (base_rev required), `_dashboard_for_draft_write` |
| Same-tile conflict 409 | `dashboards.publish_dashboard_draft` (presence read) |
| Auto-scroll bound | `DashboardGrid.useEdgeAutoScroll` |
| Labels / legend | `ExploreChart.buildDataLabelContent`, `CustomLegend(wrap)` |
| PDF pagination | `lib/pdf-sheet-plan.ts`, `lib/export-pdf.ts` |
| Deploy audit | `services/public_link_audit.py`, `backend/scripts/audit_public_links.py` |

## D. Evidence

`evidence/results.json` records every assertion of R3–R11. Screenshots were opened and reviewed. The PDF's three
pages were rendered (`R10-report-page1..3.png`) and inspected:

- rows break at row edges;
- no section is cut and no heading is left alone;
- the pie legend names all five slices;
- no glyph gaps;
- the space on page 3 is the end of the report.

Fill report (`e2e/acceptance/tools/pdf_review.py`): content reaches the footer on every page, and the largest internal
gap is 11.5 % / 4.1 % / (end of report) 43.5 %.

Performance baseline (Postgres, production build, 12-tile Olist report, 8 runs; `tools/perf_baseline.py`):

| Path | cold | p50 | p95 | Budget (p95) |
|---|---|---|---|---|
| builder load | 190 ms | 183 ms | 448 ms | 1 s |
| public structure | 350 ms | 447 ms | 558 ms | 1.5 s |
| a page of chart data (12 tiles) | 1952 ms | 290 ms | 333 ms | 1 s warm / 5 s cold |
| slicer dropdown | 154 ms | 54 ms | 96 ms | 1 s |
| draft write | 125 ms | 101 ms | 128 ms | 500 ms |
| publish | 135 ms | 228 ms | 259 ms | 1 s |

The 18–63 s stalls from earlier rounds were a single container run at 390 px; alone it passed on re-run. This round
ran every scenario on the host build. The full R3–R11 suite took 7.1 min and had no stall (see E for the
regression timings).

## E. Verification (all at `bac476b9`)

**Environment.** A production-equivalent build: host `next build` of `bac476b9` served on :3218, and the isolated
backend at `bac476b9` on :8117 against a temporary Postgres (Olist and "E2E presentation sales" datasets). The shared
`appbi-ai-*` / `appbi-af-*` containers were not touched.

| Gate | Command | Result |
|---|---|---|
| Final readiness R3–R11 | `npx playwright test -c acceptance.config.ts final-readiness` | **PASS 10/10**: R3 16, R4 7, R5 20, R6 9, R7 11, R8 18, R9 3, R10 2, R11 7 assertions. R9 and R11 were re-run after a fix to the test's own KPI reading (a tile still loading was read as a changed number). |
| Completion smoke A/B/C | `… completion-smoke` | **PASS 4/4** |
| Unified grid S1–S14 + L + U + R1–R7 | `… unified-grid` | **PASS 24/24** |
| V3 S1–S8 | `… report-studio-v3` | **PASS 9/9** |
| CI e2e suite | `npx playwright test` | **72 passed, 5 skipped, 0 failed** |
| Backend contract list (CI workflow) | `pytest` over `backend-contract-tests.yml` | 2084 passed. 3 fail locally only, for environment reasons: 2 `test_module_floor` need the pinned FastAPI, and `test_chat_thread_sharing` fails identically at the base. All pass in CI. |
| Frontend | `tsc --noEmit`, `npm run qa`, `next build` | pass (unified grid 41, presentation 128, report-experience 40) |
| Guardrail | `guardrail_check.py --diff` | **WARN** (protected: public-link security). Named `layered_merge` passes. `galaxy_golden` and `distinct_cascade_bq` are **NOT VERIFIED**: no harness, no BigQuery. |
| Semantic-guard reviews | 5 independent passes on the public changes | every finding reproduced then fixed. The 6th pass (on `bac476b9`) was cut off by a spend limit; its two questions were checked by hand (no AI tool passes `extra_filters`; the tail rule can only name a column of an exposed field). |
| CI | GitHub checks | 5/5 green at `1df4d379`, `98976b8b` and `bac476b9` |
| browser_verify, human acceptance | — | **NOT VERIFIED** (human gates) |

**Stalls.** No action timed out (20 s action limit, 45 s navigation) in any suite. The longest tests are whole
journeys, for example R5 (two accounts, five publishes) at 199 s and UG L at 100 s.

**Residual risks** (none widens data):

| Risk | Severity | Owner |
|---|---|---|
| BigQuery: `LIKE … ESCAPE ''` in every SQL builder; this round's new SQL has not run on BigQuery | P1 until verified | semantic engine / data platform |
| Semantic layer: the chart engine's raw-calendar rewrite fans an unmatched `X.<calendar part>` out to every date role. The gate now blocks it on public paths; the engine itself is unchanged. | P2 | semantic engine |
| A viewer filter the gate drops is only logged. Public tiles carry no `debug`, so no badge says "ignored". | P2 | report runtime |
| A chart saved without a binding, on a view not named `dataset_table_<id>`, loses public cross-filter | P3 | report runtime |
| Pie slice colours follow slice order (a slice changes colour when filtered); pie slice labels truncate at 390 px (full text on hover) | P3 | charts |
| Dashboard **Duplicate** copies its charts, and deleting the duplicate leaves them in the library (the existing Duplicate feature; not the report-only copy) | P3 | dashboards |
| Workboard role links verified at API level, not driven in a workspace browser session | P3 | workboards |

## F. Compatibility, rollout and rollback

**Behaviour changes a user can notice:**

- **Link locks and author boundaries now AND.**
  - A link locked to a value that is outside a page filter or a 🔒/🚫 report filter on the same field now returns
    no rows on that page. Before, the lock replaced the report's filter.
  - A page filter on a link-managed field is shown read-only (🔒).
  - Run `python backend/scripts/audit_public_links.py` before deploying. It lists:
    - `refused_malformed`: the link now returns 409;
    - `empty_against_boundary`: the page is now empty;
    - `narrowed_by_boundary`: the report's filter now applies too.
  - The remedy is the report owner's: change the link's value, or widen or remove the report filter.
- **Public viewers, and the public AI, can filter only by fields the report exposes.**
  - Exposed means its controls and the fields its charts use, spelled exactly as the report spells them.
  - A report with no controls no longer offers a picker of every dataset dimension.
  - Served chart bindings list only the exposed fields.
  - Cross-filter clicks on charts keep working.
  - Asked to filter by another field, the AI says it cannot, instead of answering with unfiltered numbers.
- **Workboard role links with an unappliable role slot return 409** instead of every row. Fix the role mapping.
- **Shared-draft writes without `base_rev` are refused (409 "reload").**
  - This affects cached old editor bundles and scripts that call `PUT /draft-filters`.
  - After a reload the editor sends it.
- **Chart-instance parameters, and tile title / appearance / toggles from the builder, are drafts.**
  - They reach public and embed only on Publish.
  - API clients that call `PATCH /parameters` without `?draft=true` and `PUT /layout` still write live
    (documented contract).
- **"Only this report" copies carry `config.reportCopy`.**
  - They are deleted when no report uses them: on Discard, when a newer copy is published, or when the report is
    deleted.
  - A copy that another report started using is kept.

**No schema change, no migration.** Everything lives in existing JSON columns: the `draft_snapshot` buckets,
`chart.config`, and link filters.

**Rollout:**

1. Run the link audit on production and send each report owner their findings.
2. Deploy the backend and frontend together. An old frontend against the new backend gets 409 on shared-draft writes
   until it reloads.
3. Watch the `filter_merge ... viewer_field_not_exposed` log lines and 409s on `/public/...`.

**Rollback:**

- Redeploy the previous image. Nothing stored needs converting.
- Report copies created in the meantime stay as ordinary library charts: the marker is ignored by old code.
- Per-author `user_parameters` drafts are dropped (unpublished only).

## G. Human checklist

1. **Two people on one report.**
   1. B clicks Request edit and A allows it.
   2. A frames one chart and B frames another. Both publish, and `/d` shows both.
   3. Both frame the same chart and A publishes. B's Publish shows "someone published".
2. **A picks a filter value (shared draft). B, on an older copy, picks another.** B is told to reload. B's Publish
   asks "only mine / everything including A".
3. **Explore → Update → "Only this report".**
   1. The library shows "Report copy".
   2. Discard: the copy is gone from the library.
4. **On a long report, drag a KPI to the bottom edge and hold.** The page scrolls to the end and stops. Drop under
   the last row, Save draft, reload: it stays.
5. **A link locked to a value outside the page filter shows no rows on that page.** `/d` states the page filter
   read-only.
6. **Open `/d` at 1440 / 820 / 390.**
   - Bar value labels never sit on other bars.
   - The pie legend names every slice.
   - Tables end at their last row.
7. **Export the PDF of a long report and read every page.**
8. **AI Design on a non-Olist report.** Executive vs Operations look different. Apply, refine by hand, Publish.
   Filter `/d` and the sentence changes.
9. **Run the link audit on production data** and review the findings with the report owners.
