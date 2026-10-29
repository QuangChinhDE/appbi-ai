# External MCP Integration Layer (Dataset + Dashboard) — intent

**Status:** approved 2026-10-13 (Q1–Q4 answered by the product owner, see "Decisions") — in progress
**Owner:** minh.ngo03@base.vn
**Date:** 2026-10-13
**Base:** `origin/demo` @ `d4cf98da4a985216252da82d98acf9ba3b0b04fb` (fetched 2026-10-13)
**Branch:** `feat/mcp-integration-layer` (worktree `D:/Appv2/wt-mcp-integration`)

## Problem

A user who works in Claude (claude.ai, Claude Desktop, Claude Code) cannot build anything
in AppBI from there. Today:

- There is **no MCP server** in the product. The old stdio servers
  (`Skill-AppBI/appbi-dashboard-mcp`, `appbi-workboard-mcp`) were removed from the repo
  (`README.md:177`, `.gitignore:114`). Only the dev-tooling guardrail MCP remains
  (`scripts/guardrail/appbi_guardrail_mcp.py`), and it is not product code.
- The removed servers ran on the user's machine with a raw PAT read from an environment
  file. They called endpoints that later drifted (a `PATCH` route that never existed,
  wrong body types, ignored query params). They also wrote live dashboard state directly,
  with no draft, no approval and no conflict handling.
- **AppBI has no OAuth authorization server** (no `/authorize`, `/token`, PKCE, or
  `/.well-known/oauth-*`). Remote MCP clients such as claude.ai can only connect to an
  OAuth-protected server through protected-resource discovery, CIMD/DCR and S256 PKCE.
  AppBI's Google sign-in makes AppBI an OAuth **client** of Google. That does not make
  AppBI an authorization server for Claude.

So the only way to get from "I have a data source" to a published dashboard is the
AppBI UI.

## Goal

A non-technical user does three things:

1. Adds AppBI as a connector in Claude.
2. Signs in with their normal AppBI account.
3. Asks Claude for a Dataset and then a Dashboard.

AppBI's own APIs build both resources, as drafts the user owns. The user approves the
plan and each publish **in the browser**, on a page Claude cannot click for them. Both
resources then behave exactly like ones authored in the AppBI UI: same lifecycle, same
permissions, same validation, same co-editing rules.

## Out of scope

- Changing Agent Flow, AI Chat, Source, Dataset Core, Chart Core, Dashboard Core, or the
  semantic layer. The MCP is an **adapter**. It owns no BI rules.
- Reviving the removed `Skill-AppBI` stdio servers.
- Custom-SQL dataset tables or `POST /datasources/query` from MCP. This is deliberate:
  that is a permissive SQL execution path. v1 builds Datasets from physical tables only.
- Creating, changing or deleting public links, embeds, shares, PATs, users or data
  sources. These are read-only or entirely absent from the MCP.
- Delete tools. v1 never deletes. A failed or abandoned draft is reported with its link,
  and the user discards it in AppBI. This means no blind rollback.
- Workboards, Agent Flows, Chat, Observability, Govern.
- Report Starter as a write path. `POST /dashboards/report-starter` writes **live** tiles
  with no draft and no plan binding (`services/report_starter_service.py:313-366`). The
  client does the planning instead, and every proposal is validated through the canonical
  chart dry-run.
- Merging to `demo`, public deployment, DNS/TLS changes, or listing in the Claude
  connector directory. Each of these needs a separate go-ahead.

## Constraints

- **Independent runtime.** The MCP runs in its own image and its own compose project.
  Core starts, runs and rolls back with the MCP absent or stopped. The MCP has:
  - no Core database credentials
  - no Core `SECRET_KEY` / `DATASOURCE_ENCRYPTION_KEY`
  - no shared data volume
  - no network route to Postgres
- **No token passthrough.** The token Claude presents is issued **for the MCP audience**
  and is never forwarded to AppBI. AppBI receives only the user's own delegated AppBI
  credential, which the MCP holds encrypted per grant.
