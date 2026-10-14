# AppBI MCP integration (Claude connector)

An independent service that lets Claude (claude.ai, Claude Desktop, Claude Code)
build AppBI **Datasets** and **Dashboards** for a signed-in AppBI user, through
AppBI's own HTTP APIs and permissions.

Design, decisions and contracts: `docs/features/mcp-integration-layer/{intent,spec,plan}.md`.

```
Claude ──HTTPS──► nginx ─/mcp, /mcp-oauth/*, /.well-known/oauth-*──► appbi-mcp (own container)
                                                                       │ user's own scoped PAT
                                                                       ▼  (internal network only)
                                                         AppBI backend /api/v1  (no DB access)
```

## What it guarantees

- **Runs as the real user.** Each Claude connection holds that user's own AppBI
  personal access token. AppBI creates the token on the user's "Connect Claude"
  page. The token is scoped, has an expiry, is visible under **Settings → API
  tokens**, and AppBI caps it at the user's live rights on every request. There is
  no shared admin credential.
- **No token passthrough.** Claude's token is issued for this server only, and AppBI
  rejects it. The AppBI PAT never leaves the service and is Fernet-encrypted at rest.
- **AppBI decides validity.** The following AppBI checks are authoritative:
  - the join fan-out guard;
  - measure dry-run through the semantic engine;
  - `POST /charts/dry-run-create` for every chart;
  - model health;
  - dashboard co-editing guards.

  This service adds no BI rules of its own.
- **Drafts first, approvals in the browser.**
  - Writes happen only after the user approves the exact plan on an approval page
    that a model cannot submit.
  - Everything is created as the user's draft: tiles are `draftOnly` and filters go
    into the shared draft with `base_rev`.
  - Publishing is a second, separate approval.
  - Public links are never created.
- **Exactly once, resumable, never destructive.**
  - Every write step is recorded.
  - A retry or timeout reconciles with AppBI before writing again.
  - Failures report what already exists, with links.
  - Nothing is deleted.
- **Allowlisted.** The service can call only ~38 AppBI routes. Live-write routes
  are unreachable, along with public links, PATs, SQL execution and every `DELETE`.
  A test checks this against the backend's route table.

## Tools

| Scope | Tools |
|---|---|
| `appbi.read` | `whoami`, `list_data_sources`, `inspect_data_source`, `inspect_source_table`, `list_datasets`, `get_dataset`, `profile_dataset_table`, `list_dashboards`, `get_dashboard`, `get_chart_data`, `plan_dataset`, `plan_dashboard`, `request_publish`, `get_operation_status`, `get_publish_status` |
| `appbi.author` | `execute_plan` (approved plan → drafts) |
| `appbi.publish` | `publish` (approved publish request) |

## Configuration

Set these in the environment of `docker compose -p appbi-mcp -f docker-compose.mcp.yml …`.
None of them are AppBI Core secrets.

| Variable | Required | Meaning |
|---|---|---|
| `MCP_PUBLIC_URL` | yes | Public origin Claude connects to, e.g. `https://report.example.com`. The endpoint is `<origin>/mcp`. |
| `MCP_STATE_KEY` | yes | Fernet key that encrypts stored AppBI tokens. Generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`. Rotating it disconnects every user (they reconnect). Keep it in your secret store. |
| `APPBI_PUBLIC_URL` | no | AppBI origin for the connect page and links (defaults to `MCP_PUBLIC_URL`). |
| `APPBI_API_URL` | no | Default `http://appbi-backend-api:8000/api/v1` (the internal network). |
| `MCP_PORT` | no | Loopback host port nginx proxies to (default `8090`). |
| `MCP_CIMD_ALLOWED_HOSTS` | no | Hosts whose OAuth Client ID Metadata Documents are fetched (default `claude.ai`). |
| `MCP_EXTRA_REDIRECT_URIS` | no | Extra OAuth redirect URIs. The defaults are Claude's callbacks and loopback. |
| `MCP_RATE_LIMIT_PER_MINUTE` | no | Per-connection tool-call budget (default 60). |
| `MCP_MAX_CONCURRENT_OPERATIONS` | no | Per-user concurrent plan executions (default 2). |
| `MCP_LOG_LEVEL` | no | Default `INFO`. |

## Deploy

1. **Core** must be running with the current `docker-compose.yml` (declares the internal
   `appbi-mcp-link` network on the backend only). **Applying that compose change recreates the
   backend container once** — rehearsed: ~21 s of failed health checks on a loaded dev host
   (`docker compose up -d` with the new file). Ship it **with a normal Core deploy** (which
   recreates the backend anyway) or in a maintenance window. After that, starting, stopping,
   upgrading or rolling back the MCP never touches Core (rehearsed: no failed health sample,
   same backend container).
2. **nginx:** the current `nginx.conf` already routes `/mcp`, `/mcp-oauth/` and
   `/.well-known/oauth-*` to `127.0.0.1:8090`. It forwards only `appbi_mcp_*`
   cookies and does not buffer.
   - Run `nginx -t && systemctl reload nginx`.
   - While the MCP is not running these routes answer `502`, and nothing else is
     affected.
3. **Start the MCP:**
   ```bash
   export MCP_PUBLIC_URL=https://report.example.com MCP_STATE_KEY=<from your secret store>
   GIT_SHA=$(git rev-parse --short HEAD) docker compose -p appbi-mcp -f docker-compose.mcp.yml up -d --build
   curl -s https://report.example.com/mcp-oauth/readyz     # {"status":"ready",...}
   ```
4. **Anthropic's egress** (`160.79.104.0/21`) must reach `MCP_PUBLIC_URL`. The nginx
   `allow` list must not block it.

