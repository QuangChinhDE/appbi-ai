# External MCP Integration Layer — spec

What the system does once built. All AppBI paths are under `/api/v1`. Citations are to
`backend/app/` at base `d4cf98da` unless marked otherwise.

## 1. Topology

```
 Claude (claude.ai · Desktop · Code)
   │  HTTPS  Streamable HTTP  ·  Authorization: Bearer <MCP-audience token>
   ▼
 host nginx :443 ── /mcp, /mcp-oauth/*, /.well-known/oauth-*  ──►  127.0.0.1:8090
   │            └── everything else (unchanged) ─► frontend / backend
   ▼
 ┌─────────────── compose project "appbi-mcp" (docker-compose.mcp.yml) ───────────────┐
 │ appbi-mcp  (own image, non-root, read-only rootfs, cpu/mem limits)                 │
 │   • MCP resource server  (/mcp)                                                    │
 │   • OAuth 2.1 authorization server for Claude  (/mcp-oauth/*, well-known)          │
 │   • approval pages  (/mcp-oauth/approve/*)                                          │
 │   • state: SQLite on its own volume `appbi_mcp_state` (grants, plans, approvals,   │
 │     operations, audit) — PATs Fernet-encrypted with MCP_STATE_KEY                  │
 │ networks: mcp-ingress (published 127.0.0.1:8090)  +  appbi-mcp-link (internal)     │
 └────────────────────────────────────────────┬───────────────────────────────────────┘
                                              │ http://appbi-backend-api:8000/api/v1
                                              │ Authorization: Bearer appbi_pat_… (the user's own,
                                              │ scoped, expiring) · X-Request-ID
 ┌──────────────── compose project "appbi" (docker-compose.yml, unchanged services) ──┐
 │ backend  ── appbi-net (db, frontend) + appbi-mcp-link (alias appbi-backend-api)    │
 │ db       ── appbi-net only  → unreachable from appbi-mcp                           │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

Core never depends on the MCP. With `docker-compose.mcp.yml` absent, the only trace is an
empty internal network attached to the backend (Q2). nginx `/mcp*` locations answer `502`
when the MCP is down. Every other route is untouched.

## 2. Authentication and delegated identity

### 2.1 Claude ↔ MCP (OAuth 2.1, MCP authorization spec 2026-07-28 and Claude connector requirements)

| Endpoint | Behaviour |
|---|---|
| `GET /.well-known/oauth-protected-resource` and `…/oauth-protected-resource/mcp` | Returns `{resource: <MCP_PUBLIC_URL>/mcp, authorization_servers: [<issuer>], scopes_supported: [appbi.read, appbi.author, appbi.publish], bearer_methods_supported: [header]}`. `resource` equals the URL the user enters, exactly. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported:[S256]`, `token_endpoint_auth_methods_supported:[none]`, `client_id_metadata_document_supported:true`, `grant_types_supported:[authorization_code, refresh_token]`, `authorization_response_iss_parameter_supported:true`. `offline_access` is advertised **only** in AS `scopes_supported`. |
| `POST /mcp-oauth/register` (DCR, RFC 7591, JSON) | Public clients only. Every `redirect_uri` must match the policy: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, loopback `http://localhost:*/…` or `http://127.0.0.1:*/…` (port ignored), plus `MCP_EXTRA_REDIRECT_URIS`. Anything else is rejected with `400 invalid_redirect_uri`. Rate limited per IP. |
| CIMD | An HTTPS `client_id` is fetched only from hosts in `MCP_CIMD_ALLOWED_HOSTS` (default `claude.ai`). The fetch has an SSRF guard (no private, loopback or link-local addresses; no redirects), a 64 KB cap, a 5 s timeout and a cache. `redirect_uris` are validated by the same policy. |
| `GET /mcp-oauth/authorize` | Required: `response_type=code`, PKCE `S256`, a `resource` equal to the canonical URL (else `invalid_target`), and `state`. Shows the consent screen (§2.2). |
| `POST /mcp-oauth/token` (form-urlencoded) | `authorization_code`: the code is single-use with a 60 s TTL and is checked against the PKCE verifier, `redirect_uri`, `client_id` and `resource`. `refresh_token`: rotated on every use; reusing an old one revokes the whole grant family (`invalid_grant`). The access token is opaque, 1 h, stored hashed and bound to `aud=resource`. The refresh token is opaque and lasts 30 days sliding, capped at the delegated PAT's expiry. |
| `POST /mcp-oauth/revoke` | RFC 7009 revocation. |
| `POST/GET /mcp` | Requires a bearer token. Missing or invalid gives `401` + `WWW-Authenticate: Bearer resource_metadata="…", scope="appbi.read"`. A token for another resource gives `401`. A tool outside the granted scopes gives `403 insufficient_scope` with the required scope. Tokens are never accepted in the query string. |

