# Unified Grid & Slicer Freedom — evidence

**Code under test:** `23f6b3c3b5ebeff0c5be1a91ac4dd024047f9d63` — the product-review round
([`../product-review.md`](../product-review.md)): `e9f441e2`, `9572f0d8`, `29e2e0ee`, `057e6955`, `17f8071d` (R7,
acceptance only) and `23f6b3c3`. The commit that adds this README changes only docs and evidence. The previous round's
evidence was at `a98e0a02`; every image and result below was regenerated at `23f6b3c3`.

**Where it ran.**
- **Production image.** The commit was built into the standalone image (`frontend/Dockerfile`) and run as
  `appbi-rx-frontend-ug` on :3219.
- **Host build (control).** The same commit, built with `next build` and served from the host on :3218. It was used
  to separate product failures from a rig limitation (see *E2E reliability*).
- **Backend.** Isolated, on 127.0.0.1:8117, with a temporary Postgres holding Olist and the E2E fixtures. The
  planner used the real model.

**The API is used only for fixtures:** a copy of the baseline, a public link, a second page. Everything under test was
done through the UI.

**Status rule.**
- A scenario stays **NOT VERIFIED** until at least one of its assertions runs.
- A scenario that threw is **FAIL**, whatever it asserted before the throw.
- A skip is never a pass.

## What was wrong (report 574)

`legacy-574/before-79993e21-builder-1440.png` shows a dashed strip above the KPIs: one Region dropdown, a gear, and
whitespace. It was the old `SlicerCluster` filter area.
- **In the DOM** it was drawn *outside* `.react-grid-layout` for every slicer that had no grid control. It was never a
  grid item.
- **In the data** the report had `slicers_config` and no control rows. Nothing had converted reports saved before grid
  controls existed.

After `20260929_0001` and the removal of the filter area:
- No `.slicer-cluster` exists on any surface.
- Region and Channel are grid elements (`legacy-574/after-migration-builder-1440.png`, `U-legacy-opened-1440`).
- They can be moved between the KPIs and the charts, and the band they leave closes (`U-moved-builder-1440`).

## Results — Unified Grid (`results.json`, 24 scenarios, 356 assertions, all PASS)

**Both surfaces, same commit:** production container 24/24 PASS (356 assertions) and host build 24/24 PASS (356). The
container run is the one in `results.json` and the images; the host run is the control. R1–R7 are the product-review
scenarios (next table).

| # | Scenario | Assertions | Evidence |
|---|---|---|---|
| S1 | **New report (A).** The starter builds a grid report whose filter is a grid control, with no filter area. No Canvas; a gap survives save + reload. | 9 | `s1-grid-only-builder-1440` |
| S2 | Section header, callout, text, and the migrated slicer control; Shift-select, align, nudge, Undo/Redo exact, lock holds | 18 | `s2-*` |
| S3 | The migrated control: removing it closes its band. Placing it again at the top moves the page down one band; **Undo gives the page back exactly, Redo repeats it**. A new filter below; beside a chart; taller → list; restyle; reload; public at 3 widths. | 29 | `s3-*` |
| S4 | Filter parity. Move, resize, restyle: 0 chart queries, every KPI and the table identical. After reload the context is `customer_state in [SP]` only. Published report identical at 1440 and 390. | 13 | `results.json → S4` |
| S5 | Custom scope. Page 1 shows the control dimmed ("still filters"), with the numbers filtered. **UI page switch:** on page 2 the Slicer button counts the filter, the author places it, and it is live with the same value. Back on page 1: still hidden, numbers unchanged. Public page 1 draws no control and still applies the filter. | 17 | `s5-public-page1-1440` |
| S6 | A link that locks the field: no control, and the locked value's numbers | 5 | `s6-locked-1440` |
| S7 | Real model. The controls the AI made are draft-only; the published control is kept and not duplicated; numbers unchanged; no typed figure; no render defect. | 7 | `s7-ai-builder-1440` |
| S8 | Style-only AI change: every rectangle unchanged, the control's too | 3 | `s8-style-applied-1440` |
| S9 | The AI control moves, restyles, is removed; the filter stays and no filter area appears | 5 | `s9-ai-then-manual-1440` |
| S10 | A new filter's control is draft-only (the public link has only the published one). Undo/Redo of the display. Undo of a move while filtered restores the place, not the filter. After Publish: both controls, with the author's display. | 13 | `results.json` |
| S11 | Builder, `/d` and `/embed`: same elements, the control, the same numbers, no filter area; PDF complete | 13 | `s11-*` |
| S12 | **Every report migrated from the bar (B)**, 12 of them including 574: no filter area outside the grid, their controls on the grid, no overlap. The baseline copy is the same in builder and public. The Canvas-migrated report opens on the grid with no overlap. | 57 | `s12-migrated-builder-1440` |
| S13 | 1440/820/390: no sideways scroll, usable controls, the selection survives narrowing, the menu fits 390 | 16 | `s13-*` |
| S14 | Performance on Olist (13 visuals): 4 moves, 0 chart queries | 4 | timings below |
| L | Olist benchmark: **date beside the headline, category right above the KPIs, state list beside "Revenue by state"**. Numbers, narrative sentences and render findings are identical after every move. Builder, `/d`, `/embed` at 3 widths. | 37 | `L-benchmark-*` |
| F | Clear a value, remove a control (filter kept, listed on the Slicer button, no filter area), delete a filter (entry and every control gone after reload) | 12 | `results.json` |
| U | **Legacy report 574 (B).** Detailed in the next section. | 63 | `U-*` |

