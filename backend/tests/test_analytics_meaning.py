# -*- coding: utf-8 -*-
"""An Agent Flow answer must MEAN what was asked — measure, period, source, qualifier.

Locks the user-reported analytics defects (F01-F10) found while hardening
Specialized Agents. Every case is a shape the user hit on a real report:

  F01  a TABLE of year_month / mrr_active / arr_active / cus_churned was read as
       having NO measures (all `selectedColumns` became dimensions)
  F02  with several measures and none named, tools took a column BY POSITION —
       asked for ARR, `cus_churned` was measured
  F03  a stock (ARR) observed monthly was summed across months: 5,244 for a
       business whose ARR in August was 72
  F04  asked about August 2026 (ARR 72 after 864), compare_periods answered about
       July because the low month LOOKED incomplete
  F06  `arr_active` on two tables matched both at `high` confidence
  F07  an earlier Agent's prose ("… VNĐ") verified the answer's currency
  F08  `{{}}` placeholders published green; a Loop ran once over the text "{{}}"
  F10  [FOLLOWUP] lines were forced on every answer

The fixture values are the ones in `backend/eval/seed_saas_fixture.py`, so the
live evaluation and these tests disagree only if the code does.
"""
from __future__ import annotations

import asyncio
import copy
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_analytics_meaning.db")
os.environ.setdefault("DATA_DIR", ".testdata")
sys.path.insert(0, os.path.dirname(__file__))

import pytest  # noqa: E402

from app.services.agent_flows.contract import Flow, upgrade_body  # noqa: E402
from app.services.agent_flows.tools.context import extract_chart_field_semantics  # noqa: E402
from app.services.agent_flows.tools.packs import derived as DER  # noqa: E402
from app.services.dashboard_ai_bot.thinking import advanced_tools as ADV  # noqa: E402

MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
          "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"]
MRR = [50, 55, 58, 60, 66, 70, 72, 6]
ARR = [600, 660, 696, 720, 792, 840, 864, 72]
CHURN = [3, 2, 4, 1, 5, 2, 3, 40]
PLAN = [101, 101, 102, 102, 103, 103, 104, 104]

TABLE_CONFIG = {"chartType": "TABLE", "roleConfig": {"metrics": [], "selectedColumns": [
    "year_month", "mrr_active", "arr_active", "cus_churned", "plan_code"]}}
TYPES = {"year_month": "date", "mrr_active": "numeric", "arr_active": "numeric",
         "cus_churned": "integer", "plan_code": "integer"}


class Ctx:
    allowed_chart_ids = {1, 2}
    db = None

    def __init__(self, fields=None):
        self.chart_meta = {1: {"name": "SaaS monthly", "fields": fields or {}}}

    def assert_chart_in_scope(self, chart_id):
        return None


@pytest.fixture()
def table(monkeypatch):
    """The monthly TABLE, as the chart engine returns it."""
    data = {"columns": ["year_month", "mrr_active", "arr_active", "cus_churned", "plan_code"],
            "rows": [list(r) for r in zip(MONTHS, MRR, ARR, CHURN, PLAN)],
            "filters_applied": []}
    for module in (DER, ADV):
        monkeypatch.setattr(module, "_fetch_chart_data", lambda ctx, cid, **kw: copy.deepcopy(data),
                            raising=False)
    monkeypatch.setattr(ADV, "_attach_delta_unit", lambda ctx, cid, m, p: p, raising=False)
    from app.services.agent_flows.tools.packs import measure_meta
    measure_meta.clear_cache()
    return Ctx(extract_chart_field_semantics(TABLE_CONFIG, TYPES))


# ── F01: a TABLE knows its measures ─────────────────────────────────────────
def test_a_multi_measure_table_exposes_its_measures_and_keeps_time_and_ids_as_dimensions():
    f = extract_chart_field_semantics(TABLE_CONFIG, TYPES)
    assert [m["field"] for m in f["measures"]] == ["mrr_active", "arr_active", "cus_churned"]
    assert all(m["agg"] is None for m in f["measures"]), "aggregation stays undeclared"
    dims = {d["field"]: d for d in f["dimensions"]}
    assert set(dims) == {"year_month", "plan_code"}, "a numeric code is not a measure"
    assert dims["year_month"].get("time") is True


