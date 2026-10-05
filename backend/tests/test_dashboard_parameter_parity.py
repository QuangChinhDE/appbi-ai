"""A published report applies its parameters exactly as the Builder does.

Before: the public runtime applied no parameter at all — a field-bound switcher
filtered the Builder's charts (even at its default) but not the public page's,
a what-if switch swapped the Builder's dimension/measure but not the public
one, and a tile's author-set parameter values were ignored — so the same
report showed different numbers on /d, /embed and the integration embed.

Locked here:
  * tile instance parameters: the backend twin produces the SAME filters as the
    frontend implementation, vector for vector (shared fixture file);
  * switcher columns are resolved once, deterministically, by the server;
  * a viewer can send only what an author control can produce (its field, one
    of its options; a bound role, one of its options) — anything else is 400;
  * the public data path (single and batch) applies all three, per TILE (a
    chart placed twice with different parameters gets two answers).
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.dashboard_parameters import (
    ParameterRefused,
    dashboard_parameters,
    instance_parameter_filters,
    resolve_switcher_fields,
    split_switcher_filters,
    tile_instance_filters,
    validate_role_overrides,
)

VECTORS = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "instance_parameter_vectors.json").read_text(encoding="utf-8")
)["vectors"]


def _num_eq(a, b) -> bool:
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_num_eq(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_num_eq(a[k], b[k]) for k in a)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        return math.isclose(a, b)
    return a == b


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_instance_parameters_match_the_frontend_vectors(vector):
    got = instance_parameter_filters(vector["params"], vector["values"])
    assert _num_eq(got, vector["expected"]), (got, vector["expected"])


# ── fixtures ─────────────────────────────────────────────────────────────────

def _switcher(tile_id, name, field=None, options=("A", "B"), default=None):
    cfg = {"paramName": name, "options": [{"label": o, "value": o} for o in options]}
    if field:
        cfg["field"] = field
    if default:
        cfg["default"] = default
    return SimpleNamespace(id=tile_id, chart_id=None, widget_type="parameter_switcher",
                           widget_config=cfg, layout={}, parameters={}, chart=None)


def _chart_tile(tile_id, chart_id, binding=None, parameters=None, chart_params=None):
    chart = SimpleNamespace(id=chart_id, config={"semanticBinding": binding or {}}, parameters=chart_params or [])
    return SimpleNamespace(id=tile_id, chart_id=chart_id, widget_type="chart", widget_config={},
                           layout={}, parameters=parameters or {}, chart=chart)


BINDING = {
    "datasetId": 7,
    "baseViewName": "orders",
    "reachableFields": ["orders.status", "orders.region", "customers.region", "customers.segment"],
    "fieldMap": {"status": "orders.status"},
}


# ── switcher resolution ──────────────────────────────────────────────────────

def test_a_switcher_column_is_resolved_once_and_deterministically():
    tiles = [_chart_tile(10, 100, BINDING), _switcher(1, "seg", field="segment"),
             _switcher(2, "reg", field="region"), _switcher(3, "st", field="status"),
             _switcher(4, "q", field="customers.region"), _switcher(5, "unknown", field="nope"),
             _switcher(6, "text_only")]
    r = resolve_switcher_fields(tiles)
    assert r["seg"] == {"field": "segment", "semanticField": "customers.segment", "fieldKey": "customers.segment", "datasetId": 7}
    # the chart's base view wins over another view's same-named column
    assert r["reg"]["semanticField"] == "orders.region"
    # the chart's own fieldMap entry
    assert r["st"]["semanticField"] == "orders.status"
    # an exact semantic ref stays itself
    assert r["q"]["semanticField"] == "customers.region"
    # nothing to resolve against: the bare column (non-semantic dataset)
    assert r["unknown"] == {"field": "nope"}
    assert "text_only" not in r


# ── what a viewer may send ───────────────────────────────────────────────────

@pytest.fixture()
def report():
    tiles = [_chart_tile(10, 100, BINDING, parameters={"__whatifBindings": [{"param": "dim", "role": "dimension"}]}),
             _switcher(1, "reg", field="region", options=("North", "South")),
             _switcher(2, "dim", options=("orders.status", "customers.segment"))]
    return tiles, dashboard_parameters(tiles), resolve_switcher_fields(tiles)


def _pf(**kw):
    return {"id": "param-reg", "operator": "in", "value": ["North"], "field": "region",
            "semanticField": "orders.region", "fieldKey": "orders.region", **kw}


def test_a_switcher_filter_the_author_control_can_produce_is_accepted(report):
    _tiles, params, resolved = report
    switcher, rest = split_switcher_filters([_pf(), {"field": "status", "operator": "in", "value": ["x"]}], params, resolved)
    assert switcher == [{"id": "param-reg", "field": "region", "semanticField": "orders.region",
                         "fieldKey": "orders.region", "operator": "in", "value": ["North"]}]
    assert rest == [{"field": "status", "operator": "in", "value": ["x"]}]


@pytest.mark.parametrize("forged", [
    {"value": ["West"]},                                   # not an option
    {"value": ["North", "South"]},                         # more than one
    {"operator": "not_in"},                                # not what the control does
    {"semanticField": "customers.secret", "fieldKey": "customers.secret", "field": "secret"},  # another field
    {"id": "param-nope"},                                  # no such switcher
    {"id": "param-dim"},                                   # a what-if switcher has no field
])
def test_a_forged_switcher_filter_is_refused(report, forged):
    _tiles, params, resolved = report
    with pytest.raises(ParameterRefused):
        split_switcher_filters([_pf(**forged)], params, resolved)


def test_a_what_if_override_must_be_a_bound_role_and_an_offered_option(report):
    tiles, params, _ = report
    tile = tiles[0]
    assert validate_role_overrides(tile, {"dimension": "customers.segment"}, params) == {"dimension": "customers.segment"}
    assert validate_role_overrides(tile, None, params) is None
    for bad in ({"dimension": "customers.secret"}, {"metric": "orders.status"}, {"colour": "x"}, ["dimension"]):
        with pytest.raises(ParameterRefused):
            validate_role_overrides(tile, bad, params)


def test_tile_instance_filters_read_the_tile_not_the_whatif_key():
    cp = [SimpleNamespace(parameter_name="region", parameter_type="dimension",
                          column_mapping={"column": "region", "type": "string"})]
    tile = _chart_tile(10, 100, BINDING, parameters={"region": "North", "__whatifBindings": []}, chart_params=cp)
    assert tile_instance_filters(tile) == [{"field": "region", "operator": "eq", "value": "North"}]


# ── the public data path applies them, per tile ─────────────────────────────

@pytest.fixture()
def http(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import public as public_api
    from app.core import get_db
    from app.services import query_cache

    cp = [SimpleNamespace(parameter_name="region", parameter_type="dimension",
                          column_mapping={"column": "region", "type": "string"})]
    tiles = [
        _chart_tile(10, 100, BINDING, parameters={"region": "North"}, chart_params=cp),
        _chart_tile(11, 100, BINDING, parameters={"region": "South"}, chart_params=cp),
        _chart_tile(12, 200, BINDING, parameters={"__whatifBindings": [{"param": "dim", "role": "dimension"}]}),
        _switcher(1, "reg", field="region", options=("North", "South")),
        _switcher(2, "dim", options=("orders.status", "customers.segment")),
    ]
    dash = SimpleNamespace(id=1, name="R", dashboard_charts=tiles, filters_config=[], slicers_config=[],
                           pages_config=[], public_filters_config=[], theme_config={})
    monkeypatch.setattr(public_api, "_get_dashboard_by_token", lambda *a, **k: (dash, [], "R", {}))
    monkeypatch.setattr(public_api, "_public_chart_page_ids", lambda *a, **k: None)
    monkeypatch.setattr(public_api, "_chart_dataset_id", lambda *a, **k: 7)
    monkeypatch.setattr(public_api._limiter, "enabled", False)
    captured: list[dict] = []

    def fake_batch(items, serialize=None):
        captured.extend(items)
        return [{"chart_id": it["chart_id"], "ok": True,
                 "data": {"chart": {"id": it["chart_id"]}, "data": [], "pre_aggregated": True}} for it in items]

    monkeypatch.setattr(public_api.ChartService, "get_charts_data_batch", staticmethod(fake_batch))
    monkeypatch.setattr(public_api, "_public_chart_payload", lambda data, _f: data)
    app = FastAPI()
    app.state.limiter = public_api._limiter
    app.include_router(public_api.router)
    app.dependency_overrides[get_db] = lambda: None
    return TestClient(app), captured


def _batch(client, items):
    return client.post("/public/dashboards/t/charts/data", json={"items": items})


def test_each_tile_gets_its_own_parameters_and_answer(http):
    client, captured = http
    r = _batch(client, [{"chart_id": 100, "tile_id": 10}, {"chart_id": 100, "tile_id": 11}])
    assert r.status_code == 200
    by_tile = {x["tile_id"]: x for x in r.json()["results"]}
    assert set(by_tile) == {10, 11}
    regions = sorted(next(f["value"] for f in it["extra_filters"] if f.get("field") == "region") for it in captured)
    assert regions == ["North", "South"]


def test_a_field_bound_switcher_filters_the_public_query(http):
    client, captured = http
    pf = {"id": "param-reg", "operator": "in", "value": ["South"], "field": "region",
          "semanticField": "orders.region", "fieldKey": "orders.region", "datasetId": 7}
    r = _batch(client, [{"chart_id": 200, "tile_id": 12, "filters": [pf]}])
    assert r.status_code == 200 and "data" in r.json()["results"][0]
    assert any(f.get("semanticField") == "orders.region" and f.get("value") == ["South"]
               for f in (captured[0]["extra_filters"] or []))


def test_a_what_if_switch_reaches_the_engine(http):
    client, captured = http
    r = _batch(client, [{"chart_id": 200, "tile_id": 12, "overrides": {"dimension": "customers.segment"}}])
    assert r.status_code == 200
    assert captured[0]["role_overrides"] == {"dimension": "customers.segment"}


def test_forged_parameters_fail_that_tile_only(http):
    client, captured = http
    forged = {"id": "param-reg", "operator": "in", "value": ["Secret"], "field": "region"}
    r = _batch(client, [
        {"chart_id": 200, "tile_id": 12, "overrides": {"dimension": "customers.secret"}},
        {"chart_id": 100, "tile_id": 10, "filters": [forged]},
        {"chart_id": 100, "tile_id": 11},
    ])
    res = {x["tile_id"]: x for x in r.json()["results"]}
    assert res[12]["status"] == 400 and res[10]["status"] == 400
    assert "data" in res[11]
    assert [it["key"] for it in captured] == ["t11"]


def test_a_tile_of_another_chart_or_report_is_not_found(http):
    client, _ = http
    r = _batch(client, [{"chart_id": 100, "tile_id": 12}, {"chart_id": 100, "tile_id": 999}])
    assert {x["status"] for x in r.json()["results"]} == {404}
