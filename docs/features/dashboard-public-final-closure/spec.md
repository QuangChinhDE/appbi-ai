# Dashboard Public / Embed final closure — spec

What the system guarantees once this ships. Each contract is stated as invariants with
the test that locks it. Source of truth for the capability matrix referenced from code
(`PublicDashboardView.exportEnabledOnThisSurface`, `lib/embed-framing.ts`).

## Delivery surfaces

| Surface | URL | Token | Created by |
|---|---|---|---|
| Public page | `/d/<token>` | stable public link token (32 bytes, `DashboardPublicLink.token`) | report editor, *Share → Public links* |
| Stable embed | `/embed/<token>` | the **same** stable token | same link — an iframe of it |
| Integration embed | `/embed/emb_<256 hex>` | `EmbedGrant` (SHA-256 stored), ≤ 1h | `POST /integrations/embed/resolve` with a PAT |
| Configurator preview | `/d/<t>` or `/embed/<t>` | short-lived link, `source='preview'`, 15 min | `POST /dashboards/{id}/public-links/preview` |
| Workboard dashboard screen | iframe `/embed/<token>` inside `/ws/<token>` | managed link `source='workboard'` (or a pasted active user link) | Workboard publish |

`DashboardPublicLink.source`: `user` · `workboard` · `embed_api` · `preview`.

## 1. Access / token contract

1. A stable public token resolves through **one** authority: an **active**
   `DashboardPublicLink` whose `source` is not `embed_api`. There is no other lookup.
   *(test_public_token_lifecycle)*
2. Disabling or deleting a link makes **every** route using its token answer 404
   immediately, including a token that once also lived in the retired
   `Dashboard.share_token` column. *(…_does_not_fall_back_to_a_legacy_copy)*
3. `POST/DELETE /dashboards/{id}/share` answer **410**; nothing creates a second authority.
4. A managed embed link's own token is never a public URL; only its `emb_` grant is.
5. `expires_at` is settable (API + UI) and enforced (410) on every route.
6. A password session is bound to `(link id, auth_version)`. Any security edit — password
   set/changed/cleared, active toggled, expiry changed — bumps `auth_version`; every
   earlier session stops verifying. Disable → re-enable does not revive old sessions.
   Sessions are bounded (2h). *(test_public_token_lifecycle)*
7. Retired: `max_access_count` (a page-load counter is not a limit on a bearer URL whose
   data endpoints it never counted; also racy), `allowed_ips` (never enforced, never
   settable). Columns remain; nothing reads them. Capped-out links were disabled by the
   migration.

## 2. Integration embed contract

1. Minting accepts a **PAT only** (browser session/cookie → 403).
2. The PAT's scope must include `dashboards ≥ edit`, and its owner must be able to **edit**
   the dashboard (owner, edit share, or module admin). `full_report` passes the same gate.
3. A grant records its PAT and is honoured only while that PAT is live; revoking/deleting
   the PAT ends every URL it minted. Grants without a recorded PAT are refused.
4. The framing policy is a state: `unrestricted` · `restricted` · `invalid`. Unknown,
   expired, revoked (grant, PAT or link) → `invalid`, never unrestricted.
5. Origin matching is decided by one server matcher; the browser enforces the same rules
   via `frame-ancestors`. Exact, wildcard-subdomain (not the parent, label boundary),
   scheme and port are all significant.
6. **Fail closed**: no fresh policy and no known-good cached policy (≤ 1h) → refusal (503).
7. `emb_` tokens are refused on `/d/`.
8. `EMBED_FRAME_ANCESTORS` is always emitted as its own CSP on `/d` and `/embed`, so a grant
   allowlist can narrow it, never widen it.
9. Report export (PDF/PPTX) is refused for `emb_` tokens.
10. A locked filter names exactly one field: `semanticField` (+ a `datasetId` that must be its
    dataset), or a bare `field` only when one filterable field has it; ambiguous / unknown /
    mismatched → 400. The stored lock is `datasetId + semanticField + bare field` (the dialog's
    shape) and `filter_hash` is computed from it.
11. One runtime: an `emb_` resolves to its managed link and reads through the ordinary public
    paths — same published report, same merge, same engine. It answers exactly as a public link
    locked to the same filters. It inherits the published dashboard, not any Public Link's
    settings (`docs/embed-integration-api.md` §3.1–3.3).

