"""Claude runtime pool, offline: fake runtime agents behind the real public app."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import httpx2
import pytest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from appbi_mcp.public.app import create_public_app

from .conftest import PUBLIC
from .test_public_mcp import DASH_STATE, FakePublicAppbi, PMCP_HEADERS, public_settings

SECRET = "rt-secret-test"


@dataclass
class FakeAgents:
    n: int = 2
    state: dict[int, dict[str, Any]] = field(default_factory=dict)
    recycled: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.state = {i: {"lease": None, "token": None} for i in range(1, self.n + 1)}

    def app(self) -> Starlette:
        def idx(request: Request) -> int:
            return int(request.url.hostname.split("-")[-1])

        async def health(request: Request) -> JSONResponse:
            st = self.state[idx(request)]
            return JSONResponse({"state": "leased" if st["lease"] else "idle", "lease": st["lease"]})

        async def lease(request: Request) -> JSONResponse:
            if request.headers.get("x-runtime-secret") != SECRET:
                return JSONResponse({"error": "unauthorized"}, status_code=401)
            body = await request.json()
            st = self.state[idx(request)]
            if st["lease"]:
                return JSONResponse({"error": "busy"}, status_code=409)
            st.update(lease=body["lease_id"], token=body["mcp_token"], url=body["mcp_url"], brief=body.get("brief"))
            return JSONResponse({"ok": True})

        async def recycle(request: Request) -> JSONResponse:
            i = idx(request)
            self.recycled.append(i)
            self.state[i] = {"lease": None, "token": None}  # the container restarts clean
            return JSONResponse({"ok": True})

        return Starlette(routes=[Route("/health", health), Route("/lease", lease, methods=["POST"]),
                                 Route("/recycle", recycle, methods=["POST"])])


class Router(httpx2.AsyncBaseTransport):
    def __init__(self, appbi: Starlette, agents: Starlette):
        self.appbi, self.agents = httpx2.ASGITransport(app=appbi), httpx2.ASGITransport(app=agents)

    async def handle_async_request(self, request):  # type: ignore[override]
        target = self.agents if request.url.host.startswith("rt-") else self.appbi
        return await target.handle_async_request(request)


@pytest.fixture
def agents() -> FakeAgents:
    return FakeAgents()


@pytest.fixture
async def rc(tmp_path, agents):
    fake = FakePublicAppbi()
    router = Router(fake.app(), agents.app())
    settings = public_settings(tmp_path, runtime_urls=("http://rt-1", "http://rt-2"), runtime_secret=SECRET)
    app = create_public_app(settings, appbi_transport=router, runtime_transport=router)
    started, stop = asyncio.Event(), asyncio.Event()

    async def run() -> None:
        async with app.router.lifespan_context(app):
            started.set()
            await stop.wait()

    task = asyncio.create_task(run())
    await started.wait()
    async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=PUBLIC, follow_redirects=False) as c:
        c.fake = fake  # type: ignore[attr-defined]
        c.app = app  # type: ignore[attr-defined]
        yield c
    stop.set()
    await task


async def tab(c, name: str) -> dict:
    r = await c.post("/public-mcp/bridge/sessions", json={"grant": c.fake.new_grant(name=name)})
    assert r.status_code == 201, r.text
    t = r.json()
    await c.post(f"/public-mcp/bridge/sessions/{t['session_id']}/state", json={"state": DASH_STATE},
                 headers={"X-Bridge-Secret": t["browser_secret"]})
    return t


async def lease(c, t: dict) -> httpx2.Response:
    return await c.post(f"/public-mcp/bridge/sessions/{t['session_id']}/runtime", headers={"X-Bridge-Secret": t["browser_secret"]})


async def mcp(c, token: str, method: str = "tools/list", params: dict | None = None) -> httpx2.Response:
    return await c.post("/public-mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
                        headers={**PMCP_HEADERS, "Authorization": f"Bearer {token}"})


async def test_each_viewer_gets_its_own_runtime_connected_without_pairing(rc, agents):
    a, b, c3 = await tab(rc, "A"), await tab(rc, "B"), await tab(rc, "C")
    ra, rb = await lease(rc, a), await lease(rc, b)
    assert ra.status_code == 200 and rb.status_code == 200, (ra.text, rb.text)
    assert {ra.json()["runtime"], rb.json()["runtime"]} == {1, 2}
    full = await lease(rc, c3)
    assert full.status_code == 503 and full.json()["error"] == "pool_busy"
    # the runtime got a token that works at once (no pairing) and reads A's report only
    tok_a = agents.state[ra.json()["runtime"]]["token"]
    assert (await mcp(rc, tok_a)).status_code == 200
    rc.fake.calls.clear()
    r = await mcp(rc, tok_a, "tools/call", {"name": "get_report_context", "arguments": {}})
    assert r.status_code == 200 and rc.fake.calls and all(body["_grant_name"] == "A" for _, body in rc.fake.calls)
    # the tab now says Claude is connected
    poll = await rc.get(f"/public-mcp/bridge/sessions/{a['session_id']}/commands", params={"wait": 0},
                        headers={"X-Bridge-Secret": a["browser_secret"]})
    assert poll.json()["claude_connected"] is True
    # leasing again for the same tab keeps the same runtime (a reload), with a new cookie
    again = await lease(rc, a)
    assert again.json()["runtime"] == ra.json()["runtime"]


async def test_panel_cookie_opens_only_its_own_runtime(rc, agents):
    a, b = await tab(rc, "A"), await tab(rc, "B")
    ra, rb = await lease(rc, a), await lease(rc, b)
    ia, ib = ra.json()["runtime"], rb.json()["runtime"]
    ca, cb = ra.cookies.get(f"appbi_pmcp_rt_{ia}"), rb.cookies.get(f"appbi_pmcp_rt_{ib}")
    assert ca and cb

    async def auth(i: int, cookie: str | None) -> int:
        h = {"X-Original-URI": f"/claude-rt/{i}/ws"}
        if cookie:
            h["Cookie"] = f"appbi_pmcp_rt_{i}={cookie}"
        return (await rc.get("/public-mcp/runtime-auth", headers=h)).status_code

    assert await auth(ia, ca) == 204
    assert await auth(ib, ca) == 403, "A's cookie never opens B's runtime"
    assert await auth(ia, None) == 403
    assert await auth(ia, cb) == 403
    r = await rc.get("/public-mcp/runtime-auth", headers={"X-Original-URI": "/somewhere/else"})
    assert r.status_code == 403


async def test_end_of_session_recycles_the_runtime_and_kills_its_token(rc, agents):
    a = await tab(rc, "A")
    ra = await lease(rc, a)
    i = ra.json()["runtime"]
    tok = agents.state[i]["token"]
    await rc.post(f"/public-mcp/bridge/sessions/{a['session_id']}/end", headers={"X-Bridge-Secret": a["browser_secret"]})
    for _ in range(50):
        if i in agents.recycled:
            break
        await asyncio.sleep(0.02)
    assert i in agents.recycled, "the runtime is recycled (container restarts clean)"
    assert (await mcp(rc, tok)).status_code == 401, "the runtime's token dies with the session"
    # the seat is free again for the next viewer
    b = await tab(rc, "B")
    assert (await lease(rc, b)).status_code == 200


async def test_link_revoked_at_appbi_releases_the_runtime(rc, agents):
    a = await tab(rc, "A")
    ra = await lease(rc, a)
    i = ra.json()["runtime"]
    tok = agents.state[i]["token"]
    for g in rc.fake.grants.values():
        g["alive"] = False
    r = await mcp(rc, tok, "tools/call", {"name": "read_chart", "arguments": {"chart": "7"}})
    assert 'access_ended' in r.text and 'link_closed' in r.text
    for _ in range(50):
        if i in agents.recycled:
            break
        await asyncio.sleep(0.02)
    assert i in agents.recycled


async def test_idle_lease_is_reaped(rc, agents, monkeypatch):
    import appbi_mcp.public.runtimes as R

    a = await tab(rc, "A")
    i = (await lease(rc, a)).json()["runtime"]
    monkeypatch.setattr(R, "IDLE_SECONDS", -1)
    await rc.app.state.pool.reap(rc.app.state.bridge)
    assert i in agents.recycled


async def test_pool_status_needs_the_runtime_secret(rc):
    assert (await rc.get("/public-mcp/runtime-pool")).status_code == 404
    r = await rc.get("/public-mcp/runtime-pool", headers={"X-Runtime-Secret": SECRET})
    assert r.status_code == 200 and len(r.json()["runtimes"]) == 2


async def test_a_runtime_restarted_under_a_lease_is_reconciled(rc, agents):
    a = await tab(rc, "A")
    ra = await lease(rc, a)
    i = ra.json()["runtime"]
    tok = agents.state[i]["token"]
    agents.state[i] = {"lease": None, "token": None}  # the container restarted (clean)
    again = await lease(rc, a)
    assert again.status_code == 200
    assert (await mcp(rc, tok)).status_code == 401, "the old lease's token is revoked"
    assert agents.state[again.json()["runtime"]]["token"] != tok


async def _poll(c, t: dict, **params) -> httpx2.Response:
    return await c.get(f"/public-mcp/bridge/sessions/{t['session_id']}/commands", params={"wait": 0, **params},
                       headers={"X-Bridge-Secret": t["browser_secret"]})


async def test_lease_hands_claude_the_report_brief(rc, agents):
    """Claude starts with the report's business context (rendered by AppBI), not tools alone."""
    a = await tab(rc, "A")
    i = (await lease(rc, a)).json()["runtime"]
    assert agents.state[i]["brief"] == "# Report: A"


