"""Data sources: Human Handoff for anything that needs a secret or a sign-in.

Credentials and OAuth consent never pass through the model or this service. The
AI asks for a handoff; the user completes it in AppBI's own Source screens (the
same form, validation, private-network guard and encryption as always); the AI
then resumes by checking the handoff, which finds the source by what AppBI
reports (owner, creation time, config version), never by anything the model says.
"""

import asyncio
import time
from typing import Annotated, Any, Literal
from urllib.parse import quote

from pydantic import Field

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..state import canonical_json, new_id
from .runtime import Env, tool

HANDOFF_TTL = 24 * 3600


def _ts(value: Any) -> float:
    from datetime import datetime, timezone

    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return 0.0
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _summary(s: dict[str, Any], env: Env) -> dict[str, Any]:
    return {"id": s.get("id"), "name": s.get("name"), "type": s.get("type"), "last_test_status": s.get("last_test_status"),
            "config_version": s.get("config_version"), "your_permission": s.get("user_permission"),
            "url": env.link(f"/datasources/{s.get('id')}")}


def _store(env: Env) -> Any:
    st = env.app.store
    with st.transaction() as cur:
        cur.execute("CREATE TABLE IF NOT EXISTS source_handoffs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT NOT NULL, "
                    "created_at REAL NOT NULL, expires_at REAL NOT NULL)")
    return st


@tool(scope=sc.READ, title="Hand off a data source connection to the user", read_only=True)
async def start_source_handoff(
    env: Env,
    kind: Literal["new", "reconnect"] = "new",
    source_type: Annotated[str | None, Field(max_length=40, description="e.g. postgresql, bigquery, google_sheets (shown to the user)")] = None,
    name_hint: Annotated[str | None, Field(max_length=200, description="Name the user is asked to give the new source")] = None,
    data_source_id: Annotated[int | None, Field(description="reconnect: the source whose credentials/sign-in must be renewed")] = None,
) -> dict[str, Any]:
    """Ask the USER to connect (or re-authorize) a data source in AppBI. Credentials never go through Claude.

    Returns a link to AppBI's own Source screen and a handoff_id. After the user
    says they are done, call check_source_handoff(handoff_id) to continue.
    """
    if kind == "reconnect":
        if data_source_id is None:
            return {"status": "invalid", "message": "reconnect needs data_source_id"}
        s = await env.appbi.get(f"/datasources/{data_source_id}")
        if s.get("user_permission") not in ("edit", "full", "owner"):
            return {"status": "forbidden", "message": "Your AppBI account cannot change this source's connection; ask its owner."}
        url = env.link(f"/datasources/{data_source_id}/edit?handoff=1")
        baseline = {"config_version": s.get("config_version"), "last_tested_at": s.get("last_tested_at")}
    else:
        q = "&".join(f"{k}={quote(str(v))}" for k, v in (("handoff", "1"), ("type", source_type), ("name", name_hint)) if v)
        url = env.link(f"/datasources/new?{q}")
        baseline = {}
    hid = new_id("handoff")
    now = time.time()
    body = {"kind": kind, "source_type": source_type, "name_hint": name_hint, "data_source_id": data_source_id, "baseline": baseline,
            "started_at": now - 5}
    with _store(env).transaction() as cur:
        cur.execute("INSERT INTO source_handoffs(id, user_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                    (hid, env.principal.user_id, canonical_json(body), now, now + HANDOFF_TTL))
    return {
        "status": "handoff_required", "handoff_id": hid, "handoff_url": url,
        "message": ("Open this link and connect the source in AppBI yourself (credentials and sign-in stay in AppBI). "
                    "Tell me when you are done.") if kind == "new" else
                   "Open this link and renew the source's connection in AppBI, then tell me when you are done.",
        "next": "When the user says they are done, call check_source_handoff(handoff_id).",
    }


@tool(scope=sc.READ, title="Check a data source handoff", read_only=True)
async def check_source_handoff(env: Env, handoff_id: str,
                               wait_seconds: Annotated[int, Field(ge=0, le=120)] = 0) -> dict[str, Any]:
    """Whether the user finished the handoff in AppBI; returns the source so the workflow can continue."""
    import json

    row = _store(env).query_one("SELECT * FROM source_handoffs WHERE id = ? AND user_id = ?", (handoff_id, env.principal.user_id))
    if not row or row["expires_at"] < time.time():
        return {"status": "not_found", "message": "No such handoff for this user (or it expired). Start a new one."}
    h = json.loads(row["body"])
    deadline = time.time() + wait_seconds
    while True:
        found = await _find(env, h)
        if found or time.time() >= deadline:
            break
        await asyncio.sleep(3)
    if not found:
        return {"status": "pending", "handoff_id": handoff_id,
                "message": "AppBI does not show the connection yet. Ask the user to finish it, then check again."}
    return {"status": "completed", "handoff_id": handoff_id, "source": _summary(found, env),
            "next": "Continue: inspect_data_source(data_source_id) or test_data_source(data_source_id)."}


async def _find(env: Env, h: dict[str, Any]) -> dict[str, Any] | None:
    if h["kind"] == "reconnect":
        s = await env.appbi.get(f"/datasources/{h['data_source_id']}")
        b = h["baseline"]
        if s.get("config_version") != b.get("config_version") or (s.get("last_tested_at") and s.get("last_tested_at") != b.get("last_tested_at")
                                                                   and _ts(s.get("last_tested_at")) >= h["started_at"]):
            return s
        return None
    me = str(env.principal.user_id)
    candidates = [s for s in await env.appbi.get("/datasources/") or []
                  if str(s.get("owner_id")) == me and _ts(s.get("created_at")) >= h["started_at"]
                  and (not h.get("source_type") or str(s.get("type")).lower() == str(h["source_type"]).lower())]
    if h.get("name_hint"):
        named = [s for s in candidates if str(s.get("name")).strip().casefold() == str(h["name_hint"]).strip().casefold()]
        candidates = named or candidates
    return sorted(candidates, key=lambda s: _ts(s.get("created_at")))[-1] if candidates else None


@tool(scope=sc.AUTHOR, title="Test a data source connection", read_only=False, idempotent=True)
async def test_data_source(env: Env, data_source_id: int) -> dict[str, Any]:
    """Re-test a saved source with ITS stored credentials (AppBI records the result as the source's health)."""
    try:
        res = await env.appbi.post(f"/datasources/{data_source_id}/test")
    except AppbiError as exc:
        if exc.status == 403:
            return {"status": "forbidden", "message": "Testing a source needs edit access to it in AppBI."}
        raise
    ok = bool(res.get("success", res.get("ok")))
    out = {"status": "ok" if ok else "connection_failed", "data_source_id": data_source_id,
           "message": res.get("message"), "error_code": res.get("error_code")}
    if not ok:
        out["next"] = "If credentials or sign-in expired, call start_source_handoff(kind='reconnect', data_source_id=...)."
    return out
