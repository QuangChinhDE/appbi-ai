"""Saving a measure whose structured filter targets a RELATED view.

The engine applies ``filters: [{"field": "other_view.col", ...}]`` through the
relationship (correlated EXISTS; unreachable / ambiguous routes are refused by
the engine), and the measure dry-run accepts it. The view save path
(PUT /datasets/{id}/model/views/{view_id}) used to check only the LAST segment
of the field against the measure's OWN table, so it refused every such
measure with 400 "cột ... không tồn tại trên bảng" — Core computed a measure it
would not let anyone save.

Contract locked here (real Postgres, real HTTP):
  1. a filter on a related view's existing column saves, and the saved measure
     computes the filtered total (oracle: direct SQL on the fixture tables)
  2. a filter naming a view that is not in this dataset -> 400 naming the view
  3. a filter naming a missing column on the other view -> 400
  4. an unknown column on the measure's own view is still 400 (unchanged)
  5. an unqualified filter on an own column still saves (unchanged)
"""
from __future__ import annotations

import sqlalchemy as sa

from tests import pair2_topology as T
from tests.pair3_world import chart_world
from tests.test_pair3_chartservice_pg import (  # noqa: F401 — fixtures
    _pg_config,
    http,
    no_result_cache,
    pg,
)

BASE = "p2_sales"
MODEL = "G2_snowflake"   # p2_sales -> p2_customers -> p2_regions


def _put_measure(client, w, measure):
    view = w.views[BASE]
    measures = [m for m in (view.measures or []) if m.get("name") != measure["name"]] + [measure]
    return client.put(f"/api/v1/datasets/{w.dataset.id}/model/views/{view.id}",
                      json={"measures": measures})


def _saved(w, name):
    from app.models.semantic import SemanticView

    w.db.expire_all()
    view = w.db.query(SemanticView).filter(SemanticView.id == w.views[BASE].id).one()
    return next((m for m in (view.measures or []) if m.get("name") == name), None)


def test_a_filter_on_a_related_view_saves_and_computes_the_filtered_total(pg, http):
    client, holder = http
    with chart_world(pg, MODEL, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        measure = {"name": "north_rev_saved", "type": "sum", "sql": "amount",
                   "filters": [{"field": "p2_regions.name", "operator": "eq", "value": "North"}]}
        r = _put_measure(client, w, measure)
        assert r.status_code == 200, r.text
        saved = _saved(w, "north_rev_saved")
        assert saved is not None
        assert saved["filters"][0]["field"] == "p2_regions.name"

        oracle = w.conn.execute(sa.text(
            f"SELECT SUM(s.amount) FROM {T.S}.sales s "
            f"JOIN {T.S}.customers c ON c.id = s.customer_id "
            f"JOIN {T.S}.regions r ON r.id = c.region_id WHERE r.name = 'North'"
        )).scalar()
        assert oracle == 130

        p = client.post(f"/api/v1/datasets/{w.dataset.id}/model/views/{w.views[BASE].id}/measures/preview",
                        json={"measure": saved})
        assert p.status_code == 200, p.text
        body = p.json()
        assert body.get("ok"), body
        values = [v for row in body["rows"] for v in row.values() if isinstance(v, (int, float))]
        assert values and float(values[0]) == float(oracle), body["rows"]


def test_a_filter_on_a_view_not_in_this_dataset_is_refused(pg, http):
    client, holder = http
    with chart_world(pg, MODEL, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        r = _put_measure(client, w, {"name": "ghost_rev", "type": "sum", "sql": "amount",
                                     "filters": [{"field": "no_such_view.name", "operator": "eq", "value": "x"}]})
        assert r.status_code == 400, r.text
        assert "no_such_view" in r.text
        assert _saved(w, "ghost_rev") is None


def test_a_filter_on_a_missing_column_of_the_other_view_is_refused(pg, http):
    client, holder = http
    with chart_world(pg, MODEL, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        r = _put_measure(client, w, {"name": "bad_col_rev", "type": "sum", "sql": "amount",
                                     "filters": [{"field": "p2_regions.no_such_col", "operator": "eq",
                                                  "value": "x"}]})
        assert r.status_code == 400, r.text
        assert "no_such_col" in r.text and "p2_regions" in r.text
        assert _saved(w, "bad_col_rev") is None


def test_an_unknown_own_column_is_still_refused(pg, http):
    client, holder = http
    with chart_world(pg, MODEL, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        for field in ("p2_sales.no_such_col", "no_such_col"):
            r = _put_measure(client, w, {"name": "own_bad", "type": "sum", "sql": "amount",
                                         "filters": [{"field": field, "operator": "eq", "value": 1}]})
            assert r.status_code == 400, (field, r.text)
            assert "no_such_col" in r.text


def test_an_unqualified_own_filter_still_saves(pg, http):
    client, holder = http
    with chart_world(pg, MODEL, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        r = _put_measure(client, w, {"name": "store1_rev", "type": "sum", "sql": "amount",
                                     "filters": [{"field": "store_id", "operator": "eq", "value": 1}]})
        assert r.status_code == 200, r.text
        assert _saved(w, "store1_rev") is not None


def test_a_legacy_non_view_prefix_on_an_own_column_still_saves(pg, http):
    """Before the fix any `prefix.col` passed when col was on the own table;
    an existing measure saved that way must not start blocking edits."""
    client, holder = http
    with chart_world(pg, MODEL, ds_config=_pg_config()) as w:
        holder["db"] = w.db
        r = _put_measure(client, w, {"name": "legacy_rev", "type": "sum", "sql": "amount",
                                     "filters": [{"field": "sales.store_id", "operator": "eq", "value": 1}]})
        assert r.status_code == 200, r.text
