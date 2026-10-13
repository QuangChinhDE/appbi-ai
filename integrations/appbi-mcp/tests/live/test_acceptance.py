"""Live acceptance journeys (brief §8) against a running rig — see README "Acceptance rig".

Real MCP client (SDK + OAuth), real browser (Playwright), real AppBI backend and
Postgres. Expected numbers come from tests/live/rig/seed_shop.sql (deterministic)
and were cross-checked with SQL against the rig's source database.

Run: python scripts/run_offline_tests.py -m live tests/live   (needs APPBI_RIG_STATE)
"""

from __future__ import annotations

import asyncio
import time

import httpx2
import pytest

from .harness import API_URL, Person, appbi_session_token, browser, mcp_session, raw_mcp_post, rig_state, signed_in_context, tool_json

pytestmark = pytest.mark.live

# Truth from seed_shop.sql (verified by SQL on the rig source).
REVENUE = 2253900.0
COMPLETED_REVENUE = 2194200.0
ORDERS = 3000
BUYERS = 200
REVENUE_BY_REGION = {"South": 574950, "West": 574950, "North": 552000, "East": 552000}
REVENUE_BY_OWNER = {"Alice": 762690, "Bao": 739980, "Chi": 751230}
NORTH = {"revenue": 552000, "orders": 750}


async def person(key: str, b) -> Person:
    u = rig_state()["users"][key]
    ctx = await signed_in_context(b, key, u["email"], u["password"])
    return Person(key, u["email"], u["password"], browser_context=ctx)


def tables(ds_id: int = 0, *names: str) -> list[dict]:
    src = rig_state()["datasource_id"]
    return [{"key": n, "data_source_id": src, "source_table": f"shop.{n}"} for n in names]


async def build_dataset(client, p: Person, plan: dict) -> dict:
    pl = tool_json(await client.call_tool("plan_dataset", {"plan": plan}))
    assert pl["status"] == "awaiting_approval", pl
    assert tool_json(await client.call_tool("execute_plan", {"plan_id": pl["plan_id"]}))["status"] == "awaiting_approval"
    assert await p.approve(pl["approval_url"]) == "Approved"
    return tool_json(await client.call_tool("execute_plan", {"plan_id": pl["plan_id"]}))


def _metric(view: str, name: str, agg: str = "auto") -> dict:
    return {"field": f"{view}.{name}", "agg": agg}


async def test_dataset_and_dashboard_end_to_end():
    stamp = int(time.time())
    async with browser() as b:
        p = await person("author_a", b)
        async with mcp_session(p) as client:
            names = {t.name for t in (await client.list_tools()).tools}
            assert {"plan_dataset", "plan_dashboard", "execute_plan", "request_publish", "publish"} <= names

            ds = await build_dataset(client, p, {
                "name": f"Shop Sales {stamp}", "tables": tables(0, "orders", "customers", "products"),
                "joins": [{"from_table": "orders", "to_table": "customers", "from_columns": ["customer_id"], "to_columns": ["customer_id"]},
                          {"from_table": "orders", "to_table": "products", "from_columns": ["product_id"], "to_columns": ["product_id"]}],
                "measures": [
                    {"table": "orders", "name": "revenue", "type": "sum", "column": "amount"},
                    {"table": "orders", "name": "completed_revenue", "type": "sum", "column": "amount", "filters": [{"field": "status", "operator": "eq", "value": "completed"}]},
                    {"table": "orders", "name": "order_count", "type": "count_distinct", "column": "order_id"},
                    {"table": "orders", "name": "buyers", "type": "count_distinct", "column": "customer_id"}]})
            assert ds["status"] == "draft_ready", ds
            totals = {m["measure"].split(".")[1]: m["value"] for m in ds["measure_totals"]}
            assert totals == {"revenue": REVENUE, "completed_revenue": COMPLETED_REVENUE, "order_count": ORDERS, "buyers": BUYERS}
            again = tool_json(await client.call_tool("execute_plan", {"plan_id": ds["plan_id"]}))
            assert again["status"] == "draft_ready" and again["dataset_id"] == ds["dataset_id"]

            t = {x["key"]: x for x in ds["tables"]}
            O, C = t["orders"]["view"], t["customers"]["view"]
            fact = t["orders"]["dataset_table_id"]
            pl = tool_json(await client.call_tool("plan_dashboard", {"plan": {
                "dataset_id": ds["dataset_id"], "dashboard_name": f"Shop Overview {stamp}",
                "charts": [
                    {"title": "Revenue", "chart_type": "KPI", "dataset_table_id": fact, "config": {"roleConfig": {"metrics": [_metric(O, "revenue")]}}},
                    # A planner that writes agg 'sum' on a count_distinct measure must not get SUM(order_id).
                    {"title": "Orders", "chart_type": "KPI", "dataset_table_id": fact, "config": {"roleConfig": {"metrics": [_metric(O, "order_count", "sum")]}}},
                    {"title": "Revenue by region", "chart_type": "BAR", "dataset_table_id": fact, "config": {"roleConfig": {"dimension": f"{C}.region", "metrics": [_metric(O, "revenue")]}}},
                ],
                "filters": [{"field": f"{C}.region", "label": "Region"}]}}))
            assert pl["status"] == "awaiting_approval", pl
            assert any("count_distinct" in w for w in pl["warnings"])
            await p.approve(pl["approval_url"])
            dash = tool_json(await client.call_tool("execute_plan", {"plan_id": pl["plan_id"]}))
            assert dash["status"] == "draft_ready", dash
            by_title = {c["title"]: c for c in dash["charts"]}
            assert all(c["in_your_draft"] for c in dash["charts"])
            assert by_title["Orders"]["sample"][0][f"{O}.order_count"] == ORDERS
            assert {r[f"{C}.region"]: r[f"{O}.revenue"] for r in by_title["Revenue by region"]["sample"]}.items() <= REVENUE_BY_REGION.items()

            rp = tool_json(await client.call_tool("request_publish", {"resource_type": "dashboard", "resource_id": dash["dashboard_id"]}))
            assert tool_json(await client.call_tool("publish", {"plan_id": rp["plan_id"]}))["status"] == "awaiting_approval"
            await p.approve(rp["approval_url"])
            assert tool_json(await client.call_tool("publish", {"plan_id": rp["plan_id"]}))["status"] == "published"

            # The filter AppBI stored applies: North only.
            north = [{"field": "region", "semanticField": f"{C}.region", "datasetId": ds["dataset_id"], "operator": "in", "value": ["North"]}]
            rev = tool_json(await client.call_tool("get_chart_data", {"chart_id": by_title["Revenue"]["chart_id"], "filters": north}))
            assert rev["rows"][0][f"{O}.revenue"] == NORTH["revenue"] and not rev["dropped_filters"]

        # Rendered in a real browser, published, as the owner.
        page = await p.browser_context.new_page()
        from .harness import RIG_URL

        await page.goto(f"{RIG_URL}/dashboards/{dash['dashboard_id']}")
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(3000)
        text = await page.inner_text("body")
        # Values as the renderer formats them (2,253,900 → 2.3M; 3,000 → 3.0K; 552,000 → 552K).
        assert "2.3M" in text and "3.0K" in text and ("552K" in text or "552.0K" in text), text[:600]
        assert "DRAFT" not in text  # published: nothing of this user is pending


