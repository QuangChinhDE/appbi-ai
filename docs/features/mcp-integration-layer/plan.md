# External MCP Integration Layer — implementation plan

## Guardrail scoping

```bash
python scripts/ci/guardrail_check.py --json --plan "Independent Remote MCP server container calling AppBI HTTP APIs" \
  --files integrations/appbi-mcp/appbi_mcp/server.py docker-compose.mcp.yml docker-compose.yml nginx.conf \
          .github/workflows/mcp-integration.yml backend/app/api/personal_access_tokens.py \
          backend/app/core/authz/route_contract.json frontend/src/app/connect/mcp/page.tsx
```

- **Verdict:** `unknown`.
  - Every non-`.github` path is `UNKNOWN` layer. `.github/workflows/*` is `repo_infra`.
  - No feature or protected subsystem matched.
  - Notably, PAT/authz files (`api/personal_access_tokens.py`, `core/authz/*`) have **no
    feature mapping** in `guardrail_rules.yaml`.
- **Protected subsystems involved:** none edited.
  - The semantic layer and the dashboard publish lifecycle are *called*, not changed.
  - `.github/**` belongs to engineering infrastructure. Adding a new workflow is additive,
    and no existing gate is touched.
- **Required tests named:** only `tsc` (for the front-end page).
- `unknown` is **not** `safe`. Step 1 below teaches the rule base an
  `integrations_mcp` layer and feature, so later diffs are judged against real rules.
  This is a deliberate, declared change to `guardrail_rules.yaml` (additive, no
  weakening).

## Ownership and overlap

- **Owned by this branch:**
  - `integrations/appbi-mcp/**`
  - `docker-compose.mcp.yml`
  - `docs/features/mcp-integration-layer/**`
  - `.github/workflows/mcp-integration.yml`
  - the `/connect/mcp` page
- **Shared files touched, additive only, each isolated in its own commit for review:**
  - `docker-compose.yml`: one internal network on `backend`
  - `nginx.conf`: new `location`s
  - `.gitignore`: allow-list
  - `guardrail_rules.yaml`: new layer and feature
  - i18n catalog: connect-page strings
- **Not touched:**
  - `backend/app/**` (if Q1 = Connect page; the existing PAT API is reused as-is)
  - Agent Flow, Chat, semantic services, dashboard/dataset/chart services
- **Other active worktrees** (`wt-agent-flow-*`, `wt-chat-hardening`,
  `wt-dataset-hardening`, `wt-chart-hardening`, `wt-source-hardening`,
  `wt-observability`): none own the paths above.
  - `docker-compose.yml`, `nginx.conf` and `.gitignore` are the conflict-prone shared
    files. Before the PR the branch is rebased on the latest `origin/demo`, and those
    three are re-diffed by hand.

