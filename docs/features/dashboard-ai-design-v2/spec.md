# Dashboard AI Design v2 — spec (the contract, and where it is enforced)

## Permission layers — `lib/dashboard-presentation/intent.ts`

| Layer | Granted when the words… | May write |
|---|---|---|
| `style` (default) | say nothing about arrangement, or say "keep the layout" | theme, `tileStyles`, slicer look (variant/style). **No coordinate, no filter dock.** |
| `structure` | name a specific move ("KPIs on top", "make X bigger", "filters left") | `structure.operations` on the named visuals; others step aside only as far as needed |
| `redesign` | hand over the page ("redesign", "rearrange", "thiết kế lại") | `sections` recomposition |

- The layer is inferred on the client, deterministically. The model may answer
  with a lower layer, never a higher one (`clampLayer`, enforced in `coerceModelPlan`).
- The validator refuses a mutation that exceeds its layer
  (`layer.styleGeometry`, `layer.slicerDock`, `layer.themeStructure`, `layer.sections`,
  `layer.operations`). This is measured on each tile's final rectangle.

## Locks

`layout.locked` is fixed on every write path:

- the grid (`static`)
- structure operations (`structure.ts`: fixed set)
- redesign (`compiler fixed`, plus `avoidFixed`)
- template re-arrange (goes through the same executor)
- tidy and compact-up (`tidyPageLayout` / `compactPageUp`)

The validator refuses moving a locked tile (`lock.geometry`) and refuses AI writing
the lock itself (`lock.write`). The lock toggle is now a draft edit (undoable, saved
and published with the layout) instead of a live write that a stale draft could
revert.

## Selection

- Click selects one visual; Shift, Ctrl or ⌘ + click adds or removes one. The
  selection is the scope of the next request.
- Under a selection, only the selected visuals change. The report theme and the
  slicer are dropped, with a note.
- The validator refuses changes outside the selection (`scope.outside`, `scope.theme`).

## Design Context — `design-context.ts`, `snapshot.ts`

Per visual, the planner receives:

- title, type and aspect
- reading order, position and lock state
- measures and dimensions as **labels** (semantic model label → humanised field
  name), with format and description
- whether the visual is temporal
- chart description or metadata `auto_description`, and metadata `intent`
- benchmark present, and good direction
- current allow-listed style

No SQL, dataset ids or rows are sent. Role inference reads meaning first
(temporal/intent) and geometry only as a tie-breaker.

## Design grammar

- `tileFrame`: `card | subtle | flush`, resolved by `tile-frame.ts` for **both**
  the builder tile and the published tile.
- Section bands are drawn by the shared `SectionBands` component on the builder
  and the public report.
- Every enumerable style key has a closed value domain (`STYLE_VALUE_DOMAINS`).
  An unrenderable value is dropped with a note.

Removed from the AI contract because they were no-ops:

- `decorativeElements`
- `span` / `allowedSpans`
- the `section_break` title
- the page/report scope selector

`emphasis` now really scales height.

## Preview / apply

- A preview is an overlay and is never persisted.
- A follow-up request composes onto the unapplied preview
  (`composeMutations` + `validateMutationAgainst`).
- Apply writes `localLayoutOverrides` and creates one undo entry.
- The preview is dropped on a page change or a selection change.
- Tile-level live toggles now write from the persisted layout, never from the
  preview or from unsaved drags.

## Post-render pass — `critic.ts` + `render-audit.ts`

After the preview paints, a DOM audit runs. It checks clipping, sub-readable size,
content overflow, overlap, running off the canvas, and title contrast. It then
makes at most three bounded repairs, always inside the preview's own layer and
re-validated through the same gate. It has no model call and no loop, and a failure
keeps the original preview. A vision-model critic can use the same findings and
repair contract later.

## Responsive — `dashboard-pages.ts`

- Desktop is authored. Tablet (`deriveTabletLayout`) changes nothing unless a tile
  would render below its readable width. Phone (`deriveStackedLayout`) is a stack in
  reading order with a height floor per tile kind.
- The public view and the builder's narrow projection use the same functions.

## Hardening round (review of PR #5)

### Presentation lifecycle: one draft, one publish

- **Draft, not live.** A theme change (AI Apply, the theme menu, or undo) is an unsaved edit, exactly like a drag. It never writes the live `theme_config`.
- **Save draft** stages three things into `draft_snapshot`:
  - layout, via `draft-layout`;
  - theme, via `draft-filters.theme_config`;
  - slicer cluster, flushed immediately rather than after the 500 ms debounce.

  If any of the three fails, the user is told so, and nothing is reported as saved.
- **Publish** runs only when every part has been staged. The server then applies tiles, theme, filters and slicers in **one transaction**:
  - a 409 conflict applies nothing and keeps the draft;
  - Discard drops the staged theme too.
- **Editor view.** The editor's GET overlays the staged theme, so a reload shows the draft. `/d` and `/embed` read only the live row.
- **Public cache.** `/d` and `/embed` serve a structure cached per token (60 s TTL). Publish now clears that cache (`query_cache.invalidate_all_public_meta`), so the published presentation is visible on the viewer's next load.
- **Preview == Apply.**
  - The preview shows the whole theme patch, filter dock and slicer variant included; previously the dock was held back until Apply.
  - A follow-up turn replaces a tile's style rather than merging it back, so a key removed by turn 2 does not come back from turn 1.
  - A follow-up turn plans against the previewed theme.

### Intent: fail safe

- A bare noun ("layout", "bố cục") grants nothing.
- STRUCTURE needs a move or size verb **and** something to move: a KPI, a chart, the filters, or "this / it" when visuals are selected.
- REDESIGN needs an explicit rebuild ("redesign", "change the whole layout", "đổi bố cục") or an explicit rearrange ("rearrange", "sắp xếp lại").
- Negations ("don't move", "no need to rearrange", "không cần sắp xếp", "chỉ đổi màu") beat everything.
- A move that a lock makes impossible is reported in the change notes, not claimed.

### What the quality gate measures, and what it does not

- **The DOM render audit measures:** title clipping, content overflow, sub-readable tile size, tile overlap, off-canvas tiles, and title contrast against its computed surface.
- **The e2e gate measures:**
  - rendered geometry relative to the grid;
  - frame, surface and theme attributes;
  - builder vs `/d` vs `/embed` frame, surface, title typography and reading order;
  - no sideways scroll at 1440, 820 and 390 px.
- **It does NOT measure aesthetic quality** (hierarchy, balance, "looks premium"). That would need a vision critic, which is deferred; see `plan.md`.
