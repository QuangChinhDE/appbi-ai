"""The Claude runtime pool: a few pre-created Claude Code containers, one viewer at a time.

No Docker access anywhere: the pool is a fixed list of runtime agents (PUBLIC_MCP_RUNTIMES).
A lease gives ONE free runtime to ONE view session:

  1. mint an MCP access token bound to that view session only (same grant table, subject
     `viewer:<session>`, lifetime capped by the session) — an AppBI token, never a Claude one;
  2. the runtime agent writes it into Claude Code's own MCP config, so the viewer's Claude is
     connected to exactly this report with no pairing code;
  3. a lease cookie (random, hashed here) opens that runtime's panel through the edge's
     auth_request — another viewer's browser holds no cookie for it.

Release (viewer disconnects, closes the tab, goes idle, session ends or the link is closed):
the grant is revoked and the agent is told to recycle — the container exits and Docker's
restart policy brings it back on empty tmpfs (read-only root): nothing of the viewer remains.
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

log = logging.getLogger("appbi_mcp.public.runtimes")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runtime_leases (
    id           TEXT PRIMARY KEY,
    runtime      INTEGER NOT NULL,
    session_id   TEXT NOT NULL,
    grant_id     TEXT NOT NULL,
    cookie_hash  TEXT NOT NULL,
    created_at   REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    ended_at     REAL,
    end_reason   TEXT
);
CREATE INDEX IF NOT EXISTS ix_runtime_leases_live ON runtime_leases(runtime, ended_at);
"""

IDLE_SECONDS = 30 * 60
#: the viewer's tab stopped polling this long (closed, not reloaded — a reload rejoins within
#: seconds): the session ends and its runtime is recycled
TAB_GONE_SECONDS = 5 * 60


class PoolBusy(Exception):
    pass


