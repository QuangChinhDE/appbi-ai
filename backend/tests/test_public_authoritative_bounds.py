"""Authoritative (server-owned) constraints fail CLOSED — unit tier.

A public link's lock / 🚫 hidden constraint, a 🔒/🚫 dashboard filter, a page
scope, a link 'limit' allow-list, an embed claim and a workboard role scope are
constraints the viewer may not relax. Each one is APPLIED, or the request is
refused (a chart tile) / answered with nothing (a dropdown) — never skipped so
that the request succeeds over WIDER data. An ordinary viewer/report filter
keeps its documented behaviour: a filter on a table with no relationship path
to the chart is ignored (Power BI parity), with a diagnostic.

Locked here: the merge (no last-wins collapse, no kill of a lock, scopes AND),
the marker, the central drop recorder, every engine drop site that can be
reached without a warehouse, the calendar rewrites (accumulate, never drop),
the live WHERE builder, the distinct cascade's column fallback and dataset
compare, and the refusal text (it names no field and no value). The route-level
proof on real data is test_public_authoritative_bounds_pg.py.
"""
from __future__ import annotations

import types

import pytest

from app.services.chart_contracts import (
    AUTHORITATIVE_KEY,
    AuthoritativeFilterNotApplied,
    _record_dropped_filter,
)
from app.services.filter_layered_merge import (
    LAYER_LINK_HIDDEN,
    LAYER_LINK_LOCKED,
    LAYER_VIEWER_SLICER,
    FilterLayer,
    apply_link_scope_bounds,
    mark_authoritative,
    merge_layered_filters,
)


def _f(field, value, op="eq", **kw):
    return {"field": field, "semanticField": field, "operator": op, "value": value, **kw}


# ── the merge ────────────────────────────────────────────────────────────────


def test_two_server_owned_constraints_on_one_field_both_apply():
    """Two embed claims / a role slot plus a static lock on one field: both are
    kept (AND). Last-wins dropped the first — wider data."""
    merged = merge_layered_filters([FilterLayer(LAYER_LINK_LOCKED, [_f("t.region", "N"), _f("t.region", "S")])])
    assert sorted(m["value"] for m in merged) == ["N", "S"]


def test_a_viewer_choice_on_the_same_field_is_still_replaced_by_the_lock():
    merged = merge_layered_filters([FilterLayer(LAYER_VIEWER_SLICER, [_f("t.region", "S")]),
                                    FilterLayer(LAYER_LINK_LOCKED, [_f("t.region", "N")])])
    assert [m["value"] for m in merged] == ["N"]


def test_a_kill_marker_never_removes_a_lock_on_its_field():
    merged = merge_layered_filters([FilterLayer(LAYER_LINK_LOCKED, [_f("t.region", "N")]),
                                    FilterLayer(LAYER_LINK_HIDDEN, [{"field": "t.region", "semanticField": "t.region"}])])
    assert [m["value"] for m in merged] == ["N"]
    # it still removes a viewer/default filter
    merged = merge_layered_filters([FilterLayer(LAYER_VIEWER_SLICER, [_f("t.region", "S")]),
                                    FilterLayer(LAYER_LINK_HIDDEN, [{"field": "t.region", "semanticField": "t.region"}])])
    assert merged == []


def test_two_link_scopes_on_one_field_intersect_and_never_fall_back_to_the_second():
    scopes = [{"field": "t.rc", "semanticField": "t.rc", "limit": True, "value": ["RC01"]},
              {"field": "t.rc", "semanticField": "t.rc", "limit": True, "value": ["RC03"]}]
    out = apply_link_scope_bounds([], scopes)
    assert sorted(tuple(o["value"]) for o in out) == [("RC01",), ("RC03",)], "both bounds AND (empty result)"


def test_mark_authoritative_marks_server_owned_layers_only():
    merged = merge_layered_filters([FilterLayer(LAYER_VIEWER_SLICER, [_f("t.a", 1)]),
                                    FilterLayer(LAYER_LINK_LOCKED, [_f("t.b", 2)])])
    marked = {m["field"]: bool(m.get(AUTHORITATIVE_KEY)) for m in mark_authoritative(merged)}
    assert marked == {"t.a": False, "t.b": True}


