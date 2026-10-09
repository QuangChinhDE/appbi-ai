# -*- coding: utf-8 -*-
"""Create the SaaS fixture's charts + report over HTTP, as an author would.

Run after `seed_saas_fixture.py`. Charts go through POST /charts so their semantic
binding is the product's own, not hand-written:

  TABLE  "SaaS theo tháng"        year_month, mrr_active, arr_active, cus_churned, plan_code
  LINE   "ARR theo tháng"         arr_active by year_month
  KPI    "ARR (cộng dồn mọi kỳ)"  arr_active summed over ALL months — the misleading tile
  BAR    "ARR theo phân khúc"     saas_segment.arr_active by segment (same column name)

    python backend/eval/build_saas_report.py --api http://127.0.0.1:8137 --token-file tok \
        --monthly-table 687 --segment-table 688
"""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request


def call(api: str, token: str, method: str, path: str, data=None):
    req = urllib.request.Request(api.rstrip("/") + "/api/v1" + path, method=method,
                                 data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code}: {e.read().decode()[:600]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--monthly-table", type=int, required=True)
    ap.add_argument("--segment-table", type=int, required=True)
    a = ap.parse_args()
    tok = open(a.token_file).read().strip()
    m, s = a.monthly_table, a.segment_table
    specs = [
        ("SaaS theo tháng", m, "TABLE", {"metrics": [], "selectedColumns": [
            "year_month", "mrr_active", "arr_active", "cus_churned", "plan_code"]}),
        ("ARR theo tháng", m, "LINE", {"metrics": [{"field": "arr_active", "agg": "sum"}],
                                       "dimension": "year_month"}),
        ("ARR (cộng dồn mọi kỳ)", m, "KPI", {"metrics": [{"field": "arr_active", "agg": "sum"}]}),
        ("ARR theo phân khúc", s, "BAR", {"metrics": [{"field": "arr_active", "agg": "sum"}],
                                          "dimension": "segment"}),
    ]
    ids = []
    for name, table, ctype, role in specs:
        c = call(a.api, tok, "POST", "/charts/", {
            "name": name, "dataset_table_id": table, "chart_type": ctype,
            "config": {"chartType": ctype, "roleConfig": role}})
        ids.append(c["id"])
    layout = lambda i: {"x": (i % 2) * 6, "y": (i // 2) * 4, "w": 6, "h": 4}  # noqa: E731
    d = call(a.api, tok, "POST", "/dashboards/", {
        "name": "EVAL SaaS metrics", "description": "Analytics correctness fixture",
        "charts": [{"chart_id": cid, "layout": layout(i)} for i, cid in enumerate(ids)]})
    print(json.dumps({"dashboard_id": d["id"], "charts": dict(zip([n for n, *_ in specs], ids))},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