S12 passed on the production container this time as well as on the host build (at `a98e0a02` it had hit the rig
stall described below on the container).

### Product-review scenarios (R1–R7)

| # | Scenario (DoD) | Assertions | Evidence |
|---|---|---|---|
| R1 | **Removal is a draft edit (DoD-1).** On a copy of the baseline: remove a published chart → the public link still has it; exact Undo → the same tile id is back and nothing is left to publish; remove again → Publish → the link no longer has it. | 11 | `R1-public-before-publish-1440`, `R1-public-after-publish-1440` |
| R2 | **A hand-added element is a draft (DoD-2).** Not on the link before Publish; Discard deletes it. | 3 | `results.json` |
| R3 | **Delete filter is one draft change (DoD-3).** Entry and every control go together; the link keeps both until Publish. | 4 | `results.json` |
| R4 | **The reader is told what filters the page (DoD-5/6).** A link locking Customer state = RJ reads "Filtered by 🔒 Customer state: RJ"; the stripped control leaves no band (first tile at ≤ 24 px, 0 absent cells); a link that HIDES the field serves no entry and no value, and names nothing. | 5 | `R4-locked-link-1440`, `s6-locked-1440` |
| R5 | **Headings keep their content (DoD-7).** The legacy report's "Performance" heading, after two Executive runs: directly above the charts it introduces, 80 px tall, full width; one "Detail", not two. | 6 | `R5-executive-applied-twice-1440` |
| R6 | **A control beside the selected chart (DoD-8).** With the chart selected, *Add → Slicer → Next to …* puts the control in the chart's row with no drag (1.5 s). The spec first narrows the chart by hand to make room; the "insert above" fallback and the lock refusal are covered by the contract check only. | 2 | `R6-beside-1440` |
| R7 | **An exclusion is stated as an exclusion (DoD-5).** A link locking Customer state `not_in [SP]` is served with its operator, reads "Customer state: not SP", and its numbers differ from the `in [SP]` link's. | 4 | `R7-excluding-link-1440` |

### U, step by step (copy of report 574, production container)

1. **Opens clean.** No filter area outside the grid; Region and Channel are grid elements above the KPIs.
2. **Region moves under the KPIs.** Dropped on the row under the KPIs, it opens a row there, and the rest of the page
   moves down by its height.
3. **Channel moves beside it; the top band closes.** The KPIs become the first row again. Every other tile ends
   exactly where it started. No whitespace (≤ 24 px) is left around the controls, and each keeps its size (80 px, not
   inflated).
4. **Nothing is re-queried.** 0 chart requests; KPIs and table identical.
5. **The value menu works.** It opens over the charts and is not clipped. Clicking a value is not a drag.
6. **Undo/Redo and reload.** Undo ×2 returns the page exactly as it opened; Redo ×2 repeats both moves. Positions
   survive save + reload.
7. **Studio Preview.** Before and After frames both draw the controls natively, with no filter area. Discard leaves
   the author's layout.
8. **Publish → `/d` and `/embed`.** The controls are drawn between the KPIs and the charts, as published, with the
   same numbers. 1440/820/390 pass for both.
9. **PDF.** The PDF is complete and has no gap where the bar was: pages break at rows (`U-export-page{1,2,3}`).

## V3 regression — S1–S8 at this commit (`v3-regression/results.json`)

At `23f6b3c3`: host build 8/8 PASS (99 assertions, the same count as the release candidate); production container
7/8 PASS in the full run — **S4 FAIL** on one of its 31 assertions: the Operations report at `/d` 390 px still showed its sentences as pending. That one page load took 63.4 s (it hit the 60 s wait); the other eight public loads of S4 in the same run took 4.0–4.8 s, and the same page took 3.7 s on the host build. Re-run alone on the same container twice (`s4-rerun-{1,2}-container.json`): **S4 PASS 31/31 both times**, that page 3.7 s. Classified as the rig stall below, not a product failure — the evidence is the timing signature and the two clean re-runs; the stall's mechanism is still not identified.