# ── the central drop recorder + the refusal text ────────────────────────────


def test_a_dropped_authoritative_filter_refuses_and_an_ordinary_one_is_recorded():
    diags: list = []
    _record_dropped_filter(diags, _f("t.a", 1), "unreachable_view")
    assert diags and diags[0]["field"] == "t.a"
    with pytest.raises(AuthoritativeFilterNotApplied) as exc:
        _record_dropped_filter(diags, _f("hidden_view.secret_col", "secret-value", **{AUTHORITATIVE_KEY: True}),
                               "unreachable_view")
    msg = str(exc.value)
    assert "secret_col" not in msg and "secret-value" not in msg and "hidden_view" not in msg


def test_an_empty_authoritative_entry_is_never_normalized_away():
    from app.services.chart_contracts import normalize_filter_conditions

    with pytest.raises(AuthoritativeFilterNotApplied):
        normalize_filter_conditions([_f("t.a", [], op="in", **{AUTHORITATIVE_KEY: True})])
    assert normalize_filter_conditions([_f("t.a", [], op="in")]) == []


# ── the engine ───────────────────────────────────────────────────────────────


@pytest.fixture()
def eng_db():
    from sqlalchemy import create_engine
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.ext.compiler import compiles
    from sqlalchemy.orm import Session

    from app.core.database import Base
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import Chart
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    @compiles(UUID, "sqlite")
    def _u(_t, _c, **_k):
        return "CHAR(36)"

    @compiles(JSONB, "sqlite")
    def _j(_t, _c, **_k):
        return "JSON"

    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, Chart.__table__,
                                             SemanticView.__table__, SemanticModel.__table__,
                                             SemanticExplore.__table__])
    dims = lambda *n: [{"name": x, "type": "string", "sql": f"${{TABLE}}.{x}"} for x in n]  # noqa: E731
    with Session(engine) as s:
        for vid, name, cols in [(1, "orders", ("id", "customer_id")), (2, "customers", ("id", "region")),
                                (3, "stores", ("id", "region"))]:
            s.add(SemanticView(id=vid, name=name, sql_table_name=name, dimensions=dims(*cols),
                               measures=[{"name": "n", "type": "count", "sql": "*"}] if vid == 1 else []))
        s.add(SemanticModel(id=1, name="m"))
        s.add(SemanticExplore(id=1, name="orders", model_id=1, base_view_id=1, base_view_name="orders", joins=[
            {"view": "customers", "from_column": "customer_id", "to_column": "id", "cardinality": "many_to_one",
             "sql_on": "${TABLE}.customer_id = ${customers}.id"}]))
        s.add(SemanticExplore(id=2, name="stores", model_id=1, base_view_id=3, base_view_name="stores", joins=[]))
        s.commit()
        yield s


def _gen(db, filters):
    from app.services.semantic_query_engine import SemanticQueryEngine

    e = SemanticQueryEngine(db, database_type="postgresql")
    sql, _c, _ = e.generate_sql(explore_name="orders", dimensions=[], measures=["orders.n"], filters=filters,
                                model_id=1)
    return e, sql


def test_an_ordinary_filter_on_an_unrelated_table_is_still_ignored_with_a_diagnostic(eng_db):
    e, sql = _gen(eng_db, {"stores.region": [{"operator": "eq", "value": "N"}]})
    assert "stores" not in sql
    assert any(d.get("reason") == "unreachable_view" for d in e._propagation_drops)


def test_an_authoritative_filter_on_an_unrelated_table_is_refused_not_ignored(eng_db):
    with pytest.raises(AuthoritativeFilterNotApplied):
        _gen(eng_db, {"stores.region": [{"operator": "eq", "value": "N", AUTHORITATIVE_KEY: True}]})


def test_a_related_authoritative_filter_is_applied(eng_db):
    _e, sql = _gen(eng_db, {"customers.region": [{"operator": "eq", "value": "N", AUTHORITATIVE_KEY: True}]})
    assert "'N'" in sql