### 2.2 MCP ↔ AppBI delegation (recommended Q1 option — "Connect page")

1. `/mcp-oauth/authorize` stores a transaction `{txn_id, client, redirect_uri, scopes, pkce, state}`. It sets an httpOnly, Secure cookie `appbi_mcp_txn` (path `/mcp-oauth`, 10 min) holding a txn-binding secret, then redirects to the AppBI page `/connect/mcp?txn=<txn_id>`.
2. The AppBI page is a **new front-end page**. It goes through the normal AppBI login, so password and Google sign-in both work.
   - It reads the transaction's display data from `GET /mcp-oauth/txn/<id>` (client name, redirect host, requested scopes) and shows it.
   - It shows what Claude will be able to do. The AppBI scopes derive from the MCP scopes: `data_sources:view`, `datasets:edit`, `explore_charts:edit`, `dashboards:edit`, or `…:view` for read-only. The page also shows a lifetime of 30 days, which the user can lower to 1–90.
3. When the user clicks **Allow**:
   - The page calls the **existing** `POST /auth/personal-access-tokens` with the user's session. This route is session-only (`api/personal_access_tokens.py:52-58`) and rate-limited to 10/min. The body is `{name:"Claude MCP · <client> · <date>", scopes, expires_in_days}`. AppBI rejects scopes above the user's own permissions (`:106-109`).
   - The page auto-submits a same-origin form POST of `{txn, pat}` to `/mcp-oauth/appbi-callback`.
   - The callback URL is a build-time constant of the page and is never taken from the query, so the token cannot be exfiltrated.
4. The MCP callback then does the following:
   - Requires the `appbi_mcp_txn` cookie to match `txn`. This defeats login-CSRF: a transaction started in an attacker's browser cannot be completed by a victim.
   - Calls `GET /auth/me` with the PAT and records `user_id`/`email`.
   - Stores the PAT Fernet-encrypted in a new **grant**.
   - Sets the browser-session cookie `appbi_mcp_session` (httpOnly, Secure, SameSite=Lax, path `/mcp-oauth`, 12 h), which the approval pages use.
   - Redirects to the client's `redirect_uri` with `code`, `state` and `iss`.
5. "Deny" redirects to the client with `error=access_denied`.

The user sees and revokes the connection in **AppBI → Settings → Access tokens**, where it
is the named PAT. Revocation takes effect on the MCP's next AppBI call (401 → grant
revoked → `401` to Claude → re-auth).

*Fallback (Q1 = "paste a PAT"):* step 2 is replaced by an MCP-hosted form where the user
pastes a PAT they created themselves. Everything else is identical. The MCP cannot see that
PAT's scopes or expiry, so the consent page warns about this and the grant lifetime is capped
at 30 days on the MCP side.

### 2.3 Scopes → tools

| MCP scope | Grants |
|---|---|
| `appbi.read` | discovery, inspect, preview (bounded), plan, status, approval-request creation |
| `appbi.author` | `execute_plan` (creates drafts) |
| `appbi.publish` | `publish` |

Scope is a ceiling only. AppBI still decides every action with the user's live authority.

## 3. Approval (server-verifiable, not forgeable by model text)

- `plan_*` and `request_publish` return `{plan_id | publish_request_id, plan_hash, summary, approval_url}`.
- `approval_url` is `/mcp-oauth/approve/<id>`. The page:
  - requires the `appbi_mcp_session` cookie of the **same AppBI user** as the grant;
  - re-runs the AppBI connect flow (step 2) if the cookie is missing;
  - shows a plain-language summary rendered from the stored plan, never from model text;
  - approves only on a `POST` with a CSRF token. A `GET` never approves, so a model with a
    web-fetch tool cannot approve.
- An approval record is `{id, user_id, grant_family, kind, target, plan_hash | fingerprint, expires_at (30 min), used_at}`. It is single-use and checked on execution against:
  - the calling grant's user;
  - the stored plan hash;
  - a fresh **staleness re-check**:
    - dataset: `updated_at`, explore `joins_version`, `publish_state`;
    - dashboard: `shared_draft.rev` and each touched tile's `layout._v`.

  A mismatch gives `stale_plan` and needs a new plan and approval.
