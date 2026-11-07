# Public Claude — deploy

Viewers of a Public Report / Public Dashboard can ask **their own Claude** (their own
Claude subscription) inside the AI Bot panel. AppBI uses no AI key of the publisher.
Claude reads only the link's published charts (aggregates, locked/hidden filters
enforced) and changes only the viewer's own view (filter, page, focus, drill).

It is **optional and separate from Core**: starting, stopping or upgrading it never
restarts Core. Deploy it **before** switching "Claude access" on for any link.

## TL;DR

```bash
git pull
APPBI_PUBLIC_HOST=report.example.com CLAUDE_RT_POOL=2 python3 scripts/deploy/public_claude.py up
# nginx: the repo's nginx.conf already has the locations -> copy, nginx -t, reload (see "nginx")
python3 scripts/deploy/public_claude.py status
```

The first `up` creates `.env.public-claude` (mode 0600, gitignored) with a random state key
and one secret per runtime; later runs reuse it. Change the pool by editing
`CLAUDE_RT_POOL` in that file and running `up` again.

| Command | Does |
|---|---|
| `up` | create missing secrets, size the pool, build + start, wait for health, print status |
| `status` | public-mcp health, each seat free / in use, RAM/CPU per container |
| `logs` | the runtimes' per-answer log lines |
| `down` | stop Public Claude (Core keeps running) |

## What runs

| Service | What | Port (loopback) |
|---|---|---|
| `public-mcp` | Public Read MCP + report bridge + runtime pool + reaper | `8091` |
| `claude-rt-N` | one isolated Claude Code runtime = **one concurrent viewer** | `810N` |

A runtime has a read-only root, no capabilities, its own network (it sees `public-mcp`
and the internet for Anthropic only: no DB, no backend, no other runtime), and keeps
the viewer's Claude login **only in memory (tmpfs)**. When a session ends (sign-out,
tab gone 5 min, idle 30 min, link revoked) the runtime restarts clean.

`docker-compose.public-claude.yml` declares public-mcp and runtimes 1–2. For a pool of
3–9 the script writes `docker-compose.public-claude.pool.yml` (gitignored) with the rest.
Do not hand-edit either; change `CLAUDE_RT_POOL`.

## Sizing

| State | RAM per runtime | CPU |
|---|---|---|
| free | ~12 MB | ~0 |
| viewer signed in, waiting | ~15–35 MB | ~0 |
| answering (pilot: ~35 s for a 5-tool question) | peak ~300–500 MB (see `peak_rss_mb` in `logs`) | up to 1 core, bursts |

The model runs at Anthropic. Limits per runtime: `CLAUDE_RT_MEM=768m`, `CLAUDE_RT_CPUS=1.0`
(override in `.env.public-claude`).

| VM | `CLAUDE_RT_POOL` |
|---|---|
| 2 vCPU / 8 GB | 2 |
| 4 vCPU / 16 GB | 3–5 |

Pool size = concurrent signed-in viewers; the next one sees "All Claude seats are in use".

## nginx

**Using the repo's `nginx.conf`** (the standard deploy): it already carries everything —
`upstream appbi_public_mcp`, `/public-mcp`, `/_rt_auth`, `/claude-rt/[1-9]/api/...`. Copy it,
`sudo nginx -t && sudo systemctl reload nginx`. Nothing changes when the pool grows.

**Server with its own nginx file** — add these, then `nginx -t` and reload:

```nginx
# http { ... } level (skip lines you already have)
upstream appbi_public_mcp { server 127.0.0.1:8091; keepalive 16; }
limit_req_zone $binary_remote_addr zone=mcp_rl:10m rate=20r/s;

# inside the app's server { listen 443 ...; } block, BEFORE "location /"
location ~ ^/(public-mcp(/.*)?|public-mcp-oauth/.*|\.well-known/oauth-protected-resource/public-mcp|\.well-known/oauth-authorization-server/public-mcp-oauth|\.well-known/openid-configuration/public-mcp-oauth)$ {
    limit_req zone=mcp_rl burst=40 nodelay;
    proxy_pass http://appbi_public_mcp;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 1m;
    proxy_buffering off;
    proxy_read_timeout 90s;
}
location = /_rt_auth {
    internal;
    proxy_pass http://appbi_public_mcp/public-mcp/runtime-auth;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header Cookie $http_cookie;
}
location ~ ^/claude-rt/([1-9])/api/(chat|status|reset|history|rate|signin/start|signin/code)$ {
    auth_request /_rt_auth;
    proxy_pass http://127.0.0.1:810$1/api/$2;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Cookie "";
    proxy_buffering off;
    proxy_read_timeout 330s;
    client_max_body_size 64k;
}
location /claude-rt/ { return 404; }   # plain prefix: NOT "^~" (that would beat the regex above)
```

## Check (after `up` + nginx reload)

1. `python3 scripts/deploy/public_claude.py status` → `public-mcp healthz: ok`, every seat `free`.
2. `curl -s https://<host>/public-mcp/healthz` → `{"status":"ok",...}`
3. `curl -s -o /dev/null -w '%{http_code}' https://<host>/claude-rt/1/api/status` → **403**
   (no lease cookie). `404` here means the nginx locations are missing or a `^~` prefix
   shadows them.
4. A runtime reaches the MCP through this host:
   `docker exec appbi-public-claude-claude-rt-1-1 curl -s https://<host>/public-mcp/healthz` → ok.
   If it hangs, the host firewall blocks docker bridge → host:443 (e.g. `ufw allow in on docker0 to any port 443`).
5. Isolation: `docker exec appbi-public-claude-claude-rt-1-1 curl -m3 http://appbi-backend-api:8000/` must fail.
6. In AppBI, on ONE test link: Share → "Claude access" on (optionally "share the AI Bot
   instructions", "keep Claude conversations"). Private window → AI Bot → Claude →
   "Sign in to Claude" → Authorize → Copy Code → come back (signs in by itself). Ask a
   question, apply a filter, rate the answer; `logs` shows one `answer` line.
7. Then switch Claude access on for the links users will use.

## Logs

`python3 scripts/deploy/public_claude.py logs` — one JSON line per event, operational
facts only (never the question, the answer, a code or a token):

```json
{"ts":"…","runtime":"1","event":"answer","wall_ms":35120,"duration_ms":33800,"tool_calls":5,
 "tools":["mcp__appbi-report__get_view_state","…"],"peak_rss_mb":412,"model":"claude-…","error":null,"turn":3}
```

Other events: `lease` (a viewer got the seat), `signin_start`, `signin` (`ok`, `error`),
`recycle` (session ended, seat cleaned).

## Upgrading

`git pull` → `python3 scripts/deploy/public_claude.py up`. **Restarting a runtime signs its
viewer out** (the login is in memory by design): upgrade out of hours.

## Data kept

- With "keep Claude conversations" on (default): question, answer, report actions and
  view state per turn, in the AI Bot's own turn tables (`public_answer_turns`,
  `report_answer_turns`), plus the viewer's 👍/👎. Token-like strings are redacted.
  Retention `PUBLIC_CLAUDE_HISTORY_DAYS` (backend `.env`, default 90).
- Never kept: Claude passwords, OAuth tokens or codes.
