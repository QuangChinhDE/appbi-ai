# -*- coding: utf-8 -*-
"""A breakdown is not a figure, and a chart with the wrong one is not an answer.

MEASURED:

    "Bang nào có doanh thu cao nhất?"   ->   "health_beauty"

`health_beauty` is a product category. The question asked for a state.

WHY IT WAS NOT ONE BUG. The type collapsed in four places on the way out, and
fixing only the last one would have left three routes to the same wrong answer:

  1. `discover._fields()` READ the semantic `kind` — its `use_with` sentence has
     always branched on it — and published a result typed only `"field"`. The
     distinction died at the tool boundary.
  2. `resolver._semantic()` therefore saw one kind of thing and sent every field
     to `resolve_chart_candidates` as a `measure`.
  3. `resolve_chart_candidates` had no way to express a dimension at all: its
     schema offered `metric` and `measure`.
  4. `_charts_on_table` labelled every hit on the config blob `"measure"`,
     whatever had actually been found in it.

So a DIMENSION went in as a measure, any chart whose config mentioned it came
back as an exact match, and the first one was read as the answer.

WHAT THIS LOCKS. A question that names a figure AND a breakdown is resolved by a
chart that has BOTH, or it is not resolved. Half a match is reported as half a
match — `measure_match` and `dimension_match` say which half — and a caller with
no judge must not treat it as a resolution.

Deliberately NOT locked: any Vietnamese word list. The kinds come from the
governed semantic model, so a report in either language works by the same rule.
"""
from __future__ import annotations

import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows import resolver as RS  # noqa: E402
from app.services.agent_flows.tools.packs import discover as D  # noqa: E402


# ── the report these cases run against ──────────────────────────────────────
#
# Two revenue charts on one table, differing ONLY in their breakdown. That is the
# whole shape of the defect: matching on revenue alone cannot tell them apart.

CHARTS = {
    684: {"name": "Doanh thu theo bang",
          "config": {"measures": ["revenue"], "dimensions": ["customer_state"]}},
    686: {"name": "Doanh thu theo danh muc",
          "config": {"measures": ["revenue"],
                     "dimensions": ["product_category_name_english"]}},
    690: {"name": "So don theo bang",
          "config": {"measures": ["order_count"], "dimensions": ["customer_state"]}},
}

#: What the governed semantic model declares. `kind` is the fact that used to be
#: read and dropped.
FIELDS = [
    {"name": "revenue", "label": "Doanh thu", "kind": "measure"},
    {"name": "order_count", "label": "So don hang", "kind": "measure"},
    {"name": "customer_state", "label": "Bang", "kind": "dimension"},
    {"name": "product_category_name_english", "label": "Danh muc",
     "kind": "dimension"},
]


class _Chart:
    def __init__(self, cid, row):
        self.id = cid
        self.name = row["name"]
        self.config = row["config"]


class _Query:
    def __init__(self, charts):
        self._charts = charts

    def filter(self, *a, **k):
        return self

    def all(self):
        return self._charts


class _Db:
    def __init__(self, charts):
        self._charts = charts

    def query(self, _model):
        return _Query(self._charts)


class _Ctx:
    def __init__(self, allowed=(684, 686, 690)):
        self.allowed_chart_ids = set(allowed)
        self.db = _Db([_Chart(c, CHARTS[c]) for c in allowed])
        self.knowledge_scope = {}


@pytest.fixture()
def report(monkeypatch):
    """The real tools, with the semantic model and the table scope stubbed."""
    monkeypatch.setattr(
        "app.services.dashboard_ai_bot.govern_tools.tool_describe_semantic_model",
        lambda ctx, args: {"ok": True, "data": {"fields": FIELDS}},
        raising=False,
    )
    monkeypatch.setattr(
        "app.services.dashboard_ai_bot.govern_tools._scope",
        lambda ctx: ({1}, {}),
        raising=False,
    )
    return _Ctx()


def resolve(ctx, **args):
    res = D.tool_resolve_chart_candidates(ctx, args)
    assert res.get("ok") is True, res
    return res["data"]


def ids(data, *, match=None):
    return [c["chart_id"] for c in data["candidates"]
            if match is None or c["match"] == match]


