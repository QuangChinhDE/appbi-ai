# Report Studio V3 — completion round

Continuation of V3 (PR #7, stacked on #6 → #5 → `demo`). Code: `e2cc3237` (Milestone 1), `5838de2c` (Milestones
2, 4, 5), `7b247fa8` (auto-scroll fix + smoke). Evidence: [`evidence/`](evidence/) — small on purpose.

## Shared root causes

1. **Two interpretations of one filter.** The structure response decided "is this lock enforced" by the raw value;
   the engine decided by `normalize_filter_conditions`. Page filters were enforced by whatever the viewer's page
   chose to send. → One authority: the engine's own chokepoint for link entries, and page scope resolved on the
   server from the stored dashboard.
2. **Enforcement and disclosure were the same list.** Everything that *said* which filters ran (structure JSON,
   field picker, AI tool results, system prompt, flow envelope, debug SQL) was fed the enforced list — hidden
   constraints included. → Entries from hidden sources are tagged `_disclose: False`; one projection
   (`disclosed_applied_filters`) is what may be said.
3. **Shared edits without a consistency model.** Filters/pages/theme are one draft for every author, written as
   whole arrays with no revision. → Optimistic concurrency (revision = last publish + pending counter) and an
   explicit, named choice when Publish/Discard would touch another author's edits.
4. **A capability the renderer had but authors could not reach.** `tileFrame` (card/subtle/flush) rendered in
   builder and public, but only AI Design could set it. → A manual control.

## Decisions

| Problem | Chosen | Why |
|---|---|---|
| A lock the engine cannot apply (`between 5`) | refuse the link: 409 on every public path, 422 at save, 400 for an embed claim | the alternative is serving what the author meant to restrict; an EMPTY lock stays the documented no-op |
| Page scope | server applies `pages_config[p].filters` for the page(s) the chart is on; `page_id` on requests; none → every page the chart is on (AND) | a crafted request cannot drop it; never wider than any page |
| Link lock vs page filter on the same field | a value-carrying lock replaces the page filter (as before); `is_null` / preset-only locks AND | preserves existing link semantics without widening |
| Workboard links without `field` | canonicalise from `semanticField`; producer emits `field` | their role row-filter was silently dropped (every role saw every row) |
| Editing a shared chart from a report | ask: "only this report" (copy swapped in as a DRAFT) or "the shared chart" (lists the reports it changes live) | keeps chart identities; the report-only path rides the existing draft lifecycle |
| Co-authoring | revision on the shared draft; 409 + Reload on a stale write; Publish/Discard with others' edits → "only mine" or "everything, including X" | observable and recoverable, no new collaboration platform |
| Hidden debug in public responses | public chart payloads carry no `debug`; engine errors naming a hidden field are replaced | the viewer never needed the SQL; the builder endpoint still returns it |

## DoD status

Levels: **Code** implemented · **Tech** automated checks · **Smoke** production-build browser run · **Human** acceptance.

| DoD | Code | Tech | Smoke | Human |
|---|---|---|---|---|
| 1.1 Filter semantics authoritative | DONE | DONE (test_public_filter_authority 34, disclosure, layered merge) | DONE (C: crafted/escape/no-page requests all = page scope R$5,202,955.05; 422) | PENDING |
| 1.2 Hidden metadata does not leak | DONE | DONE | DONE (C: hidden page filter absent from public JSON) | PENDING |
| 1.3 One lifecycle; shared chart edits | DONE | DONE (swap/usage tests) | DONE (C: report-only copy is a draft, link keeps original, Discard restores) | PENDING |
| 1.4 Co-authoring consistency | DONE | DONE (stale write, publish/discard with others) | PARTIAL — stale write + dialog verified; the Publish/Discard choice dialog verified by backend tests only | PENDING |
| 2.1 Efficient authoring | DONE (auto-scroll, frame, next-to in a full row) | DONE (contract) | DONE (A: 1,308px auto-scroll; control above chart, neighbour not shrunk) | PENDING |
| 2.2 Coherent design language | PARTIAL — frame per element added; no new element types | DONE | DONE (A/B frame on /d) | PENDING |
| 2.3 Slicer presentation | DONE (scope cue; Place all existed) | DONE | DONE (A: "Filters every chart on this page") | PENDING |
| 3.1–3.4 AI composition | PARTIAL — directions already differ structurally; executive density, table fit, headline layout improved; no new AI vocabulary | DONE (presentation 128, report-experience 39) | DONE (B: real model, no number changed, manual refinement kept) | PENDING |
| 4.1 Responsive readability | PARTIAL | — | DONE for render defects/overflow at 820/390 (A) | PENDING |
| 4.2 Content-aware presentation | DONE (table fit, pie label room, headline columns) | DONE | DONE (B: table ends at its last row) | PENDING |
| 4.3 PDF readable | DONE (glyph gaps, band frames, heading keeps with content) | DONE | DONE (D: 3 pages reviewed) | PENDING |
| 5 Legacy debt | PARTIAL (dead dock logic and misleading `dock` removed) | DONE | — | PENDING |

