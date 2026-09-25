# -*- coding: utf-8 -*-
"""The second adversarial review of the V3 closure — each finding, locked.

It reviewed the fixes of the first review and found that they were themselves
exploitable: a number the caller typed still became evidence through tools that
echo arguments, the new vocabulary made different measures aliases, a chart
title could supply a breakdown the semantic model contradicted, accent folding
made "bảng" (a table) name "bang" (a state), the dimension gate was defeated by
the word "theo", and a spent tool ceiling still killed a run whose answer needed
only the model. The reviewer's reproductions asserted each defect; these assert
its absence.
"""
from __future__ import annotations

import copy
import os
from types import SimpleNamespace

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import pytest  # noqa: E402

import test_adversarial_review_v3_closure as C  # noqa: E402
import test_budget_always_reaches_an_answer as B  # noqa: E402
import test_dimension_is_not_a_measure as T  # noqa: E402

from app.services.agent_flows import resolver as RS  # noqa: E402
from app.services.agent_flows import skills  # noqa: E402
from app.services.agent_flows.runtime.reserve import minimum_calls  # noqa: E402
from app.services.agent_flows.runtime.state import Budget, RunState  # noqa: E402
from app.services.agent_flows.tools import compute  # noqa: E402
from app.services.agent_flows.tools import dimension_gate as G  # noqa: E402
from app.services.agent_flows.tools.context import extract_chart_field_semantics  # noqa: E402
from app.services.agent_flows.tools.packs import discover as D  # noqa: E402
import app.services.agent_flows.tools.registry as tool_registry  # noqa: E402


def _ctx(state):
    return SimpleNamespace(evidence_store=state.evidence_store)


# ── P0: a number the caller typed never vouches for itself ──────────────────
def test_an_echoed_query_is_not_evidence():
    res = D.tool_search_business_assets(SimpleNamespace(), {"query": "13590000"})
    assert res["ok"] is True and res["data"]["coverage"]["query"] == "13590000"
    state = RunState()
    state.evidence_source = "agent"
    ref = state.record_evidence(res, tool="search_business_assets", args={"query": "13590000"})
    assert 13590000.0 not in state.evidence
    out = compute.tool_compute(_ctx(state), {"expression": "x",
                                             "vars": {"x": {"ref": ref, "path": "coverage.query"}}})
    assert out["data"]["provenance"] == "unreferenced" and out["data"]["evidence_values"] == []


def test_a_caller_target_and_what_is_derived_from_it_are_not_evidence(monkeypatch):
    from app.services.agent_flows.tools.packs import target as TG

    monkeypatch.setattr(TG, "_fetch_chart_data", lambda ctx, cid: {
        "columns": ["revenue"], "rows": [[100.0]], "filters_applied": []})
    monkeypatch.setattr(TG.measure_meta, "describe_measure",
                        lambda ctx, cid, col: {"additive": True, "agg": "sum", "format_kind": "", "unit": ""})
    monkeypatch.setattr(TG.measure_meta, "unit_note", lambda info: "")
    ctx = SimpleNamespace(assert_chart_in_scope=lambda cid: None, chart_meta={}, db=None)
    args = {"chart_id": 41, "measure": "revenue", "target": 13590000}
    res = TG.tool_compare_to_target(ctx, args)
    assert res["ok"] is True and res["data"]["target_source"] == "caller"
    state = RunState()
    state.evidence_source = "agent"
    ref = state.record_evidence(res, tool="compare_to_target", args=args)
    assert 13590000.0 not in state.evidence
    assert 100.0 in state.evidence, "the figure READ from the report is still evidence"
    for path in ("target", "gap", "attainment_pct"):
        out = compute.tool_compute(_ctx(state), {"expression": "t", "vars": {"t": {"ref": ref, "path": path}}})
        assert out["data"]["provenance"] == "unreferenced", path
    ok = compute.tool_compute(_ctx(state), {"expression": "t", "vars": {"t": {"ref": ref, "path": "actual"}}})
    assert ok["data"]["provenance"] == "referenced"