# ── 1–2. the two questions that must not resolve to each other ──────────────

def test_revenue_by_state_resolves_to_the_state_chart(report):
    data = resolve(report, measure="revenue", dimension="customer_state")
    assert ids(data, match="both") == [684]
    assert data["coverage"]["exact"] == 1


def test_revenue_by_category_resolves_to_the_category_chart(report):
    data = resolve(report, measure="revenue",
                   dimension="product_category_name_english")
    assert ids(data, match="both") == [686]


# ── 3–4. and a half-match is not a resolution ───────────────────────────────

def test_no_chart_with_that_breakdown_is_not_a_category_substitution(report):
    """THE HISTORICAL WRONG ANSWER. Revenue exists, `seller_city` does not, and
    the revenue-by-category chart must not stand in for it."""
    data = resolve(report, measure="revenue", dimension="seller_city")
    assert data["coverage"]["exact"] == 0, (
        "a chart was reported as an exact match for a breakdown this report does "
        "not have — this is the substitution that answered 'which STATE' with a "
        "product category"
    )
    assert ids(data, match="both") == []
    assert "do NOT substitute" in (data["coverage"].get("note") or "")


def test_the_right_measure_with_the_wrong_dimension_says_which_half(report):
    data = resolve(report, measure="revenue", dimension="seller_city")
    by_id = {c["chart_id"]: c for c in data["candidates"]}
    assert by_id[686]["measure_match"] is True
    assert by_id[686]["dimension_match"] is False
    assert by_id[686]["match"] == "measure"
    assert by_id[686]["confidence"] == "low", (
        "half a match was presented at full confidence, which is how a caller "
        "with no judge picks a plausible wrong chart"
    )


def test_the_right_dimension_with_the_wrong_measure_is_also_only_half(report):
    data = resolve(report, measure="margin", dimension="customer_state")
    by_id = {c["chart_id"]: c for c in data["candidates"]}
    assert by_id[684]["dimension_match"] is True
    assert by_id[684]["measure_match"] is False
    assert data["coverage"]["exact"] == 0


# ── 5–6. one-sided questions still work ─────────────────────────────────────

def test_a_measure_only_question_is_unchanged(report):
    data = resolve(report, measure="revenue")
    assert set(ids(data, match="measure")) == {684, 686}
    assert data["coverage"]["exact"] == 2
    assert data["coverage"]["asked_dimension"] is None


def test_a_dimension_only_question_is_useful(report):
    """New capability, and the reason the argument is not merely a filter: asked
    only for a breakdown, the tool finds the charts that have it."""
    data = resolve(report, dimension="customer_state")
    assert set(ids(data, match="dimension")) == {684, 690}
    assert data["coverage"]["resolved_via"] == "dimension"


def test_neither_argument_is_still_refused(report):
    res = D.tool_resolve_chart_candidates(report, {})
    assert res.get("ok") is False
    assert res.get("error_code") == "bad_argument"
    assert "dimension" in str(res.get("error") or "")


# ── 7. the kind has to survive the tool boundary ────────────────────────────

def test_search_business_assets_publishes_the_field_kind(report):
    """The root cause, at the place it was lost. `use_with` branched on `kind`,
    so this function always knew — and published a result that did not say."""
    query = "doanh thu theo bang"
    out = D._fields(report, query, {"doanh", "thu", "bang"},
                    D._Once(report, query))
    by_id = {f["id"]: f for f in out}
    assert by_id, "the field finder returned nothing; the fixture is not wired"
    for fid, entry in by_id.items():
        assert "field_kind" in entry, (
            f"{fid} was published without its kind — every reader downstream has "
            "to guess, and they all guessed 'measure'"
        )
    if "customer_state" in by_id:
        assert by_id["customer_state"]["field_kind"] == "dimension"
    if "revenue" in by_id:
        assert by_id["revenue"]["field_kind"] == "measure"


# ── 8. the ReportRead path consumes the same semantics ──────────────────────

