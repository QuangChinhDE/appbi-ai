# Public Read MCP — spec (draft for owner decision)

Status: DRAFT, 2026-11-05. Protected subsystem involved (public-link security) — needs the
product owner's decisions D1–D5 below before implementation.

## Goal
A customer who received a public link (Manual Dashboard or AI Vibe report) connects
**their own Claude** to it and can read, ask and analyse **exactly what the publisher
published** — nothing more, read-only, and without spending the publisher's AI key.

## Trust boundary
- A separate MCP resource (`/public-mcp`), separate from the author MCP (`/mcp`): different
  audience, different tokens, no AppBI user, no PAT, no write tool registered at all.
- Authority = the public link itself (its token + password session), re-resolved on EVERY
  call through the same Core path a viewer uses, so revoke / expiry / password change /
  "MCP disabled" take effect on the next call.
- Claude's model runs at the customer; AppBI never calls a model for these requests
  (no `public_turn._core`, no `data_core.service.ask`, no Model Gateway billing).

## Reused Core (no second data/AI path)
| Need | Vibe report | Manual dashboard |
|---|---|---|
| token -> link, password, expiry, revoke | `report_code.public_links.resolve` | `api.public._get_dashboard_by_token` |
| scope (charts on the page, locks, exposed fields) | `report_code.public_bot.build_context` | `api.public._public_link_tool_context` |
| catalog (charts, fields, pages) | `answer_core.publisher_guide.catalog_payload(PublishedReportScope)` | same |
| chart data with the link's locks | `bindings.mint_dto(..., public=True, enforced=...)` | `_fetch_chart_data(ctx, chart_id)` |
| governed aggregate within published fields | `PublishedReportScope.read(...)` (thin plan adapter) | same |
| filter values | `bindings.filter_values(..., enforced)` | `/filters/distinct-values` logic |

Implemented as a backend router (in-process service calls; this is not a second Core) plus
a thin MCP adapter in `integrations/appbi-mcp` that holds no data rights of its own.

## Tools (all read-only)
`describe_report` (name, pages, charts, metrics, viewer filters, publisher guide per D2),
`get_chart_data(chart_id, filters)`, `list_filter_values(key, search)`,
`query_published(metrics, dimensions, filters, grain, limit)`.
Locked filters are applied server-side and are not parameters; hidden locks are applied
and never named (same `DISCLOSE_KEY` rule as the public bot).

## Controls
- Owner opt-in per link: `appearance_config.mcp_access = {enabled, expires_at?, turns_per_hour}`
  (free-form JSON, no migration), stripped from viewer payloads like the AI bot keys.
- Link-bound OAuth: the customer opens the link in a browser, (enters its password), clicks
  "Allow Claude"; the MCP issues a token bound to that link id + its `auth_version`.
- Rate limits per link and per token; audit row per call (link id, tool, filters hash,
  rows returned) — reads without a model are not audited today, so this adds it.

## Owner decisions needed
- **D1 Authorization model**: (a) link-bound OAuth as above (recommended), or (b) the link
  token pasted into the Claude connector as a bearer (simpler, weaker: a leaked chat leaks the link).
- **D2 Publisher guide/context note**: today deliberately NOT served to viewers. Expose it
  to the external Claude? (a) only the fields the publisher marks "share with external AI"
  (recommended), (b) all of it, (c) none.
- **D3 Raw rows**: allow `query_published` row-level output (bounded) or aggregates only?
- **D4 Remote HTTPS**: a public hostname + TLS for `/public-mcp` (and `/mcp`) — needed for
  claude.ai / Desktop testing. Which domain/tunnel may be used?
- **D5 Embedding Claude UI inside AppBI**: out of scope; no supported mechanism verified.
