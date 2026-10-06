# Responsive dashboard layouts — Desktop, Tablet, Phone

The contract for how a report is laid out on each device, in the Builder and on
every viewer surface (`/d`, stable `/embed`, integration `emb_`). The code is the
authority; this file describes it and is a bug where they disagree.

| Concern | Code |
|---|---|
| The ONE resolver (breakpoint, AUTO generators, CUSTOM, reconciliation) | `frontend/src/lib/responsive-layout/resolve.ts` |
| AUTO generators it calls | `frontend/src/lib/dashboard-pages.ts` (`deriveTabletLayout`, `deriveStackedLayout`), `frontend/src/lib/responsive-fit.ts` |
| Server validation, publish, prune, copy, public projection | `backend/app/services/responsive_layouts.py` |
| Draft / publish endpoints | `backend/app/api/dashboards.py` (`PUT /draft-responsive`, `POST /publish`, `POST /discard-draft`) |
| Storage | `dashboards.responsive_layouts` (JSONB, migration `20261006_0001`) |
| Contract checks | `frontend/scripts/check-responsive-layout-contract.mjs`, `backend/tests/test_dashboard_responsive_layouts*.py`, `e2e/tests/public-closure-responsive.spec.ts` |

## 1. Model

- **Desktop is canonical.** Its geometry is the authored layout in
  `DashboardChart.layout` (36-column grid). Nothing here duplicates it.
- **Tablet (`md`) and Phone (`xs`)**, per page, are each:
  - **AUTO** (default): derived from desktop at render time, never stored —
    exactly the published behaviour before this feature;
  - **CUSTOM**: a complete layout of that page at that breakpoint, authored in
    the Builder, stored, and drawn as stored.
- CUSTOM is page-level. There are no per-tile overrides: the page profile is
  the authority for every tile on the page (tiles it does not place are
  reconciled, §6).

## 2. Breakpoints and preview widths

Runtime selection is by the **measured report/grid container width** — never
the user agent, never `window.innerWidth` (an embed's iframe width is what
counts):

| Container width | Breakpoint |
|---|---|
| `>= 1024` (or unmeasured) | Desktop (`lg`) |
| `640 – 1023` | Tablet (`md`) |
| `< 640` | Phone (`xs`) |

Representative widths used by the Builder device switcher and Studio preview:
Desktop 1440, Tablet 820, Phone 390. They are presets inside the bands, not the
boundaries.

One width authority per rendered report: each surface has ONE ResizeObserver on
its report container (rounded to whole pixels); that value decides the
breakpoint, feeds the resolver, and sizes the grid. The grid
(`react-grid-layout` `GridLayout`, `compactType=null`; `preventCollision` on
every read-only view) renders the resolved geometry at that width — it never
picks a breakpoint, measures its own width or reflows. A hidden container
(width 0) keeps the last real width: the grid never unmounts for it.

The Builder's **Desktop** authoring canvas draws the authored grid at any width
`>= 640` (an author may edit desktop in a narrow window); below that it shows
the phone resolution, read-only. Its **Tablet / Phone** modes render the canvas
at 820 / 390 px, so the resolver resolves those breakpoints from a real width.

## 3. Storage

```json
{
  "version": 1,
  "pages": {
    "page-1": {
      "md": {
        "mode": "custom",
        "cols": 36,
        "rev": 3,
        "generatorVersion": 1,
        "baseFingerprint": "fnv1a64:<16 hex>",
        "source": "auto-freeze",
        "updatedAt": "2026-10-06T10:00:00+00:00",
        "updatedBy": "<user uuid>",
        "items": { "412": { "x": 0, "y": 0, "w": 18, "h": 6 } }
      }
    }
  }
}
```

- `NULL` (or a missing page / breakpoint) = AUTO. No backfill: existing reports
  render exactly as before.
- Both CUSTOM breakpoints are stored in **36 columns** (the phone AUTO stack is
  2-column; freezing multiplies `x`/`w` by 18 — exact).
- `items` are keyed by **tile id** (`dashboard_charts.id`), never `chart_id`: a
  chart placed twice is two tiles.
- `version` = shape of this document. `generatorVersion` = the AUTO generator a
  CUSTOM layout was frozen with; stored coordinates are never reinterpreted when
  the generators change (only AUTO output follows the current generator).
