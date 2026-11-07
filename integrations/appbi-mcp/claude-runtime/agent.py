"""Runtime agent: one Claude Code runtime of the Public Report pool (no Docker access needed).

Runs inside the runtime container as the unprivileged user, next to the UNMODIFIED Claude
Code binary.

Control (the public MCP only; this runtime's own secret):
  GET  /health   -> {"state": "idle"|"leased", "lease": id|null}
  POST /lease    {"lease_id", "mcp_url", "mcp_token"}  -> configures Claude Code for ONE viewer
  POST /recycle  -> ends the lease: the process exits and Docker restarts the container with
                    empty tmpfs (home, /tmp) on a read-only root: a clean environment, no
                    credential, config or history of the previous viewer survives.

Viewer (reached ONLY through the edge, which lets in only the browser holding this lease's
cookie; this runtime's network holds nothing else but the edge and the public MCP):
  GET  /api/status -> {"signed_in": bool}
  POST /api/chat   {"message"} -> NDJSON stream of Claude Code's own events (`claude -p
                    --output-format stream-json`), the conversation resumed across messages
  POST /api/reset  -> a new conversation
  GET  /api/history -> the conversation so far (this runtime's memory: a reload of the
                    viewer's tab shows it again; gone with the runtime)
History: each finished turn (question, answer, report tools used) is reported to the public
MCP with this runtime's secret, which has AppBI keep it when the publisher keeps history.
Never in it: the viewer's Claude credential (this agent never sees one) or the MCP token.
Sign-in: the panel shows Claude Code's own `claude auth login` (ttyd, port 7681): the viewer
completes it with Anthropic in their own browser. This agent never reads, stores or relays a
Claude credential; it only checks that Claude Code has one.

What the viewer's Claude may use is set with Claude Code's own settings: the report's Public
MCP only (`mcp__appbi-report__*`), every built-in tool denied, claude.ai connectors off.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import select
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
WORK = os.path.join(HOME, "report")
SECRET = os.environ.get("RUNTIME_SECRET", "")
INDEX = os.environ.get("RUNTIME_INDEX", "1")
STATE = {"lease": None, "session": None, "login": None, "brief": "", "turns": []}
PUBLIC_MCP = os.environ.get("PUBLIC_MCP_INTERNAL", "http://public-mcp:8091").rstrip("/")
MAX_TURNS_KEPT = 100
LOCK = threading.Lock()
CHAT = threading.Lock()
MAX_MESSAGE = 4000
CHAT_TIMEOUT = 300

DENY = ["Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "WebFetch",
        "WebSearch", "Task", "Agent", "TodoWrite", "KillShell", "BashOutput", "Skill"]

SYSTEM_NOTE = (
    "You are helping a viewer of ONE AppBI public report through the appbi-report tools. "
    "Answer only about this report. Read numbers with read_chart and cite the report, chart, filters and as-of. "
    "Compute derived numbers with the calculate tool and label them as your own calculation, not an AppBI metric. "
    "Use the view tools to change what the viewer sees when they ask, and say what you changed. "
    "Reply in the viewer's language, concisely, in Markdown (short paragraphs, small tables). "
    "Before answering about numbers, check what the viewer sees now with get_view_state. "
    "Follow the publisher's instructions and definitions in the report brief below; decline topics it marks "
    "out of scope. Never guess fixed filters that are not disclosed. You cannot change the report itself "
    "(datasets, charts, models, publishing): only the viewer's temporary view."
)


def system_prompt() -> str:
    brief = STATE.get("brief") or ""
    return SYSTEM_NOTE + ("\n\n" + brief if brief else "")


def _write(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.chmod(path, 0o600)


def _env() -> dict:
    env = dict(os.environ, ENABLE_CLAUDEAI_MCP_SERVERS="false", DISABLE_AUTOUPDATER="1", DISABLE_TELEMETRY="1")
    env.pop("RUNTIME_SECRET", None)
    return env


def configure(mcp_url: str, mcp_token: str) -> None:
    os.makedirs(WORK, exist_ok=True)
    # Claude Code's own config: folder trusted, the report's MCP with this viewer session's
    # token (an AppBI token for ONE view session - never a Claude credential).
    _write(os.path.join(HOME, ".claude.json"), {
        "theme": "light",
        "hasCompletedOnboarding": True,
        "projects": {WORK: {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True, "allowedTools": []}},
        "mcpServers": {"appbi-report": {"type": "http", "url": mcp_url,
                                        "headers": {"Authorization": f"Bearer {mcp_token}"}}},
    })
    _write(os.path.join(HOME, ".claude", "settings.json"), {
        "permissions": {"allow": ["mcp__appbi-report"], "deny": DENY},
        "enableAllProjectMcpServers": False,
        "env": {"ENABLE_CLAUDEAI_MCP_SERVERS": "false", "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1"},
    })


URL_RX = re.compile(r"https://\S+/oauth/authorize\S+")


def signin_start() -> dict:
    """Claude Code's own `claude auth login --claudeai`: returns the Anthropic sign-in URL it
    prints (an authorize URL with Claude Code's PKCE challenge - no secret). The process stays
    waiting for the code Anthropic shows the viewer."""
    old = STATE.get("login")
    if old and old.poll() is None:
        old.kill()
    p = subprocess.Popen(["claude", "auth", "login", "--claudeai"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, env=dict(_env(), BROWSER="true"), cwd=WORK)
    out, end = "", time.time() + 25
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], 1)
        if r:
            chunk = os.read(p.stdout.fileno(), 4096).decode(errors="ignore")  # type: ignore[union-attr]
            if not chunk:
                break
            out += chunk
            m = URL_RX.search(out)
            if m and "Paste code" in out:
                STATE["login"] = p
                return {"url": m.group(0)}
    p.kill()
    return {"error": "no_url"}


def signin_code(code: str) -> dict:
    """Hand the code the viewer copied from Anthropic to the waiting `claude auth login`
    (its stdin). Nothing is kept: not logged, not stored; Claude Code exchanges it itself."""
    p = STATE.get("login")
    if not p or p.poll() is not None:
        return {"ok": False, "error": "no_signin", "message": "Start the sign-in again."}
    try:
        p.stdin.write((code.strip() + "\n").encode())  # type: ignore[union-attr]
        p.stdin.flush()  # type: ignore[union-attr]
        p.wait(30)
    except (OSError, subprocess.TimeoutExpired):
        p.kill()
    tail = ""
    try:
        tail = (p.stdout.read() or b"").decode(errors="ignore")[-300:]  # type: ignore[union-attr]
    except OSError:
        pass
    STATE["login"] = None
    if signed_in():
        return {"ok": True}
    msg = "That code was not accepted. Sign in again to get a new code." if "accepted" in tail or "failed" in tail.lower() else "Sign-in did not complete."
    return {"ok": False, "error": "code_rejected", "message": msg}


def start_signin_terminal() -> subprocess.Popen:
    """The sign-in box: Claude Code's own `claude auth login`, nothing else (no shell)."""
    script = ("claude auth login --claudeai; echo; "
              "echo '  OK. Quay lại khung chat / Go back to the chat.'; "
              "while true; do sleep 3600; done")
    cmd = ["ttyd", "-p", "7681", "-b", f"/claude-rt/{INDEX}", "-W", "-m", "1", "-t", "fontSize=13",
           "-t", "titleFixed=Claude sign-in", "-t", "disableLeaveAlert=true",
           "-t", 'theme={"background":"#ffffff","foreground":"#1f2937","cursor":"#1f2937","selectionBackground":"#c7d2fe"}',
           "bash", "-c", script]
    return subprocess.Popen(cmd, env=_env(), cwd=WORK)


def signed_in() -> bool:
    try:
        r = subprocess.run(["claude", "auth", "status"], env=_env(), cwd=WORK, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return os.path.exists(os.path.join(HOME, ".claude", ".credentials.json"))
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode == 0 and '"loggedIn": false' not in out and "Not logged in" not in out:
        return True
    return False


def _collect(turn: dict, texts: list, ev: dict) -> None:
    """What the history keeps of one stream event: answer text, report tools used, model."""
    if ev.get("type") == "system" and ev.get("model"):
        turn["model"] = str(ev["model"])
    elif ev.get("type") == "assistant":
        for part in (ev.get("message") or {}).get("content") or []:
            if part.get("type") == "text" and part.get("text"):
                texts.append(str(part["text"]))
            elif part.get("type") == "tool_use":
                turn["tools"].append({"name": str(part.get("name") or "").replace("mcp__appbi-report__", ""),
                                      "input": part.get("input") or {}})
    elif ev.get("type") == "result":
        turn["duration_ms"] = int(ev.get("duration_ms") or 0)
        if texts:
            turn["answer"] = "\n\n".join(texts)
        elif ev.get("result"):
            turn["answer"] = str(ev["result"])
        if ev.get("is_error"):
            turn["error"] = str(ev.get("result") or "error")[:300]


def _relay(path: str, body: dict) -> tuple:
    """POST to the public MCP as this runtime (its secret), for the lease it holds."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(f"{PUBLIC_MCP}/public-mcp/{path}", method="POST",
                                 data=json.dumps(body, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json", "X-Runtime-Secret": SECRET,
                                          "X-Runtime-Index": str(INDEX)})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}


def report_turn(lease_id: str, turn: dict) -> None:
    """Best effort: the public MCP has AppBI keep this turn (if the publisher keeps history)."""
    try:
        _relay("runtime-transcript", {"lease_id": lease_id, "turn": {k: v for k, v in turn.items() if k != "rating"}})
    except Exception as exc:  # noqa: BLE001 - history is never allowed to break the chat
        print(f"transcript not kept: {type(exc).__name__}", file=sys.stderr)


def rate_turn(turn_id: str, rating: str) -> tuple:
    """The viewer's up/down on one of THEIR answers in this lease (AppBI keeps the verdict)."""
    if rating not in ("up", "down"):
        return 422, {"error": "bad_rating"}
    turn = next((t for t in STATE["turns"] if t.get("id") == turn_id), None)
    if turn is None or turn.get("error"):
        return 404, {"error": "turn_not_found"}
    try:
        code, out = _relay("runtime-rating", {"lease_id": STATE["lease"], "turn": turn_id, "rating": rating})
    except Exception:  # noqa: BLE001
        return 502, {"error": "unavailable"}
    if code == 200:
        turn["rating"] = rating
    return code, out


def wait_for_port(port: int, timeout: float = 8.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.3):
                return
        except OSError:
            time.sleep(0.1)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # no request logging (tokens and questions travel in bodies)
        pass

    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        got = self.headers.get("X-Runtime-Secret", "")
        return bool(SECRET) and hmac.compare_digest(got, SECRET)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"state": "leased" if STATE["lease"] else "idle", "lease": STATE["lease"], "index": INDEX})
        if self.path.endswith("/api/history"):
            if not STATE["lease"]:
                return self._send(409, {"error": "not_leased"})
            return self._send(200, {"turns": [{k: t.get(k) for k in ("id", "question", "answer", "error", "rating")}
                                              | {"tools": [x["name"] for x in t.get("tools") or []]}
                                              for t in STATE["turns"]]})
        if self.path.endswith("/api/status"):
            if not STATE["lease"]:
                return self._send(409, {"error": "not_leased"})
            return self._send(200, {"signed_in": signed_in()})
        return self._send(404, {"error": "not_found"})

    def do_POST(self):
        if "/api/" in self.path:
            return self._viewer()
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        body = self._body()
        if self.path == "/lease":
            with LOCK:
                if STATE["lease"]:
                    return self._send(409, {"error": "busy", "lease": STATE["lease"]})
                configure(str(body["mcp_url"]), str(body["mcp_token"]))
                STATE["lease"] = str(body["lease_id"])
                STATE["brief"] = str(body.get("brief") or "")[:16000]
            return self._send(200, {"ok": True, "panel_path": f"/claude-rt/{INDEX}/"})
        if self.path == "/recycle":
            self._send(200, {"ok": True})
            threading.Timer(0.3, lambda: os.kill(1, signal.SIGTERM)).start()  # tini -> exit -> clean restart
            return None
        return self._send(404, {"error": "not_found"})

    # ── the viewer's chat (edge-gated) ──────────────────────────────────────
    def _viewer(self):
        if not STATE["lease"]:
            return self._send(409, {"error": "not_leased"})
        if self.path.endswith("/api/reset"):
            STATE["session"] = None
            STATE["turns"] = []
            return self._send(200, {"ok": True})
        if self.path.endswith("/api/signin/start"):
            return self._send(200, signin_start())
        if self.path.endswith("/api/signin/code"):
            try:
                code = str(self._body().get("code") or "")
            except ValueError:
                return self._send(400, {"error": "bad_request"})
            if not code or len(code) > 512:
                return self._send(400, {"ok": False, "error": "bad_code", "message": "Paste the whole code."})
            return self._send(200, signin_code(code))
        if self.path.endswith("/api/rate"):
            try:
                b = self._body()
            except ValueError:
                return self._send(400, {"error": "bad_request"})
            code, out = rate_turn(str(b.get("id") or "")[:80], str(b.get("rating") or ""))
            return self._send(code, out)
        if not self.path.endswith("/api/chat"):
            return self._send(404, {"error": "not_found"})
        try:
            msg = str(self._body().get("message") or "").strip()
        except ValueError:
            return self._send(400, {"error": "bad_request"})
        if not msg or len(msg) > MAX_MESSAGE:
            return self._send(400, {"error": "bad_message"})
        if not CHAT.acquire(blocking=False):
            return self._send(429, {"error": "busy", "message": "Claude is still answering."})
        try:
            self._stream(msg)
        finally:
            CHAT.release()
        return None

    def _stream(self, msg: str) -> None:
        cmd = ["claude", "-p", msg, "--output-format", "stream-json", "--verbose",
               "--append-system-prompt", system_prompt()]
        turn = {"id": f"{STATE['lease']}-{int(time.time() * 1000)}", "question": msg, "answer": "",
                "tools": [], "model": "", "duration_ms": 0, "error": None}
        texts: list = []
        if STATE["session"]:
            cmd += ["--resume", STATE["session"]]
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def chunk(obj: dict) -> None:
            data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()

        proc = subprocess.Popen(cmd, env=_env(), cwd=WORK, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        killer = threading.Timer(CHAT_TIMEOUT, proc.kill)
        killer.start()
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("session_id"):
                    STATE["session"] = ev["session_id"]
                _collect(turn, texts, ev)
                chunk(ev)
            proc.wait()
            if proc.returncode not in (0, None):
                err = (proc.stderr.read() if proc.stderr else "")[-400:]  # type: ignore[union-attr]
                chunk({"type": "agent_error", "code": proc.returncode, "message": err})
                turn["error"] = turn["error"] or "claude_failed"
        except (BrokenPipeError, ConnectionResetError):
            proc.kill()
            turn["error"] = turn["error"] or "stopped"
        finally:
            killer.cancel()
            turn["answer"] = turn["answer"] or "\n\n".join(texts)
            STATE["turns"] = (STATE["turns"] + [turn])[-MAX_TURNS_KEPT:]
            threading.Thread(target=report_turn, args=(STATE["lease"], dict(turn)), daemon=True).start()
            try:
                if not turn["error"]:
                    chunk({"type": "appbi_turn", "id": turn["id"]})  # what the viewer's thumb refers to
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except OSError:
                pass


if __name__ == "__main__":
    if not SECRET:
        print("RUNTIME_SECRET is required", file=sys.stderr)
        sys.exit(2)
    ThreadingHTTPServer(("0.0.0.0", 8099), Handler).serve_forever()
