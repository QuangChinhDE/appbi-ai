"""The Report UI Bridge: Claude ↔ exactly ONE browser tab showing a public report.

How a tab and a Claude find each other, and why nobody else can join:

1. The viewer clicks "Ask your Claude" on the public page. The page pairs with AppBI
   (`POST /public/mcp/pair`, same proof as viewing the link) and hands the grant to
   this service (`POST /public-mcp/bridge/sessions`). We check the grant with AppBI,
   then return a session id, a BROWSER SECRET (kept in that tab's memory only) and a
   short PAIRING CODE shown in that tab.
2. The viewer adds the connector in their Claude; OAuth lands on our pairing page and
   they type the code. The code is single use, expires in 10 minutes, is stored
   hashed and is rate limited. The OAuth grant created is bound to that session only.
3. Claude's view tools enqueue commands for THAT session; only a caller holding the
   browser secret can poll them or report the tab's state. Another viewer's tab has
   another session, another secret and another grant: Claude cannot address it.

Every command is validated by AppBI (`/public/mcp/check-state`) before the tab sees
it, and the tab applies it through the page's own controls — locks stay enforced by
AppBI on every data read regardless of what any tab claims.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from typing import Any

import httpx2

from ..state import new_id, new_secret, sha256_hex

log = logging.getLogger("appbi_mcp.public.bridge")

PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
APPBI_PATHS = ("/public/mcp/describe", "/public/mcp/chart-data", "/public/mcp/check-state", "/public/mcp/filter-values")
MAX_STATE_BYTES = 64 * 1024


class Refused(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def new_pair_code() -> str:
    raw = "".join(secrets.choice(PAIR_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def norm_code(code: str) -> str:
    c = "".join(ch for ch in (code or "").upper() if ch.isalnum())
    return f"{c[:4]}-{c[4:]}" if len(c) == 8 else ""


class PublicAppbi:
    """AppBI's public MCP endpoints, with one viewer session's grant. Nothing else is reachable."""

    def __init__(self, settings: Any, grant: str, transport: httpx2.AsyncBaseTransport | None = None):
        self.settings, self.grant, self.transport = settings, grant, transport

    async def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        if path not in APPBI_PATHS:
            raise Refused("route_not_allowed", f"{path} is not a public MCP route", 500)
        async with httpx2.AsyncClient(base_url=self.settings.appbi_api_url, transport=self.transport,
                                      timeout=self.settings.appbi_timeout_seconds) as client:
            try:
                r = await client.post(path, json=body, headers={"X-Public-MCP-Grant": self.grant,
                                                                 "User-Agent": f"appbi-public-mcp/{self.settings.build_sha}"})
            except httpx2.HTTPError as exc:
                raise Refused("appbi_unavailable", f"AppBI did not answer ({type(exc).__name__}).", 503)
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code >= 400:
            if r.status_code == 429:
                raise Refused("rate_limited", "Too many reads on this report; wait a minute.", 429)
            raise Refused(str(data.get("error") or "refused"), str(data.get("message") or data.get("detail") or "AppBI refused the request."), r.status_code)
        return data if isinstance(data, dict) else {"data": data}


class Bridge:
    def __init__(self, ctx: Any):
        self.ctx = ctx
        self.store = ctx.store
        self.settings = ctx.settings
        self._wake: dict[str, asyncio.Event] = {}
        self._acks: dict[int, asyncio.Future] = {}

    # ── sessions ─────────────────────────────────────────────────────────────

    def appbi(self, grant: str) -> PublicAppbi:
        return PublicAppbi(self.settings, grant, self.ctx.appbi_transport)

    async def create_session(self, grant: str) -> dict[str, Any]:
        if not grant or len(grant) > 4096:
            raise Refused("invalid_grant", "A grant from AppBI is required.", 400)
        described = await self.appbi(grant).post("/public/mcp/describe", {"state": {}})
        sid = new_id("vws")
        secret = new_secret("pmb_")
        code = new_pair_code()
        now = time.time()
        report = {"kind": described.get("kind"), "name": described.get("name")}
        with self.store.transaction() as cur:
            cur.execute(
                "INSERT INTO view_sessions(id, grant_enc, browser_hash, pair_hash, pair_expires_at, report_json, "
                "created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (sid, self.store.encrypt(grant), sha256_hex(secret), sha256_hex(code), now + self.settings.pair_ttl,
                 json.dumps(report, ensure_ascii=False), now, now + self.settings.session_ttl, now),
            )
        log.info("view session %s created (%s)", sid, report.get("kind"))
        return {"session_id": sid, "browser_secret": secret, "pair_code": code,
                "pair_expires_in": self.settings.pair_ttl, "report": report,
                "connector_url": self.settings.resource_url}

    def session(self, sid: str) -> dict[str, Any] | None:
        row = self.store.query_one("SELECT * FROM view_sessions WHERE id = ? AND ended_at IS NULL AND expires_at > ?",
                                   (sid, time.time()))
        return dict(row) if row else None

    def browser_session(self, sid: str, secret: str) -> dict[str, Any] | None:
        row = self.session(sid)
        if not row or not secret or not secrets.compare_digest(row["browser_hash"], sha256_hex(secret)):
            return None
        return row

    def grant_of(self, row: dict[str, Any]) -> str | None:
        return self.store.decrypt(row["grant_enc"])

    def claim(self, code: str) -> dict[str, Any] | None:
        """Single use: the first Claude that presents a live code gets that session."""
        c = norm_code(code)
        if not c:
            return None
        now = time.time()
        with self.store.transaction() as cur:
            row = cur.execute(
                "SELECT * FROM view_sessions WHERE pair_hash = ? AND ended_at IS NULL AND expires_at > ? AND pair_expires_at > ?",
                (sha256_hex(c), now, now),
            ).fetchone()
            if not row:
                return None
            cur.execute("UPDATE view_sessions SET pair_hash = NULL, claimed_at = ? WHERE id = ? AND pair_hash IS NOT NULL",
                        (now, row["id"]))
            if cur.rowcount != 1:
                return None
        return dict(row)

    def new_code(self, sid: str) -> str:
        """The tab asks for a fresh code (expired, or to connect another Claude): the old one dies."""
        code = new_pair_code()
        with self.store.transaction() as cur:
            cur.execute("UPDATE view_sessions SET pair_hash = ?, pair_expires_at = ? WHERE id = ?",
                        (sha256_hex(code), time.time() + self.settings.pair_ttl, sid))
        return code

    def end(self, sid: str, reason: str) -> None:
        with self.store.transaction() as cur:
            cur.execute("UPDATE view_sessions SET ended_at = ?, end_reason = ?, pair_hash = NULL WHERE id = ? AND ended_at IS NULL",
                        (time.time(), reason, sid))
            cur.execute("UPDATE view_commands SET status = 'expired', updated_at = ? WHERE session_id = ? AND status = 'pending'",
                        (time.time(), sid))
        self.ctx.provider.revoke_session_grants(sid, reason)
        self._event(sid).set()
        log.info("view session %s ended (%s)", sid, reason)

    # ── state reported by the tab ────────────────────────────────────────────

    def report_state(self, sid: str, state: Any, ack: Any) -> None:
        now = time.time()
        raw = json.dumps(state if isinstance(state, dict) else {}, ensure_ascii=False)
        if len(raw.encode()) > MAX_STATE_BYTES:
            raise Refused("state_too_large", "The view state is too large.", 413)
        with self.store.transaction() as cur:
            cur.execute("UPDATE view_sessions SET state_json = ?, state_seq = state_seq + 1, last_seen_at = ? WHERE id = ?",
                        (raw, now, sid))
            if isinstance(ack, dict) and isinstance(ack.get("id"), int):
                ok = ack.get("ok") is True
                cur.execute("UPDATE view_commands SET status = ?, result_json = ?, updated_at = ? "
                            "WHERE id = ? AND session_id = ? AND status = 'pending'",
                            ("applied" if ok else "failed", json.dumps({"error": str(ack.get("error") or "")[:300]}), now,
                             ack["id"], sid))
        if isinstance(ack, dict) and isinstance(ack.get("id"), int):
            fut = self._acks.pop(ack["id"], None)
            if fut is not None and not fut.done():
                fut.set_result({"ok": ack.get("ok") is True, "error": str(ack.get("error") or "")[:300]})

    def touch(self, sid: str) -> None:
        self.store.execute("UPDATE view_sessions SET last_seen_at = ? WHERE id = ?", (time.time(), sid))

    def view_state(self, row: dict[str, Any]) -> dict[str, Any]:
        try:
            return json.loads(row.get("state_json") or "{}")
        except ValueError:
            return {}

    def tab_online(self, row: dict[str, Any]) -> bool:
        return bool(row.get("last_seen_at")) and time.time() - float(row["last_seen_at"]) < 45

    # ── commands Claude sends to the tab ─────────────────────────────────────

    def _event(self, sid: str) -> asyncio.Event:
        ev = self._wake.get(sid)
        if ev is None:
            ev = self._wake[sid] = asyncio.Event()
        return ev

    def pending(self, sid: str, after: int) -> list[dict[str, Any]]:
        rows = self.store.query("SELECT id, cmd_json FROM view_commands WHERE session_id = ? AND id > ? AND status = 'pending' "
                                "ORDER BY id LIMIT 20", (sid, after))
        return [{"id": r["id"], **json.loads(r["cmd_json"])} for r in rows]

    async def poll(self, sid: str, after: int, wait: float = 25.0) -> list[dict[str, Any]]:
        cmds = self.pending(sid, after)
        if cmds:
            return cmds
        ev = self._event(sid)
        ev.clear()
        try:
            await asyncio.wait_for(ev.wait(), timeout=wait)
        except asyncio.TimeoutError:
            return []
        return self.pending(sid, after)

    async def send(self, sid: str, cmd: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        now = time.time()
        with self.store.transaction() as cur:
            cur.execute("INSERT INTO view_commands(session_id, cmd_json, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)",
                        (sid, json.dumps(cmd, ensure_ascii=False), now, now))
            cmd_id = int(cur.lastrowid)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._acks[cmd_id] = fut
        self._event(sid).set()
        try:
            res = await asyncio.wait_for(fut, timeout=timeout or self.settings.viewer_ack_timeout)
        except asyncio.TimeoutError:
            self._acks.pop(cmd_id, None)
            self.store.execute("UPDATE view_commands SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'",
                               (time.time(), cmd_id))
            return {"ok": False, "error": "viewer_not_responding", "command_id": cmd_id}
        return {**res, "command_id": cmd_id}