def test_declared_fields_hold_under_every_path_spelling():
    state = RunState()
    state.evidence_source = "a"
    e1 = state.record_evidence({"ok": True, "kind": "value", "data": {"value": 100.0}}, tool="get_chart_data")
    first = compute.tool_compute(_ctx(state), {"expression": "x + 13590000",
                                               "vars": {"x": {"ref": e1, "path": "value"}}})
    e2 = state.record_evidence(first, tool="compute")
    for path in ('["literals"][0]', "data['literals'][0]", "data.inputs[0].value", "inputs[-1].value"):
        out = compute.tool_compute(_ctx(state), {"expression": "z", "vars": {"z": {"ref": e2, "path": path}}})
        assert (not out.get("ok")) or out["data"]["provenance"] == "unreferenced", path
    for path in ('["result"]', "data.result", "data['result']"):
        out = compute.tool_compute(_ctx(state), {"expression": "z", "vars": {"z": {"ref": e2, "path": path}}})
        assert out["data"]["provenance"] == "referenced", path


# ── P1: the vocabulary and the title ────────────────────────────────────────
def _mk(charts: dict, fields: list, monkeypatch):
    monkeypatch.setattr("app.services.dashboard_ai_bot.govern_tools.tool_describe_semantic_model",
                        lambda ctx, args: {"ok": True, "data": {"fields": fields}}, raising=False)
    monkeypatch.setattr("app.services.dashboard_ai_bot.govern_tools._scope",
                        lambda ctx: ({1}, {}), raising=False)
    ctx = T._Ctx.__new__(T._Ctx)
    ctx.allowed_chart_ids = set(charts)
    ctx.db = T._Db([T._Chart(c, charts[c]) for c in charts])
    ctx.knowledge_scope = {}
    ctx.question = ""
    ctx.chart_meta = {c: {"name": charts[c]["name"],
                          "fields": extract_chart_field_semantics(charts[c]["config"])} for c in charts}
    return ctx


def _complete(data):
    return {c["chart_id"]: c for c in data["candidates"] if c["complete"]}


def test_a_description_mentioning_the_phrase_does_not_make_another_measure_an_alias(monkeypatch):
    fields = T.FIELDS + [
        {"name": "avg_order_value", "label": "Gia tri don TB", "kind": "measure",
         "description": "doanh thu chia cho so don"},
        {"name": "revenue_target", "label": "Doanh thu ke hoach", "kind": "measure"}]
    charts = dict(T.CHARTS)
    charts[700] = {"name": "Gia tri don TB theo danh muc",
                   "config": T._role("dataset_table_438.avg_order_value",
                                     "dataset_table_445.product_category_name_english")}
    charts[701] = {"name": "Ke hoach theo danh muc",
                   "config": T._role("dataset_table_438.revenue_target",
                                     "dataset_table_445.product_category_name_english")}
    ctx = _mk(charts, fields, monkeypatch)
    comp = _complete(D.tool_resolve_chart_candidates(ctx, {"measure": "doanh thu", "dimension": "danh muc"})["data"])
    assert 686 in comp and 700 not in comp and 701 not in comp, sorted(comp)


def test_an_exact_identifier_is_matched_exactly(monkeypatch):
    charts = {810: {"name": "AOV by category", "config": T._role("dataset_table_438.aov",
                                                                "dataset_table_438.category")}}
    fields = [{"name": "total_revenue", "label": "Total revenue", "kind": "measure"},
              {"name": "aov", "label": "Average order value", "kind": "measure",
               "description": "total revenue divided by the number of orders"},
              {"name": "category", "label": "Product category", "kind": "dimension"}]
    ctx = _mk(charts, fields, monkeypatch)
    data = D.tool_resolve_chart_candidates(ctx, {"measure": "total_revenue", "dimension": "category"})["data"]
    assert 810 not in _complete(data)