async def test_relationship_created_by_mcp_and_fanout_refused():
    stamp = int(time.time())
    async with browser() as b:
        p = await person("author_a", b)
        async with mcp_session(p) as client:
            snow = await build_dataset(client, p, {
                "name": f"Segments {stamp}", "tables": tables(0, "orders", "customers", "segments"),
                "joins": [{"from_table": "orders", "to_table": "customers", "from_columns": ["customer_id"], "to_columns": ["customer_id"]},
                          {"from_table": "customers", "to_table": "segments", "from_columns": ["segment"], "to_columns": ["segment"]}],
                "measures": [{"table": "orders", "name": "revenue", "type": "sum", "column": "amount"}]})
            assert snow["status"] == "draft_ready"
            assert {"join": "customers→segments", "result": "created", "cardinality": "many_to_one"} in snow["relationships"]
            t = {x["key"]: x for x in snow["tables"]}
            pl = tool_json(await client.call_tool("plan_dashboard", {"plan": {
                "dataset_id": snow["dataset_id"], "dashboard_name": f"Owners {stamp}",
                "charts": [{"title": "By owner", "chart_type": "BAR", "dataset_table_id": t["orders"]["dataset_table_id"],
                            "config": {"roleConfig": {"dimension": f"{t['segments']['view']}.segment_owner", "metrics": [_metric(t["orders"]["view"], "revenue")]}}}]}}))
            got = {r[f"{t['segments']['view']}.segment_owner"]: r[f"{t['orders']['view']}.revenue"] for r in pl["charts"][0]["preview"]}
            assert got == REVENUE_BY_OWNER

            trap = await build_dataset(client, p, {
                "name": f"Trap {stamp}", "tables": tables(0, "orders", "customer_regions_dup"),
                "joins": [{"from_table": "orders", "to_table": "customer_regions_dup", "from_columns": ["customer_id"], "to_columns": ["customer_id"]}]})
            assert trap["status"] == "blocked" and trap["failed_step"].startswith("join:")
            assert [r["type"] for r in trap["resources"]] == ["dataset"]  # reported, not silently deleted