- **No privileged shared credential.** Every AppBI call runs as the real user, through a
  PAT whose scope AppBI caps at the user's live authority (`core/dependencies.py:268-314`).
  A read-only user therefore cannot write through the MCP even if the MCP is wrong.
- **Explicit API allowlist.** The MCP's AppBI client can reach only the listed
  `(method, path)` pairs. The following are not on the list:
  - the live-write dashboard routes: `POST /dashboards` with tiles,
    `PUT /dashboards/{id}`, `PUT /layout`, non-draft tile PATCH/DELETE, report-starter
  - public-link routes
  - PAT routes
  - `/datasources/query`
- **Reuse, don't re-implement.** These AppBI endpoints decide validity:
  - dataset structure: the join fan-out guard, `/model/health`, measure `dry-run`
  - charts: `POST /charts/dry-run-create`
  - publish: `POST /datasets/{id}/publish` and `POST /dashboards/{id}/publish`

  The MCP adds only plan bookkeeping, approval, idempotency and status reconciliation.
- **Protected subsystems.** None are edited. The semantic layer and public-link security
  are only *called*, and the public surface is never called.
- **Python.** The MCP SDK (`mcp` 2.x) needs newer FastAPI/Starlette/Pydantic/httpx than
  the backend pins (`fastapi==0.109`, `pydantic==2.5.3`). The MCP is a separate Python
  project with its own lockfile, and it is never installed into the backend image.

## Acceptance criteria

Each item maps to a numbered journey in the brief, §8.

1. **Discovery.** A real MCP client fetches `/.well-known/oauth-protected-resource`.
   - An unauthenticated `POST /mcp` returns `401` with
     `WWW-Authenticate: Bearer resource_metadata=…`.
   - After the OAuth flow (S256 PKCE, `resource`=canonical URL, CIMD or DCR), `tools/list`
     returns the tool set with JSON schemas.
2. **Bad credentials.** These are each rejected at the HTTP layer with `401`, and no
   AppBI call is made:
   - no token
   - a malformed token
   - an expired MCP token
   - a revoked MCP grant
   - an MCP token whose `aud`/resource is not this server

   When a user revokes their delegated PAT in AppBI, the next tool call reports
   "connection revoked", and every later request gets `401`.
3. **Cross-user and cross-resource access.**
   - User B's MCP session cannot read or modify User A's dataset, dashboard, plan, approval
     or operation. AppBI answers `403`/`404` to B's credential, and the MCP refuses A's
     plan IDs for B.
   - An approval issued to A cannot execute B's plan, or a different plan hash.
4. **Read-only users.** A user with `datasets:view` / `dashboards:view` can discover and
   plan. `execute`/`publish` fail with AppBI's `403`, surfaced as `blocked`, and nothing
   is created.
5. **Single-table Dataset.** A single-table Dataset is created from one physical table.
   - It reaches `draft_ready`, with the model generated.
   - Its measure dry-runs pass.
   - Its row count and measure values equal an independent SQL computation against the
     source.
6. **Multi-table Dataset.** A multi-table Dataset (fact + ≥2 dimensions) gets joins with
   correct cardinality.
   - The KPI values (SUM, COUNT DISTINCT) equal independent SQL against the source,
     including a dimension breakdown.
   - A deliberately wrong cardinality, which would cause fan-out, is **refused** by
     AppBI's guard and reported as `blocked`, never forced.
7. **Dataset publish.** After a browser approval, `publish_state` becomes `published`.
   - The MCP polls `/publish-status` until the run is terminal, and reports `published` or
     `sync_failed` with AppBI's own error.
   - Published data answers a chart query.
8. **Dashboard build.** The Dashboard plan validates every chart through
   `/charts/dry-run-create`.
   - Executing the plan creates charts (including KPI), `draftOnly` tiles and dashboard
     filters/slicers through the draft endpoints, with `base_rev`.