def test_a_table_without_known_types_behaves_as_before():
    f = extract_chart_field_semantics(TABLE_CONFIG, None)
    assert f["measures"] == [] and len(f["dimensions"]) == 5


def test_a_chart_with_declared_metrics_is_unchanged():
    cfg = {"roleConfig": {"metrics": [{"field": "t.revenue", "agg": "sum"}], "dimension": "t.cat",
                          "selectedColumns": ["t.cat", "t.revenue", "t.qty"]}}
    f = extract_chart_field_semantics(cfg, {"revenue": "numeric", "qty": "integer"})
    assert [m["field"] for m in f["measures"]] == ["t.revenue"]
    assert [d["field"] for d in f["dimensions"]] == ["t.cat"]


# ── F02: never a measure by position ────────────────────────────────────────
def test_total_without_a_named_measure_on_a_multi_measure_table_asks_which(table):
    got = DER.tool_total_measure(table, {"chart_id": 1})
    assert got["ok"] is False and got["error_code"] == "measure_ambiguous", got
    assert {"mrr_active", "arr_active", "cus_churned"} <= set(got["detail"]["candidates"])


def test_ranking_without_a_named_measure_asks_which(table):
    got = DER.tool_rank_values(table, {"chart_id": 1})
    assert got["ok"] is False and got["error_code"] == "measure_ambiguous", got


def test_the_named_measure_is_the_one_measured(table):
    got = DER.tool_total_measure(table, {"chart_id": 1, "measure": "arr_active", "period": "2026-08"})
    assert got["ok"] is True, got
    assert got["data"]["measure"] == "arr_active" and got["data"]["value"] == 72


def test_advanced_tools_refuse_an_unknown_measure_instead_of_the_last_column(table):
    got = ADV.tool_compare_periods(table, {"chart_id": 1, "mode": "mom", "measure": "net_revenue"})
    assert got["ok"] is False and got.get("error_code") == "bad_argument", got


def test_advanced_tools_ask_when_several_measures_and_none_named(table):
    got = ADV.tool_compare_periods(table, {"chart_id": 1, "mode": "mom"})
    assert got["ok"] is False and got.get("error_code") == "measure_ambiguous", got


# ── F03: a stock is not summed across time ──────────────────────────────────
def test_an_undeclared_series_is_not_summed_across_periods(table):
    got = DER.tool_total_measure(table, {"chart_id": 1, "measure": "arr_active"})
    assert got["ok"] is False and got["error_code"] == "time_aggregation_ambiguous", got
    assert "5244" not in str(got), "the meaningless sum must not leak into the refusal"
    assert got["detail"]["periods"]["count"] == 8


def test_the_value_at_a_period_is_that_period_and_says_so(table):
    got = DER.tool_total_measure(table, {"chart_id": 1, "measure": "arr_active", "period": "2026-07"})
    assert got["data"]["value"] == 864
    assert got["data"]["period"] == "2026-07"
    assert got["data"]["periods_covered"]["selected"] == ["2026-07-01"]


def test_a_period_not_in_the_data_is_refused_not_substituted(table):
    got = DER.tool_total_measure(table, {"chart_id": 1, "measure": "arr_active", "period": "2026-09"})
    assert got["ok"] is False and got["error_code"] == "period_not_found", got


def test_a_declared_sum_still_totals_and_names_the_periods(table, monkeypatch):
    from app.services.agent_flows.tools.packs import measure_meta
    monkeypatch.setattr(measure_meta, "describe_measure", lambda ctx, cid, m: {
        "measure": m, "agg": "sum", "format_kind": None, "unit": None, "unit_known": False,
        "additive": True, "declared": True})
    got = DER.tool_total_measure(table, {"chart_id": 1, "measure": "cus_churned"})
    assert got["data"]["value"] == sum(CHURN)
    assert got["data"]["periods_covered"]["count"] == 8


def test_a_period_asked_of_a_chart_without_time_is_refused(monkeypatch):
    data = {"columns": ["arr_active"], "rows": [[5244]], "filters_applied": []}
    monkeypatch.setattr(DER, "_fetch_chart_data", lambda ctx, cid, **kw: data)
    got = DER.tool_total_measure(Ctx({"measures": [{"field": "arr_active"}], "dimensions": []}),
                                 {"chart_id": 1, "period": "2026-08"})
    assert got["ok"] is False and got["error_code"] == "no_time_dimension", got


