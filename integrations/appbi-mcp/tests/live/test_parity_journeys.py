"""Live parity journeys (M2-M5): real MCP client + OAuth, real browser approvals,
real AppBI backend and Postgres. Expected numbers come from rig/seed_shop.sql.
"""

from __future__ import annotations

import time

import httpx2
import pytest

from .harness import API_URL, RIG_URL, appbi_session_token, browser, mcp_session, rig_state, tool_json
from .test_acceptance import COMPLETED_REVENUE, REVENUE, REVENUE_BY_REGION, _metric, build_dataset, person, tables
from .test_vibe_journey import _open, _shot

pytestmark = pytest.mark.live


async def _approve_and_run(client, p, plan: dict) -> dict:
    assert plan["status"] == "awaiting_approval", plan
    assert tool_json(await client.call_tool("execute_plan", {"plan_id": plan["plan_id"]}))["status"] == "awaiting_approval"
    assert await p.approve(plan["approval_url"]) == "Approved"
    return tool_json(await client.call_tool("execute_plan", {"plan_id": plan["plan_id"]}))


async def _dashboard(token: str, did: int) -> dict:
    async with httpx2.AsyncClient(timeout=30) as c:
        r = await c.get(f"{API_URL}/dashboards/{did}", headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        return r.json()


async def test_model_and_dashboard_edit_share_and_conflict():
    stamp = int(time.time())
    st = rig_state()
    async with browser() as b:
        pa = await person("author_a", b)
        async with mcp_session(pa) as ca:
            ds = await build_dataset(ca, pa, {"name": f"Parity {stamp}", "tables": tables(0, "orders", "customers"),
                                               "joins": [{"from_table": "orders", "to_table": "customers", "from_columns": ["customer_id"], "to_columns": ["customer_id"]}],
                                               "measures": [{"table": "orders", "name": "revenue", "type": "sum", "column": "amount"}]})
            assert ds["status"] == "draft_ready", ds
            t = {x["key"]: x for x in ds["tables"]}
            O, C = t["orders"]["view"], t["customers"]["view"]

            # ── M3: edit the EXISTING model; AppBI computes the preview value before approval ──
            me = tool_json(await ca.call_tool("plan_model_edit", {"dataset_id": ds["dataset_id"], "operations": [
                {"op": "upsert_measure", "view": O, "name": "completed_revenue", "type": "sum", "column": "amount",
                 "filters": [{"field": "status", "operator": "eq", "value": "completed"}]},
                {"op": "update_dimension", "view": C, "name": "region", "label": "Sales region"},
                {"op": "add_calculated_column", "view": O, "name": "amount_k", "expression": "amount / 1000"}]}))
            assert me["status"] == "awaiting_approval", me
            values = [p["items"][0].get("value now") for p in me["previews"] if "Measure" in p["title"]]
            assert values == [COMPLETED_REVENUE], me["previews"]
            done = await _approve_and_run(ca, pa, me)
            assert done["status"] == "draft_ready", done
            got = tool_json(await ca.call_tool("get_dataset", {"dataset_id": ds["dataset_id"]}))
            assert "completed_revenue" in str(got) and "amount_k" in str(got)
            # A measure charts use cannot be removed (cascade guard, never forced).

            dash_plan = tool_json(await ca.call_tool("plan_dashboard", {"plan": {
                "dataset_id": ds["dataset_id"], "dashboard_name": f"Parity board {stamp}",
                "charts": [{"title": "Revenue", "chart_type": "KPI", "dataset_table_id": t["orders"]["dataset_table_id"],
                            "config": {"roleConfig": {"metrics": [_metric(O, "revenue")]}}},
                           {"title": "By region", "chart_type": "BAR", "dataset_table_id": t["orders"]["dataset_table_id"],
                            "config": {"roleConfig": {"dimension": f"{C}.region", "metrics": [_metric(O, "revenue")]}}}]}}))
            dash = await _approve_and_run(ca, pa, dash_plan)
            assert dash["status"] == "draft_ready", dash
            did = dash["dashboard_id"]
            rp = tool_json(await ca.call_tool("request_publish", {"resource_type": "dashboard", "resource_id": did}))
            assert await pa.approve(rp["approval_url"]) == "Approved"
            assert tool_json(await ca.call_tool("publish", {"plan_id": rp["plan_id"]}))["status"] == "published"
            tiles = {c["title"]: c["tile_id"] for c in dash["charts"]}

            rm = tool_json(await ca.call_tool("plan_model_edit", {"dataset_id": ds["dataset_id"], "operations": [
                {"op": "remove_measure", "view": O, "name": "revenue"}]}))
            res = await _approve_and_run(ca, pa, rm)
            assert res["status"] == "blocked", res

            # ── M2: edit the EXISTING published dashboard in the author's draft ──
            ed = tool_json(await ca.call_tool("plan_dashboard_edit", {"dashboard_id": did, "operations": [
                {"op": "layout", "tile_id": tiles["Revenue"], "title": "Total revenue (MCP)", "w": 12},
                {"op": "edit_chart", "tile_id": tiles["By region"], "config": {"roleConfig": {"dimension": f"{C}.region", "metrics": [_metric(O, "completed_revenue")]}}},
                {"op": "responsive", "page_id": "default", "breakpoint": "xs", "auto": True}]}))
            if ed["status"] == "invalid" and any("page 'default'" in e for e in ed["errors"]):
                pages = [p.get("id") for p in (await _dashboard(await appbi_session_token(st["users"]["author_a"]["email"], st["users"]["author_a"]["password"]), did)).get("pages_config") or []]
                ops = [{"op": "layout", "tile_id": tiles["Revenue"], "title": "Total revenue (MCP)", "w": 12},
                       {"op": "edit_chart", "tile_id": tiles["By region"], "config": {"roleConfig": {"dimension": f"{C}.region", "metrics": [_metric(O, "completed_revenue")]}}}]
                if pages:
                    ops.append({"op": "responsive", "page_id": pages[0], "breakpoint": "xs", "auto": True})
                ed = tool_json(await ca.call_tool("plan_dashboard_edit", {"dashboard_id": did, "operations": ops}))
            assert ed["status"] == "awaiting_approval", ed
            assert sum(r[f"{O}.completed_revenue"] for r in ed["previews"][0]["rows"]) <= COMPLETED_REVENUE
            token_a = await appbi_session_token(st["users"]["author_a"]["email"], st["users"]["author_a"]["password"])
            before = await _dashboard(token_a, did)
            out = await _approve_and_run(ca, pa, ed)
            assert out["status"] == "draft_ready", out
            mid = await _dashboard(token_a, did)
            live_title = next(x for x in mid["dashboard_charts"] if x["id"] == tiles["Revenue"])["layout"].get("custom_title")
            assert live_title == next(x for x in before["dashboard_charts"] if x["id"] == tiles["Revenue"])["layout"].get("custom_title"), \
                "the published tile is unchanged until publish"
            page = await pa.browser_context.new_page()
            await _open(page, pa, f"{RIG_URL}/dashboards/{did}")
            await page.wait_for_load_state("networkidle")
            await page.wait_for_timeout(2500)
            assert "Total revenue (MCP)" in await page.inner_text("body"), "the Builder renders the author's draft"
            await _shot(page, "m2-dashboard-draft-in-builder")
            rp = tool_json(await ca.call_tool("request_publish", {"resource_type": "dashboard", "resource_id": did}))
            assert rp["status"] == "awaiting_approval", rp
            assert await pa.approve(rp["approval_url"]) == "Approved"
            assert tool_json(await ca.call_tool("publish", {"plan_id": rp["plan_id"]}))["status"] == "published"
            after = await _dashboard(token_a, did)
            assert next(x for x in after["dashboard_charts"] if x["layout"].get("custom_title") == "Total revenue (MCP)")

            # ── M5: share (own approval) -> the co-author can edit; a stale plan is refused ──
            sh = tool_json(await ca.call_tool("plan_share", {"resource_type": "dashboard", "resource_id": did, "permission": "edit",
                                                            "email": st["users"]["author_b"]["email"]}))
            assert (await _approve_and_run(ca, pa, sh))["status"] == "done"
            dsh = tool_json(await ca.call_tool("plan_share", {"resource_type": "dataset", "resource_id": ds["dataset_id"], "permission": "view",
                                                             "email": st["users"]["author_b"]["email"]}))
            assert (await _approve_and_run(ca, pa, dsh))["status"] == "done"

            pb = await person("author_b", b)
            async with mcp_session(pb) as cb:
                bplan = tool_json(await cb.call_tool("plan_dashboard_edit", {"dashboard_id": did, "operations": [
                    {"op": "layout", "tile_id": tiles["Revenue"], "x": 0, "y": 20}]}))
                assert bplan["status"] == "awaiting_approval", bplan
                # author_a publishes a change to the same tile first
                ap = tool_json(await ca.call_tool("plan_dashboard_edit", {"dashboard_id": did, "operations": [
                    {"op": "layout", "tile_id": tiles["Revenue"], "h": 6}]}))
                assert (await _approve_and_run(ca, pa, ap))["status"] == "draft_ready"
                rp = tool_json(await ca.call_tool("request_publish", {"resource_type": "dashboard", "resource_id": did}))
                assert await pa.approve(rp["approval_url"]) == "Approved"
                assert tool_json(await ca.call_tool("publish", {"plan_id": rp["plan_id"]}))["status"] == "published"
                stale = await _approve_and_run(cb, pb, bplan)
                assert stale["status"] in ("stale_plan", "conflict"), stale

        # ── the reader: read-only connection, cannot plan writes or publish ──
        pr = await person("reader", b)
        pr.consent_choice = "read_only"
        async with mcp_session(pr) as cr:
            tried = tool_json(await cr.call_tool("plan_dashboard_edit", {"dashboard_id": did, "operations": [{"op": "remove", "tile_id": tiles["Revenue"]}]}))
            assert tried["status"] in ("forbidden", "not_found"), tried
            pub = tool_json(await cr.call_tool("request_publish", {"resource_type": "dashboard", "resource_id": did}))
            assert pub["status"] != "awaiting_approval" or tool_json(await cr.call_tool("publish", {"plan_id": pub["plan_id"]}))["status"] == "insufficient_scope"


async def test_source_handoff_new_and_resume():
    st = rig_state()
    adm = st["users"]["admin"]
    stamp = int(time.time())
    async with browser() as b:
        p = await person("admin", b)
        async with mcp_session(p) as client:
            h = tool_json(await client.call_tool("start_source_handoff", {"kind": "new", "source_type": "postgresql", "name_hint": f"Handoff {stamp}"}))
            assert h["status"] == "handoff_required" and "/datasources/new?handoff=1" in h["handoff_url"], h
            assert tool_json(await client.call_tool("check_source_handoff", {"handoff_id": h["handoff_id"]}))["status"] == "pending"
            page = await p.browser_context.new_page()
            await _open(page, p, h["handoff_url"])
            await page.get_by_test_id("source-handoff-banner").wait_for(timeout=30_000)
            await _shot(page, "m4-source-handoff-page")
            # The user saves the source in AppBI (credentials typed into AppBI, never into the assistant).
            token = await appbi_session_token(adm["email"], adm["password"])
            src = (await httpx2.AsyncClient(timeout=30).get(f"{API_URL}/datasources/{st['datasource_id']}",
                                                             headers={"Authorization": f"Bearer {token}"})).json()
            cfg = {**{k: v for k, v in (src.get("config") or {}).items() if k != "password"}, "password": "appbi"}
            async with httpx2.AsyncClient(timeout=30) as c:
                r = await c.post(f"{API_URL}/datasources/", headers={"Authorization": f"Bearer {token}"},
                                 json={"name": f"Handoff {stamp}", "type": "postgresql", "config": cfg})
                assert r.status_code in (200, 201), r.text
            done = tool_json(await client.call_tool("check_source_handoff", {"handoff_id": h["handoff_id"], "wait_seconds": 10}))
            assert done["status"] == "completed" and done["source"]["name"] == f"Handoff {stamp}", done
            tested = tool_json(await client.call_tool("test_data_source", {"data_source_id": done["source"]["id"]}))
            assert tested["status"] == "ok", tested
            insp = tool_json(await client.call_tool("inspect_data_source", {"data_source_id": done["source"]["id"]}))
            assert insp.get("status") != "error", insp