@pytest.mark.parametrize("cond", [
    {"operator": "in", "value": []},
    {"operator": "between", "value": [None, None]},
    {"operator": "contains", "value": None},
])
def test_an_authoritative_filter_that_renders_nothing_is_refused(eng_db, cond):
    with pytest.raises(AuthoritativeFilterNotApplied):
        _gen(eng_db, {"customers.region": [{**cond, AUTHORITATIVE_KEY: True}]})


def test_a_role_lock_on_its_own_column_gets_its_calendar_grain_or_refuses(eng_db):
    """A role lock kept on its date column is rendered with the calendar math
    for its field; a calendar field with no expression (week_start_date) was
    compared with the raw column — refused for a lock, legacy for a viewer."""
    lock = {"operator": "eq", "value": 2024, "calendarField": "year", AUTHORITATIVE_KEY: True}
    _e, sql = _gen(eng_db, {"orders.customer_id": [lock]})
    assert "EXTRACT(YEAR FROM CAST(" in sql
    with pytest.raises(AuthoritativeFilterNotApplied):
        _gen(eng_db, {"orders.customer_id": [{**lock, "calendarField": "week_start_date", "value": "2024-01-01"}]})
    _e, sql = _gen(eng_db, {"orders.customer_id": [{"operator": "eq", "value": "2024-01-01",
                                                    "calendarField": "week_start_date"}]})
    assert "2024-01-01" in sql


def test_an_unrenderable_lock_refuses_without_naming_its_field(eng_db):
    with pytest.raises(AuthoritativeFilterNotApplied) as ei:
        _gen(eng_db, {"customers.secret_col": [{"operator": "eq", "value": "x", AUTHORITATIVE_KEY: True}]})
    assert "secret_col" not in str(ei.value)
    with pytest.raises(ValueError, match="secret_col"):
        _gen(eng_db, {"customers.secret_col": [{"operator": "eq", "value": "x"}]})


def test_two_date_filters_rewritten_onto_one_calendar_key_both_apply():
    from app.services.semantic_query_engine import SemanticQueryEngine

    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng.views_cache = {"cal": object()}
    out = eng._rebind_calendar_filters({
        "o.ship_date": [{"operator": "eq", "value": 2024, "calendarField": "year"}],
        "o.order_date": [{"operator": "eq", "value": 2025, "calendarField": "year"}],
    }, "cal")
    assert sorted(d["value"] for d in out["cal.year"]) == [2024, 2025], "the second rebind overwrote the first"


def test_an_authoritative_role_specific_date_lock_is_never_moved_to_another_date_column():
    """Review #2: a 🔒 ship-date-year lock and a viewer's order-date pick with the
    SAME value were taken for one fanned filter and collapsed onto the main
    calendar (order date) — rows shipped in another year came back. Only copies
    of ONE fanned filter (one fan id) collapse; a role lock keeps its column."""
    from app.services.semantic_query_engine import SemanticQueryEngine

    eng = SemanticQueryEngine.__new__(SemanticQueryEngine)
    eng.views_cache = {"cal": object()}
    lock = {"operator": "in", "value": [2024], "calendarField": "year", AUTHORITATIVE_KEY: True}
    pick = {"operator": "in", "value": [2024], "calendarField": "year"}
    filters = {"o.ship_date": [lock], "o.order_date": [pick]}
    assert eng._collapse_fanned_calendar_filters(dict(filters), "o") == filters, "no fan: nothing collapses"
    out = eng._rebind_calendar_filters(dict(filters), "cal")
    assert out["o.ship_date"] == [lock], "the lock stays on ship_date"
    # copies of ONE fanned filter (stamped by chart_service) are still a fan
    fan = {"operator": "in", "value": [2024], "calendarField": "year", "_calendar_fan": "f1",
           AUTHORITATIVE_KEY: True}
    assert eng._rebind_calendar_filters({"o.ship_date": [fan], "o.order_date": [dict(fan)]}, "cal")["cal.year"]