async def test_a_reload_rejoins_the_same_session_and_runtime(rc, agents):
    """Reload: the tab polls again with its saved secret; nothing ends, the runtime stays."""
    a = await tab(rc, "A")
    i = (await lease(rc, a)).json()["runtime"]
    r = await _poll(rc, a, after=2**53)
    assert r.status_code == 200 and r.json()["last_command_id"] == 0
    again = await lease(rc, a)
    assert again.json()["runtime"] == i and i not in agents.recycled
    # a wrong secret cannot rejoin
    bad = await rc.get(f"/public-mcp/bridge/sessions/{a['session_id']}/commands", params={"wait": 0},
                       headers={"X-Bridge-Secret": "nope"})
    assert bad.status_code == 410


async def test_a_tab_that_never_comes_back_ends_and_frees_its_runtime(rc, agents, monkeypatch):
    import appbi_mcp.public.runtimes as R

    a = await tab(rc, "A")
    i = (await lease(rc, a)).json()["runtime"]
    await rc.app.state.pool.reap(rc.app.state.bridge)
    assert i not in agents.recycled, "a polling tab keeps its runtime"
    monkeypatch.setattr(R, "TAB_GONE_SECONDS", -1)
    await rc.app.state.pool.reap(rc.app.state.bridge)
    for _ in range(50):
        if i in agents.recycled:
            break
        await asyncio.sleep(0.02)
    assert i in agents.recycled
    assert (await _poll(rc, a)).status_code == 410


