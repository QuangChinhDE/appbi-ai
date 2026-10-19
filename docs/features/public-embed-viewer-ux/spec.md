# Public Dashboard & Embed Viewer UX hardening — spec

## Options compared for wide screens

| Option | Verdict |
|---|---|
| Fill the container (today) | Rejected: fixed row height ⇒ 13 : 1 tiles at 3440, masthead pulled to the edges. |
| Scale row height with width ("fit to width") | Rejected: a viewer-only row height gives a different geometry than the Builder at the same container width (breaks the parity rule); text does not scale with it. |
| CSS `transform: scale()` of the whole report | Rejected by the brief: blurs text, breaks hit-testing, popovers and tooltips. |
| **Centred report frame with a readable maximum** | **Chosen.** Geometry still comes from the measured canvas width through the one resolver, so equal widths keep resolving equally everywhere; nothing stored changes; a 1440 laptop is untouched. |

## Decisions

**`REPORT_FRAME_MAX_WIDTH = 1600`** (`lib/dashboard-pages.ts`), applied to the masthead and
the canvas wrapper of `PublicDashboardView` (shared by `/d`, `/embed`, `emb_`). 1600 keeps
the widest tile at ≈ 6.3 : 1 (the Builder at 1440 draws 5.4 : 1) and covers the canvas
an author sees on a 1440–1680 screen. Below 1600 nothing changes. PDF pages render at
≤ ≈ 1 550 px (A3 landscape), so exports are unaffected. Both frames carry
`data-report-frame` for tests.

**Embed height = the report's own box.** `useParentResize(enabled, rootRef)` measures
`<main>`'s bottom edge (or, before the report exists, the lowest non-fixed body child),
which does not depend on the iframe height — honouring a message cannot trigger another.
Equal heights are never re-sent; bursts (the grid animates a relayout over ~300 ms) are
coalesced: trailing 150 ms, never held more than 600 ms. Message shape and target are
unchanged (`{ type: 'appbi:resize', height }`, `'*'`), so existing hosts keep working.

**Transient status is an overlay.** Opening a page / charts loading is a pill over the
canvas' top-right corner (`role=status`, `aria-live=polite`, `data-export-hide`), not a
masthead row. Lasting states (cross-filter, load error) stay in the masthead flow.

**Table header floor in the real font.** The header's widest unbreakable piece (same cut
points as its `<wbr>`s) is measured with canvas `measureText` in the header's computed
font, letter-spacing and text-transform; the floor applies when the table has room too.

## Host integration contract (unchanged, now honest)

The embed posts `{ type: 'appbi:resize', height }` whenever the report's height settles
on a new value. A host that sets `iframe.style.height = height + 'px'` gets a frame with
no inner scrollbar that grows and shrinks with the report. A host that ignores the
message keeps its fixed-height iframe and the report scrolls inside it (fallback).

## Unchanged by design

Stored layouts, AUTO/CUSTOM resolution and breakpoints (640 / 1024), Builder and Studio,
data requests, theme and appearance presets, logo, page tabs, filter banner, export
permissions, password gate, CSP / origin / grant enforcement.
