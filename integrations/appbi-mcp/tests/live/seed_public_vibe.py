"""Seed ONE published AI Vibe (Report-as-Code) report on the ISOLATED rig, code written by hand
(no model call), and a public link with Claude access on. Reuses the dataset + charts that
seed_public_report.py created (pass DASHBOARD_ID / DATASET_ID via argv).
Usage: python -m tests.live.seed_public_vibe <dataset_id> <dashboard_id>
"""
from __future__ import annotations

import asyncio
import json
import sys

import httpx2

from .harness import API_URL, appbi_session_token, rig_state

HTML = """<main class="page">
  <header class="top" data-rac-region="header" data-rac-label="Tiêu đề">
    <h1>Doanh thu cửa hàng</h1>
    <div class="filters"><div data-rac-filter="f1"></div></div>
  </header>
  <section class="kpis" data-rac-region="kpis" data-rac-label="Chỉ số chính">
    <div class="card"><h3 data-rac-title="b1"></h3><div data-rac-viz="kpi" data-rac-bind="b1"></div></div>
  </section>
  <section class="charts" data-rac-region="regions" data-rac-label="Theo vùng">
    <div class="card"><h3 data-rac-title="b2"></h3><div data-rac-viz="bar" data-rac-bind="b2" style="height:260px"></div></div>
  </section>
  <section class="charts" data-rac-region="status" data-rac-label="Theo trạng thái đơn">
    <div class="card"><h3 data-rac-title="b3"></h3><div data-rac-viz="bar" data-rac-bind="b3" style="height:260px"></div></div>
  </section>
</main>"""
CSS = """.page{font-family:system-ui;padding:20px;max-width:960px;margin:auto}.card{border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:12px 0}
.top{display:flex;justify-content:space-between;align-items:center}h1{font-size:20px;margin:0}h3{font-size:14px;margin:0 0 8px}"""


async def main(dataset_id: int, dashboard_id: int) -> None:
    admin = rig_state()["users"]["admin"]
    tok = await appbi_session_token(admin["email"], admin["password"])
    async with httpx2.AsyncClient(base_url=API_URL, headers={"Authorization": f"Bearer {tok}"}, timeout=120) as c:
        d = (await c.get(f"/dashboards/{dashboard_id}")).raise_for_status().json()
        chart_ids = [x["chart_id"] for x in sorted(d["dashboard_charts"], key=lambda x: x["chart_id"]) if x.get("chart_id")]
        art = (await c.post("/report-artifacts/blank", json={"dataset_id": dataset_id, "name": "Vibe — Doanh thu cửa hàng"})).raise_for_status().json()
        aid = art["id"]
        for cid in chart_ids:
            (await c.post(f"/report-artifacts/{aid}/bindings", json={"chart_id": cid})).raise_for_status()
        cat = (await c.get(f"/report-artifacts/{aid}/catalog")).raise_for_status().json()
        region = next(x for x in cat["dimensions"] if "region" in (x["label"] or "").lower() or "vùng" in (x["label"] or "").lower())
        (await c.post(f"/report-artifacts/{aid}/filters", json={"dimension_id": region["id"]})).raise_for_status()
        cur = (await c.get(f"/report-artifacts/{aid}")).raise_for_status().json()
        base = (cur.get("draft") or {}).get("number") or cur.get("draft_number")
        r = await c.put(f"/report-artifacts/{aid}/source", json={"html": HTML, "css": CSS, "js": "", "base_number": base})
        r.raise_for_status()
        (await c.post(f"/report-artifacts/{aid}/publish", json={})).raise_for_status()
        link = (await c.post(f"/report-artifacts/{aid}/public-links", json={
            "name": "vibe-claude", "appearance_config": {"mcp_access": {"enabled": True}, "allow_viewer_filters": True}})).raise_for_status().json()
    print(json.dumps({"artifact_id": aid, "link": link["token"]}))


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]), int(sys.argv[2])))