## Files and layers, in order

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `scripts/guardrail/guardrail_rules.yaml` | repo_infra | Add layer `integrations_mcp` (`integrations/appbi-mcp/**`, `docker-compose.mcp.yml`) and feature `mcp_integration` with its required tests. |
| 2 | `.gitignore` | repo_infra | `!integrations/appbi-mcp/tests/` + per-file `!…/test_*.py`. Without these the tests are silently ignored (`.gitignore:72-77`). |
| 3 | `integrations/appbi-mcp/pyproject.toml`, `requirements.lock` | integrations_mcp | Python 3.12, `mcp==2.2.0` (released 2026-09-07; 2.3.0 is 11 days old). Pin the exact versions of `httpx`, `cryptography` and `pydantic`. Use the package name `appbi_mcp`; a root `mcp/` directory would shadow the SDK. |
| 4 | `appbi_mcp/config.py` | integrations_mcp | Env: `MCP_PUBLIC_URL`, `APPBI_API_URL`, `APPBI_PUBLIC_URL`, `MCP_STATE_KEY`, limits, redirect/CIMD allowlists. Fail fast when a value is missing. |
| 5 | `appbi_mcp/state.py` | integrations_mcp | SQLite in WAL mode, schema plus version, Fernet helpers. Used only on the MCP volume. |
| 6 | `appbi_mcp/appbi_client.py` | integrations_mcp | httpx client with an **allowlist** of `(METHOD, path-template)`. Adds `X-Request-ID`, timeouts, the read-retry policy, maps errors to structured outcomes, and clamps/redacts output. |
| 7 | `appbi_mcp/oauth/*` | integrations_mcp | Metadata, DCR, CIMD fetch (SSRF guard), authorize/txn, AppBI callback, token/refresh rotation/reuse detection, revoke, and bearer verification middleware (401/403 + `WWW-Authenticate`). |
| 8 | `appbi_mcp/approvals.py` + templates | integrations_mcp | Approval pages: session cookie, CSRF, single-use, re-check against the plan hash and staleness. |
| 9 | `appbi_mcp/operations.py` | integrations_mcp | Plan/operation state machine, reconciliation, limits, wall budget. |
| 10 | `appbi_mcp/tools/{discovery,dataset,dashboard,publish}.py` | integrations_mcp | Tools from spec §5. Each one is a thin mapping onto `appbi_client` + `operations`, and none contains BI rules. |
| 11 | `appbi_mcp/server.py` | integrations_mcp | Starlette app: the MCP SDK Streamable HTTP app at `/mcp` (stateless, JSON responses), OAuth routes, health/ready, request-id and JSON logging, and per-grant rate limit. |
| 12 | `integrations/appbi-mcp/Dockerfile` | integrations_mcp | Multi-stage build on `python:3.12-slim`. Non-root UID, `HEALTHCHECK`, no build secrets, `APPBI_MCP_BUILD_SHA` label. |
| 13 | `docker-compose.mcp.yml` | integrations_mcp | Project `appbi-mcp` with service `appbi-mcp`. `read_only: true` + tmpfs, `cpus: 0.5`, `mem_limit: 512m`, `pids_limit`, `no-new-privileges`, `cap_drop: ALL`. Volume `appbi_mcp_state`. Networks: `mcp-ingress` (port `127.0.0.1:${MCP_PORT:-8090}:8090`) + external `appbi-mcp-link`. Its own `env_file: .env.mcp`, never `.env`. |
| 14 | `docker-compose.yml` (**Core, isolated commit**) | deploy | Add network `appbi-mcp-link` (`internal: true`, fixed name) to `backend` only, with alias `appbi-backend-api`. No other service changes. **Q2** |
| 15 | `nginx.conf` (**Core, isolated commit**) | deploy | `location /mcp`, `/mcp-oauth/` and `^~ /.well-known/oauth-` → `127.0.0.1:8090`, with `proxy_buffering off`, `proxy_read_timeout 300s`, and `Cookie` reduced to the `appbi_mcp_*` cookies only (a `map`). Its own `limit_req` zone. **Q3** |
| 16 | `frontend/src/app/(main)/connect/mcp/page.tsx` + i18n (**Core, isolated commit**) | fe_app | The consent page from spec §2.2. It calls only the existing PAT API, and the callback URL is a build-time constant. **Q1** |
| 17 | `integrations/appbi-mcp/tests/*` | tests | See below. |
| 18 | `.github/workflows/mcp-integration.yml` | repo_infra | Two jobs on the `integrations/appbi-mcp/**`, compose, nginx and `connect/mcp` paths: unit/contract tests, and image build + container smoke. Satisfies `verify.py`'s workflow checks (`ENVIRONMENT: test`, `METADATA_CATALOG_ENABLED`). |
| 19 | `integrations/appbi-mcp/README.md` + `docs/ops-runbook.md` section | docs | Enable/disable, env, rotation, monitoring, rollback, Claude setup steps. |

None of these rows crosses an architecture boundary. The MCP depends on AppBI only over
HTTP, the front-end page uses the authed client on an authed route, and nothing touches a
public surface.

## Risks

| Risk | How it shows up | What catches it |
|---|---|---|
| Endpoint drift between the MCP and AppBI (the documented failure of the old MCP) | 404/405/422 from an MCP tool | **Contract test**: every allowlisted `(method, path)` must exist in the backend's route table *and* the MCP's request bodies must validate against the backend Pydantic schemas. Built from `backend/app` source in CI with no running server, so drift fails the PR. |
| A live-write route gets used by accident | Draft bypass, a collaborator overwritten | Allowlist + a test asserting the forbidden routes from spec §5.3 are **not** in it; the acceptance test for concurrent edits |
| Token confusion (the MCP token used against AppBI, or a PAT presented to the MCP) | Privilege bypass | Tests: an MCP token rejected by AppBI, a PAT rejected by `/mcp`, a wrong-audience token rejected |
| Login-CSRF in connect | An attacker's Claude gets the victim's PAT | The txn cookie binding plus a negative test completing a txn from another browser context |
| PAT survives a password change (AppBI: the PAT path does not check `security_stamp`, `core/dependencies.py:209`) | A grant outlives the account's password reset | Residual risk, documented; the grant TTL is ≤ the PAT expiry (≤ 90 d). This is a Core gap reported to the authz owner and not fixed here. |
| Last-write-wins on view/dictionary PUT | A concurrent semantic edit lost | Re-read and merge right before the PUT; documented residual risk; Core gap reported (no version on view PUT) |
| Publish needs a BigQuery host | `sync_failed` in the rig | Q4. Reported **NOT VERIFIED** if no host is available. |
| Shared `appbi-net` name crosstalk on this machine (other rigs) | The test rig talks to another stack's backend | The rig uses project `appbi-mcprig` with **its own network names**, and is inspected before tests. |
| SDK major version churn (`mcp` 2.x is ~2.5 months old) | Transport incompatibility with Claude clients | Pinned version; a real-client test with Claude Code; a stateless JSON-response mode, which every protocol era accepts |

## Tests — decided now