class RuntimePool:
    def __init__(self, ctx: Any, urls: list[str], secret: str, *, transport: httpx2.AsyncBaseTransport | None = None):
        self.ctx, self.urls, self.secret, self.transport = ctx, urls, secret, transport
        self.store = ctx.store
        with self.store._lock:  # noqa: SLF001 - one schema statement block at start-up
            self.store._conn.executescript(_SCHEMA)  # noqa: SLF001
        self._lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return bool(self.urls and self.secret)

    def secret_for(self, index: int) -> str:
        """Each runtime has its OWN secret (comma-separated, in pool order): a viewer who reads
        their runtime's secret from inside it can only act on that same runtime."""
        parts = [p.strip() for p in self.secret.split(",") if p.strip()]
        return parts[index - 1] if len(parts) >= index else (parts[0] if parts else "")

    async def _agent(self, index: int, method: str, path: str, body: dict | None = None) -> dict:
        async with httpx2.AsyncClient(base_url=self.urls[index - 1], transport=self.transport, timeout=10) as c:
            r = await c.request(method, path, json=body, headers={"X-Runtime-Secret": self.secret_for(index)})
            r.raise_for_status()
            return r.json()

    def live_lease(self, session_id: str) -> dict | None:
        row = self.store.query_one("SELECT * FROM runtime_leases WHERE session_id = ? AND ended_at IS NULL", (session_id,))
        return dict(row) if row else None

    async def status(self) -> list[dict]:
        out = []
        for i in range(1, len(self.urls) + 1):
            try:
                h = await self._agent(i, "GET", "/health")
            except Exception as exc:  # noqa: BLE001
                h = {"state": "down", "error": type(exc).__name__}
            lease = self.store.query_one("SELECT id, session_id FROM runtime_leases WHERE runtime = ? AND ended_at IS NULL", (i,))
            out.append({"runtime": i, **h, "lease_record": dict(lease) if lease else None})
        return out

    async def lease(self, session: dict) -> dict:
        """One runtime for this view session (the same one again if it already holds one)."""
        async with self._lock:
            mine = self.live_lease(session["id"])
            if mine and not await self._holds(mine):
                self._end_stale(mine)
                mine = None
            if mine:
                cookie = new_secret("rtc_")
                self.store.execute("UPDATE runtime_leases SET cookie_hash = ?, last_seen_at = ? WHERE id = ?",
                                   (sha256_hex(cookie), time.time(), mine["id"]))
                return {"runtime": mine["runtime"], "cookie": cookie, "panel_path": f"/claude-rt/{mine['runtime']}/"}
            busy = {r["runtime"] for r in self.store.query("SELECT runtime FROM runtime_leases WHERE ended_at IS NULL")}
            for i in range(1, len(self.urls) + 1):
                if i in busy:
                    continue
                try:
                    h = await self._agent(i, "GET", "/health")
                except Exception:  # noqa: BLE001 - a recycling runtime is simply not free yet
                    continue
                if h.get("state") != "idle":
                    continue
                return await self._take(i, session)
            raise PoolBusy()

    async def _take(self, index: int, session: dict) -> dict:
        provider = self.ctx.provider
        grant = provider.create_viewer_grant(session_id=session["id"], client_id="appbi-claude-runtime",
                                             expires_at=session["expires_at"])
        token = provider.issue_runtime_token(grant)
        lease_id, cookie = new_id("rtl"), new_secret("rtc_")
        now = time.time()
        with self.store.transaction() as cur:
            cur.execute("INSERT INTO runtime_leases(id, runtime, session_id, grant_id, cookie_hash, created_at, last_seen_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)", (lease_id, index, session["id"], grant["id"], sha256_hex(cookie), now, now))
        try:
            brief = await self._brief(session)
            await self._agent(index, "POST", "/lease", {"lease_id": lease_id, "mcp_token": token,
                                                         "mcp_url": self.ctx.settings.resource_url, "brief": brief})
        except Exception:
            self._close(lease_id, "agent_refused")
            provider.revoke_grant(grant["id"], "runtime_lease_failed")
            raise
        log.info("runtime %s leased to session %s (%s)", index, session["id"], lease_id)
        return {"runtime": index, "cookie": cookie, "panel_path": f"/claude-rt/{index}/"}

    async def _brief(self, session: dict) -> str:
        """The report's business context for Claude's system prompt (AppBI renders it from what
        the link discloses: structure, filters, the publisher's guide and instructions if shared)."""
        bridge = getattr(self, "bridge", None)
        grant = bridge.grant_of(session) if bridge else None
        if not grant:
            return ""
        try:
            d = await bridge.appbi(grant).post("/public/mcp/describe", {"state": {}})
        except Exception as exc:  # noqa: BLE001 - Claude still has get_report_context
            log.warning("runtime brief unavailable: %s", type(exc).__name__)
            return ""
        return str(d.get("assistant_brief") or "")[:16000]

    async def _holds(self, lease: dict) -> bool:
        """The runtime still runs THIS lease (it may have restarted under it: then it is clean)."""
        try:
            h = await self._agent(int(lease["runtime"]), "GET", "/health")
        except Exception:  # noqa: BLE001 - unreachable now: keep the lease, the reaper retries
            return True
        return h.get("lease") == lease["id"]

    def _end_stale(self, lease: dict) -> None:
        self._close(lease["id"], "runtime_restarted")
        self.ctx.provider.revoke_grant(lease["grant_id"], "runtime_restarted")
        log.info("runtime %s no longer holds lease %s: closed", lease["runtime"], lease["id"])

    def _close(self, lease_id: str, reason: str) -> None:
        self.store.execute("UPDATE runtime_leases SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
                           (time.time(), reason, lease_id))

    async def release_session(self, session_id: str, reason: str) -> None:
        lease = self.live_lease(session_id)
        if not lease:
            return
        self._close(lease["id"], reason)
        self.ctx.provider.revoke_grant(lease["grant_id"], f"runtime_{reason}")
        try:
            await self._agent(lease["runtime"], "POST", "/recycle")
        except Exception as exc:  # noqa: BLE001 - the reaper retries a runtime that still reports leased
            log.warning("runtime %s recycle failed: %s", lease["runtime"], type(exc).__name__)
        log.info("runtime %s released from session %s (%s)", lease["runtime"], session_id, reason)

    def authorize_panel(self, index: int, cookie: str) -> bool:
        if not cookie:
            return False
        row = self.store.query_one("SELECT id, cookie_hash FROM runtime_leases WHERE runtime = ? AND ended_at IS NULL", (index,))
        if not row or not secrets.compare_digest(row["cookie_hash"], sha256_hex(cookie)):
            return False
        self.store.execute("UPDATE runtime_leases SET last_seen_at = ? WHERE id = ?", (time.time(), row["id"]))
        return True

    async def reap(self, bridge: Any) -> None:
        """Leases whose session ended or that sat idle; runtimes left 'leased' with no lease."""
        now = time.time()
        for row in self.store.query("SELECT * FROM runtime_leases WHERE ended_at IS NULL"):
            if not await self._holds(dict(row)):
                self._end_stale(dict(row))
                continue
            sess = bridge.session(row["session_id"])
            seen = max(float(row["last_seen_at"]), float((sess or {}).get("last_seen_at") or 0))
            if sess is None:
                await self.release_session(row["session_id"], "session_ended")
            elif now - seen > IDLE_SECONDS:
                await self.release_session(row["session_id"], "idle")
            elif now - float(sess.get("last_seen_at") or row["created_at"]) > TAB_GONE_SECONDS:
                bridge.end(row["session_id"], "tab_gone")  # on_end releases the runtime
        live = {r["runtime"] for r in self.store.query("SELECT runtime FROM runtime_leases WHERE ended_at IS NULL")}
        for i in range(1, len(self.urls) + 1):
            if i in live:
                continue
            try:
                h = await self._agent(i, "GET", "/health")
                if h.get("state") == "leased":
                    await self._agent(i, "POST", "/recycle")
            except Exception:  # noqa: BLE001
                pass

    async def reaper_loop(self, bridge: Any, every: float = 60.0) -> None:
        while True:
            try:
                await self.reap(bridge)
            except Exception:  # noqa: BLE001
                log.exception("runtime reaper")
            await asyncio.sleep(every)


def parse_runtime_urls(raw: str) -> list[str]:
    return [u.strip().rstrip("/") for u in (raw or "").split(",") if u.strip()]


def dumps(x: Any) -> str:
    return json.dumps(x, ensure_ascii=False)
