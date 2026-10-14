"""Report Studio V3 — performance baseline of the report paths a viewer and an
author wait on, against a running build.

    E2E_ORIGIN=http://localhost:3218 E2E_EMAIL=... E2E_PASSWORD=... \\
      python e2e/acceptance/tools/perf_baseline.py <dashboard_id> [runs]

Measures, through the FE origin (the same proxy a browser uses), wall time of:
  builder load (GET /dashboards/{id}), public structure (GET /public/dashboards/
  {token}), one page of chart data (POST /public/.../charts/data with every
  tile), a slicer dropdown (distinct values), a draft write and a publish.
The first sample of each is the cold one (empty caches); p50/p95 over the rest.
Prints JSON; budgets are judged by the caller (see readiness/README.md).
"""
from __future__ import annotations

import json
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request
import http.cookiejar

ORIGIN = os.environ.get("E2E_ORIGIN", "http://localhost:3218").rstrip("/")
V1 = f"{ORIGIN}/api/v1"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method: str, url: str, body=None, timeout=180):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "x-e2e": "1"})
    t0 = time.perf_counter()
    with opener.open(req, timeout=timeout) as res:
        raw = res.read()
    return (time.perf_counter() - t0) * 1000, (json.loads(raw) if raw else None)


def stats(samples: list[float]) -> dict:
    warm = samples[1:] or samples
    q = sorted(warm)
    return {"cold_ms": round(samples[0]), "p50_ms": round(statistics.median(q)),
            "p95_ms": round(q[min(len(q) - 1, int(round(0.95 * (len(q) - 1))))]), "n": len(samples)}


def main() -> int:
    dash_id = int(sys.argv[1])
    runs = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    call("POST", f"{V1}/auth/login", {"email": os.environ["E2E_EMAIL"], "password": os.environ["E2E_PASSWORD"]})
    _, dash = call("GET", f"{V1}/dashboards/{dash_id}")
    _, link = call("POST", f"{V1}/dashboards/{dash_id}/public-links", {"name": f"perf-{int(time.time())}"})
    token = link["token"]
    chart_ids = [c["chart_id"] for c in dash.get("dashboard_charts") or [] if c.get("chart_id")]
    page_id = str((dash.get("pages_config") or [{"id": "page-1"}])[0].get("id") or "page-1")
    slicer = next((s for s in dash.get("slicers_config") or [] if s.get("semanticField") and s.get("datasetId")), None)
    out: dict = {"dashboard_id": dash_id, "tiles": len(chart_ids), "origin": ORIGIN}
    series: dict[str, list[float]] = {k: [] for k in ("builder_load", "public_structure", "public_page_data", "distinct", "draft_write", "publish")}
    for _ in range(runs):
        series["builder_load"].append(call("GET", f"{V1}/dashboards/{dash_id}")[0])
        series["public_structure"].append(call("GET", f"{V1}/public/dashboards/{token}")[0])
        series["public_page_data"].append(call("POST", f"{V1}/public/dashboards/{token}/charts/data",
                                               {"items": [{"chart_id": c} for c in chart_ids], "page_id": page_id})[0])
        if slicer:
            q = urllib.parse.urlencode({"dataset_id": slicer["datasetId"], "field": slicer["semanticField"], "page_id": page_id})
            series["distinct"].append(call("GET", f"{V1}/public/dashboards/{token}/filters/distinct-values?{q}")[0])
        _, d = call("GET", f"{V1}/dashboards/{dash_id}")
        rev = (d.get("shared_draft") or {}).get("rev")
        series["draft_write"].append(call("PUT", f"{V1}/dashboards/{dash_id}/draft-filters",
                                          {"theme_config": dict(d.get("theme_config") or {}), "base_rev": rev})[0])
        series["publish"].append(call("POST", f"{V1}/dashboards/{dash_id}/publish", {"force": True})[0])
    out["timings"] = {k: stats(v) for k, v in series.items() if v}
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