def test_a_binding_matches_its_own_table_only(monkeypatch):
    charts = {900: {"name": "Gia niem yet theo danh muc",
                    "config": T._role("dataset_table_999.price",
                                      "dataset_table_445.product_category_name_english")}}
    fields = [{"name": "product_category_name_english", "label": "Danh muc", "kind": "dimension"}]
    ctx = _mk(charts, fields, monkeypatch)
    monkeypatch.setattr(D._Once, "metrics", lambda self: [SimpleNamespace(name="doanh_thu", display_name="Doanh thu")])
    from app.services.governance_service import GovernanceService

    monkeypatch.setattr(GovernanceService, "metric_binding_details",
                        staticmethod(lambda db, m: [{"status": "ok", "dataset_table_id": 438,
                                                     "measure_ref": "dataset_table_438.price"}]))
    data = D.tool_resolve_chart_candidates(ctx, {"measure": "doanh thu", "dimension": "danh muc"})["data"]
    assert 900 not in _complete(data)


def test_a_title_cannot_contradict_a_labelled_dimension(monkeypatch):
    charts = dict(T.CHARTS)
    charts[702] = {"name": "Doanh thu theo thang - danh muc Dien tu",
                   "config": T._role("dataset_table_438.revenue", "dataset_table_438.order_month")}
    fields = T.FIELDS + [{"name": "order_month", "label": "Thang", "kind": "dimension"}]
    ctx = _mk(charts, fields, monkeypatch)
    comp = _complete(D.tool_resolve_chart_candidates(ctx, {"measure": "doanh thu", "dimension": "danh muc"})["data"])
    assert 686 in comp and 702 not in comp


def test_bang_a_table_is_not_bang_a_state(monkeypatch):
    charts = dict(T.CHARTS)
    charts[703] = {"name": "Bảng doanh thu theo danh mục",
                   "config": T._role("dataset_table_438.revenue",
                                     "dataset_table_445.product_category_name_english")}
    unlabelled = [f for f in T.FIELDS if f["kind"] == "measure"] + [
        {"name": "customer_state", "label": "", "kind": "dimension"},
        {"name": "product_category_name_english", "label": "", "kind": "dimension"}]
    ctx = _mk(charts, unlabelled, monkeypatch)
    comp = _complete(D.tool_resolve_chart_candidates(ctx, {"measure": "doanh thu", "dimension": "bang"})["data"])
    assert 703 not in comp, "a table of revenue by category is not revenue by state"


def test_the_deterministic_resolver_never_selects_on_a_title(monkeypatch):
    charts = {
        800: {"name": "Revenue by category", "config": T._role("dataset_table_438.total_revenue",
                                                                "dataset_table_438.category")},
        801: {"name": "Revenue by month - category Electronics",
              "config": T._role("dataset_table_438.total_revenue", "dataset_table_438.order_month")}}
    fields = [{"name": "total_revenue", "label": "Total revenue", "kind": "measure"},
              {"name": "category", "label": "Product category", "kind": "dimension"}]
    ctx = _mk(charts, fields, monkeypatch)

    def call(tool, args):
        if tool == "search_business_assets":
            return D.tool_search_business_assets(ctx, args)
        if tool == "resolve_chart_candidates":
            return D.tool_resolve_chart_candidates(ctx, args)
        return {"ok": False}

    out = RS.resolve_charts("total revenue by product category", [800, 801], call=call)
    assert 801 not in out["chart_ids"], out


def test_the_word_theo_does_not_name_every_breakdown(monkeypatch):
    ctx = _mk(T.CHARTS, T.FIELDS, monkeypatch)
    ctx.question = "Doanh thu theo bang?"
    assert G.requested_dimension(ctx) == "customer_state"
    assert G.refusal(ctx, "rank_values", {"chart_id": 686}) is not None, \
        "the category chart must not answer 'revenue by state'"


