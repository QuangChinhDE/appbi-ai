# Public Claude — deploy checklist

Viewers of a Public Report / Public Dashboard can ask **their own Claude** (their own
Claude subscription) inside the AI Bot panel. AppBI uses no AI key of the publisher.
Claude reads only the link's published charts (aggregates, locked/hidden filters
enforced) and changes only the viewer's own view (filter, page, focus, drill).

It is **optional and separate from Core**. Without it, everything else works; a link
with "Claude access" switched on shows the option but cannot connect. So deploy this
**before** switching Claude access on for any link.

## What runs

| Service | What | Port (loopback) |
|---|---|---|
| `public-mcp` | Public Read MCP + report bridge + runtime pool + reaper | `8091` |
| `claude-rt-N` | one isolated Claude Code runtime = **one concurrent viewer** | `810N` |

A runtime has a read-only root, no capabilities, its own network (sees `public-mcp`
and the internet for Anthropic only: no DB, no backend, no other runtime), and keeps
the viewer's Claude login **only in memory (tmpfs)**. When a session ends (sign-out,
tab gone 5 min, idle 30 min, link revoked) the runtime restarts clean.

## Sizing

Measured on the test rig (Claude Code, Opus):

| State | RAM per runtime | CPU |
|---|---|---|
| idle (no viewer) | ~12 MB | ~0 |
| viewer signed in, waiting | ~15–35 MB | ~0 |
| answering (a few seconds per question) | up to ~300–500 MB peak | up to 1 core, short bursts |

The model runs at Anthropic; the runtime only drives the CLI and the MCP calls, so the
VM cost is memory headroom and short CPU bursts. Limits per runtime: `mem_limit 768m`,
`cpus 1.0`.

| VM | Suggested pool |
|---|---|
| 2 vCPU / 8 GB (pilot) | **2 runtimes** (the default in the compose file) |
| 4 vCPU / 16 GB | 3–4 runtimes |

Pool size = concurrent signed-in viewers. The next viewer sees "All Claude seats are in
use, try again in a few minutes"; a seat frees when someone ends the session or leaves.

## Checklist

1. Core is up (it creates the `appbi-mcp-link` network).
2. On the server, create `.env.public-claude` next to the compose file (never commit it).
   Core's `.env` is not read and needs no change:
   ```bash
   APPBI_PUBLIC_HOST=report.example.com          # as viewers open it: no scheme, no slash
   PUBLIC_MCP_STATE_KEY=<Fernet key, NOT MCP_STATE_KEY>
   #   python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   CLAUDE_RT_SECRET_1=<random>                   # one per runtime:
   CLAUDE_RT_SECRET_2=<random>                   #   python3 -c "import secrets; print(secrets.token_urlsafe(32))"
   # optional: CLAUDE_RT_MEM=768m  CLAUDE_RT_CPUS=1.0  PUBLIC_MCP_PORT=8091
   ```
   `PUBLIC_MCP_URL` in the backend stays empty (same origin; nginx routes `/public-mcp`).
3. Build and start (Core is not restarted):
   ```bash
   GIT_SHA=$(git rev-parse --short HEAD) docker compose -p appbi-public-claude \
     -f docker-compose.public-claude.yml --env-file .env.public-claude up -d --build
   ```
4. nginx: the repo's `nginx.conf` already carries the Public Claude locations
   (`/public-mcp`, `/_rt_auth`, `/claude-rt/N/api/...`). Copy it to the host as usual and
   `sudo nginx -t && sudo systemctl reload nginx`. The runtime index class `[1-2]` must
   match the pool size.
5. Check:
   - `curl -s https://<host>/public-mcp/healthz` → `{"status":"ok",...}`
   - `curl -s -o /dev/null -w '%{http_code}' https://<host>/claude-rt/1/api/status` → `403`
     (no lease cookie: refused — correct)
   - `docker ps` shows `public-mcp` healthy and `claude-rt-1..N` up.
   - A runtime reaches the MCP through this host's nginx:
     `docker exec appbi-public-claude-claude-rt-1-1 curl -s https://<host>/public-mcp/healthz` → `ok`.
     If it hangs, the host firewall blocks the docker bridge → host:443 (allow it, e.g.
     `ufw allow in on docker0 to any port 443` / the compose bridge interface).
   - Isolation: from a runtime, `curl -m3 http://appbi-backend-api:8000/` must fail.
6. In AppBI, on ONE test link: Share → "Claude access" on (optionally "share the AI Bot
   instructions" and "keep Claude conversations"). Open the link in a private window →
   AI Bot → Claude → "Sign in to Claude" → Authorize → Copy Code → come back: the panel
   signs in by itself. Ask a question, apply a filter, rate the answer.
7. Only then switch Claude access on for the links users will use.

## Growing the pool

Copy `claude-rt-2` → `claude-rt-3` in the compose file (index `3`, its own secret, port
`8103`, network `rtnet3` declared and added to `public-mcp`), append its URL to
`PUBLIC_MCP_RUNTIMES` and its secret to `PUBLIC_MCP_RUNTIME_SECRET` (same order), widen
`[1-2]` → `[1-3]` in nginx, then `up -d` and reload nginx.

## Upgrading

`git pull` → rebuild with the new `GIT_SHA` → `up -d`. **Restarting a runtime signs its
viewer out** (the login is in memory by design). Prefer upgrading out of hours, or
upgrade `public-mcp` alone (`up -d public-mcp`: sessions survive, its state is on a volume).

## Data kept

- With "keep Claude conversations" on (default): question, answer, report actions and
  view state per turn, in the AI Bot's own turn tables (`public_answer_turns`,
  `report_answer_turns`), plus the viewer's 👍/👎. Token-like strings are redacted.
  Retention `PUBLIC_CLAUDE_HISTORY_DAYS` (backend `.env`, default 90).
- Never kept: Claude passwords, OAuth tokens or codes.