# ── F04: the asked period is the period compared ────────────────────────────
def test_a_named_low_period_is_compared_not_replaced(table):
    got = ADV.tool_compare_periods(table, {"chart_id": 1, "mode": "mom", "measure": "arr_active",
                                           "period": "2026-08"})
    assert got["ok"] is True, got
    d = got["data"]
    assert d["current"] == {"label": "2026-08-01", "value": 72}
    assert d["baseline"] == {"label": "2026-07-01", "value": 864}
    assert d["requested_period"] == "2026-08"
    assert d["edge_completeness"] == "suspected_incomplete", "low is suspected, not proven"


def test_a_named_period_missing_from_the_chart_is_refused(table):
    got = ADV.tool_compare_periods(table, {"chart_id": 1, "mode": "mom", "measure": "arr_active",
                                           "period": "2025-12"})
    assert got["ok"] is False and got.get("error_code") == "period_not_found", got


def test_without_a_named_period_the_suspected_edge_is_still_disclosed(table):
    got = ADV.tool_compare_periods(table, {"chart_id": 1, "mode": "mom", "measure": "arr_active"})
    d = got["data"]
    assert d["observed_latest"] == {"label": "2026-08-01", "value": 72}
    assert any(e.get("label") == "2026-08-01" for e in d["excluded_periods"])
    assert "period" in d["note_partial"], "the note tells the caller how to ask for that month"


# ── F06: one name in two tables is ambiguous ────────────────────────────────
def test_the_same_measure_name_in_two_tables_is_reported_ambiguous(monkeypatch):
    from types import SimpleNamespace
    from app.services.agent_flows.tools.packs import discover as D

    charts = {10: SimpleNamespace(id=10, name="ARR monthly", dataset_table_id=1),
              20: SimpleNamespace(id=20, name="ARR by segment", dataset_table_id=2)}
    meta = {10: {"fields": {"measures": [{"field": "dataset_table_1.arr_active"}], "dimensions": []}},
            20: {"fields": {"measures": [{"field": "dataset_table_2.arr_active"}], "dimensions": []}}}

    def on_table(ctx, tid, meas, dim, *, measure_aliases=None, dimension_aliases=None):
        c = charts[10 if tid == 1 else 20]
        return [{"chart_id": c.id, "chart_name": c.name, "dataset_table_id": tid,
                 "measure_field": meta[c.id]["fields"]["measures"][0]["field"], "match": "measure",
                 "measure_match": True, "dimension_match": False, "complete": True,
                 "confidence": "high"}]
    monkeypatch.setattr(D, "_charts_on_table", on_table)
    monkeypatch.setattr(D, "_vocabulary", lambda ctx, p, k: [p])
    import app.services.dashboard_ai_bot.govern_tools as G
    monkeypatch.setattr(G, "_scope", lambda ctx: ({1, 2}, set()))
    got = D.tool_resolve_chart_candidates(SimpleNamespace(chart_meta=meta, db=None),
                                          {"measure": "arr_active"})
    data = got["data"]
    assert {c["confidence"] for c in data["candidates"]} == {"ambiguous"}
    srcs = data["coverage"]["ambiguous_sources"]
    assert {s["measure_field"] for s in srcs} == {"dataset_table_1.arr_active", "dataset_table_2.arr_active"}
    qualified = D.tool_resolve_chart_candidates(SimpleNamespace(chart_meta=meta, db=None),
                                                {"measure": "dataset_table_1.arr_active"})
    assert "ambiguous_sources" not in qualified["data"]["coverage"]