# ── P1: one spent ceiling ends only the steps that need it ──────────────────
def test_a_loop_of_tool_steps_on_the_minimum_still_reaches_the_answer(monkeypatch):
    body = {"answer_node": "tl", "nodes": [
        {"key": "lp", "name": "lp", "type": "loop", "over": "a, b", "item_var": "it",
         "body": [{"key": "t", "name": "t", "type": "tool", "tool": "list_charts", "inputs": {},
                   "on_error": "continue"}]},
        B._agent("tl", "TRA_LOI", tools=())]}
    assert minimum_calls(B._flow(body).nodes) == (1, 1)
    env, model = C._run_env(monkeypatch, body, llm=5, tools=1)
    assert len(model.by("TRA_LOI")) == 1
    assert "steps_skipped_for_budget" in [n.get("code") for n in env.get("notices") or []]


# ── P2 ──────────────────────────────────────────────────────────────────────
def test_a_skill_step_leaves_the_answering_steps_tool_reserve():
    parent = Budget(max_llm_calls=10, max_tool_calls=12)
    child = skills.child_budget(parent, reading_round=0)
    assert child.max_tool_calls == 8        # 12 − min(6, 12 // 3)


def test_argument_coercion_never_raises_and_reads_ascii_digits_only():
    spec = tool_registry.all_tools()["rank_values"]
    assert tool_registry._coerce_numeric_args(spec, {"chart_id": "007", "top_n": "-3"}) == \
        {"chart_id": 7, "top_n": -3}
    assert tool_registry._coerce_numeric_args(spec, {"chart_id": "６８６"})["chart_id"] == "６８６"
    assert tool_registry._coerce_numeric_args(spec, {"chart_id": "1" * 5000})["chart_id"] == "1" * 5000


def test_non_object_arguments_are_refused_not_raised(monkeypatch):
    monkeypatch.setattr(tool_registry, "_capability_refusal", lambda ctx, spec: None)
    out = tool_registry.execute(SimpleNamespace(), "rank_values", [1, 2], allowed=None)
    assert out["ok"] is False and out["error_code"] == "bad_argument"


def test_the_preflight_minimum_still_counts_a_disabled_skill(skill_db):
    from app.services.agent_flows.runtime.reserve import skill_lookup_for

    skill_db.registry[("so_sanh", 2)][0].lifecycle = skills.DISABLED
    flow = B._flow({"answer_node": "tl", "nodes": [
        {"key": "k", "type": "skill", "skill_key": "so_sanh", "version": 2, "inputs": {}},
        B._agent("tl", "TRA_LOI", tools=())]})
    assert minimum_calls(flow.nodes, skill_lookup=skill_lookup_for(skill_db.db, include_disabled=True)) == (2, 0)
    assert minimum_calls(flow.nodes, skill_lookup=skill_lookup_for(skill_db.db)) == (1, 0)


# ── found by the live eval: the names a model actually passes ─────────────
def _derived_ctx():
    return SimpleNamespace(chart_meta={686: {"fields": {
        "measures": [{"field": "dataset_table_438.total_revenue", "label": "Total revenue"}],
        "dimensions": [{"field": "dataset_table_445.product_category_name_english",
                        "label": "Product category name english"}]}}})


COLUMNS = ["dataset_table_445.product_category_name_english", "dataset_table_438.total_revenue"]
ROWS = [["health_beauty", 1258681.34], ["watches_gifts", 1205005.68], ["bed_bath_table", 1036988.68]]


@pytest.mark.parametrize("said", ["Total revenue", "total_revenue", "dataset_table_438.total_revenue"])
def test_the_measure_said_another_way_is_the_same_column(said):
    from app.services.agent_flows.tools.packs import derived

    got = derived._resolve(_derived_ctx(), 686, COLUMNS, ROWS, measure=said, dimension=None)
    assert isinstance(got, tuple) and got[2] == "dataset_table_438.total_revenue", got