def _fake_call(assets, candidates_by_args):
    """A `Call` that answers exactly what the two tools would answer."""
    seen: list[dict] = []

    def call(name, args):
        seen.append({"name": name, "args": dict(args or {})})
        if name == "list_charts":
            return {"ok": True, "data": {"selection": {"status": "none",
                                                       "selected_ids": []}}}
        if name == "search_business_assets":
            return {"ok": True, "data": {"results": assets}}
        if name == "resolve_chart_candidates":
            key = (args.get("measure") or args.get("metric") or "",
                   args.get("dimension") or "")
            return {"ok": True,
                    "data": {"candidates": candidates_by_args.get(key, [])}}
        return {"ok": False}

    call.seen = seen                                          # type: ignore[attr-defined]
    return call


STATE_ASSETS = [
    {"type": "field", "field_kind": "measure", "id": "revenue",
     "name": "Doanh thu", "detail": "doanh thu"},
    {"type": "field", "field_kind": "dimension", "id": "customer_state",
     "name": "Bang", "detail": "bang cua khach"},
]


def test_report_read_asks_for_both_halves_together():
    """The resolver must not send a dimension as a measure — that is step 2 of
    the collapse, and it is the step the historical answer went through."""
    call = _fake_call(STATE_ASSETS, {
        ("revenue", "customer_state"): [
            {"chart_id": 684, "chart_name": "Doanh thu theo bang",
             "match": "both", "measure_match": True, "dimension_match": True},
        ],
    })
    got = RS.resolve_charts("bang nao co doanh thu cao nhat", [684, 686], call=call)

    resolves = [c for c in call.seen if c["name"] == "resolve_chart_candidates"]
    assert resolves, "the resolver never reached the bridge tool"
    assert all(c["args"].get("dimension") != "revenue" for c in resolves), (
        "a measure was passed as a dimension"
    )
    assert any(c["args"].get("dimension") == "customer_state" for c in resolves), (
        f"the breakdown never reached the tool as a dimension: "
        f"{[c['args'] for c in resolves]} — this is the collapse that made "
        "'which state' resolve to a product category"
    )
    assert got["chart_ids"] == [684]


def test_report_read_refuses_the_category_chart_when_the_state_chart_is_absent():
    """Only the category chart is authorised. The honest answer is 'not this
    report', not 'here is a different breakdown'."""
    call = _fake_call(STATE_ASSETS, {
        ("revenue", "customer_state"): [
            {"chart_id": 686, "chart_name": "Doanh thu theo danh muc",
             "match": "measure", "measure_match": True, "dimension_match": False},
        ],
    })
    got = RS.resolve_charts("bang nao co doanh thu cao nhat", [686], call=call)
    assert got["chart_ids"] == [], (
        f"a half-matching chart was resolved as the answer: {got}"
    )
    assert got["status"] in ("none", "ambiguous")


def test_an_undeclared_kind_behaves_exactly_as_before():
    """A semantic model that never declared kinds must not lose the behaviour it
    had. Measured on this deployment: 161 of 5,721 fields carry a description,
    so undeclared is the common case, not the edge case."""
    assets = [{"type": "field", "id": "revenue", "name": "Doanh thu",
               "detail": "doanh thu"}]
    call = _fake_call(assets, {
        ("revenue", ""): [
            {"chart_id": 684, "chart_name": "Doanh thu", "match": "measure"},
        ],
    })
    got = RS.resolve_charts("doanh thu the nao", [684], call=call)
    assert got["chart_ids"] == [684]
    resolves = [c for c in call.seen if c["name"] == "resolve_chart_candidates"]
    assert resolves and resolves[0]["args"] == {"measure": "revenue"}


# ── 9. and the direct Agent-tool path, which bypasses the resolver ──────────

def test_an_agent_calling_the_tool_directly_gets_the_same_verdict(report):
    """An Agent node with `resolve_chart_candidates` granted never goes through
    ReportRead's resolver. Fixing only the resolver would have left this route
    to the same wrong answer open."""
    direct = resolve(report, measure="revenue", dimension="customer_state")
    assert ids(direct, match="both") == [684]

    wrong = resolve(report, measure="revenue", dimension="seller_city")
    assert wrong["coverage"]["exact"] == 0
    assert all(c["match"] != "both" for c in wrong["candidates"])