| Test | New/existing | Locks |
|---|---|---|
| `tests/test_oauth_metadata.py` | new | Well-known documents, `resource` equality, `401` + `WWW-Authenticate` shape, no `offline_access` in PRM |
| `tests/test_oauth_flow.py` | new | DCR redirect policy; CIMD allowlist + SSRF guard; PKCE S256 only; `resource` mismatch gives `invalid_target`; code single-use/TTL; refresh rotation + reuse revokes the family; expired/revoked/wrong-aud gives 401; form-urlencoded token endpoint; `iss` in the redirect |
| `tests/test_connect_binding.py` | new | Callback requires the matching txn cookie; a foreign-browser completion is refused; a PAT is never logged; the PAT is encrypted at rest (read the raw SQLite) |
| `tests/test_allowlist_contract.py` | new | Every allowlisted route exists in `backend/app` (via an AST scan of `@router.*` + `include_router` prefixes); the forbidden list is absent; request models validate against the backend schemas |
| `tests/test_approvals.py` | new | GET never approves; CSRF required; cross-user approval refused; plan-hash mismatch refused; single-use; staleness gives `stale_plan` |
| `tests/test_operations.py` | new | Resume after a failure at each step; an ambiguous timeout reconciles instead of duplicating; concurrent `execute_plan` gives one runner; limits; redaction |
| `tests/test_tool_scopes.py` | new | Each tool → required scope; `403 insufficient_scope` header |
| `tests/integration/test_live_appbi.py` | new, rig-only | Journeys 2–8 and 10–13 against a **real** backend + Postgres. Wired into a manual/dispatch CI job, because CI has no BigQuery host. |
| `e2e/tests/mcp-dashboard-render.spec.ts` | new | Journeys 9 + 10 + 11 in a real browser: render, filter, values, concurrent edit |
| Existing: preflight, change-guardrail, product-gate (backend + e2e via the `docker-compose.yml`/`nginx.conf`/frontend changes), `tsc`, `npm run qa` | existing | Core unaffected |

New backend tests: none. If Q1 is changed to require a backend endpoint, its test is
added to the `.gitignore` allow-list **and** `backend-contract-tests.yml`, then
`git add -f`, and the route is declared in `core/authz/route_contract.json`.

## Verification (real runtime, on this branch's SHA)

1. **Isolated rig.** Compose project `appbi-mcprig` builds Core from **this worktree's
   SHA**, with its own Postgres, its own ports and its own network names, plus the MCP
   overlay.
   - Seed: the Olist PG sample (`olist` schema), and two users at different permission
     levels plus a read-only user, each minted through the real login.
2. **Real MCP clients.**
   - The official `mcp` SDK client with its OAuth provider performs the full PRM → AS
     metadata → DCR → authorize → connect → token flow, with Playwright driving the
     consent and approval pages.
   - **Claude Code** (`claude mcp add --transport http appbi http://localhost:<port>/mcp`)
     connects and lists tools. This step needs the user's interactive browser for OAuth;
     if that is not possible in this session it is reported **NOT VERIFIED**.
3. **Journeys 5–7 and 14.** Values are checked against independent SQL run directly in the
   rig's Postgres by the *test harness*. The MCP itself never touches Postgres.
4. **Journeys 9–11** in Playwright, with screenshots in `.artifacts/mcp/`.
5. **Journey 13.**
   - `docker compose -p appbi-mcprig-mcp stop`: the Core health check and an e2e smoke
     stay green.
   - Core started with only `docker-compose.yml`: unchanged.
   - Kill the backend while a plan executes: the run ends `partially_failed`, then resumes
     after the backend returns.
6. `python scripts/ci/verify.py task` must pass. Every `NOT VERIFIED` gate is listed in
   the report.

## Rollback

- **MCP only:**
  - `docker compose -p appbi-mcp -f docker-compose.mcp.yml down`.
  - Remove the nginx `/mcp*` locations, or leave them, since they `502` harmlessly.
  - Core is unaffected.
  - Grants become unusable. The PATs remain in AppBI until they expire or the user revokes
    them. To kill them all, revoke them in Settings → Access tokens (admin view), filtering
    on the "Claude MCP" name.
- **Core commits** (network, nginx, connect page) each revert independently. Removing the
  network makes compose recreate the backend once.
- **Data:** MCP state lives only in the `appbi_mcp_state` volume. Deleting it revokes every
  Claude connection, and nothing in Core is lost. AppBI resources created through the MCP
  are ordinary AppBI resources and stay.

## Milestones (each ends green on its own)

| Milestone | Delivers |
|---|---|
| **M0** | Guardrail layer, gitignore, MCP skeleton, image, compose overlay, health, contract test. **Core untouched** (except the network if Q2 is approved). |
| **M1** | OAuth AS + connect flow + bearer enforcement. Journeys 1–3 with the SDK client. |
| **M2** | Discovery + Dataset plan/execute/publish + approvals + operations. Journeys 4–7 and 12. |
| **M3** | Dashboard plan/execute/publish. Journeys 8–11 and 14 (browser). |
| **M4** | Docs/runbook, CI workflow, rebase on the latest `origin/demo`, full re-run, final report (A–L). |