- No tool accepts an approval token as an argument. The model never sees anything it could
  replay.

## 4. Operation model

`execute_plan(plan_id)` runs an approved plan as a persisted, **resumable state machine**:

- A step is `pending → sent → done | failed`, and records the AppBI resource ids it
  produced.
- One active execution is allowed per plan, enforced by a row lock in SQLite.
  Re-invoking while one is running returns the current status.
- **Ambiguous step** (sent, no response, e.g. a timeout): before any retry the MCP
  **reconciles** by reading AppBI.
  - dataset by exact name + owner + `created_at ≥ step.sent_at`;
  - table by `(datasource, source_table_name)`;
  - chart by name + owner;
  - tile by `chart_id` on the dashboard.

  It adopts what exists rather than writing twice.
- Terminal statuses come from the real lifecycle, never from a `2xx` alone:

  | Status | Meaning |
  |---|---|
  | `draft_ready` | everything created, AppBI validation passed |
  | `blocked` | AppBI refused (403, fan-out guard, measure dry-run error, health blocker); nothing more written |
  | `partially_failed` | some resources exist; lists them with links + the failed step; `execute_plan` resumes |
  | `conflict` | dashboard 409; nothing forced |
  | `stale_plan` | underlying resource changed since approval |
  | `syncing` / `published` / `sync_failed` | dataset publish, from `/publish-status` |
  | `published` | dashboard, after `POST /publish` 200 **and** a re-read showing no remaining `draftOnly` tiles of the user |

- No step deletes anything. There is no automatic rollback.
- Limits:
  - a plan has ≤ 12 tables, ≤ 20 joins, ≤ 40 measures, ≤ 24 charts, ≤ 12 filters;
  - one execution has a wall budget of ≤ 10 min, after which it reports `partially_failed (timeout)`;
  - each user has ≤ 2 concurrent executions and the token bucket is 60 calls/min;
  - tool output is ≤ 24 KB of text, with previews ≤ 20 rows;
  - anything matching `appbi_pat_…`, `password`, `private_key`, `client_secret` or `token` keys is redacted.

## 5. Tool contract map

"Authority" is the AppBI component whose answer the MCP reports verbatim. "Gap" is a
behaviour the MCP must compensate for, with the evidence.

### 5.1 Discovery (scope `appbi.read`, no AppBI writes)

| Tool | AppBI call(s) | AppBI permission | Notes / gaps |
|---|---|---|---|
| `whoami` | `GET /auth/me` | any | Adds grant scopes and expiry from MCP state. `/auth/me` returns **uncapped** `permissions` (`api/auth.py:449`, `schemas/auth.py:113`), so the MCP never presents them as the token's rights. |
| `list_data_sources` | `GET /datasources/?skip&limit` | `data_sources:view` + owned/shared | Secrets are masked by AppBI. The MCP redacts again and returns id/name/type/health only. |
| `inspect_data_source` | `GET /datasources/{id}/schema` | view | Truncated to 200 tables, with a search arg. PG row counts are estimates (`services/datasource_service.py:3873`), labelled `row_count_estimate`. |
| `inspect_source_table` | `GET /datasources/{id}/tables/{s}/{t}?preview_rows=N` | view | **Gap:** `preview_rows` has no server cap (`api/datasources.py:563`). The MCP clamps it to ≤ 20. |
| `list_datasets` / `get_dataset` | `GET /datasets/`, `GET /datasets/{id}`, `GET /datasets/{id}/model`, `GET /datasets/{id}/publish-status` | datasets view | `publish_state` lives only in `/publish-status`. Note that `/publish-status` can itself commit `published↔changes_pending` (`dataset_publish_service.py:371-385`). This is AppBI-owned reconciliation, accepted. |
| `profile_dataset_table` | `POST /datasets/{id}/tables/{tid}/profile?sample_limit≤20` | EXPLORE | Read-only. `/tables/{tid}/preview` is **not** used because it seeds caches on first read (`api/datasets.py:4516`). |
| `list_dashboards` / `get_dashboard` | `GET /dashboards/`, `GET /dashboards/{id}` | dashboards view | `get_dashboard` returns the caller's draft overlay, `shared_draft.rev` and each tile's `_v`, which are needed for staleness checks. |
| `get_chart_data` | `GET /charts/{id}/data?context=dashboard&filters=[…]` | chart effective ≠ none | Rows ≤ 50. Returns `debug.dropped_filters` when AppBI includes it (edit callers only, `api/charts.py:1037`). |