def test_a_measure_that_is_not_there_is_still_refused_with_the_valid_names():
    from app.services.agent_flows.tools.packs import derived

    got = derived._resolve(_derived_ctx(), 686, COLUMNS, ROWS, measure="lợi nhuận", dimension=None)
    assert isinstance(got, dict) and got["error_code"] == "bad_argument"
    assert "dataset_table_438.total_revenue" in got.get("recovery", "")


def test_a_category_written_as_a_person_writes_it_is_the_value(monkeypatch):
    from app.services.agent_flows.tools.packs import derived

    monkeypatch.setattr(derived, "_load", lambda ctx, args: (COLUMNS, ROWS, []))
    monkeypatch.setattr(derived.measure_meta, "describe_measure",
                        lambda ctx, cid, col: {"additive": True, "agg": "sum", "format_kind": "", "unit": None})
    out = derived.tool_share_of(_derived_ctx(), {"chart_id": 686, "item": "Health & beauty"})
    assert out["ok"] is True and out["data"]["item"] in ("Health & beauty", "health_beauty")
    assert round(out["data"]["share_pct"], 2) == round(1258681.34 / sum(r[1] for r in ROWS) * 100, 2)


def test_a_kpi_tile_refusal_names_the_charts_that_break_the_measure_down():
    from app.services.agent_flows.tools.packs import derived

    ctx = SimpleNamespace(allowed_chart_ids={679, 686}, chart_meta={
        679: {"name": "Doanh thu sản phẩm", "fields": {
            "measures": [{"field": "dataset_table_438.total_revenue", "label": "Total revenue"}],
            "dimensions": []}},
        686: {"name": "Doanh thu theo danh mục", **_derived_ctx().chart_meta[686]}})
    got = derived._resolve(ctx, 679, ["dataset_table_438.total_revenue"], [[13591643.7]],
                           measure=None, dimension=None)
    assert isinstance(got, dict) and got["error_code"] == "not_applicable"
    assert "686" in got["error"], got["error"]


def test_a_measure_phrase_maps_through_the_governed_vocabulary(monkeypatch):
    from app.services.agent_flows.tools.packs import derived, discover

    monkeypatch.setattr(discover, "_vocabulary", lambda ctx, phrase, kind: [phrase, "total_revenue"]
                        if kind == "measure" else [phrase])
    got = derived._resolve(_derived_ctx(), 686, COLUMNS, ROWS, measure="doanh thu", dimension=None)
    assert isinstance(got, tuple) and got[2] == "dataset_table_438.total_revenue"


def test_a_breakdown_named_in_words_is_not_told_the_chart_has_no_grouping(monkeypatch):
    """Live: rank_values(chart 686, dimension='danh mục') came back 'chart 686 has
    no grouping column' three times; the model believed it and answered 'no data'."""
    from app.services.agent_flows.tools.packs import derived

    got = derived._resolve(_derived_ctx(), 686, COLUMNS, ROWS, measure=None, dimension="thành phố")
    assert isinstance(got, dict) and got["error_code"] == "bad_argument"
    assert "no grouping column" not in got["error"] and "groups by" in got["error"]
    assert "Omit `dimension`" in got.get("recovery", "")


def test_total_measure_takes_the_measure_the_way_rank_values_does(monkeypatch):
    from app.services.agent_flows.tools.packs import derived

    monkeypatch.setattr(derived, "_load", lambda ctx, args: (COLUMNS, ROWS, []))
    monkeypatch.setattr(derived.measure_meta, "describe_measure",
                        lambda ctx, cid, col: {"additive": True, "agg": "sum", "format_kind": "", "unit": None})
    out = derived.tool_total_measure(_derived_ctx(), {"chart_id": 686, "measure": "Total revenue"})
    assert out["ok"] is True and round(out["data"]["value"], 2) == round(sum(r[1] for r in ROWS), 2)


from test_skills_run_as_governed_children import skill_db  # noqa: E402,F401
