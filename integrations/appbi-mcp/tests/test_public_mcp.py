"""Public Read MCP, offline: the real public app in-process, a fake AppBI behind it.

The fake models only the grant contract (a grant is alive or not; one filter key is a
lock). The real AppBI rules are locked by backend/tests/test_public_mcp_http_pg.py
and by the live journeys.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx2
import pytest
from cryptography.fernet import Fernet
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from appbi_mcp.public.app import create_public_app
from appbi_mcp.public.settings import PUBLIC_SCOPE, PublicSettings

from .conftest import MCP_HEADERS, PUBLIC, REDIRECT, make_settings, pkce

PMCP_HEADERS = {**MCP_HEADERS}


@dataclass
class FakePublicAppbi:
    grants: dict[str, dict[str, Any]] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    def new_grant(self, kind: str = "dashboard", name: str = "Sales") -> str:
        g = "g_" + secrets.token_urlsafe(12)
        self.grants[g] = {"kind": kind, "name": name, "alive": True}
        return g

    def app(self) -> Starlette:
        async def handler(request: Request) -> JSONResponse:
            path = request.url.path.removeprefix("/api/v1")
            body = await request.json()
            g = self.grants.get(request.headers.get("x-public-mcp-grant", ""))
            self.calls.append((path, {**body, "_grant_name": (g or {}).get("name")}))
            if g is None:
                return JSONResponse({"error": "invalid_grant", "message": "bad grant"}, status_code=401)
            if not g["alive"]:
                return JSONResponse({"error": "link_closed", "message": "closed"}, status_code=404)
            state = body.get("state") or {}
            if path == "/public/mcp/describe":
                return JSONResponse({"kind": g["kind"], "name": g["name"], "charts": [{"chart_id": 7, "title": "Revenue"}]})
            if path == "/public/mcp/check-state":
                for f in state.get("viewer_filters") or []:
                    if f.get("field") == "orders.region":
                        return JSONResponse({"error": "filter_not_adjustable", "message": "fixed"}, status_code=403)
                if "region" in (state.get("filters") or {}):
                    return JSONResponse({"error": "filter_not_adjustable", "message": "fixed"}, status_code=403)
                return JSONResponse({"ok": True})
            if path == "/public/mcp/chart-data":
                return JSONResponse({"chart_id": 7, "title": "Revenue", "columns": ["year", "orders"],
                                     "rows": [[2017, 43428], [2018, 52783]], "row_count": 2, "truncated": False,
                                     "filters_applied": state.get("viewer_filters") or []})
            return JSONResponse({"error": "nope"}, status_code=404)

        return Starlette(routes=[Route("/api/v1/public/mcp/{rest:path}", handler, methods=["POST"])])


def public_settings(tmp_path, **over: Any) -> PublicSettings:
    from dataclasses import fields

    base = make_settings(tmp_path)
    values = {f.name: getattr(base, f.name) for f in fields(type(base))}
    values.update(state_key=Fernet.generate_key(), viewer_ack_timeout=1.0, **over)
    return PublicSettings(**values)


@pytest.fixture
def fake() -> FakePublicAppbi:
    return FakePublicAppbi()


@pytest.fixture
async def pc(tmp_path, fake):
    app = create_public_app(public_settings(tmp_path), appbi_transport=httpx2.ASGITransport(app=fake.app()))
    started, stop = asyncio.Event(), asyncio.Event()

    async def run() -> None:
        async with app.router.lifespan_context(app):
            started.set()
            await stop.wait()

    task = asyncio.create_task(run())
    await started.wait()
    async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=PUBLIC, follow_redirects=False) as c:
        c.app = app  # type: ignore[attr-defined]
        yield c
    stop.set()
    await task


async def open_tab(c: httpx2.AsyncClient, grant: str) -> dict[str, Any]:
    r = await c.post("/public-mcp/bridge/sessions", json={"grant": grant}, headers={"Origin": PUBLIC})
    assert r.status_code == 201, r.text
    return r.json()


async def connect_claude(c: httpx2.AsyncClient, code: str, *, expect_ok: bool = True) -> dict[str, Any] | httpx2.Response:
    r = await c.post("/public-mcp-oauth/register", json={"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none",
                                                          "grant_types": ["authorization_code", "refresh_token"],
                                                          "response_types": ["code"], "client_name": "Claude"})
    assert r.status_code == 201, r.text
    client_id = r.json()["client_id"]
    verifier, challenge = pkce()
    r = await c.get("/public-mcp-oauth/authorize", params={
        "client_id": client_id, "response_type": "code", "code_challenge": challenge, "code_challenge_method": "S256",
        "redirect_uri": REDIRECT, "state": "s1", "resource": f"{PUBLIC}/public-mcp", "scope": PUBLIC_SCOPE})
    assert r.status_code == 302, r.text
    loc = urlparse(r.headers["location"])
    assert loc.path == "/public-mcp-oauth/pair"
    r = await c.get(loc.path, params=parse_qs(loc.query))
    assert r.status_code == 302  # binding moved into the cookie
    txn = parse_qs(urlparse(r.headers["location"]).query)["txn"][0]
    r = await c.get("/public-mcp-oauth/pair", params={"txn": txn})
    assert r.status_code == 200 and "Type the code" in r.text
    r = await c.post("/public-mcp-oauth/pair", data={"txn": txn, "code": code, "decision": "allow"})
    if not expect_ok:
        return r
    assert r.status_code == 200, r.text
    target = r.text.split("url=", 1)[1].split("'", 1)[0].replace("&amp;", "&")
    q = {k: v[0] for k, v in parse_qs(urlparse(target).query).items()}
    r = await c.post("/public-mcp-oauth/token", data={"grant_type": "authorization_code", "code": q["code"], "redirect_uri": REDIRECT,
                                                        "client_id": client_id, "code_verifier": verifier,
                                                        "resource": f"{PUBLIC}/public-mcp"})
    assert r.status_code == 200, r.text
    return r.json()


async def call(c: httpx2.AsyncClient, token: str, name: str, args: dict[str, Any] | None = None, method: str = "tools/call") -> Any:
    params = {"name": name, "arguments": args or {}} if method == "tools/call" else {}
    r = await c.post("/public-mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                     headers={**PMCP_HEADERS, "Authorization": f"Bearer {token}"})
    if r.status_code != 200:
        return r
    res = r.json()["result"]
    if method != "tools/call":
        return res
    return json.loads(res["content"][0]["text"])


async def tab_loop(c: httpx2.AsyncClient, tab: dict[str, Any], state: dict[str, Any], *, rounds: int = 3, seen: list | None = None) -> None:
    """A viewer tab: report state, poll commands, apply them, ack."""
    h = {"X-Bridge-Secret": tab["browser_secret"], "Origin": PUBLIC}
    sid = tab["session_id"]
    await c.post(f"/public-mcp/bridge/sessions/{sid}/state", json={"state": state}, headers=h)
    after = 0
    for _ in range(rounds):
        r = await c.get(f"/public-mcp/bridge/sessions/{sid}/commands", params={"after": after, "wait": 1}, headers=h)
        if r.status_code != 200:
            return
        for cmd in r.json()["commands"]:
            after = cmd["id"]
            if seen is not None:
                seen.append(cmd)
            if cmd["type"] == "set_filters":
                state = {**state, **({"viewer_filters": cmd["viewer_filters"]} if "viewer_filters" in cmd else {"filters": cmd["filters"]})}
            elif cmd["type"] == "go_to_page":
                state = {**state, "page": {"id": cmd["page"]}}
            elif cmd["type"] == "focus":
                state = {**state, "focus": cmd["chart"]}
            await c.post(f"/public-mcp/bridge/sessions/{sid}/state", json={"state": state, "ack": {"id": cmd["id"], "ok": True}}, headers=h)


DASH_STATE = {"kind": "dashboard", "page": {"id": "p1", "name": "Overview"},
              "viewer_filters": [{"id": "s-year", "field": "orders.year", "operator": "in", "value": [2018]}],
              "controls": [{"key": "s-year", "field": "orders.year", "operator": "in", "label": "Year"}]}


async def test_bridge_needs_a_live_appbi_grant(pc, fake):
    r = await pc.post("/public-mcp/bridge/sessions", json={"grant": "forged"})
    assert r.status_code == 401 and r.json()["error"] == "invalid_grant"


async def test_pair_connects_one_claude_to_one_tab_read_only_toolset(pc, fake):
    tab = await open_tab(pc, fake.new_grant())
    assert len(tab["pair_code"]) == 9 and tab["connector_url"].endswith("/public-mcp")
    bad = await connect_claude(pc, "ZZZZ-ZZZZ", expect_ok=False)
    assert bad.status_code == 400 and "not valid" in bad.text
    tok = await connect_claude(pc, tab["pair_code"])
    assert tok["scope"] == PUBLIC_SCOPE
    listed = await call(pc, tok["access_token"], "", method="tools/list")
    names = {t["name"] for t in listed["tools"]}
    assert names == {"get_report_context", "get_view_state", "read_chart", "list_filter_values", "calculate", "set_filters",
                     "reset_filters", "go_to_page", "focus_chart", "drill_down", "clear_drill_down"}
    assert not any(t["annotations"].get("destructiveHint") for t in listed["tools"])
    ctx = await call(pc, tok["access_token"], "get_report_context")
    assert ctx["status"] == "ok" and ctx["report"]["name"] == "Sales"
    # the code was single use: a second Claude cannot join this tab with it
    again = await connect_claude(pc, tab["pair_code"], expect_ok=False)
    assert again.status_code == 400
    # the author MCP is not here
    r = await pc.post("/mcp", json={}, headers={"Authorization": f"Bearer {tok['access_token']}"})
    assert r.status_code == 404


async def test_two_viewers_never_cross(pc, fake):
    a = await open_tab(pc, fake.new_grant(name="A"))
    b = await open_tab(pc, fake.new_grant(name="B"))
    tok_a = await connect_claude(pc, a["pair_code"])
    seen_a: list = []
    seen_b: list = []
    loop_a = asyncio.create_task(tab_loop(pc, a, dict(DASH_STATE), seen=seen_a))
    await asyncio.sleep(0.05)
    out = await call(pc, tok_a["access_token"], "set_filters", {"changes": {"s-year": [2017]}})
    await loop_a
    assert out["status"] == "applied", out
    assert out["current_view"]["viewer_filters"][0]["value"] == [2017]
    # B's tab polls and sees nothing; B's secret cannot read A's queue either
    hb = {"X-Bridge-Secret": b["browser_secret"]}
    r = await pc.get(f"/public-mcp/bridge/sessions/{b['session_id']}/commands", params={"after": 0, "wait": 0}, headers=hb)
    assert r.status_code == 200 and r.json()["commands"] == []
    r = await pc.get(f"/public-mcp/bridge/sessions/{a['session_id']}/commands", params={"after": 0, "wait": 0}, headers=hb)
    assert r.status_code == 410
    assert [c["type"] for c in seen_a] == ["set_filters"] and seen_b == []
    # each read carries A's grant only
    fake.calls.clear()
    await call(pc, tok_a["access_token"], "read_chart", {"chart": "7"})
    assert fake.calls and all(body["_grant_name"] == "A" for _, body in fake.calls), "every read runs on A's grant only"


async def test_a_lock_is_refused_before_the_tab_sees_anything(pc, fake):
    tab = await open_tab(pc, fake.new_grant())
    tok = await connect_claude(pc, tab["pair_code"])
    state = {**DASH_STATE, "controls": DASH_STATE["controls"] + [{"key": "s-region", "field": "orders.region", "operator": "in"}]}
    h = {"X-Bridge-Secret": tab["browser_secret"]}
    await pc.post(f"/public-mcp/bridge/sessions/{tab['session_id']}/state", json={"state": state}, headers=h)
    out = await call(pc, tok["access_token"], "set_filters", {"changes": {"s-region": ["South"]}})
    assert out["status"] == "refused" and out["reason"] == "filter_not_adjustable"
    r = await pc.get(f"/public-mcp/bridge/sessions/{tab['session_id']}/commands", params={"after": 0, "wait": 0}, headers=h)
    assert r.json()["commands"] == [], "a refused change is never sent to the viewer"
    out = await call(pc, tok["access_token"], "set_filters", {"changes": {"no-such": [1]}})
    assert out["status"] == "refused" and out["reason"] == "unknown_filter"


async def test_closed_tab_answers_honestly(pc, fake):
    tab = await open_tab(pc, fake.new_grant())
    tok = await connect_claude(pc, tab["pair_code"])
    await pc.post(f"/public-mcp/bridge/sessions/{tab['session_id']}/state", json={"state": DASH_STATE},
                  headers={"X-Bridge-Secret": tab["browser_secret"]})
    out = await call(pc, tok["access_token"], "go_to_page", {"page": "p2"})
    assert out["status"] == "not_applied" and "viewer_not_responding" in str(out)


async def test_revocation_at_appbi_ends_the_session_and_the_token(pc, fake):
    g = fake.new_grant()
    tab = await open_tab(pc, g)
    tok = await connect_claude(pc, tab["pair_code"])
    assert (await call(pc, tok["access_token"], "get_report_context"))["status"] == "ok"
    fake.grants[g]["alive"] = False  # owner closed the link / turned Claude off
    out = await call(pc, tok["access_token"], "read_chart", {"chart": "7"})
    assert out["status"] == "access_ended" and out["reason"] == "link_closed"
    r = await call(pc, tok["access_token"], "get_view_state")
    assert isinstance(r, httpx2.Response) and r.status_code == 401, "the token dies with the session"
    r = await pc.get(f"/public-mcp/bridge/sessions/{tab['session_id']}/commands", headers={"X-Bridge-Secret": tab["browser_secret"]})
    assert r.status_code == 410


async def test_viewer_disconnect_revokes_claude(pc, fake):
    tab = await open_tab(pc, fake.new_grant())
    tok = await connect_claude(pc, tab["pair_code"])
    r = await pc.post(f"/public-mcp/bridge/sessions/{tab['session_id']}/end", headers={"X-Bridge-Secret": "wrong"})
    assert (await call(pc, tok["access_token"], "get_view_state"))["status"] == "ok", "a wrong secret ends nothing"
    await pc.post(f"/public-mcp/bridge/sessions/{tab['session_id']}/end", headers={"X-Bridge-Secret": tab["browser_secret"]})
    r = await call(pc, tok["access_token"], "get_view_state")
    assert isinstance(r, httpx2.Response) and r.status_code == 401


async def test_calculate_is_exact_and_closed(pc, fake):
    tab = await open_tab(pc, fake.new_grant())
    tok = await connect_claude(pc, tab["pair_code"])
    out = await call(pc, tok["access_token"], "calculate", {"expression": "(cur - prev) / prev * 100", "values": {"cur": 52783, "prev": 43428}})
    assert out["status"] == "ok" and round(out["result"], 4) == round((52783 - 43428) / 43428 * 100, 4)
    assert "not an AppBI metric" in out["note"]
    for evil in ("__import__('os')", "prev.__class__", "open('x')", "[x for x in y]", "10 ** 1000"):
        r = await call(pc, tok["access_token"], "calculate", {"expression": evil, "values": {"prev": 1}})
        assert r["status"] == "error", evil
    assert (await call(pc, tok["access_token"], "calculate", {"expression": "avg(xs)", "values": {"xs": [1, 2, 6]}}))["result"] == 3


async def test_pair_code_rate_limit_and_unauthenticated_challenge(pc, fake):
    r = await pc.post("/public-mcp", json={}, headers=PMCP_HEADERS)
    assert r.status_code == 401
    assert PUBLIC_SCOPE in r.headers["www-authenticate"] and "/.well-known/oauth-protected-resource/public-mcp" in r.headers["www-authenticate"]
    meta = (await pc.get("/.well-known/oauth-protected-resource/public-mcp")).json()
    assert meta["resource"] == f"{PUBLIC}/public-mcp" and meta["scopes_supported"] == [PUBLIC_SCOPE]
