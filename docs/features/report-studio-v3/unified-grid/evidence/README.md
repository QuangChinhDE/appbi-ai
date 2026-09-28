# Unified Grid & Slicer Freedom — evidence

**Commit:** `f5d0a883651710f90130034e300db71a7e95f3e0`

**Where it ran.** The commit was built into the production standalone Docker image (`frontend/Dockerfile`). It ran as a
dedicated container (`appbi-rx-frontend-ug`), and every scenario used that container. The backend was isolated, with
a temporary Postgres holding Olist and the E2E fixtures. The planner used the real model.

**How it was produced.** Each command was run with `E2E_BASE_URL`/`E2E_API_URL` set to the container:

| Suite | Command |
|---|---|
| Unified Grid | `npx playwright test -c acceptance.config.ts acceptance/unified-grid.spec.ts` |
| V3 S1–S8 regression | `ACCEPT_EVIDENCE_DIR=…/v3-regression npx playwright test -c acceptance.config.ts acceptance/report-studio-v3.spec.ts` |
| CI suite | `npx playwright test` |

**The API is used only for fixtures:** a copy of the baseline, a public link, and a second page (S5). Everything under
test was done through the UI, as an author or a viewer would.

**Status rule.**
- A scenario stays **NOT VERIFIED** until at least one of its assertions runs.
- A scenario that threw is **FAIL**, whatever it asserted before the throw.
- A skip is never a pass.

## Results — Unified Grid (`results.json`)

| # | Scenario | Result (assertions) | Evidence |
|---|---|---|---|
| S1 | Grid-only creation: no Canvas anywhere; a Canvas write is stored as grid; a gap survives save and reload; nothing else moves | **PASS** (6) | `s1-grid-only-builder-1440` |
| S2 | Section header, callout, text and slicer added through the UI; Shift-select; align; nudge (moves into free space, refused into a neighbour); Undo/Redo exact; lock holds; no coordinates shown | **PASS** (17) | `s2-elements-1440`, `s2-arranged-1440` |
| S3 | Slicer at the top (the page moves down one band, keeping every gap); a new filter below; narrow a chart, drop the control beside it; taller → a list; restyle; survives reload; public at 3 widths | **PASS** (21) | `s3-slicers-builder-1440`, `s3-public-{1440,820,390}` |
| S4 | Filter parity. Move, resize, restyle: **0 chart queries**, every KPI identical, the table identical. The effective filter context after reload is `customer_state in [SP]` and nothing else. The published report shows the same numbers at 1440 and 390. | **PASS** (12) | `results.json → S4.metrics` |
| S5 | Scope: a control placed where its scope says "filter, don't show" is dimmed for the author ("still filters"), and the numbers are still filtered. Public page 1 shows no control and still applies the filter. The same field cannot get a second slicer. | **PASS** (6) | `s5-public-page1-1440` |
| S6 | A link that locks the field: no control for it, and its numbers are the locked value | **PASS** (4) | `s6-locked-1440` |
| S7 | Real model: "filters on the page as a filter band at the top". The control is draft-only and names an existing slicer; the numbers are unchanged; no typed figure; no render defect. | **PASS** (6) | `s7-ai-builder-1440` |
| S8 | Style-only AI change: every rectangle unchanged, the slicer control's too | **PASS** (2) | `s8-style-applied-1440` |
| S9 | The AI report is editable: move and restyle the AI control; remove it → the filter returns to the bar | **PASS** (4) | `s9-ai-then-manual-1440` |
| S10 | Before Publish the public report has no control; Undo/Redo of the display; Undo of a move while a filter is active restores the place, not the filter; reload; after Publish the public report draws the control with the author's display | **PASS** (9) | `results.json` |
| S11 | Builder, `/d` and `/embed` show the same elements, control and numbers. The PDF has no missing data. | **PASS** (8) | `s11-d-1440`, `s11-embed-1440`, `s11-export.pdf` |
| S12 | An untouched report keeps its filter bar (builder and public). A migrated Canvas report opens on the grid with no overlap, and every tile has a cell. | **PASS** (6) | `s12-migrated-builder-1440` |
| S13 | At 1440/820/390: no sideways scroll; no control taller than half the screen or below a usable size; the selection survives narrowing; the value menu fits a 390px screen | **PASS** (15) | `s13-public-{1440,820,390}`, `s13-menu-390` |
| S14 | Performance: 4 moves, 0 chart queries; timings below | **PASS** (3) | `results.json → S14.metrics` |
| L | Slicer benchmark: executive narrative; a global date at the top (starts at all dates, numbers unchanged); category and region lists beside their charts. Builder, `/d` and `/embed` at 1440/820/390. | **PASS** (30) | `L-benchmark-{builder,public,embed}-{1440,820,390}` |
| F | Clear a value (the report is unfiltered, the control stays). Remove the control (the entry stays, back in the bar). Delete the filter (the entry and every control go; nothing points at it after reload). | **PASS** (9) | `results.json` |

**Total:** 158 assertions, all PASS.

## V3 regression — S1–S8 at this commit (`v3-regression/results.json`)

All 8 scenarios **PASS** with 99 assertions, the same count as the release candidate:

| Scenario | Assertions |
|---|---|
| S1 | 34 |
| S2 | 5 |
| S3 | 3 |
| S4 | 31 |
| S5 | 5 |
| S6 | 3 |
| S7 | 10 |
| S8 | 8 |

**S7's first attempt failed.** Its direction half stopped on a 20 s API timeout while duplicating the baseline. The V3
harness then recorded it as PASS, because it lacks the fail-on-throw rule that the new suite has. It was run again and
passed 10/10. The duplicate endpoint takes about 3 s on this backend, the same on the release-candidate code
(`ee22d60d`, measured side by side), and a single-process backend under the full suite occasionally exceeds the
harness timeout.

## CI Playwright suite (`e2e/tests`) against the container

This is recorded in the handoff with the final run's counts. Earlier runs at this commit had 2–3 failures that did
not reproduce when run alone: the Studio preview frame settling under load, and API timeouts on duplicate and
delete. Both pass in isolation.

## Timings (production image, isolated backend)

| Measure | This scope | V3 release candidate |
|---|---|---|
| Move a slicer control (gesture to settled) | 465–536 ms | (the cluster could not be placed) |
| Chart queries caused by moving, resizing or restyling a control | **0** | Moving the filter area (dock) was a filter-draft change, re-queried on Apply |
| Filter → numbers updated (Apply, whole page in view) | 4.2–4.6 s | ~4.2 s |
| Publish | 0.45–0.92 s | 1.3–3.2 s |
| AI preview (real model) | 4.0 s | 3.0–4.6 s |
| PDF export | 2.4 s | ~2.6 s |
| Create from data | 7.8 s | 4.0–7.6 s |

## What the images show (reviewed one by one)

These defects were found by looking at the pages and fixed at their source (commit `f5d0a883`):
- A new date control defaulted to "this month" and emptied the report. It now starts at all dates.
- On `/d` a tall control stayed a dropdown instead of a list, because it was measured before the viewer's filters
  arrived.
- A pill-styled control stretched to a tall tile drew an oval.
- The control's own menu sat under the grid's lock and remove buttons.
- A widget could not be selected: the grid's drag placeholder swallowed the click.
- AI "filters on the page" answered with a direction dropped the controls.

After the fixes:
- **`L-benchmark-public-1440`:** the date control reads "All". The headline, KPIs and "What moved" are live. The
  category and state lists sit beside their charts with their values listed.
- **`s13-public-390`:** two controls at the top as full-width cards, 2-up KPIs, no overflow.
