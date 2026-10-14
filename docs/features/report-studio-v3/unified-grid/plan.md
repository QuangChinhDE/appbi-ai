# Unified Grid & Slicer Freedom — plan

Branch `feat/report-studio-v3` (PR #7). Stacked #5 → #6 → #7, no merge, no deploy.

## Audit, before any change

Read-only, on the dev database (41 dashboards):
- **Canvas:** 0 dashboards in `canvas` mode and 0 pixel-only tiles. 337 tiles in 25 dashboards carry dormant pixel
  coordinates next to their grid coordinates.
- **Viewer surfaces:** Public, Embed and PDF never read `layout_mode` or pixels (`PublicDashboardView`, `export-pdf`
  and `public.py` were grepped). The only Canvas consumer is the builder's `DashboardCanvas`, and switching to Canvas
  was already disabled.
- **Slicers:** 16 dashboards have slicers; 26 entries (24 dropdown, 1 date, 1 number), 2 of them page slicers.
  - Every entry has a unique `id`.
  - No same-field duplicates.
  - No image entries.
  - Docks: 3 left, 4 top, 1 drawer, 8 unset.

## Steps

1. **Slicer control contract.**
   - `lib/slicer-placement.ts`: pure; decides which control renders where and never writes an entry.
   - `lib/slicer-entry.ts`: the one entry factory, which the filter bar now calls.
   - Backend normaliser for `slicer`.
   - Tests:
     - contract `check-unified-grid-contract.mjs` in `npm run qa`;
     - backend `test_slicer_control_widget.py` (allow-listed and in the workflow).
2. **GridSlicerTile.** Renders one `FilterCard` through `DashboardFilterBar` in a `bare` mode, with:
   - treatment;
   - fill-the-tile sizing;
   - a portalled value menu;
   - builder states (hidden, not applicable, missing).
3. **Builder wiring.**
   - The grid gets a `renderSlicer` render-prop.
   - The cluster shows only unplaced slicers and merges placed ones back on change.
   - Apply bar.
   - Add-element picker, remove control, delete filter.
4. **Public/Embed/PDF wiring.** The same tile, bound to the viewer's filters. The cluster excludes placed slicers.
   Responsive kind `slicer`.
5. **Canvas removal.**
   - Delete `DashboardCanvas.tsx`, `dashboard-layout-convert.ts`, the toggle and its handlers.
   - Model coercion.
   - Migration `rs3ug01`, with its test.
6. **Manual builder.** Multi-select, Arrange bar, keyboard nudge, widget lock.
7. **AI.** Snapshot `placedTileId`, `slicerControls` + `filter_bar`, validator, compiler height, executor and prompt.
8. **Verification.**
   - Production image in its own container.
   - Playwright acceptance S1–S15 (`e2e/acceptance/unified-grid.spec.ts`) with the real model.
   - V3 S1–S8 regression.
   - Evidence pack, as-built, push, CI.

## Risks

- **Pending-filter UX:** with controls spread over the page, Apply must stay findable. One sticky Apply bar is used,
  not one per control.
- **Legacy cluster merge:** `handleSlicerChildrenChange` rebuilds page slicers from what the cluster reports. The
  cluster no longer sees placed slicers, so they are merged back before that call, or they would be deleted.
- **Draft-only controls:** they are real rows, so Discard deletes them, which is what we want. A published control a
  person deletes is deleted immediately, like any tile today (existing behaviour, unchanged).