### 5.2 Dataset authoring

| Tool | AppBI call(s), in order | Permission | Authority | Gaps handled |
|---|---|---|---|---|
| `plan_dataset` (read) | `GET /datasources/{id}` and `…/tables/{s}/{t}` for each table, existence checks only | view | — | v1 accepts physical tables only. The plan stores the source columns used, so execution detects drift. |
| `execute_plan` (dataset) | 1 `POST /datasets/` `{name, description, purpose:"reporting"}` | `datasets:edit` | AppBI | **Not idempotent:** a name collision is auto-suffixed (`services/dataset_crud.py:261-271`), so it is reconciled by name + owner + time. |
| | 2 `POST /datasets/{id}/tables` per table `{display_name, source_kind:"physical_table", datasource_id, source_table_name}` | dataset edit + source view | AppBI | Physical-table add is idempotent (`dataset_crud.py:421-433`). Multi-commit, and a late 500 is possible (`api/datasets.py:3570`), so the table is re-read to confirm `columns_cache`. |
| | 3 `POST /datasets/{id}/generate-model` | edit | AppBI | Must precede joins and publish (`dataset_model_service.py:2635`). |
| | 4 `POST /model/joins/suggestion` per join, then `POST /model/joins` **one at a time** (not `/joins/batch`, which returns 200 on partial failure, `:6224`) | view / edit | **fan-out guard** (`dataset_model_service.py:2721-2736`) | Never sends `force`. A guard refusal gives `blocked` with AppBI's message. |
| | 5 `POST /model/views/{vid}/measures/dry-run` per measure, then `PUT /model/views/{vid}` with the union of existing + new measures | edit | **SemanticQueryEngine** dry-run | View PUT is last-write-wins (no version). The MCP re-reads the view immediately before the PUT and merges; a concurrent change between the read and the PUT is a documented residual risk. `rename_map` is never sent. |
| | 6 `PUT /datasets/{id}/dictionary` (optional) | edit | AppBI | Last-write-wins. Sent only when the plan has notes. |
| | 7 `GET /model/health?execute=true` | view | AppBI | Blocking failures give `blocked`. |
| `request_publish` (dataset) | `GET /publish-status`, `GET /model` | view | — | Fingerprint = `updated_at`, `joins_version`, `publish_state`. |
| `publish` (dataset) | `POST /datasets/{id}/publish` | dataset **manage** (`api/datasets.py:2570`) | AppBI publish pipeline | No job id: `{started:false, reason:already_syncing}` means a run is already in progress, so the MCP tracks it (idempotent). |
| `get_publish_status` | `GET /publish-status`, `GET /refresh-runs?limit=5` | view | AppBI | Polls with backoff for ≤ 10 min per call, then returns `syncing` with a resume hint. A BigQuery host is required (`snapshot_service.py:296-377`). Without one, it is `sync_failed` with AppBI's message. |

### 5.3 Dashboard authoring

| Tool | AppBI call(s) | Permission | Authority | Gaps handled |
|---|---|---|---|---|
| `plan_dashboard` (read) | `GET /datasets/{id}/model`, then `POST /charts/dry-run-create` for each proposed chart/KPI | explore_charts view + dataset EXPLORE | **chart dry-run** (`api/charts.py:575-707`) | Only `ok=true` proposals enter the plan, and the plan stores AppBI's `normalized_config`. For edits to an existing dashboard it also captures `shared_draft.rev` and the tiles' `_v`. |
| `execute_plan` (dashboard) | 1 new dashboard: `POST /dashboards/` with **no charts** `{name, description}` | `dashboards:edit` | AppBI | Names are **globally unique** (`models.py:158`); a collision gives `blocked:name_taken` with a suggestion, never auto-renamed silently. Reconciled by name + owner. |
| | 2 `POST /charts/` with the stored `normalized_config` | explore_charts edit + dataset BUILD | `ChartCreate` validation | Duplicate name per owner gives 400 (`services/chart_service.py:4341`), so it is reconciled by name + owner. |
| | 3 `POST /dashboards/{id}/charts` `{chart_id, layout:{…, draftOnly:true, gv:2}}` | dashboard edit | AppBI (server stamps `draftOwner`, `api/dashboards.py:2049`) | **Always `draftOnly:true`.** Without it the tile goes live (`dashboard_service.py:660-692`). Not deduped by AppBI, so it is reconciled by `chart_id` on the dashboard. |
| | 4 `PUT /dashboards/{id}/draft-filters` `{filters_config | slicers_config | pages_config, base_rev}` | edit | AppBI | `base_rev` = the latest `shared_draft.rev`. A 409 `shared_draft_stale` gives `conflict`. |
| `request_publish` (dashboard) | `GET /dashboards/{id}` | view | — | Fingerprint = `shared_draft.rev` + the `_v` of every tile in the caller's draft. |
| `publish` (dashboard) | `POST /dashboards/{id}/publish` `{tile_base_v:{every own draft tile}, force:false, keep_shared:<see note>, shared_ack_rev}` | dashboard edit (`api/dashboards.py:3009`) | AppBI co-editing guard | **Gap:** the per-tile check is skipped when the body or a tile id is absent (`:3022-3030`), so the MCP always sends the full map. Each 409 (`tiles changed`, `shared_draft_other_authors`, `responsive_conflict`) gives `conflict`. The MCP sets `keep_shared:true` when others hold shared-draft changes, so only the user's own work publishes. |