*(test_embed_integration_security, test_public_authoritative_bounds_pg `test_api_embed_*`,
e2e public-closure-api-embed.spec.ts, scripts/check-embed-framing-contract.mjs)*

## 3. Data authority contract

Merge order for every public data path (single chart, batch, distinct values, AI, PDF
render), lowest to highest:

```
chart base filters (always ANDed)
  < dashboard filter (visible)  < dashboard slicer  < viewer slicer/filter
  < dashboard 🔒/🚫 filter (authoritative)  < link lock (incl. value-bearing 🚫 hidden)
then hard bounds: link 'limit' scope · page scope (from stored pages_config) · author bounds
then tile instance parameter filters (ANDed)
```

Invariants (all public routes, single and batch identical):

- A. A viewer cannot remove or widen a locked filter. *(test_public_filter_authority, _pg)*
- B. A viewer cannot remove or widen a hidden filter; a value-bearing hidden entry is
  enforced and never named. *(test_public_filter_authority, test_public_link_filter_disclosure)*
- C. Page scope and author bounds come from stored config, never from the request.
- D. A token fetches only published tiles of its own dashboard; a tile id of another
  chart/dashboard is 404. *(test_dashboard_parameter_parity, test_publication_boundary)*
- E. A viewer filter may name only fields the served report exposes. A parameter switcher
  filter is accepted only as exactly what that switcher can produce (its resolved column,
  `in`, one of its options); a what-if override only as a bound role and one of the bound
  switcher's options. Anything else is 400 for that tile.
