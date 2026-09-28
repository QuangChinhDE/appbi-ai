# Unified Grid & Slicer Freedom — as built

This is a scope inside Report Studio V3 (PR #7), stacked #5 → #6 → #7. Evidence is in [`evidence/`](evidence/README.md).
The intent, spec and plan are in this folder.

## 1 · Architecture

| Piece | What it is | Where |
|---|---|---|
| **One layout** | The grid is the only authoring and presentation surface. The builder, Studio Preview, `/d`, `/embed` and the PDF export all render grid cells. | `DashboardGrid`, `PublicDashboardView` |
| **Slicer control** | A grid element, `widget_type: 'slicer'`, stored as `{slicerId, treatment, origin?}`. It can be moved, resized, locked, restyled and deleted like any element. It holds no filter state. | `GridSlicerTile.tsx`, `lib/slicer-placement.ts` |
| **Filter (semantics)** | Unchanged: `slicers_config` and `pages_config[].slicers`. They feed the same `resolveEffectiveFilterSet`, distinct cascade, public merge and diagnostics. | `lib/filters.ts`, `api/public.py` (untouched) |
| **Placement rule** | One pure function per page: a visible slicer is drawn by its control(s) or by the filter bar, never both and never neither. A hidden or missing slicer shows an author why and shows a viewer nothing. | `partitionSlicerControls`, `resolveSlicerControl` |
| **Filter bar** | Now optional grouping: the legacy cluster, showing only the slicers that are not placed on the page. When it has nothing to show it is not drawn. | `SlicerCluster` (unchanged), page wiring |
| **Staging** | A value picked in a control is staged into the same entry the bar stages, through the same handlers (`DashboardFilterBar` `bare` mode). One Apply bar serves all controls. | `DashboardFilterBar.tsx`, `FilterApplyBar` |
| **Entry factory** | The bar's "Add slicer" and the grid's "Add element → Slicer" create the same entry. | `lib/slicer-entry.ts` |
| **Manual tools** | Arrange (align left/right/top/bottom, same width/height, distribute), Arrow/Shift+Arrow nudge, widget lock. Each fits, or is refused and names the tile in the way. Every change goes through the layout-override path, so it can be undone, saved as a draft, published or discarded. | `lib/grid-arrange.ts`, `ArrangeBar.tsx` |
| **AI** | The snapshot says where each slicer is (`placedTileId`, `visibleHere`), never its field. A redesign may add `slicerControls` and a `filter_bar`. Created controls are draft-only `slicer` rows, made through the same commit path as blocks. | `snapshot.ts`, `validator.ts`, `compiler.ts`, `executor.ts`, `dashboard_presentation_planner.py` |

## 2 · Legacy Canvas paths kept, and why

| Kept | Why |
|---|---|
| `dashboards.layout_mode`, `dashboards.canvas_config` columns | Old rows, old clients and the downgrade. Every write stores `grid` (model `@validates`). |
| `xPx/yPx/wPx/hPx/z` inside tile layouts | Dormant: 337 tiles in 25 dev dashboards carry them next to their grid cell, and they are never rendered. They are the rollback data. |
| `DashboardLayoutMode`, `DashboardCanvasConfig` TS types | The API still returns the fields. |
| HTML import accepting `layout_mode: 'canvas'` in a plan | It is coerced at the model. A pixel-only tile gets a grid cell (`ensure_grid_cell`). |

Removed, after proving no consumers (grep, plus an audit showing no viewer surface read pixels):
- `DashboardCanvas.tsx` (675 lines);
- `lib/dashboard-layout-convert.ts`;
- the Grid/Canvas toggle and its handlers;
- 16 Canvas i18n keys.

## 3 · Migration

`20260928_0001_canvas_to_grid` is data only and idempotent:
- `canvas` rows become `grid`, including a pending draft;
- pixel-only tiles get the cell their box occupied, and their pixels are kept;
- a `canvas_config.migratedFromCanvas` marker lists the tiles whose cells were derived.

The downgrade restores exactly those tiles and the mode. It was run upgrade → downgrade → upgrade on the temp Postgres, and it is locked by `backend/tests/test_unified_grid_contract.py` on a real SQLite database. The dev database had 0 Canvas dashboards. The migrated probe row opens on the grid with no overlap (S12).

**Policy for a layout that cannot be converted exactly:** the grid cell is the nearest cell to the pixel box, and the pixels stay. Before this change a viewer already saw the grid cell, not the pixels, so what viewers see does not change.

## 4 · Slicer contract

| Act | What it changes | What it never changes |
|---|---|---|
| Move, resize, restyle a control | The tile's layout (`x,y,w,h`, `slicerTreatment`) | Dataset, field, operator, value, scope, permissions — 0 chart queries (S4, S14) |
| Clear a value | The entry's value (staged, then Apply) | The control, the scope |
| Hide on a page / stop filtering a page | The entry's scope matrix (⚙) | The control's place; an author sees it dimmed and told why |
| Remove control | Deletes the tile | The filter: it returns to the filter bar (S9, F) |
| Delete filter | Deletes the entry and every control for it, after a confirmation | — (F) |

The backend normaliser rebuilds a control's config from an allow-list, so a control can never carry a predicate.

Two rules keep controls safe on a public link:
- A field the link locks or hides is stripped by the server from `slicers_config`, so its control resolves to "missing" and a viewer sees nothing (S6).
- A viewer's controls are bound only to the viewer's own seed.

Visual-level targeting ("this control filters only that chart") is not offered, because the pipeline does not support it end to end. Placement never implies targeting.

## 5–13 · Evidence

See [`evidence/README.md`](evidence/README.md) for:
- manual and AI screenshots;
- the selected-charts → AI → manual-edit path;
- the filter parity matrix;
- Public, Embed and PDF parity;
- responsive views;
- performance;
- the Playwright results;
- the V3 regression.

## 14 · Limitations

- **Date preset labels** in the slicer card are hard-coded Vietnamese ("Tháng này"). This is older i18n debt in `DATE_PRESET_LABELS`, not changed here.
- **Treatment of a published control** is a layout key, so it is published with the draft. A control deleted from a published report is deleted immediately, like any tile today.
- **Page switch with a placed global slicer** is verified by fixture and rendering (S5, page 1), not by a UI page switch.
- **Cross-filter and relative-date presets** go through the unchanged pipeline. No scenario exercises them *from a grid control* specifically.
- **`galaxy_golden` / `distinct_cascade_bq`** (the guardrail's named tests for the distinct cascade) need the ds113 / BigQuery fixtures and did not run. The cascade code is unchanged, and the grid control's search goes through the same resolved-set function (contract check).
- **Layering and group** are not offered: the grid forbids overlap by design, and a section header is the grouping element. Distribute is horizontal only.
- **Adding a control to the top of the page** moves the page's content down by one band, saved to the draft at once. Discard undoes it; Undo does not, because the element set changed.
- The **model's composition varies** between runs. The acceptance suite asserts properties (a control was placed, it is draft-only, the numbers are unchanged, no typed figure), not one layout.