**Never called** (enforced by the allowlist and a test):
- `PUT /dashboards/{id}`
- `PUT /dashboards/{id}/layout`
- non-`draft=true` widget/tile PATCH/DELETE
- `POST /dashboards/report-starter`
- any `public-links` route
- `/auth/personal-access-tokens*` (from the server; the AppBI connect page is the browser, not the MCP)
- `/datasources/query`
- `/datasources/{id}/test`
- every `DELETE`

## 6. Observability and audit

- Each MCP request gets a `request_id`. It is sent to AppBI as `X-Request-ID` and
  written to MCP logs (JSON, one line per tool call) and to the MCP audit table.
  - The audit fields are `ts, request_id, user_id, client_id, grant_id, tool, args_sha256, outcome, appbi_status, resource_ids, duration_ms`.
  - Tokens, PATs and raw arguments are never logged.
  - AppBI has no request-id middleware (audit finding §7), so correlation is MCP-side only.
- `GET /mcp-oauth/healthz` (liveness) and `/readyz` (state DB writable **and** AppBI
  `/api/v1/health` reachable). Readiness failure never affects Core.
- AppBI-unavailable handling:
  - connect errors and 5xx on reads get one retry with jitter, then `appbi_unavailable`;
  - writes are **not** retried blindly. They go through the reconciliation path in §4.

## 7. Permissions summary

Who can do what is decided by AppBI. The MCP narrows it, never widens:

`effective = AppBI(user live authority ∩ PAT scope) ∩ MCP grant scope ∩ tool allowlist`

- A user without access gets AppBI's honest `403`/`404`, surfaced as `blocked` or
  `not_found`.
- A plan, approval or operation belonging to another user gives `not_found`. The MCP does
  not reveal that it exists.

## 8. Data

No AppBI schema change. MCP state lives only in the MCP's SQLite volume:
`clients, auth_txns, grants, tokens, plans, approvals, operations, operation_steps, audit`.

## 9. UI

- **New AppBI page `/connect/mcp`.** This exists only if Q1 is the recommended option.
  - States: signed out (normal login redirect then back), loading txn, txn
    expired/invalid, consent, submitting, error from the PAT API (e.g. scope above own
    rights gives an explanation).
  - The page uses the authed `apiClient`, matching Settings → Access tokens. It is not a
    public or embed surface.
- **MCP approval pages:** minimal server-rendered HTML with a CSRF-protected form and no
  external assets.

## 10. Edge cases

- **Plan source table renamed or dropped after planning:** reported as `stale_plan`.
- **Dataset name collision:**
  - On create, AppBI auto-suffixes the name. The MCP reports the actual name and does not
    treat it as an error.
  - On dashboard create, a collision is `blocked`.
- **Publish while an AppBI publish is already running** (started from the UI): the MCP
  attaches to that run and reports its outcome.
- **The user revokes the PAT mid-execution:** the step fails with `401`, the operation
  becomes `partially_failed (credential_revoked)`, and the grant is revoked.
- **Dataset `purpose=operational`:** publish is refused by AppBI and surfaced as
  `blocked`. MCP plans always set `reporting`.
- **No BigQuery host:** `sync_failed` with AppBI's message; the draft stays usable.
- **Very large schema:** `inspect_data_source` paginates by search.

