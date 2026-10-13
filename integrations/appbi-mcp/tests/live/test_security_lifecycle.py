"""F2 — account and token lifecycle vs. a Claude connection (live rig).

Policy (spec §13 F2): a revoked/expired token or a deactivated account stops every
AppBI call at once and ends the Claude connection (401, refresh refused). A user's
own password change does NOT end it today, because AppBI's PAT path does not check
the security stamp — that case is asserted as the CURRENT behaviour so the Core
fix (handoff F2) flips this test deliberately rather than silently.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import httpx2
import pytest

from .harness import API_URL, RIG_URL, Person, appbi_session_token, browser, mcp_session, raw_mcp_post, rig_state, signed_in_context, tool_json

pytestmark = pytest.mark.live

WHOAMI = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}}


async def _admin() -> dict[str, str]:
    a = rig_state()["users"]["admin"]
    return {"Authorization": f"Bearer {await appbi_session_token(a['email'], a['password'])}"}


async def _connection_token_id(admin: dict[str, str], email: str) -> str:
    async with httpx2.AsyncClient(base_url=API_URL, headers=admin, timeout=30) as c:
        toks = (await c.get("/auth/personal-access-tokens/admin")).json()
    mine = [t for t in toks if t.get("owner_email") == email and t["name"].startswith("Claude MCP") and not t.get("revoked_at")]
    return sorted(mine, key=lambda t: t["created_at"])[-1]["id"]


async def _refresh(person: Person) -> int:
    tokens, client = person.storage.tokens, person.storage.client_info
    async with httpx2.AsyncClient(timeout=30) as c:
        r = await c.post(f"{RIG_URL}/mcp-oauth/token", data={"grant_type": "refresh_token", "refresh_token": tokens.refresh_token,
                                                            "client_id": client.client_id})
    return r.status_code


async def test_admin_revocation_and_deactivation_end_the_connection():
    st = rig_state()
    b = st["users"]["author_b"]
    admin = await _admin()
    async with browser() as br:
        p = Person("author_b", b["email"], b["password"], browser_context=await signed_in_context(br, "author_b", b["email"], b["password"]))

        # 1) Admin revokes the connection's token → stops immediately, refresh refused.
        async with mcp_session(p) as client:
            assert tool_json(await client.call_tool("whoami", {}))["status"] == "ok"
            tid = await _connection_token_id(admin, b["email"])
            async with httpx2.AsyncClient(base_url=API_URL, headers=admin, timeout=30) as c:
                assert (await c.delete(f"/auth/personal-access-tokens/admin/{tid}")).status_code in (200, 204)
            assert tool_json(await client.call_tool("whoami", {}))["status"] == "credential_revoked"
            assert (await raw_mcp_post(p.storage.tokens.access_token, WHOAMI)).status_code == 401
            assert await _refresh(p) == 400  # invalid_grant: the grant is gone, not just the access token

        # 2) Reconnecting after a security event goes through AppBI consent again and works.
        p.storage.tokens = None
        p.storage.client_info = None
        async with mcp_session(p) as client:
            assert tool_json(await client.call_tool("whoami", {}))["status"] == "ok"
            # 3) Admin deactivates the account → AppBI refuses the PAT → connection ends.
            async with httpx2.AsyncClient(base_url=API_URL, headers=admin, timeout=30) as c:
                r = await c.put(f"/users/{b['id']}", json={"status": "deactivated"})
                assert r.status_code == 200, r.text
            try:
                assert tool_json(await client.call_tool("whoami", {}))["status"] == "credential_revoked"
                assert (await raw_mcp_post(p.storage.tokens.access_token, WHOAMI)).status_code == 401
            finally:
                async with httpx2.AsyncClient(base_url=API_URL, headers=admin, timeout=30) as c:
                    assert (await c.put(f"/users/{b['id']}", json={"status": "active"})).status_code == 200


async def test_revocation_during_a_running_operation_stops_it():
    st = rig_state()
    b = st["users"]["author_b"]
    admin = await _admin()
    async with browser() as br:
        p = Person("author_b", b["email"], b["password"], browser_context=await signed_in_context(br, "author_b", b["email"], b["password"]))
        async with mcp_session(p) as client:
            src = st["datasource_id"]
            plan = tool_json(await client.call_tool("plan_dataset", {"plan": {
                "name": f"Revoke mid-run {int(time.time())}",
                "tables": [{"key": k, "data_source_id": src, "source_table": f"shop.{k}"} for k in ("orders", "customers", "products", "segments")],
                "measures": [{"table": "orders", "name": "revenue", "type": "sum", "column": "amount"}]}}))
            await p.approve(plan["approval_url"])
            tid = await _connection_token_id(admin, b["email"])

            async def revoke_soon():
                await asyncio.sleep(0.4)
                async with httpx2.AsyncClient(base_url=API_URL, headers=admin, timeout=30) as c:
                    await c.delete(f"/auth/personal-access-tokens/admin/{tid}")

            res, _ = await asyncio.gather(client.call_tool("execute_plan", {"plan_id": plan["plan_id"]}), revoke_soon())
            res = tool_json(res)
            # Either the run finished before the revocation landed, or it stopped — never "blocked"/silent.
            assert res["status"] in ("credential_revoked", "draft_ready"), res
            if res["status"] == "credential_revoked":
                assert (await raw_mcp_post(p.storage.tokens.access_token, WHOAMI)).status_code == 401
            # Nothing runs after revocation: a further call is refused at the HTTP layer.
            assert (await raw_mcp_post(p.storage.tokens.access_token, WHOAMI)).status_code == 401


async def test_password_change_does_not_end_the_connection_yet():
    """CURRENT AppBI behaviour (F2, Core-owned): documents the gap; flips when fixed."""
    st = rig_state()
    a = st["users"]["author_a"]
    async with browser() as br:
        p = Person("author_a", a["email"], a["password"], browser_context=await signed_in_context(br, "author_a", a["email"], a["password"]))
        async with mcp_session(p) as client:
            assert tool_json(await client.call_tool("whoami", {}))["status"] == "ok"
            new_password = a["password"] + "x"
            tok = await appbi_session_token(a["email"], a["password"])
            async with httpx2.AsyncClient(timeout=30) as c:
                r = await c.post(f"{API_URL}/auth/change-password", headers={"Authorization": f"Bearer {tok}"},
                                 json={"old_password": a["password"], "new_password": new_password})
                assert r.status_code == 200, r.text
            st["users"]["author_a"]["password"] = new_password
            Path(__import__("os").environ["APPBI_RIG_STATE"]).write_text(json.dumps(st, indent=2))
            still = tool_json(await client.call_tool("whoami", {}))
            assert still["status"] == "ok", "F2 fixed in Core? Update the policy test: a password change should now end the connection."
