"""P1 — model sync keeps authored dimensions, seen from every consumer (real PG).

The owner edits dimensions through the real PUT route, the model is regenerated
through the real Generate-model route (force), and then every surface that
reads the stored dimensions is asked:

  Dataset   GET  /datasets/{id}/model                     (the model editor)
  Chart     GET  /charts/{id}/data                         (Explore / the tile)
  Dashboard GET  /public/dashboards/{t}/charts/{id}/data   (/d, /embed, PDF)

The numbers are compared with a hand-computed oracle over tests/pair2_topology
`sales` (amount by order month: 2024-01 = 100 + 11, 2024-02 = 50 + 30,
2025-03 = 7), never with ChartService's own output.
"""
from __future__ import annotations

from tests.pair3_world import chart_world, save_chart
from tests.test_pair3_chartservice_pg import (  # noqa: F401 — fixtures
    _pg_config,
    http,
    no_result_cache,
    pg,
)
from tests.test_pair4_surfaces_pg import _dashboard, batch_on_the_world_session  # noqa: F401

MONTHLY = {"2024-01": 111, "2024-02": 80, "2025-03": 7}
REQ = {"dims": ["p2_sales.order_date"], "measures": ["p2_sales.revenue"], "time_grains": {"p2_sales.order_date": "month"}}


def _month_rows(rows):
    out = {}
    for r in rows:
        key = next(v for k, v in r.items() if "order_date" in k)
        val = next(v for k, v in r.items() if "revenue" in k)
        out[str(key)[:7]] = int(float(val))
    return out


def _sales_view(client, dataset_id):
    r = client.get(f"/api/v1/datasets/{dataset_id}/model")
    assert r.status_code == 200, r.text
    return next(v for v in r.json()["views"] if v["name"] == "p2_sales")


def test_authored_dimensions_survive_generate_model_on_every_surface(pg, http):
    client, holder = http
    with chart_world(pg, "G1_star", ds_config=_pg_config()) as w:
        holder["db"] = w.db
        chart = save_chart(w, "p2_sales", REQ)
        _dash, tokens = _dashboard(w, [(chart, None)])

        view = _sales_view(client, w.dataset.id)
        dims = []
        for d in view["dimensions"]:
            d = dict(d)
            if d["name"] == "order_date":
                d.update(label="Ngày đặt hàng", description="Ngày khách đặt đơn")
            if d["name"] == "customer_id":
                d.update(type="string", label="Mã khách")  # an identifier: never summed
            dims.append(d)
        r = client.put(f"/api/v1/datasets/{w.dataset.id}/model/views/{view['id']}", json={"dimensions": dims})
        assert r.status_code == 200, r.text

        before = client.get(f"/api/v1/charts/{chart.id}/data")
        assert before.status_code == 200, before.text
        assert _month_rows(before.json()["data"]) == MONTHLY

        g = client.post(f"/api/v1/datasets/{w.dataset.id}/generate-model", params={"force": True})
        assert g.status_code == 200, g.text

        # Dataset: what the owner wrote is still there
        after = {d["name"]: d for d in _sales_view(client, w.dataset.id)["dimensions"]}
        assert after["order_date"]["label"] == "Ngày đặt hàng"
        assert after["order_date"]["description"] == "Ngày khách đặt đơn"
        assert after["customer_id"]["type"] == "string" and after["customer_id"]["label"] == "Mã khách"
        # an untouched dimension is exactly what the generator makes from the source
        from app.services.dataset_model_service import _classify_columns

        generated = {d["name"]: d for d in _classify_columns(w.tables["p2_sales"].columns_cache)[0]}
        assert {k: v for k, v in after["store_id"].items() if k != "user_edited"} == generated["store_id"]
        assert "user_edited" not in after["store_id"]

        # Chart: same truth after the sync
        r = client.get(f"/api/v1/charts/{chart.id}/data")
        assert r.status_code == 200, r.text
        assert _month_rows(r.json()["data"]) == MONTHLY

        # Dashboard / public link: same truth
        r = client.get(f"/api/v1/public/dashboards/{tokens['plain']}/charts/{chart.id}/data")
        assert r.status_code == 200, r.text
        assert _month_rows(r.json()["data"]) == MONTHLY