## 11. Non-goals

- Editing or deleting existing charts.
- Theme/design changes and AI presentation planning.
- Chart edits are live and shared across dashboards (`PUT /charts/{id}`), so v1 never
  edits existing charts; it only creates new ones.
- Workboards.
- Calculated columns / transformations.
- SQL tables.
- Data quality rules.
- Multi-page dashboards. v1 uses the default page.

## 12. As built — deviations found by running it (2026-10-13)

Each change below came from a real client, browser or rig run, not from review.

| # | Spec said | Built | Why (evidence) |
|---|---|---|---|
| D1 | Connect page `/connect/mcp?txn=…` | **`/connect/mcp/<txn>`**: the txn is in the path | AppBI's login redirect keeps only the pathname (`middleware.ts` `next=pathname`), so a query would be lost for a signed-out user. |
| D2 | Callback answers `302` to the client | **`200` page with meta refresh** + a link | The connect page's CSP `form-action 'self'` (nginx) is enforced on redirects after a form POST, so a 302 to `claude.ai` would be blocked in Chrome. |
| D3 | 401 challenges `scope="appbi.read"` | **All three scopes** on the initial 401; a `403` names only the missing one | Clients use the challenge's scopes first. A read-only first grant would need a step-up that Claude may not perform. The user can still choose read-only on the consent page. |
| D4 | — | **`offline_access` accepted** at DCR/authorize (it grants nothing) | The SDK client, and Claude per its docs, add it because the AS metadata lists it, and DCR rejected it. Found by the first real connect. |
| D5 | Columns + preview via `GET /datasources/{id}/tables/{s}/{t}` | Columns via **`GET /datasets/datasources/{id}/tables/columns`**; the preview there is best-effort | That route 500s for every stored Postgres source (finding F1). |
| D6 | Chart metric aggs passed through | **Metrics on semantic measures are pinned to `agg: "auto"`**; a differing request is reported as a plan warning | An explicit chart agg OVERRIDES the measure type (`semantic_query_engine.py` ~1972). `sum` on a `count_distinct` measure returned `SUM(order_id)` = 4,501,500 instead of 3,000. The query was valid and the number wrong. |
| D7 | Chart name clash → suffix with the dashboard name | Short counter `Title (2)` | Chart names are unique per owner and render as tile titles. |
| D8 | `GET /dashboards/{id}` tile `_v` | `tile_base_v` = keys of the caller's `draft_layouts` with the live `_v` (default 0), **the Builder's exact rule** (`buildTileBaseV`) | Publish checks only the tiles it is given (`api/dashboards.py:3022`). |
| D9 | — | DNS-rebinding guard also accepts the public URL's bare hostname | nginx forwards `$host`, which drops the port. |

## 13. Core findings (reported, not changed here)

- **F1. `GET /datasources/{id}/tables/{schema}/{table}` fails for every stored PostgreSQL source.** Owner: Source Core, `services/datasource_service.py`.
  - **Repro:** on the rig as any user with view, the route returns `500 Failed to retrieve table details`. The log shows `password authentication failed`.
  - **Cause:** `get_table_detail` passes the stored, still-encrypted `config` to `_pg_table_detail` → `_pg_connect`. `get_schema_browser` calls `decrypt_config` first (around line 3880).
  - **Impact:** the AppBI UI's data-source table panel uses this route (`frontend/src/lib/api/datasources.ts:104`).
  - **Smallest fix:** `config = decrypt_config(config)` at the top of `get_table_detail` (as `get_schema_browser` does), plus a regression test.
  - **Not fixed here:** it is not an MCP blocker (D5 works around it), it is outside this branch's ownership, and no active branch fixes it (checked: `feat/source-core-hardening` is merged; `fix/dataset-final-hardening` has no newer commits).
- **F2. A PAT survives a password change.** `security_stamp` is not checked on the PAT path (`core/dependencies.py:108-161`).
  - **Impact:** a Claude connection outlives a password reset until its PAT expires (≤ 90 days) or is revoked.
  - **Owner:** authz.
- **F3. No request-id correlation in AppBI.** The MCP sends `X-Request-ID`, but AppBI neither logs nor audits it, so cross-service tracing joins on user + time.
- **F4. View PUT and dictionary PUT are last-write-wins.** The MCP re-reads and merges immediately before writing, but a concurrent UI edit in that window can still be lost. The proper fix is a version check in Core.
