# Unified Grid & Slicer Freedom — as built

This is a scope inside Report Studio V3 (PR #7), stacked #5 → #6 → #7. Evidence is in [`evidence/`](evidence/README.md).
The intent, spec and plan are in this folder.

## 1 · Architecture

| Piece | What it is | Where |
|---|---|---|
| **One layout** | The grid is the only authoring and presentation surface. The builder, Studio Preview, `/d`, `/embed` and the PDF export all render grid cells. | `DashboardGrid`, `PublicDashboardView` |
| **Slicer control** | A grid element, `widget_type: 'slicer'`, stored as `{slicerId, treatment, origin?}`. It can be moved, resized, locked, restyled and deleted like any element. It holds no filter state. | `GridSlicerTile.tsx`, `lib/slicer-placement.ts` |
| **Filter (semantics)** | Unchanged: `slicers_config` and `pages_config[].slicers`. They feed the same `resolveEffectiveFilterSet`, distinct cascade, public merge and diagnostics. | `lib/filters.ts`, `api/public.py` (untouched) |
| **No filter area** | A report has no filter area of its own — no strip, rail or drawer. Every filter a viewer can change (report slicers the page shows, filter-pane filters left visible, page slicers) is drawn by a control on the grid. A filter with no control on a page still filters it (scope decides that, not placement); the Slicer button counts such filters and places them. `SlicerCluster.tsx` is deleted. | `SlicerControlScope` (`GridSlicerTile.tsx`), page wiring |
| **Placement rule** | A hidden or missing slicer shows an author why and shows a viewer nothing. | `resolveSlicerControl` |
| **Staging** | A value picked in a control is staged into its entry through the same handlers as before (`DashboardFilterBar` `bare` mode); a filter-pane filter is staged into the pane's draft. One Apply bar serves all controls. | `DashboardFilterBar.tsx`, `FilterApplyBar` |
| **Entry factory** | "Slicer → new field" creates the entry and its control in one step. | `lib/slicer-entry.ts` |
| **Stored overlaps** | The public report settles a stored overlap on render (react-grid-layout moves a colliding tile below the earlier one). The builder lets a tile pass over others while dragging, which had switched that settling off, so report 75 and the Canvas probe 445 drew overlapping tiles for the author only. The builder now settles the stored layout with the library's own `compact`, and the drop rules work on those settled boxes. | `lib/grid-settle.ts`, `DashboardGrid`, `pageBoxes` |
| **Drop and band rules** | A tile dropped (or grown) onto others opens room where it lands: the tiles from the insertion row down move down by the tile's height; the insertion row is the top of what it covers, so a control never lands inside a chart row. A band that held only filter controls closes when its last control is moved out or removed. Whitespace an author left anywhere else is kept. A locked tile never moves: the gesture is refused and the locked tile is named. | `resolveDrop`, `closeVacatedBand` (`lib/grid-arrange.ts`), `handleGridGesture` |
| **Manual tools** | Arrange (align left/right/top/bottom, same width/height, distribute), Arrow/Shift+Arrow nudge, widget lock. Each fits, or is refused and names the tile in the way. Every change goes through the layout-override path, so it can be undone, saved as a draft, published or discarded. | `lib/grid-arrange.ts`, `ArrangeBar.tsx` |
| **AI** | The snapshot says where each slicer is (`placedTileId`, `visibleHere`), never its field. A redesign may add `slicerControls` and a `filter_bar` (a band of grid controls, placed by the direction's reading order). Created controls are draft-only `slicer` rows, made through the same commit path as blocks. The planner is told there is no filter bar or dock; `slicerPresentation` only sets how controls look. | `snapshot.ts`, `validator.ts`, `compiler.ts`, `executor.ts`, `directions.ts`, `dashboard_presentation_planner.py` |

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

### 3b · The slicer bar becomes grid controls (`20260929_0001`)

Why it was needed: a report saved before grid controls had its filters only in the old slicer cluster. The builder, `/d` and `/embed` drew that cluster **outside** `.react-grid-layout` for every slicer without a control — the strip with a big container, whitespace and a gear seen on report 574. It was never a grid item; nothing converted old reports.

For each report, per page, every filter the old cluster drew there gets a control (`{slicerId, treatment:'auto', origin:'migration'}`) in a band at the top of the page, four per row; the cluster's image decorations become image elements (`url`, `fit`, `alt`, `link`) in the same band. The page's tiles move down by the band — the live rows and every editor's pending draft layout, so publishing an old draft cannot put a tile back under the band. What a filter means is not touched: no field, operator, value, scope, visibility or public-link restriction changes, and a decoration never becomes a predicate. A report whose filter UI was hidden (dock `hidden`) keeps it hidden and gets no control. A filter that already had a control on a page gets no second one.

`slicer_cluster_layout.migratedToGrid` records every row created and every shift; the downgrade deletes exactly those rows and moves exactly those tiles back, and only rows of that report — a copy made after the upgrade carries its source's marker (a duplicate copies `slicer_cluster_layout`), and an unscoped downgrade would have deleted the source's controls and moved its tiles twice. It is idempotent; an image element already on the page with the decoration's URL is not added again.

The downgrade is a rollback for **before** authors use the controls: a control an author restyled is deleted with the rest (its filter is untouched and the old bar draws it again); a tile an author moved goes back by the recorded shift from where it is now, never above row 0. It runs one statement per tile inside the migration transaction — fine for this database (29 reports), to be sized before a very large one. New reports (starter, HTML import, E2E seed) get their controls from `slicer_control_service.ensure_slicer_controls`, the same rules.

On the temp Postgres it migrated 17 of 29 dashboards. Report 574 got a Region control at (0,0,8,3) and its tiles moved down 3 rows; its Channel control already existed (an author had placed it) and was not duplicated. Locked by `test_every_viewer_filter_gets_a_control_on_the_pages_that_show_it_and_the_downgrade_restores_all` (pages, custom scope, visible/locked pane filters, image with link, legacy tile, drafts, hidden dock, idempotence, exact downgrade) and by acceptance S12/U on every migrated report.

**Policy for a layout that cannot be converted exactly:** the grid cell is the nearest cell to the pixel box, and the pixels stay. Before this change a viewer already saw the grid cell, not the pixels, so what viewers see does not change.

## 4 · Slicer contract

| Act | What it changes | What it never changes |
|---|---|---|
| Move, resize, restyle a control | The tile's layout (`x,y,w,h`, `slicerTreatment`) | Dataset, field, operator, value, scope, permissions — 0 chart queries (S4, S14) |
| Clear a value | The entry's value (staged, then Apply) | The control, the scope |
| Hide on a page / stop filtering a page | The entry's scope matrix (⚙) | The control's place; an author sees it dimmed and told why |
| Remove control | Deletes the tile (one undoable step; its band closes if it was the last control there) | The filter: it keeps filtering, and the Slicer button lists it as having no control here (S3, S9, F) |
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
- **A new page** gets no controls automatically: the filters its scope shows are counted on the Slicer button and placed by the author (S5 drives this through a UI page switch).
- **Undo history** is reset by a page switch, as before (an entry is keyed to one page's layout map).
- **Guardrail signal `tile_fetch_seed_gate`** fires on this PR's range. It is a false positive: the matched lines are the removed `filtersReady` prop of the deleted `DashboardCanvas.tsx`; the gate in `ChartTile.tsx` (`filtersReady && serverFilterKey === debouncedFilterKey`) is unchanged.
- **Cross-filter and relative-date presets** go through the unchanged pipeline. No scenario exercises them *from a grid control* specifically.
- **`galaxy_golden` / `distinct_cascade_bq`** (the guardrail's named tests for the distinct cascade) need the ds113 / BigQuery fixtures and did not run. The cascade code is unchanged, and the grid control's search goes through the same resolved-set function (contract check).
- **Layering and group** are not offered: the grid forbids overlap by design, and a section header is the grouping element. Distribute is horizontal only.
- **Adding a control to the top of the page** moves the page's content down by one band, saved to the draft at once. Discard undoes it; Undo does not, because the element set changed.
- The **model's composition varies** between runs. The acceptance suite asserts properties (a control was placed, it is draft-only, the numbers are unchanged, no typed figure), not one layout.