async def test_runtime_transcript_only_from_that_runtime_for_its_lease(rc, agents):
    a = await tab(rc, "A")
    i = (await lease(rc, a)).json()["runtime"]
    lease_id = agents.state[i]["lease"]
    turn = {"id": "t1", "question": "Doanh thu?", "answer": "2,253,900", "tools": [{"name": "read_chart", "input": {"chart": "7"}}]}

    async def send(headers: dict, lid: str = lease_id) -> httpx2.Response:
        return await rc.post("/public-mcp/runtime-transcript", json={"lease_id": lid, "turn": turn}, headers=headers)

    assert (await send({})).status_code == 404
    assert (await send({"X-Runtime-Index": str(i), "X-Runtime-Secret": "wrong"})).status_code == 404
    other = 2 if i == 1 else 1
    assert (await send({"X-Runtime-Index": str(other), "X-Runtime-Secret": SECRET})).status_code == 409
    assert (await send({"X-Runtime-Index": str(i), "X-Runtime-Secret": SECRET}, "rtl_other")).status_code == 409
    rc.fake.calls.clear()
    ok = await send({"X-Runtime-Index": str(i), "X-Runtime-Secret": SECRET})
    assert ok.status_code == 200 and ok.json() == {"kept": True}
    path, body = rc.fake.calls[-1]
    assert path == "/public/mcp/transcript" and body["_grant_name"] == "A"
    assert body["turn"]["question"] == "Doanh thu?" and body["view_state"] == DASH_STATE