The notes below are from the previous round (`a98e0a02`).

S5 needed attention:
- **On the container,** S5 first failed "the result opens with a headline". The model had put the KPI strip first,
  and the report's control, which the plan omitted, was appended at the very bottom.
- **Two boundary fixes followed (`a98e0a02`):**
  - a forgotten control joins the filter band after the headline;
  - a reference that opens with a headline opens the result with it.
- **The next run's result did open with the headline** (`s5-native-result.jpg`), but a chart shares its row. The spec
  sorted tiles by `top` only, so DOM order decided the tie. It now reads in reading order (top, then left); the
  assertion is unchanged.
- **Final result:** S5 PASS on the host-build run.

## Migration and rollback

**Postgres round trip (`legacy-574/postgres-roundtrip.json`).** Reports 1, 5, 574 and 604, a copy of 574 made after
the upgrade, went through downgrade and upgrade again:
- **Downgrade** deleted exactly the three controls the migration had made and moved exactly their tiles back. The
  copy (604) was untouched.
- **Re-upgrade** recreated the controls with `parameters={}`, the same cells and the same pages.

The round trip found two defects, both fixed in `e53726b0` with a test each:
- **Copies were not isolated.** A duplicate carries its source's marker, and the unscoped downgrade would have deleted
  the source's controls and moved its tiles twice.
- **Author edits after the upgrade could be overwritten.** 574's Channel control was placed by an author after the
  upgrade, and the old downgrade moved the KPIs up under it. The downgrade now leaves a tile where it is when its
  destination is taken.

574 was then repaired through the builder: Channel was dragged back beside Region and published.

**SQLite tests (`backend/tests/test_unified_grid_contract.py`)** cover:
- pages and custom scope;
- visible and locked pane filters;
- an image with a link;
- a legacy 12-column tile;
- pending drafts;
- a hidden dock;
- idempotence;
- the exact downgrade;
- a copied report;
- an author's move after the upgrade;
- a control placed after the upgrade;
- an image already on the page.

A migration review, delegated to a reviewer, found it "safe with caveats"; those caveats are the fixes above.

## Network Error on 574 (`network-error/`)

Reproduced on purpose, with both servers' logs:

| Condition | What the tiles show | Evidence |
|---|---|---|
| Backend stopped, frontend up | "Load data failed · Request failed with status code **500**" (the proxy answers) | `0-backend-down-500.png` |
| Frontend server stopped while the report is open | "Load data failed · **Network Error**": `net::ERR_CONNECTION_REFUSED` on `/api/v1/charts/*/data` | `1-frontend-origin-down.png`, `frontend-down.json` |
| Both up again, same page | data (North + South = 1.1M = 491.2K + 576.1K); the backend log shows the region-filtered chart requests answered 200 | `2-recovered.png` |

The 574 screenshot's "Network Error" is the second row. It is an environment condition: the page stayed open while
the frontend server restarted between builds. It is not a fixture, auth, migration or product defect.

## E2E reliability — CI suite (`e2e/tests`, 77 tests)

| Where the frontend ran | Commit | Runs | Failed per run |
|---|---|---|---|
| GitHub Actions (Linux, compose network) | `388ea4a9`, `a98e0a02` | 1 + 1 | 0, 0 |
| Production container (Docker Desktop, `host.docker.internal` → host backend) | `388ea4a9` | 3 | 4, 2, 2 |
| Production container, backend keep-alive raised to 75 s | `a98e0a02` | 2 | 2, 3 |
| Host build, same backend | `a98e0a02` | 2 | **0, 0** (72 passed, 5 skipped) |
| Host build, same backend | `23f6b3c3` | 1 | **0** (72 passed, 5 skipped) |
| GitHub Actions (Linux, compose network) | `23f6b3c3` | 1 | 0 (E2E job green, with the other four checks) |

**Classification: environment limitation of this rig, not a product regression and not a test-isolation defect.**
The evidence:
- **They are all stalls, and they rotate.** Every failure is a request or a UI wait timing out: API calls at 15–20 s,
  a Publish or a tile load that never completed. Across runs they hit different tests (brains PUT, `GET
  /dashboards/{id}`, publish, tiles).
- **The stalled requests never reached the backend.** They are absent from its access log, including the
  *unauthenticated* `PUT /brains`, which the backend refuses instantly (401 in every other run). App-log timestamps
  show recurring ~30 s holes right before a request's first log line.
- **The database was idle.** A read-only `pg_stat_activity` sampler (1 s) over the whole chain saw 0 lock waits and
  no query active longer than 3 s.
- **It is not keep-alive.** Raising uvicorn's keep-alive did not change it.
- **The network path decides it.** The same commit and backend with the frontend served from the host: 0 failures in
  2 full runs, and S12 and V3 S5 pass. GitHub Actions, where the frontend reaches the backend over the compose network,
  is green.

