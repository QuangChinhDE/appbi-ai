# Device-specific dashboard layouts — spec

The behavioural contract is `docs/responsive-dashboard-layouts.md` (model,
breakpoints, storage shape, draft/publish, resolution, reconciliation, content
fit, Builder UX, AI, data independence, performance). This file records only the
decisions and prerequisites specific to delivering it.

## Prerequisites fixed first (Phase 0)

| # | Defect | Fix |
|---|---|---|
| P0.1 | Builder "move to page" wrote the LIVE layout (`PUT /layout`): the move and pending draft geometry went public at once | the move is staged into the caller's draft (and lands below the target page's content); `PUT /layout` (kept for external clients) drops client-sent draft keys, keeps the row's, bumps `_v`, invalidates the public cache |
| P0.2 | duplicate/export copied raw rows: other authors' draft-only tiles and draft keys | the snapshot carries published tiles only, draft keys stripped; rebuild maps tile ids (device items and `sectionId`) |
| P0.3 | Studio preview was read-only only by one permission gate | the preview's API client refuses every write; no layout callback is wired |
| P0.4 | the public grid measured its own width (WidthProvider/Responsive) beside the fit's width; the fit read `clientWidth` itself | one ResizeObserver per surface, whole pixels; plain `GridLayout` fed the resolver's `{cols, layout}` at that width; the fit takes the width it is given |
| P0.5 | Builder and public derived device layouts with different inputs | both draw through the one resolver (same tile kinds, reading order, defaults, breakpoints, generator version); public-only absent controls are an explicit input |
| P0.6 | the server resolved a tile's page in several places, each with its own default | ONE rule (`dashboard_service.tile_page_id`) for public page scope, device-layout validation/pruning and relayout: an explicit `pageId`, else `page-1` — the frontend `getDashboardChartPageId` contract. A report without a `page-1` keeps not drawing such a tile: re-homing it to the first page was rejected in review because it would start SERVING a tile nobody published. The resolver uses the same page assignment, so a device layout can never orphan or surface it. |
| P0.7 | `POST /relayout` wrote live rows (and re-flowed every page when the page had no tiles) | it stages into the caller's draft; an empty page changes nothing |

## Decisions

- Storage: a dedicated `dashboards.responsive_layouts` JSONB document
  (single authority, page-scoped, draft/publish-friendly, one field to copy).
- CUSTOM is stored in 36 columns for tablet and phone.
- Tile-set changes never block Publish; the render-time reconciliation is the
  guarantee, the Builder asks for review.
- Regenerate freezes the generator's geometry without content fit (Fit heights
  is the explicit fit).
