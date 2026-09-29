# Unified Grid & Slicer Freedom — spec

> **Superseded in part.** This spec was written when a legacy filter bar still drew unplaced slicers. There is no filter
> area any more: every filter a viewer can change is a control on the grid (migration `20260929_0001`), and a filter
> with no control on a page still filters it and is listed on the Slicer button. The lines below are updated to that;
> the lifecycle (draft additions, removals and widget edits) is in [`product-review.md`](product-review.md) §3 and §6.

## Behaviour

### A slicer on the grid

1. In the builder, **Add element → Slicer** opens a picker with two lists:
   - **Place a filter already on this report.** These are the report's slicers not yet placed on this page.
   - **New filter.** A field picker: columns a chart on the report can apply, plus dates.
2. Choosing one creates a **slicer control** at the top of the page, below the content, or — with an element
   selected — next to that element. It is draft only until Publish, like every addition.
3. A new filter is created with `createSlicerEntry` (`scope: 'page'`). It is
   saved to the draft immediately, so a reload never leaves a control pointing at nothing.
4. The control can be dragged, resized, locked, nudged, aligned and deleted like any element. Its presentation menu
   offers:
   - **Treatment:**
     - *Auto* — a list when the tile is tall enough, otherwise a compact card.
     - *Dropdown*
     - *List*
     - *Buttons* — a segmented control when the values fit, otherwise a dropdown.
     - *Compact*
   - **Remove control.** The filter stays and keeps filtering; the Slicer button lists it as having no control here.
     A draft removal: the public link keeps the control until Publish; Undo and Discard bring it back.
   - **Delete filter.** The logical filter and every control for it go, after a confirmation, in one draft change.
5. Values chosen in a control are **staged**. One **Apply** bar is shown while something is pending, and the choice
   applies on Apply.

### What decides where a control appears (one rule, builder and public)

For page P and slicer S:

| S's scope on P | Control for S on P's grid | Rendered |
|---|---|---|
| visible | yes | the grid control(s) |
| visible | no | no control; S still filters P. Builder: counted on the Slicer button. Public: stated in "Filtered by" when it has a value |
| filter-only (visible=false) | yes | builder: control dimmed, "Hidden on this page — still filters". Public: no cell (its band closes); the value is stated in "Filtered by" |
| not applicable here | yes | builder: dimmed, "Does not filter this page". Public: no cell |
| S missing (deleted, or stripped by a link lock/hide) | yes | builder: "This filter was removed" + Remove control. Public: no cell; a link lock is stated as "🔒 field: value", a hide is never shown |

Placement never changes whether S filters P. That is S's scope, set in the same ⚙ scope matrix as before.


### Filter semantics — unchanged

The same entries as before feed `resolveEffectiveFilterSet`, the distinct cascade, cross-filter, relative-date
resolution, the public link merge and the diagnostics:
- `slicers_config`,
- `pages_config[].slicers`,
- the viewer's staged/applied filters on public.

A control holds only `{slicerId, treatment}`. The backend normaliser drops every other key, so a control can never
carry a predicate.

Moving, resizing or restyling a control changes only its row's layout or `widget_config`. No chart query key changes,
so no chart data is re-requested.

### Same field, several places

- One slicer placed several times is one filter with several synchronised controls.
- Two slicers on the same field at the same level are prevented at creation, as before: the picker excludes used
  fields.
- A page slicer on a field that also has a report slicer keeps the documented precedence: the page wins, in both the
  builder and public.

### Canvas

- There is no Canvas mode. The builder always renders the grid, and the "Switch to Grid/Canvas" item is gone.
- Every writer of `dashboards.layout_mode` stores `grid`, whether it is the API, MCP, HTML import or restore. A
  `canvas` value is coerced at the model.
- A tile that arrives with pixel coordinates only gets grid coordinates derived from its pixels. This is the inverse of
  the old conversion.
- Existing rows are migrated by `alembic` (see Data). No viewer surface ever read Canvas pixels, so what a viewer sees
  does not change.

### Manual builder

- Selection: Shift+click adds to the selection, and Esc clears it.
- With two or more tiles selected, an **Arrange** bar offers:
  - align left, right, top or bottom;
  - match width or height;
  - distribute horizontally.

  An arrangement that would overlap an unselected tile is refused and says which one. Locked tiles never move.
- Arrow keys nudge the selection by one column or row; Shift+Arrow nudges by four. Collisions and locks are respected.
- Each widget has a lock toggle, as charts already do.
- Every one of these goes through the same layout-override path, so Save, Discard, Undo and Redo cover them.

### AI Design

- The snapshot tells the model, for each slicer, whether it is placed on this page (`placedTileId`) and gives its
  label. The field is not sent.
- A redesign or structure plan may:
  - place existing slicer tiles like any visual;
  - ask for a new control for a report slicer: `slicerControls: [{id, slicer, treatment}]`;
  - use the `filter_bar` primitive, a row of controls.
- The validator keeps a control only when:
  - its slicer is on the report and visible on this page, and
  - it is not already placed there.
- Style-only plans make no controls.
- The executor creates controls as draft-only `slicer` widgets through the same path as blocks, so Undo, Discard and
  Publish treat them the same.

## Data

- No schema change: `dashboard_charts.widget_type` is free text, and `widget_config` is JSON.
- **Migration `rs3ug01`** is data-only and reversible:
  - For each dashboard with `layout_mode='canvas'`: set it to `grid` and record
    `canvas_config.migratedFromCanvas = {tiles, derived}`.
  - For each of its tiles with pixel coordinates but no grid coordinates: derive x/y/w/h. Pixels are kept.
  - Downgrade restores `layout_mode='canvas'` where the marker is present.

## API

No endpoint is added.
- `POST /dashboards/{id}/widgets` and `PUT .../widgets/{wid}` accept `widget_type: 'slicer'`, with `widget_config`
  normalised to `{slicerId, treatment, origin?}`.
- The public payload already carries widgets.
- A draft-only control is excluded from public until Publish, by the existing `is_draft_only_item`.

## UI

Builder, Studio Preview, `/d`, `/embed` and PDF export all render controls through `GridSlicerTile`:
- In the builder and Studio Preview it is bound to the draft slicer state.
- On `/d` and `/embed` it is bound to the viewer's filters (`publicClient` only).

On a phone:
- a control's stack height floor is 56px;
- two controls in a row stay 2-up;
- the value menu is portalled, clamped to the viewport, and flips above when there is no room below.
