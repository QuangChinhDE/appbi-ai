# Dashboard Builder UX simplification — spec

Each decision answers: does a person need it in view now? If not, why was it there? Does
moving it make it harder to find? Does it remove complexity or only move it?

## Ownership of tools

| Level | Where it lives |
|---|---|
| Dashboard | Header: name, page, save state, Save draft / Save & publish / Discard, Filters, More, Preview ▾, AI Design, + Add, Inspector |
| Page | Page menu in the header (unchanged) |
| One chart | The chart's own tools (filter, ⋯ menu); Frame and geometry in the Inspector |
| Many charts | Arrange bar: count · Arrange ▾ · Frame ▾ · ✕ |
| Device view | Device bar, only while Tablet/Phone is shown |
| Advanced/rare | More menu (export, share, public links, theme, tidy, manage, import) |

## Decisions

**Preview ▾ (replaces the Preview button and the permanent device bar).** Contents: Full
report preview (Studio) · Desktop · Tablet · Phone. The trigger shows the active device
(icon, label at wide widths, tonal when not Desktop). Device work is occasional and
deliberate; a permanent bar spent a toolbar layer on every visit. It stays one click
from the header, in the same place the old Preview button was, so nothing becomes harder
to find. Below `sm` the same items are in More (the row has no room).

**Device bar is contextual.** Rendered only when Tablet/Phone is shown, tinted so the
mode is unmistakable, with Desktop · Tablet · Phone, AUTO/CUSTOM status and its actions
(Customize, Fit heights, Regenerate, Reset, Add below). Desktop on the bar is the way
back; no separate "exit" button (it would duplicate Desktop).

**Arrange bar for 2+ only.** Arranging needs two tiles; Frame for one chart is already in
the Inspector. Align/match/distribute (7) and Frame (3) each sit behind one menu: 11
controls → 4. Keyboard nudge, Undo/Redo and the layout-override path are unchanged.
Escape closes a menu without clearing the selection; Distribute says why it is disabled.

**Chart tools.** Removed: the hover ✕ (destructive, appeared on every pass of the mouse)
and the inline Explore icon (duplicate of the menu item). Remove is the last, danger
item of the ⋯ menu and still opens the confirmation. The remaining tools (filter, ⋯) are
24px, named, and visible on hover, while the tile is selected, on keyboard focus, and
always on touch screens (`@media (hover: none)`).

**AI Design is one toggle** (`aria-pressed`, tonal when on) instead of Manual|AI. It is
an on/off mode; one control says which mode the screen is in. Leaving it still drops an
unapplied design.

**Slicer button removed from the header.** Slicer is in the Add palette; More keeps the
entry because it carries the unplaced-filter count.

**Chart selection by click.** A still press on any tile (charts included) selects it via
the grid's `onDragStop` — the rule widgets already used — with a 400ms per-tile dedupe so
a Shift-click that also reaches the tile's own click does not toggle twice. Clicks on a
chart's marks remain data interactions (cross-filter); the resize edge does not select.

## Unchanged by design

Data schema, API, layout/arrange algorithms, responsive resolver, AUTO/CUSTOM semantics,
Save draft/Publish/Discard flow, conflict dialog, Studio, exports, public and embed.