9. **Browser render.** The dashboard opens in a real browser (Playwright) as its owner.
   - Draft tiles render with data.
   - After the publish approval, the published dashboard renders for a second user it is
     shared with.
10. **Value agreement.** Chart values on the rendered dashboard, including with a filter
    applied, equal `GET /charts/{id}/data` and independent SQL. The filter must not
    appear in `debug.dropped_filters`.
11. **Concurrent edits.** User A edits a shared dashboard in the UI while the MCP (as
    user B) adds tiles.
    - B's publish sends `tile_base_v` and the `shared_draft` rev.
    - A conflict returns a structured `conflict` result, and nothing of A's is overwritten
      or discarded.
    - The MCP never sends `force`.
12. **Duplicates, timeouts and partial failures.**
    - Calling `execute_plan` twice, or retrying after a simulated timeout, creates each
      resource exactly once.
    - A failure partway through reports `partially_failed`, listing the resources already
      created (with links) and the failed step. Re-executing resumes from that step.
13. **Isolation.** `docker compose -p appbi-mcp … stop`/`down` leaves the Core backend
    and frontend healthy, and the Core e2e smoke stays green. Core started without the MCP
    files is byte-identical in behaviour.
14. **End-to-end.** One real MCP client session goes Dataset → publish → Dashboard →
    publish, with the two plan approvals and two publish approvals done in the browser.

## Decisions (product owner, 2026-10-13)

- **Q1 → Connect page in AppBI.** Front-end only. It reuses the existing session-only PAT API.
- **Q2 → Internal `appbi-mcp-link` network.** Attached to `backend` only.
- **Q3 → Same host.** The MCP is served under `/mcp`, `/mcp-oauth/` and `/.well-known/oauth-*`.
- **Q4 → The product owner provides a BigQuery materialization host for the rig.**
- **Q5 →** Unchanged. claude.ai/Desktop stay NOT VERIFIED until there is a public deployment.

## Open questions as originally posed

| # | Question | Recommendation |
|---|---|---|
| Q1 | How does the user delegate their AppBI identity to the MCP? | **Connect page in AppBI** (front-end only). The user signs in normally, and AppBI mints a dedicated PAT that is scoped and must expire, via the *existing* session-only PAT API. The PAT is handed to the MCP in a same-origin POST bound to the browser that started the OAuth flow. The alternatives are a "paste a PAT" page on the MCP (zero Core change, poor UX, and the MCP cannot see the PAT's scope or expiry because `/auth/me` returns uncapped permissions), or AppBI as a full OAuth AS (a large auth change). |
| Q2 | Network path MCP → backend | **Dedicated internal network `appbi-mcp-link`**, declared additively in `docker-compose.yml` and attached to `backend` only. The MCP can reach the API and cannot reach Postgres. Turning it on means recreating the backend container once. The alternative is the public HTTPS URL (no Core compose change, but it hairpins through nginx and shares nginx's per-IP rate limit across all MCP users). |
| Q3 | Public hosting | **Same host, under `/mcp` and `/mcp-oauth/`**, with the existing certificate. nginx forwards only the MCP's own cookie to it, never AppBI's session cookie. The alternative is a subdomain (`mcp.<host>`), which needs DNS and a certificate and makes the connect POST cross-site. |
| Q4 | Publish acceptance (journey 7) needs a BigQuery materialization host (`snapshot_service.py:296-377`) | Confirm which BigQuery project/credentials the test rig may use. Without one, journey 7 can only be verified as far as `sync_failed: no host`, and is reported **NOT VERIFIED**. |
| Q5 | claude.ai and Desktop journeys need a publicly reachable HTTPS URL | Local verification uses a real SDK client and Claude Code over localhost. The claude.ai/Desktop connection stays **NOT VERIFIED** until the endpoint is deployed somewhere Anthropic's egress (`160.79.104.0/21`) can reach. |