# ── F07: an Agent's prose is not evidence for a qualifier ───────────────────
def test_a_prior_agents_prose_does_not_verify_a_currency():
    from types import SimpleNamespace
    from app.services.agent_flows.qualifiers import check_qualifiers
    from app.services.agent_flows.runtime.handlers.agent import _trusted_prior_results

    state = SimpleNamespace(
        evidence_store={"e1": {"result": {"ok": True, "data": {"value": 1258681.34, "unit": None}}}},
        trace=[SimpleNamespace(key="phan_tich", type="agent"), SimpleNamespace(key="doc", type="report_read")],
        outputs={"phan_tich": "Doanh thu là 1.258.681,34 VNĐ", "doc": {"read_ok": True}},
    )
    trusted = _trusted_prior_results(state, skip="tra_loi")
    assert all("VNĐ" not in str(x) for x in trusted), "agent prose leaked into evidence"
    assert {"read_ok": True} in trusted, "a deterministic read IS evidence"
    violations = check_qualifiers("Doanh thu đạt 1.258.681,34 VNĐ.", trusted, [])
    assert violations, "an unsupported currency must be flagged"


# ── F08: blank placeholders are not a configured flow ───────────────────────
def _flow(nodes):
    body = {"nodes": nodes}
    return Flow.model_validate({**upgrade_body(copy.deepcopy(body), key="fx", name="fx"),
                                "key": "fx", "name": "fx"})


AGENT = {"key": "a", "type": "agent", "prompt": "trả lời", "provider": "openai",
         "model": "gpt-4o-mini", "max_tool_calls": 2}


@pytest.mark.parametrize("node, needle", [
    ({"key": "sw", "type": "switch", "value": "{{}}", "cases": [{"key": "c1", "value": "x", "body": []}]},
     "{{}}"),
    ({"key": "sw", "type": "switch", "value": "", "cases": [{"key": "c1", "value": "x", "body": []}]},
     "Switch"),
    ({"key": "lp", "type": "loop", "over": "{{}}", "body": []}, "{{}}"),
    ({"key": "ft", "type": "filter", "conditions": [{"left": "{{}}", "op": "is_not_empty"}]}, "{{}}"),
])
def test_an_unfilled_expression_blocks_publish_and_says_what(node, needle):
    f = _flow([node, AGENT])
    probs = f.incomplete_config_problems()
    assert probs and any(needle in p for p in probs), probs
    assert set(probs) <= set(f.blocking_problems())


def test_a_switch_on_an_empty_expression_fails_the_step_instead_of_running_the_fallback():
    from app.services.agent_flows.runtime import executor

    with pytest.raises(ValueError, match="chưa được cấu hình"):
        executor._require_expression(type("N", (), {"key": "sw", "name": "Rẽ nhánh"})(), "{{}}", "giá trị")


# ── F10: follow-ups are the author's choice ─────────────────────────────────
def test_followups_off_strips_the_lines_and_on_is_the_default():
    from app.services.agent_flows.contract import AgentNode
    from app.services.agent_flows.runtime.handlers.agent import _strip_followups

    assert AgentNode.model_validate(AGENT).followups is True
    text = "ARR tháng 8 là 72.\n\n[FOLLOWUP] So với tháng 7 thì sao?\n- [FOLLOWUP] Theo phân khúc?"
    assert _strip_followups(text) == "ARR tháng 8 là 72."


def test_a_range_total_of_a_flow_measure_needs_the_explicit_claim_and_covers_the_range(table):
    """Live (A_single, H1): asked for churn Jan-Aug, the agent fetched AUGUST (40)
    and published it as the range total. The range is a first-class argument; an
    undeclared measure is summed over it only when the caller says it is a flow."""
    refused = DER.tool_total_measure(table, {"chart_id": 1, "measure": "cus_churned",
                                             "period_from": "2026-01", "period_to": "2026-08"})
    assert refused["ok"] is False and refused["error_code"] == "time_aggregation_ambiguous"
    assert "period_from" in refused["recovery"] and "never summed" in refused["recovery"]
    got = DER.tool_total_measure(table, {"chart_id": 1, "measure": "cus_churned", "across_periods": True,
                                         "period_from": "2026-01", "period_to": "2026-08"})
    assert got["data"]["value"] == sum(CHURN) == 60
    assert got["data"]["summed_across_periods"] == 8
    part = DER.tool_total_measure(table, {"chart_id": 1, "measure": "cus_churned", "across_periods": True,
                                          "period_from": "2026-07", "period_to": "2026-08"})
    assert part["data"]["value"] == 43 and part["data"]["periods_covered"]["selected_count"] == 2