async def test_security_negatives():
    st = rig_state()
    for token in (None, "garbage", st.get("pats", {}).get("author_a")):
        r = await raw_mcp_post(token, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}})
        assert r.status_code == 401
    async with browser() as b:
        pa, pb = await person("author_a", b), await person("author_b", b)
        pr = await person("reader", b)
        pr.consent_choice = "read_only"
        async with mcp_session(pa) as ca, mcp_session(pb) as cb:
            async with httpx2.AsyncClient(timeout=30) as c:
                r = await c.get(f"{API_URL}/auth/me", headers={"Authorization": f"Bearer {pa.storage.tokens.access_token}"})
                assert r.status_code == 401  # an MCP token is not an AppBI credential
            plan = tool_json(await ca.call_tool("plan_dataset", {"plan": {"name": "A only", "tables": tables(0, "orders")}}))
            assert tool_json(await cb.call_tool("execute_plan", {"plan_id": plan["plan_id"]}))["status"] == "not_found"
            async with httpx2.AsyncClient(timeout=30, follow_redirects=False) as c:
                await c.get(plan["approval_url"])
                await c.post(plan["approval_url"], data={"decision": "approve", "plan_hash": plan["plan_hash"], "csrf": "x"})
            assert tool_json(await ca.call_tool("execute_plan", {"plan_id": plan["plan_id"]}))["status"] == "awaiting_approval"
        async with mcp_session(pr) as cr:
            assert pr.storage.tokens.scope.strip() == "appbi.read"
            plan = tool_json(await cr.call_tool("plan_dataset", {"plan": {"name": "Reader", "tables": tables(0, "orders")}}))
            r = await raw_mcp_post(pr.storage.tokens.access_token, {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                                                     "params": {"name": "execute_plan", "arguments": {"plan_id": plan["plan_id"]}}})
            assert r.status_code == 403 and "insufficient_scope" in r.headers["www-authenticate"]


async def test_revoking_the_appbi_token_ends_the_connection():
    st = rig_state()
    a = st["users"]["author_a"]
    async with browser() as b:
        p = await person("author_a", b)
        async with mcp_session(p) as client:
            assert tool_json(await client.call_tool("whoami", {}))["status"] == "ok"
            sess = await appbi_session_token(a["email"], a["password"])
            async with httpx2.AsyncClient(base_url=API_URL, headers={"Authorization": f"Bearer {sess}"}, timeout=30) as c:
                toks = [t for t in (await c.get("/auth/personal-access-tokens/")).json() if t["name"].startswith("Claude MCP") and not t.get("revoked_at")]
                newest = sorted(toks, key=lambda t: t["created_at"])[-1]
                assert (await c.delete(f"/auth/personal-access-tokens/{newest['id']}")).status_code in (200, 204)
            assert tool_json(await client.call_tool("whoami", {}))["status"] == "credential_revoked"
            r = await raw_mcp_post(p.storage.tokens.access_token, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}})
            assert r.status_code == 401


async def test_concurrent_execute_creates_once():
    stamp = int(time.time())
    async with browser() as b:
        p = await person("author_a", b)
        async with mcp_session(p) as client:
            name = f"Once {stamp}"
            pl = tool_json(await client.call_tool("plan_dataset", {"plan": {"name": name, "tables": tables(0, "orders", "customers")}}))
            await p.approve(pl["approval_url"])
            await asyncio.gather(*(client.call_tool("execute_plan", {"plan_id": pl["plan_id"]}) for _ in range(3)))
            final = tool_json(await client.call_tool("execute_plan", {"plan_id": pl["plan_id"]}))
            assert final["status"] == "draft_ready"
            listed = tool_json(await client.call_tool("list_datasets", {}))["datasets"]
            assert len([d for d in listed if d["name"].startswith(name)]) == 1


async def test_dataset_sync_and_publish_to_bigquery():
    """Journey 7. Needs a materialization-enabled BigQuery source owned by author_a
    (rig state `bq_host_id`); AppBI requires one to publish."""
    st = rig_state()
    if not st.get("bq_host_id"):
        pytest.skip("rig has no BigQuery materialization host (state.bq_host_id)")
    stamp = int(time.time())
    async with browser() as b:
        p = await person("author_a", b)
        async with mcp_session(p) as client:
            ds = await build_dataset(client, p, {
                "name": f"Publish {stamp}", "tables": tables(0, "orders", "customers"),
                "measures": [{"table": "orders", "name": "revenue", "type": "sum", "column": "amount"}]})
            assert ds["status"] == "draft_ready"
            rp = tool_json(await client.call_tool("request_publish", {"resource_type": "dataset", "resource_id": ds["dataset_id"]}))
            assert tool_json(await client.call_tool("publish", {"plan_id": rp["plan_id"]}))["status"] == "awaiting_approval"
            await p.approve(rp["approval_url"])
            res = tool_json(await client.call_tool("publish", {"plan_id": rp["plan_id"]}))
            for _ in range(10):
                if res["status"] in ("published", "sync_failed"):
                    break
                res = tool_json(await client.call_tool("get_publish_status", {"dataset_id": ds["dataset_id"], "wait_seconds": 60}))
            assert res["status"] == "published", res
            assert res["has_published_data"] and res["published_generation"]
            assert res["recent_runs"][0]["status"] == "success"
            again = tool_json(await client.call_tool("publish", {"plan_id": rp["plan_id"]}))
            assert again["status"] == "published"  # idempotent: no second sync