def test_a_lock_reaching_the_dropdown_through_linked_fields_is_kept():
    """Review #3: the dropdown's self-strip removed a 🔒 filter whose
    linkedFields named the dropdown's field, and the hard bound was not re-added:
    the dropdown listed values outside the lock."""
    from app.services.filter_layered_merge import HARD_BOUND_KEY, hard_bounds_on_field

    lock = {"field": "orders.region", "semanticField": "orders.region", "operator": "in", "value": ["North"],
            "linkedFields": ["customers.region"], "datasetId": 1}
    (b,) = hard_bounds_on_field([lock], 1, "customers.region")
    assert b["semanticField"] == "customers.region" and b["value"] == ["North"] and b[HARD_BOUND_KEY]


def test_a_viewer_can_neither_claim_nor_shed_a_server_marker():
    from app.services.filter_layered_merge import without_server_owned_keys

    crafted = {"field": "t.a", "operator": "eq", "value": 1, "_authoritative": True, "_hard_bound": True,
               "_layer_source": "link_locked", "_calendar_fan": "x", "calendarField": "year"}
    assert without_server_owned_keys(crafted) == {"field": "t.a", "operator": "eq", "value": 1}


def test_the_per_measure_executor_never_swallows_an_authoritative_refusal():
    """Review #4 (behind FEATURE_PER_MEASURE_ISOLATION): a refused group used to
    become an empty group in a 200 response."""
    from app.services import per_measure_executor as pme
    from app.services.per_measure_planner import MeasureGroup, PerMeasurePlan

    def refused(_cfg):
        raise AuthoritativeFilterNotApplied("unreachable_view")

    def broken(_cfg):
        raise RuntimeError("warehouse hiccup")

    plan = PerMeasurePlan(enabled=True, groups=(MeasureGroup(fact_view="f", measures=()),))
    with pytest.raises(AuthoritativeFilterNotApplied):
        pme.execute_groups_parallel(plan, {"metrics": [], "dimensions": []}, runner=refused)
    # an ordinary group failure keeps its documented degrade-to-empty-group shape
    (g,) = pme.execute_groups_parallel(plan, {"metrics": [], "dimensions": []}, runner=broken)
    assert g["data"] == [] and "warehouse hiccup" in g["error"]


# ── the live WHERE builder and the distinct cascade ─────────────────────────


def test_the_live_where_builder_refuses_an_authoritative_filter_it_cannot_render():
    from app.services.live_query_service import _build_where_clause

    assert _build_where_clause([{"field": "a", "operator": "between", "value": ["x"]}], "postgresql") == ""
    with pytest.raises(AuthoritativeFilterNotApplied):
        _build_where_clause([{"field": "a", "operator": "between", "value": ["x"], AUTHORITATIVE_KEY: True}],
                            "postgresql")


def test_the_result_cache_key_carries_the_semantic_contract_version():
    from app.services import query_cache

    k1 = query_cache._make_key("t", "bar", {}, [])
    old = query_cache.SEMANTIC_RESULT_CACHE_VERSION
    try:
        query_cache.SEMANTIC_RESULT_CACHE_VERSION = old + "-next"
        assert query_cache._make_key("t", "bar", {}, []) != k1, "a contract bump must change every key"
    finally:
        query_cache.SEMANTIC_RESULT_CACHE_VERSION = old


def test_the_public_refusal_names_no_field_and_no_value():
    msg = str(AuthoritativeFilterNotApplied("unreachable_view"))
    assert "không trả dữ liệu" in msg and "." not in msg.split("(")[0][-3:]


def test_malformed_dashboard_and_page_bounds_fail_closed():
    from fastapi import HTTPException

    from app.api.public import _refuse_malformed_author_bounds

    ok = types.SimpleNamespace(filters_config=[_f("t.a", "x", publicMode="locked")],
                               pages_config=[{"id": "p1", "filters": [_f("t.b", ["y"], op="in")]}])
    _refuse_malformed_author_bounds(ok)
    for bad in (
        types.SimpleNamespace(filters_config=[_f("t.a", 5, op="between", publicMode="locked")], pages_config=[]),
        types.SimpleNamespace(filters_config=[], pages_config=[{"id": "p1", "filters": [_f("t.b", 5, op="between")]}]),
    ):
        with pytest.raises(HTTPException) as exc:
            _refuse_malformed_author_bounds(bad)
        assert exc.value.status_code == 409
