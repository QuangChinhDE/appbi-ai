"""Seed ONE published test dashboard on the ISOLATED rig and a public link with Claude access on.

Run against the rig only (APPBI_RIG_URL / APPBI_RIG_STATE): builds the dataset and dashboard
through the author MCP (the product path), adds a second page with the builder's draft
pipeline, publishes, and creates two public links:
  - "claude-open":   Claude access on, viewer filters on;
  - "claude-locked": Claude access on, plus a HIDDEN lock (customers.region = North).
Prints the link tokens and the expected numbers (computed with SQL on the rig source).
Usage: python -m tests.live.seed_public_report
"""
from __future__ import annotations

import asyncio
import json
import time

import httpx2

from .harness import API_URL, appbi_session_token, browser, mcp_session, rig_state, tool_json
from .test_acceptance import _metric, build_dataset, person, tables
from .test_parity_journeys import _approve_and_run


async def main() -> None:
    stamp = int(time.time())
    st = rig_state()
    admin = st["users"]["admin"]
    async with browser() as b:
        pa = await person("admin", b)
        async with mcp_session(pa) as ca:
            ds = await build_dataset(ca, pa, {
                "name": f"Public report test {stamp}", "tables": tables(0, "orders", "customers"),
                "joins": [{"from_table": "orders", "to_table": "customers", "from_columns": ["customer_id"], "to_columns": ["customer_id"]}],
                "measures": [{"table": "orders", "name": "revenue", "type": "sum", "column": "amount"},
                             {"table": "orders", "name": "order_count", "type": "count", "column": "order_id"}]})
            assert ds["status"] == "draft_ready", ds
            t = {x["key"]: x for x in ds["tables"]}
            O, C = t["orders"]["view"], t["customers"]["view"]
            tid = t["orders"]["dataset_table_id"]
            plan = tool_json(await ca.call_tool("plan_dashboard", {"plan": {
                "dataset_id": ds["dataset_id"], "dashboard_name": f"Public report test {stamp}",
                "charts": [
                    {"title": "Doanh thu", "chart_type": "KPI", "dataset_table_id": tid,
                     "config": {"roleConfig": {"metrics": [_metric(O, "revenue")]}}},
                    {"title": "Doanh thu theo vùng", "chart_type": "BAR", "dataset_table_id": tid,
                     "config": {"roleConfig": {"dimension": f"{C}.region", "metrics": [_metric(O, "revenue")]}}},
                    {"title": "Số đơn theo trạng thái", "chart_type": "BAR", "dataset_table_id": tid,
                     "config": {"roleConfig": {"dimension": f"{O}.status", "metrics": [_metric(O, "order_count")]}}},
                ]}}))
            dash = await _approve_and_run(ca, pa, plan)
            assert dash["status"] == "draft_ready", dash
            did = dash["dashboard_id"]
            rp = tool_json(await ca.call_tool("request_publish", {"resource_type": "dashboard", "resource_id": did}))
            assert await pa.approve(rp["approval_url"]) == "Approved"
            assert tool_json(await ca.call_tool("publish", {"plan_id": rp["plan_id"]}))["status"] == "published"

    token = await appbi_session_token(admin["email"], admin["password"])
    h = {"Authorization": f"Bearer {token}"}
    async with httpx2.AsyncClient(base_url=API_URL, headers=h, timeout=120) as c:
        d = (await c.get(f"/dashboards/{did}")).raise_for_status().json()
        # page 2 "Chi tiết" through the builder's draft pipeline, the status chart moves there
        pages = [{"id": "page-1", "name": "Tổng quan"}, {"id": "page-2", "name": "Chi tiết"}]
        r = await c.put(f"/dashboards/{did}/draft-filters", json={"pages_config": pages, "base_rev": (d.get("shared_draft") or {}).get("rev")})
        r.raise_for_status()
        status_tile = next(x for x in d["dashboard_charts"] if (x.get("chart") or {}).get("name") == "Số đơn theo trạng thái")
        lay = {k: v for k, v in (status_tile.get("layout") or {}).items() if k not in ("_v", "draftOnly", "draftOwner", "draftRemoved", "draftRemovedBy")}
        lay.update({"pageId": "page-2", "x": 0, "y": 0})
        (await c.put(f"/dashboards/{did}/draft-layout", json={"chart_layouts": [{"id": status_tile["id"], "layout": lay}]})).raise_for_status()
        # a viewer slicer on region (page-wide)
        region_field = f"{C}.region"
        slicer = {"id": "s-region", "field": "region", "fieldKey": region_field, "semanticField": region_field,
                  "datasetId": ds["dataset_id"], "label": "Vùng", "type": "dropdown", "interactionType": "dropdown",
                  "operator": "in", "value": []}
        d2 = (await c.get(f"/dashboards/{did}")).raise_for_status().json()
        (await c.put(f"/dashboards/{did}/draft-filters", json={"slicers_config": [slicer], "base_rev": (d2.get("shared_draft") or {}).get("rev")})).raise_for_status()
        d3 = (await c.get(f"/dashboards/{did}")).raise_for_status().json()
        tile_v = {str(x["id"]): (x.get("layout") or {}).get("_v") for x in d3["dashboard_charts"] if (x.get("layout") or {}).get("_v") is not None}
        pub = await c.post(f"/dashboards/{did}/publish", json={"tile_base_v": tile_v, "force": False,
                                                              "shared_ack_rev": (d3.get("shared_draft") or {}).get("rev"), "keep_shared": False})
        pub.raise_for_status()
        on = {"mcp_access": {"enabled": True, "share_guide": True}, "allow_viewer_filters": True,
              "ai_bot_guide": {"context": {"purpose": "Theo dõi doanh thu cửa hàng theo vùng", "unit": "USD"},
                               "facts": [{"title": "Kỳ dữ liệu", "content": "Dữ liệu test của rig MCP"}]}}
        links = {}
        for name, extra in (("claude-open", {}), ("claude-locked", {"filters_config": [
                {"field": region_field, "fieldKey": region_field, "operator": "in", "value": ["North"], "hidden": True}]})):
            r = await c.post(f"/dashboards/{did}/public-links", json={"name": name, "appearance_config": on, **extra})
            r.raise_for_status()
            links[name] = r.json()["token"]
    print(json.dumps({"dataset_id": ds["dataset_id"], "dashboard_id": did, "links": links,
                      "orders_view": O, "customers_view": C}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
