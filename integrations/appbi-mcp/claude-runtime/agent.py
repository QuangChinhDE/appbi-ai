"""Runtime agent: one Claude Code runtime of the Public Report pool (no Docker access needed).

Runs inside the runtime container as the unprivileged user, next to the UNMODIFIED Claude
Code binary. It answers only the Public MCP (shared secret, internal network):

  GET  /health   -> {"state": "idle"|"leased", "lease": id|null}
  POST /lease    {"lease_id", "mcp_url", "mcp_token"}  -> configures Claude Code for ONE viewer
  POST /recycle  -> ends the lease: the process exits and Docker restarts the container with
                    empty tmpfs (home, /tmp) on a read-only root: a clean environment, no
                    credential, config or history of the previous viewer survives.

What the viewer's Claude may use is set here with Claude Code's own settings:
  - the report's Public MCP only (`mcp__appbi-report__*`); Bash, file, web and agent tools denied;
  - claude.ai account connectors off (ENABLE_CLAUDEAI_MCP_SERVERS=false);
  - an empty working folder, trusted, so no first-run prompt can exit the session.
Sign-in stays Claude Code's own /login flow, in the viewer's own browser.
"""
from __future__ import annotations

import hmac
import json
import os
import signal
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
WORK = os.path.join(HOME, "report")
SECRET = os.environ.get("RUNTIME_SECRET", "")
INDEX = os.environ.get("RUNTIME_INDEX", "1")
STATE = {"lease": None, "ttyd": None}
LOCK = threading.Lock()

DENY = ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "WebFetch",
        "WebSearch", "Task", "Agent", "TodoWrite", "KillShell", "BashOutput", "Skill", "SlashCommand"]

SYSTEM_NOTE = (
    "You are helping a viewer of ONE AppBI public report through the appbi-report tools. "
    "Answer only about this report. Read numbers with read_chart and cite the report, chart, filters and as-of. "
    "Compute derived numbers with the calculate tool and label them as your own calculation, not an AppBI metric. "
    "Use the view tools to change what the viewer sees when they ask. Reply in the viewer's language."
)


def _write(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)


def configure(mcp_url: str, mcp_token: str) -> None:
    os.makedirs(WORK, exist_ok=True)
    # Claude Code's own config: onboarding done, folder trusted, the report's MCP with this
    # viewer session's token (an AppBI token for ONE view session — never a Claude credential).
    _write(os.path.join(HOME, ".claude.json"), {
        "hasCompletedOnboarding": True,
        "theme": "light",
        "projects": {WORK: {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True, "allowedTools": []}},
        "mcpServers": {"appbi-report": {"type": "http", "url": mcp_url,
                                        "headers": {"Authorization": f"Bearer {mcp_token}"}}},
    })
    _write(os.path.join(HOME, ".claude", "settings.json"), {
        "permissions": {"allow": ["mcp__appbi-report"], "deny": DENY, "defaultMode": "default"},
        "enableAllProjectMcpServers": False,
        "env": {"ENABLE_CLAUDEAI_MCP_SERVERS": "false", "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1"},
    })
    with open(os.path.join(WORK, "CLAUDE.md"), "w", encoding="utf-8") as f:
        f.write(SYSTEM_NOTE + "\n")


def start_ttyd() -> subprocess.Popen:
    env = dict(os.environ, ENABLE_CLAUDEAI_MCP_SERVERS="false", DISABLE_AUTOUPDATER="1")
    env.pop("RUNTIME_SECRET", None)
    # When Claude Code exits, the lease is over: recycle (no shell is ever offered).
    cmd = ["ttyd", "-p", "7681", "-b", f"/claude-rt/{INDEX}", "-W", "-o", "-t", "fontSize=15",
           "-t", "titleFixed=Claude", "-t", 'theme={"background":"#ffffff","foreground":"#1f2937","cursor":"#1f2937","selectionBackground":"#c7d2fe"}',
           "-t", "disableLeaveAlert=true",
           "bash", "-c", f"cd {WORK} && claude --permission-mode default; curl -s -X POST -H 'X-Runtime-Secret: {SECRET}' http://127.0.0.1:8099/recycle >/dev/null"]
    return subprocess.Popen(cmd, env=env, cwd=WORK)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # no request logging (the token travels in a body)
        pass

    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        got = self.headers.get("X-Runtime-Secret", "")
        return bool(SECRET) and hmac.compare_digest(got, SECRET)

    def do_GET(self):
        if self.path != "/health":
            return self._send(404, {"error": "not_found"})
        self._send(200, {"state": "leased" if STATE["lease"] else "idle", "lease": STATE["lease"], "index": INDEX})

    def do_POST(self):
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        if self.path == "/lease":
            with LOCK:
                if STATE["lease"]:
                    return self._send(409, {"error": "busy", "lease": STATE["lease"]})
                configure(str(body["mcp_url"]), str(body["mcp_token"]))
                STATE["ttyd"] = start_ttyd()
                STATE["lease"] = str(body["lease_id"])
            return self._send(200, {"ok": True, "panel_path": f"/claude-rt/{INDEX}/"})
        if self.path == "/recycle":
            self._send(200, {"ok": True})
            threading.Timer(0.3, lambda: os.kill(1, signal.SIGTERM)).start()  # tini -> container exits -> restart clean
            return None
        return self._send(404, {"error": "not_found"})


if __name__ == "__main__":
    if not SECRET:
        print("RUNTIME_SECRET is required", file=sys.stderr)
        sys.exit(2)
    ThreadingHTTPServer(("0.0.0.0", 8099), Handler).serve_forever()
