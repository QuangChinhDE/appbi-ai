# Unified Grid & Slicer Freedom — evidence

**Code under test:** `a98e0a0268e8d6305e21ae099958ccef66d661c4`. The commit that adds this README changes only the
acceptance specs and docs: the V3 S5 reading-order fix and the evidence itself.

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

## Results — Unified Grid (`results.json`, 17 scenarios, 321 assertions, all PASS)

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

S12 is from the host-build control run; every other scenario is from the production container. S12 also passed on
the container up to the moment a fixture API call hit the rig stall described below.

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

All 8 scenarios **PASS** with 99 assertions, the same count as the release candidate.

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
| Move a control on Olist, 13 visuals (gesture to settled) | 450–608 ms | the cluster could not be placed |
| Move a control on 574 (gesture) | 451–502 ms | — |
| Chart queries caused by moving, resizing or restyling a control | **0** | a dock move re-queried on Apply |
| Filter → numbers updated (Apply, whole page in view) | 4.4–4.5 s | ~4.2 s |
| Publish | 0.28–0.94 s | 1.3–3.2 s |
| PDF export | 2.8 s | ~2.6 s |
| Create from data | 4.5 s | 4.0–7.6 s |

## What the images show (reviewed one by one)

- **`U-moved-builder-1440`.** KPIs first, then Region and Channel as two compact cards, then the Performance
  section. No strip above the KPIs.
- **`L-benchmark-public-1440`.** The date control sits in the headline's row. "Product category name" sits right
  above the KPIs. The Customer-state list sits beside "Revenue by state". Three positions in one grid.
- **`L-benchmark-public-390`, `U-public-390`.** Controls are full-width cards, 2-up KPIs, no overflow.
- **`U-studio-compare-1440`.** Both frames draw native controls. In "After", the Executive direction puts the filter
  band under the headline.
  - Observation, not changed here: the fixture's original "Performance" section header is left at the bottom of the
    "After" frame by that direction.
- **`U-export-page1..3`.** Page 1 has the KPIs, the two controls and the section header. The charts start on page 2,
  a row break. There is no gap from the old bar.
- **The PDF bug, fixed for controls.** Controls in every PDF read "…" instead of their value (seen in the earlier
  `s11-export.pdf` at `f5d0a883`). The capture now draws control text in full: `s11-export-page1` reads "SP" and
  `U-export-page1` reads "All".
  - **Still open:** the same capture bug truncates other short text in the PDF. The section header reads
    "Performan…". This is outside filter controls and not changed here.