- F. No user value changes a query's structure: every literal goes through
  `app/services/sql_literal.py` (dialect-aware; BigQuery/MySQL backslash escapes).
  *(test_sql_literal_security — sqlglot parses each builder's output)*

**Presentation flags are not data controls.** `show_page_tabs`, `allow_viewer_filters`,
`allow_data_export` choose which controls a viewer sees. Data a link can read is decided
by its locked/hidden filters. `allow_data_export=false` removes the CSV button; it is not
DLP (the rows a chart shows were already delivered).

## 4. Render / data parity contract

Given the same published report, viewport class, filter state and parameter state, the
Builder canvas, `/d`, stable `/embed` and an integration embed show the same tiles, order,
layout, chart types, formatting and **numbers**. Editor and embed chrome may differ (table
below).

- One row height for every width (`computeReportRowHeight` = the Builder's row; phones
  included). *(check-unified-grid-contract)*
- Parameters: text-only, field-bound, what-if dimension, what-if metric and tile instance
  parameters are applied identically. The switcher's column is resolved once by the
  server (`parameter_fields`) and used by both surfaces; tile instance parameters run the
  same vectors on both halves. *(test_dashboard_parameter_parity,
  check-dashboard-parameter-parity.mjs)*
- Proven in a real browser on all four surfaces (Builder, `/d`, stable `/embed`, a PAT-minted
  `emb_` grant), compared TILE by TILE (`dashboard_chart` id — a chart placed twice keeps
  two answers): `e2e/tests/public-closure-*.spec.ts` (shared machinery
  `_public-closure.ts`). Builder tiles send an observability-only `tile_id` on their
  data requests; the public batch echoes `tile_id`.
- Tablet/phone content-fit (`lib/responsive-fit`) gives a KPI the same height on every
  surface: it is measured with its context line in full, only once its number has
  rendered, and after that first measure a re-measure may only grow it (the number's
  font follows its cell, so repeated shrinking landed on a row decided by timer order).

### Interaction contract (one model, every surface)

- Clicking a data point: the SOURCE tile dims its other marks (its own query is
  unchanged) and every OTHER tile FILTERS to that value. Clicking the same point again
  clears. A tile with `layout.highlightEnabled === false` neither emits nor receives a
  selection.
- There is no other interaction mode. A `theme_config.interactions.mode` switch and a
  parallel "highlight overlay" fetch existed in the public view but nothing could enable
  them (no writer, state never set): that dead runtime was removed rather than left
  untested.
- Date drill / viewer grain re-buckets server-side. In the Builder's EDIT canvas the
  same control sets the chart's saved default grain (authoring); the viewer behaviour is
  the Builder READ canvas (`?studio=preview`), `/d` and both embeds.
  `layout.lockDateGrain` removes the control.

### Preview contract

The Public Links configurator preview shows **the published report + this link's unsaved
settings** (filters, appearance), rendered by the real public runtime. Unpublished
dashboard edits are not shown, and the UI says so. Previewing creates no listed link
and publishes nothing.

## 5. Capability matrix (source of truth)

| Capability | Builder | `/d` | Stable `/embed` | Integration `emb_` | Intentional difference |
|---|---|---|---|---|---|
| Page navigation | ✔ | ✔ if `show_page_tabs` | same | same | presentation flag |
| Viewer filters / slicers | ✔ | ✔ if `allow_viewer_filters` | same | same, inside locked filters | presentation flag |
| Cross-filter / cross-highlight | ✔ | ✔ | ✔ | ✔ | — |
| Date drill / viewer grain | ✔ | ✔ | ✔ | ✔ | — |
| Parameter switchers (all kinds) | ✔ | ✔ | ✔ | ✔ | — |
| Widgets | ✔ | ✔ | ✔ | ✔ | switchers interactive on all |
| Per-chart CSV | ✔ | ✔ if `allow_data_export` | same | same | presentation flag |
| Report PDF / PPTX | ✔ | ✔ | ✘ | ✘ (server refuses) | embed chrome belongs to the host |
| Data-as-of badge | ✔ | ✔ | ✔ | ✔ | — |
| AI assistant | — | if enabled on link | ✘ | ✘ | out of scope |
| Password | — | ✔ | ✔ | ✘ (PAT-gated mint) | — |
| Expiry | — | ✔ | ✔ | ≤ 1h grant | — |
| Revocation | — | disable/delete link | same | revoke PAT / disable link | — |
| Per-link origin allowlist | — | ✘ (nginx `'self'`) | ✘ | ✔ fail closed | stable links: deployment floor only |
| Deployment floor `EMBED_FRAME_ANCESTORS` | — | ✔ | ✔ | ✔ | — |
| Host auto-resize (postMessage) | — | ✘ | ✔ | ✔ | — |

## 6. API

| Method | Path | Auth | Notes / errors |
|---|---|---|---|
| POST | `/dashboards/{id}/share` · DELETE | session | **410** retired |
| POST | `/dashboards/{id}/public-links` | edit | `expires_at` accepted |
| PATCH | `/dashboards/{id}/public-links/{link}` | edit | security edits bump `auth_version`; `expires_at` omitted = unchanged, null = never |
| POST | `/dashboards/{id}/public-links/preview` | edit | `{token, expires_at}`; 15 min; 422 on unappliable filters |
| POST | `/public/dashboards/{t}/auth` | — | 10/min per IP, 100/hour per link |
| GET | `/public/dashboards/{t}/charts/{chart}/data` | token | `tile_id`, `overrides` (JSON) |
| POST | `/public/dashboards/{t}/charts/data` | token | items `{chart_id, tile_id?, filters?, granularity?, overrides?}`; results echo `tile_id` |
| GET | `/public/embed/{t}/policy?origin=` | — | `{state, allowed_origins, enforced, origin_allowed}`; 600/min per token |
| POST | `/integrations/embed/resolve` | PAT, `dashboards ≥ edit`, edit access | see docs/embed-integration-api.md |
| GET/POST | `/public/dashboards/{t}/exports…` | token | 403 for `emb_` |

## Data

Migration `20261004_0001` (additive columns + deliberate data changes):

- `dashboard_public_links.auth_version` INT NOT NULL DEFAULT 0.
- `embed_grants.personal_access_token_id` UUID NULL, FK `personal_access_tokens` ON DELETE CASCADE.
- `dashboards.share_token` set to NULL (column kept, unread). Not restored on downgrade.
- Links already at `max_access_count` set `is_active = false`.

## Operations

- `TRUSTED_PROXY_CIDRS` (default loopback + RFC1918 + ULA) and `TRUSTED_PROXY_HOPS`
  (default 1 — host nginx) decide the client address for rate limits. Put a load
  balancer in front of nginx → `TRUSTED_PROXY_HOPS=2`.
- Uvicorn runs with `--no-proxy-headers`; the app middleware owns forwarded headers.
- Application logs name public tokens by `tok:<sha256[:12]>`.