- `baseFingerprint` = FNV-1a 64 of the page's desktop tiles + cells when frozen.
- `rev` = published revision of that page/breakpoint (Publish's conflict check).

Server validation (the authority; FE checks are a convenience) refuses with 400:
unsupported breakpoint or page; unknown keys; `cols != 36`; non-integer (or
boolean) cells; negative position; size `< 1`; `x + w > 36`; overlapping cells;
a tile not of this dashboard; a tile not on the requested page (as the author's
draft sees it — a tile moved in the draft is on its new page); another
author's draft-only tile; an empty/incomplete profile; a malformed reset marker.
Nothing is normalised: a payload FE and BE would draw differently is refused.

## 4. Draft / Publish / Discard

- Authors edit a per-author draft:
  `draft_snapshot.user_responsive_layouts[userId][pageId][md|xs]` = CUSTOM
  profile | `{"mode": "auto"}` (reset marker), and
  `draft_snapshot.user_responsive_base_rev[userId]["pageId:bp"]` = the published
  `rev` the author started from (recorded on their first save of that key).
- `PUT /dashboards/{id}/draft-responsive` writes ONE page/breakpoint, under the
  dashboard row lock. It never writes live state. Builder edits are local until
  Save draft / page switch / Publish staging (one request per changed
  page/breakpoint — never per tile, never per drag).
- Editor responses carry `responsive_layouts` (published) and
  `draft_responsive_layouts` (the caller's draft); `has_draft` counts it.
  Public responses carry only the viewer projection of the published document.
- `POST /publish`, in the same transaction as the rest of the report:
  1. for every page/breakpoint the caller drafted, published `rev` must equal the
     draft's base rev, else **409** `{code: "responsive_conflict", responsive:
     ["page-1:md", …]}` (the Builder's conflict dialog; overwrite = `force`);
  2. CUSTOM draft → replaces that page/breakpoint, `rev + 1`; reset marker →
     removes it (AUTO again);
  3. prune: profiles of deleted pages; items of tiles no longer published on
     their page; a profile left empty is AUTO;
  4. the caller's responsive draft is cleared, other authors' drafts kept; the
     public metadata cache is invalidated (`/d`, `/embed`, `emb_` see it on the
     next request).
- `POST /discard-draft` drops the caller's responsive draft; published profiles
  are unchanged.

## 5. Resolution

`resolveReportLayout({tiles, absentIds, profiles, containerWidth, gap,
measuredRows})` → `{breakpoint, cols, layout, source, orphans, dropped, stale,
desktopFingerprint, fitsContent}`. Pure: no DOM, network or React state.

- **Desktop**: the authored layout (public size defaults 4×4), absent controls'
  bands closed.
- **Tablet AUTO**: `deriveTabletLayout` (reference width = container width in
  the band, else 820) then `fitLayoutToContent(…, 'grow')`.
- **Phone AUTO**: `deriveStackedLayout` (2 columns, reading order, report row
  pitch) then `fitLayoutToContent(…, 'stack')`.
- **CUSTOM**: the stored cells, 36 columns, **no content fit**; reconciled (§6).

AUTO output equals the old published pipeline byte for byte — locked by golden
vectors captured before this feature (`frontend/scripts/fixtures/
responsive-auto-vectors.json`: 140 vectors at 1440/1024/1023/820/640/639/390,
two gaps, with and without measured content).

Callers: `DashboardGrid` (Builder desktop canvas, Builder device modes, Studio
preview frames) and `PublicDashboardView` (`/d`, stable `/embed`, `emb_`). No
other component derives a device layout.

## 6. Reconciliation (CUSTOM meets a changed tile set)

Deterministic, identical on every surface:

- **Tile no longer on the page** (deleted, moved to another page, swapped —
  a swap creates a new tile id): its item is ignored and reported as `dropped`.
  Nothing reflows; the gap stays. Publish prunes the item.
- **Published tile the layout does not place** (added, moved here, AI block
  published, swap replacement): never omitted. The breakpoint's generator lays
  the missing tiles out in reading order and they are placed BELOW the layout's
  bottom (`orphans`); existing cells never move; nothing overlaps.
- The Builder reports **Needs review — N new elements** with **Add below**
  (writes the drawn positions into the draft), manual placement (drag), or
  **Regenerate from Desktop**. Publish is not blocked: tile sets also change
  through other authors' publishes, so the render rule is the guarantee.
- A control absent for a viewer (public link filters) closes its band, in
  desktop and CUSTOM layouts alike (`withoutAbsentControls`).

## 7. Desktop changes after customising

- AUTO devices follow desktop automatically.
- CUSTOM devices keep their geometry exactly. When the current desktop
  fingerprint differs from `baseFingerprint`, the Builder shows **Desktop
  changed since this layout was created**. Desktop geometry is never merged in.
- **Regenerate from Desktop** freezes the current desktop's AUTO layout (the
  generator's geometry; use **Fit heights to content** to fit text) as a new
  CUSTOM draft. **Reset to Auto** drafts the reset marker.

## 8. Content fit

- AUTO: unchanged — headers, text, narrative, callouts and KPI cards are
  measured at the container width; tablet only grows, phone repacks; a tile's
  first measure may shrink it, later ones only grow it.
- CUSTOM: **no runtime geometry fit** — no measurement runs, `fitLayoutToContent`
  is not called. Readability comes from drag/resize minimums (per tile kind, from
  `RESPONSIVE_MIN_WIDTH_PX` / `STACK_MIN_HEIGHT_PX`), server validation, the
  diagnostics, and the explicit **Fit heights to content** action (measures once,
  writes the grown cells into the draft). Content may adapt inside a tile; it
  never changes the tile's cell.
- A tile header is one line high whatever its badges: a title keeps at least
  ~7rem and a status badge ("As of 08:01") truncates beside it. Wrapping the
  badge under the title was rejected — the header height (and an AUTO layout
  fitted to it) would then change with the age of the result cache.

## 9. Builder

- Device switcher **Desktop | Tablet | Phone**; Tablet/Phone render the canvas at
  820 / 390 px of REPORT width. (The Studio preview frames a whole 820 / 390 px
  device, so its report is that width minus the page gutter — same band, same
  CUSTOM cells; an AUTO layout may differ by its content fit.)
- AUTO: badge **Auto from Desktop**, read-only, nothing persisted by viewing;
  **Customize layout** freezes exactly what is shown (content fit included) —
  no jump — and enables drag/resize. A device drop follows the desktop rule
  (`lib/grid-arrange` `resolveDrop`): a tile may be carried over others and the
  layout opens room where it lands — the tiles that make room move down, as one
  change; nothing ever overlaps. A drop that cannot be placed (a locked tile in
  the way) returns the tile. (Until 2026-10 a drop on an occupied cell was
  refused, so a packed tablet could not be reordered.)
- CUSTOM: badge **Custom layout**; **Reset to Auto**, **Regenerate from
  Desktop**, **Fit heights to content**, **Add below** (when needed); stale and
  needs-review notes.
- Desktop arrange tools / keyboard nudge act on desktop only and are off on a
  device canvas. Undo/redo records device edits as their own entries (undo
  switches to that device). Save draft, page switch (flush) and Publish stage
  device drafts with the rest; Discard drops them.
- Studio preview is **read-only verification** of the same resolver and of the
  author's unsaved device layouts: its API client refuses every write
  (`isStudioPreviewWrite`), it takes no edit lock and wires no layout callback.

## 10. AI design

AI presentation designs desktop only. AUTO devices follow the new desktop.
CUSTOM device layouts are never written by AI: they may become stale, and
AI-created draft blocks appear as orphans (needs review). AI Discard removes the
draft blocks; their orphan status goes with them. No automatic AI responsive
design.

## 11. Data independence

Device layouts are presentation geometry only. They never change chart queries,
filters, page scope, link locks, parameters, what-if, drill, cross-filter or
distinct values. The device mode is not part of any query or cache identity;
switching device on a loaded report issues no chart-data request (a tile that
first becomes visible may fetch once, as lazy loading always did).

## 12. Intentional differences

- PDF / print export uses the desktop layout (print bands), whatever the worker
  viewport or the device layouts.
- The Builder desktop canvas keeps the authored grid down to 640 px (§2).
- The public view hides controls a viewer does not have (absent controls); the
  Builder shows every control.

## 13. Performance invariants

- The resolver runs once per page render state (memoised on its inputs), not per
  tile; reconciliation uses id maps. Measured: ~0.7 ms / 2.3 ms / 3.5 ms for 50 /
  200 / 500 tiles (tablet AUTO + phone AUTO + tablet CUSTOM with 10% orphans),
  reported by the contract script.
- CUSTOM skips content measurement entirely.
- Drag/resize updates local state only; persistence is one request per changed
  page/breakpoint on Save / page switch / Publish.
- One width observer per report surface; sub-pixel changes ignored.