## Connect Claude

The connector URL is `https://<your AppBI host>/mcp`.

- **claude.ai / Claude Desktop:**
  1. Go to Settings → Connectors → *Add custom connector*.
  2. Name it "AppBI", paste the URL, and click Add, then Connect.
  3. AppBI opens. Sign in as usual, review what Claude may do (optionally choose
     *Read only*), and click **Allow**.
- **Claude Code:**
  1. Run `claude mcp add --transport http appbi https://<host>/mcp`.
  2. In a session, run `/mcp` → appbi → Authenticate, and use the same AppBI page.
- **Using it:** ask, for example, *"Build a dataset from the orders, customers and
  products tables, then a sales dashboard with revenue KPIs and a region filter"*.
  Claude shows a plan and an approval link. Open it, check the summary, and
  approve. Approve the publish the same way.
- **Disconnecting:** revoke the "Claude MCP · …" token in **AppBI → Settings → API
  tokens**. The connection stops on its next call.

### Claude Desktop against a local, plain-HTTP AppBI

Claude's built-in connectors need HTTPS. For a local AppBI (for example
`http://localhost:3000`), Claude Desktop reaches the MCP through a local bridge.
The user never sees or copies a token: the connection is still AppBI sign-in plus
consent, and AppBI creates and stores the PAT itself.

1. **One entry point.** The browser address users already use must also serve
   `/mcp`, `/mcp-oauth/*` and `/.well-known/oauth-*`. Put a reverse proxy on that
   address with the same `location`s as `nginx.conf`, and set
   `MCP_PUBLIC_URL = APPBI_PUBLIC_URL = <that address>`. Do not give MCP a second,
   user-facing port: the connect page posts to a relative `/mcp-oauth/…` path.
2. **Add the bridge** (pinned) to `claude_desktop_config.json` under `mcpServers`:
   ```json
   "appbi": {
     "command": "node",
     "args": ["<path>/node_modules/mcp-remote/dist/proxy.js", "http://localhost:3000/mcp",
              "--transport", "http-only", "--allow-http", "--auth-timeout", "1800"]
   }
   ```
   Install it with `npm install --ignore-scripts mcp-remote@0.1.38`. A long
   `--auth-timeout` matters: with the 300 s default, the bridge gave up before people
   had finished signing in.
3. **Restart Claude Desktop.** A browser tab opens on the AppBI sign-in page. Sign in
   as **yourself**, choose read-only (forced for view-only accounts) and an expiry
   (7 days for trials), then click **Allow**.
4. **Disconnect.** Revoke the token in AppBI → Settings → API tokens. Claude reports
   that the connection is no longer accepted. To reconnect, restart Claude Desktop
   and sign in again.

Known with this bridge: AppBI lists the connection as "MCP CLI Client", because that
is the name the bridge registers under. On a read-only connection, a write call is
refused with HTTP 403 (`insufficient_scope`). The bridge treats that as a step-up
sign-in and waits, so Claude reports a timeout instead of "read only".

## Operate

- **Health:**
  - `GET /mcp-oauth/healthz` checks the process.
  - `GET /mcp-oauth/readyz` checks the state store and AppBI reachability; it
    returns 503 when AppBI is down.
  - The container `HEALTHCHECK` uses `healthz`.
- **Logs:** one JSON line per event on stdout, with a `request_id` that is also
  sent to AppBI as `X-Request-ID`. Tokens and arguments are never logged.
- **Audit:** the `audit` table in `/data/appbi_mcp.sqlite3` records one row per
  tool call: user, client, tool, argument hash, outcome, AppBI status, resource ids
  and duration. Rows are kept for 180 days.
- **Limits:**
  - 0.5 CPU, 512 MB, 128 pids, read-only rootfs, all capabilities dropped,
    non-root (uid 10001);
  - 4 MB request body;
  - plans: ≤ 12 tables, ≤ 40 measures, ≤ 24 charts;
  - a 10-minute budget per execution.
- **Single replica:** OAuth state and rate limits live in this process and its
  volume. Scale vertically.

## Roll back / disable

```bash
docker compose -p appbi-mcp -f docker-compose.mcp.yml down        # Core keeps running; /mcp → 502
```

- Deleting the `appbi_mcp_state` volume forgets every Claude connection. The
  "Claude MCP" tokens still exist in AppBI until they expire; revoke them under
  Settings → API tokens (admins: *All tokens*).
- Datasets and dashboards created through Claude are ordinary AppBI resources and
  stay.
- The Core changes (the network in `docker-compose.yml`, the nginx locations and the
  `/connect/mcp` page) can each be reverted on their own.

## Tests

```bash
python scripts/run_offline_tests.py                       # offline: OAuth, allowlist ⊆ backend routes, approvals, operations
python scripts/run_offline_tests.py -m live tests/live    # live: needs the acceptance rig (below)
```

**Acceptance rig.** The rig is Core built from this branch, the MCP container and
an nginx front on `localhost:18180`, all isolated from other stacks:

1. Compose Core with `tests/live/rig/docker-compose.rig.yml`, which sets its own
   network names and subnet.
2. Seed `tests/live/rig/seed_shop.sql` into a `shopsrc` database.
3. Run `tests/live/rig/bootstrap_rig.py`. It takes admin/DB credentials from the
   environment and writes `APPBI_RIG_STATE`.
4. Start the MCP with `MCP_PUBLIC_URL=http://localhost:18180`.
5. Put `tests/live/rig/nginx.rig.conf` in front.

The live suite drives the official MCP SDK client (OAuth: discovery, DCR, PKCE,
refresh) and a real Chromium (AppBI login, Allow, approvals). It checks every number
against the deterministic seed.