What remains open: the mechanism inside the container → `host.docker.internal` path (Docker Desktop's host
forwarding) is not identified. Production does not use that path. Whether an analogous stall exists on another
network path is **NOT VERIFIED**.

## Timings (production container)

| Measure | This scope | V3 release candidate |
|---|---|---|
| Move a control on Olist, 13 visuals (gesture to settled) | 445–557 ms | the cluster could not be placed |
| Move a control on 574 (gesture) | 443–659 ms | — |
| Chart queries caused by moving, resizing or restyling a control | **0** | a dock move re-queried on Apply |
| Filter → numbers updated (Apply, whole page in view) | 4.1–4.4 s | ~4.2 s |
| Publish | 0.28–0.76 s | 1.3–3.2 s |
| PDF export | 2.7 s | ~2.6 s |
| Create from data | 5.5 s | 4.0–7.6 s |
| Place a control next to the selected chart (open picker → control on the grid) | 1.5 s | a place, then a drag across the page |

Timings are from the production container at `23f6b3c3` (previous round's in the git history).

## What the images show (reviewed one by one)

**At `23f6b3c3` (this round).**
- **`R4-locked-link-1440`, `s6-locked-1440`.** "Filtered by 🔒 Customer state: RJ" above the KPIs; the KPIs start right
  under it. At `7c237d7c` the same page had a blank ~100 px strip there and no statement.
- **`R7-excluding-link-1440`.** "Customer state: not SP"; Revenue by state has no SP bar; R$8.4M against R$13.6M open.
  The Top sellers table still lists SP — that column is the *seller's* state, a different field; correct, but a reader
  could misread it.
- **`R5-executive-applied-twice-1440`.** Headline, the two controls, KPIs, then the "Performance" heading directly above
  its charts, then one "Detail" above the table. Observation: the pie's "Online (44%)" label is clipped at the top of its
  tile (a dangling leader line); not changed here.
- **`R6-beside-1440`.** The category control sits in "Revenue by category"'s row, beside it. The chart is narrow because
  the spec narrowed it first; the control is shorter than the row, so the space under it stays empty.
- **`U-studio-compare-1440`.** "Performance" is above its charts in *After* (at `a98e0a02` it was alone at the bottom).
  The region bar chart was captured mid-animation in both frames (empty *Before*, flat *After*); the same chart has its
  bars in the builder — a capture-timing artifact, not verified as a product defect.
- **PDF, every page (`s11-export-page1..3`, `U-export-page1..3`).** Labels in the UI language ("Exported", "Filters",
  "Page snapshot — tables print the data as shown"); the header states the filter with its value ("Filters: Customer
  state: SP"); a report with no active filter prints no filter line (at `a98e0a02` it printed "Bộ lọc: Region ·
  Channel" for two controls set to *All*); no dropdown chevron and no Group-by chips; "Performance" printed in full (was
  "Performan…"). **Still open, pre-existing (same on the `a98e0a02` pages):** KPI figures print with glyph gaps
  ("41 .4K", "R$1 25.8", "$1 43.4"); a section band's frame is sliced across page breaks (thin side edges on pages 2–3
  of `U-export`); page 1 of `U-export` is mostly empty because pages break at rows; the snapshot table on page 3 shows
  only its visible rows (the footer says so).

**At `a98e0a02` (previous round, kept for reference).**

- **`U-moved-builder-1440`.** KPIs first, then Region and Channel as two compact cards, then the Performance
  section. No strip above the KPIs.
- **`L-benchmark-public-1440`.** The date control sits in the headline's row. "Product category name" sits right
  above the KPIs. The Customer-state list sits beside "Revenue by state". Three positions in one grid.
- **`L-benchmark-public-390`, `U-public-390`.** Controls are full-width cards, 2-up KPIs, no overflow.
- **`U-studio-compare-1440`.** Both frames draw native controls. In "After", the Executive direction puts the filter
  band under the headline.
  - At `a98e0a02` the fixture's "Performance" section header was left at the bottom of the "After" frame; fixed this
    round (F3), and the regenerated image shows it above its charts.
- **`U-export-page1..3`.** Page 1 has the KPIs, the two controls and the section header. The charts start on page 2,
  a row break. There is no gap from the old bar. (Still true of the regenerated pages.)
- **The PDF bug, fixed for controls.** Controls in every PDF read "…" instead of their value (seen in the earlier
  `s11-export.pdf` at `f5d0a883`). The capture now draws control text in full: `s11-export-page1` reads "SP" and
  `U-export-page1` reads "All".
  - At `a98e0a02` the same capture bug still truncated other short text ("Performan…"); fixed this round (F5), see
    the PDF notes above.