## Verification (one production-equivalent environment: host `next build` + isolated backend)

- **Smoke, `completion-smoke.spec.ts`** (`evidence/results.json`): A, B and C all PASS.
  - B and C ran on the 5838de2c build.
  - A ran on the build that already held the auto-scroll fix, committed next as `7b247fa8` (its first run at
    5838de2c failed: 0 px scrolled).
- **Regression at `7b247fa8`:**
  - unified grid: 24/24 PASS;
  - V3 S1–S8: 8/8 PASS;
  - CI e2e suite: 72 passed, 5 skipped, 0 failed.
- **Backend:** the CI contract list and the guardrail-required agent-flow gates pass (2,043 locally). 2
  `test_module_floor` tests need the pinned FastAPI and pass in CI. The tier-1 oracles pass.
- **Frontend:** `npm run qa` passes (unified grid 41, presentation 128, report-experience 39), tsc is clean and the
  production build passes.
- **CI:**
  - `e2cc3237` and `5838de2c`: 5/5 green.
  - `7b247fa8`: Product gate e2e failed on a cleanup `socket hang up` (`tests/report-studio.spec.ts`, DELETE at
    uvicorn's 5 s keep-alive idle limit). The same test passed in the E2E workflow on the same SHA, and nothing in
    the commit reaches that path. This is recorded as a flake, not fixed here.
- **NOT VERIFIED:**
  - `galaxy_golden` and `distinct_cascade_bq` (need the ds113/BigQuery fixtures). More predicates now reach the
    warehouse (🔒/🚫 page filters), so BigQuery typing is untested.
  - The Publish/Discard shared-choice dialog in a browser.
  - `browser_verify` as a human gate.

## Remaining limitations

- **`DashboardFilterBar`'s unreachable non-`bare` half is kept.** Controls render through it, so deleting ~360 lines
  is a cleanup with its own risk. The `.slicer-cluster` CSS and the `slicerCluster.*` i18n names are also kept
  (harmless).
- **The persisted `theme_config.filterDock` / `slicer_cluster_layout` keys stay.** They are read for stored reports
  and by the rollback.
- **The AI reads a chart on several pages under the AND of their scopes.** It can see less than the tile on the
  viewer's page shows; this is never wider. Sending the viewer's page with AI requests would fix it.
- **The distinct endpoint without `page_id`** (an old cached bundle) is bounded by the first page's scope.
- **A 🔒 dashboard filter plus a page filter on the same field now AND.** Before, the lock replaced the page filter,
  so some existing numbers narrow.
- **Filter wording gaps (low):** `not_between` stored as a string; `ends_with`/regex conditions.
- **PDF:** a sheet breaks at a row edge, so a sheet can end half empty when the next row does not fit (D page 2). A
  narrow pie legend truncates ("credit_ca").
- **Mobile:** bar data labels crowd on the narrowest charts, and pie labels truncate (with a tooltip).
- **No new native element types** (e.g. a KPI hierarchy block); DoD 2.2 remains partial.

## Migration and compatibility

- **No schema change.** The shared-draft revision lives in `draft_snapshot`, and only while shared edits are pending.
- **Stored links with a malformed value-bearing lock now return 409.** Count them before deploy:
  `malformed_link_entries(filters_config)` over `dashboard_public_links` and legacy `dashboards.public_filters_config`.
- **Workboard role filters start being enforced** on public links (a security fix): viewers see only their role's
  rows.
- **Public numbers narrow where the server now applies what the client used to skip:**
  - 🔒/🚫 page filters;
  - a dashboard lock ANDed with a page filter.

## Run it

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up    # or ./run.sh then rebuild
cd e2e && E2E_BASE_URL=http://localhost:3000 E2E_API_URL=http://localhost:3000 \
  npx playwright test -c acceptance.config.ts completion-smoke        # this round's smoke
```

## Human acceptance checklist

1. Select a chart → **Frame: Subtle / Flush**. Undo gives the card back, and after Publish `/d` looks the same.
2. On a long report, drag an element to the bottom edge and hold: the page scrolls.
3. Select a chart in a full row → **Add → Slicer → Next to …**: the control goes directly above it, and nothing is
   shrunk.
4. Hover a control: it says it filters the whole page (or all pages).
5. Tile menu → Explore → **Update** → "Only this report". The builder shows the copy, the link keeps the original,
   and Discard reverts.
6. Two tabs of one report: change a filter in one, apply one in the other. The second tab shows "This report
   changed…" with Reload.
7. A link with a 🔒 value and a page with a 🚫 page filter: `/d` states the lock and never names the hidden filter
   (check the network JSON too).
8. AI Design → Executive on a selected-chart report → Apply → refine by hand → Publish: no number changes, and the
   table tile ends at its last row.
9. Open `/d` at 1440 / 820 / 390 and export the PDF: figures have no glyph gaps, and no heading sits alone at the
   foot of a sheet.
