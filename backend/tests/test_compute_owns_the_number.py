# -*- coding: utf-8 -*-
"""The AI writes the formula; the runtime owns the result.

THE HOLE. `compute` took `vars` straight from the model and its result — echoing
those vars — was harvested into the evidence ledger, so the answer verifier would
certify a figure computed from a number the model typed.

THE CONTRACT THESE TESTS PIN.
  * a variable is a REFERENCE into a result this run produced (`{ref, path}`);
    the runtime reads the value — the model never supplies a trusted number;
  * a reference that does not resolve to one finite number is refused with a
    reason the model can act on;
  * literals in the expression are mathematics, allowed at any magnitude;
  * a bare number passed as a variable is computed with but NEVER certified;
  * the evaluator is a whitelist, bounded, finite;
  * lineage names every input's value, reference and producing tool/step;
  * `record_evidence` never mutates the result (results are shared/cached).
"""
from __future__ import annotations

import os
from types import SimpleNamespace

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_compute.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.agent_flows.runtime.state import RunState
from app.services.agent_flows.tools import compute as C
from app.services.agent_flows.tools import registry as reg


def _state_with(*results: tuple[str, str, dict]) -> RunState:
    state = RunState()
    for step, tool, payload in results:
        state.evidence_source = step
        state.record_evidence({"ok": True, "kind": "table", "data": payload}, tool=tool)
    return state


def _run(state: RunState, expression: str, vars_: dict) -> dict:
    ctx = SimpleNamespace(evidence_store=state.evidence_store, web_search=True, read_rows=True)
    return C.tool_compute(ctx, {"expression": expression, "vars": vars_})


REVENUE = ("read", "total_measure", {"value": 1200.0, "measure": "revenue"})
PREVIOUS = ("read", "total_measure", {"value": 1000.0, "measure": "revenue"})
TABLE = ("agent", "rank_values", {"rows": [{"category": "a", "revenue": 300}, {"category": "b", "revenue": 150}]})


# ── the canonical path ───────────────────────────────────────────────────────
def test_a_formula_over_references_is_computed_by_the_runtime_with_lineage():
    state = _state_with(REVENUE, PREVIOUS)
    out = _run(state, "(cur - prev) / prev * 100",
               {"cur": {"ref": "e1", "path": "value"}, "prev": {"ref": "e2", "path": "data.value"}})
    assert out["ok"] is True
    data = out["data"]
    assert data["result"] == 20.0
    assert data["provenance"] == "referenced"
    assert data["literals"] == [100.0]
    assert [(i["name"], i["value"], i["ref"], i["tool"], i["step"]) for i in data["inputs"]] == [
        ("cur", 1200.0, "e1", "total_measure", "read"),
        ("prev", 1000.0, "e2", "total_measure", "read"),
    ]


def test_list_indices_and_quoted_keys_resolve():
    state = _state_with(TABLE, ("x", "t", {"items": [{"Doanh thu": 7}]}))
    out = _run(state, "a + b + c", {
        "a": {"ref": "e1", "path": "rows[0].revenue"},
        "b": {"ref": "e1", "path": "rows[-1].revenue"},
        "c": {"ref": "e2", "path": 'items[0]["Doanh thu"]'},
    })
    assert out["data"]["result"] == 457.0


def test_equal_values_are_told_apart_by_reference_not_by_value():
    """The case value matching cannot decide: revenue and target both 100."""
    state = _state_with(("read", "total_measure", {"value": 100}),
                        ("read", "target_for", {"value": 100}))
    out = _run(state, "x * 2", {"x": {"ref": "e2", "path": "value"}})
    assert out["data"]["inputs"][0]["tool"] == "target_for"


# ── refusals the model can act on ────────────────────────────────────────────
@pytest.mark.parametrize("var,code", [
    ({"ref": "e9", "path": "value"}, "evidence_ref_unknown"),
    ({"ref": "e1", "path": "nope"}, "evidence_path_missing"),
    ({"ref": "e1", "path": "rows[5].revenue"}, "evidence_path_missing"),
    ({"ref": "e1", "path": "rows"}, "evidence_not_numeric"),        # ambiguous: a list
    ({"ref": "e1", "path": "rows[0]"}, "evidence_not_numeric"),     # ambiguous: an object
    ({"ref": "e1", "path": "rows[0].category"}, "evidence_not_numeric"),
])
def test_a_reference_that_is_not_one_number_is_refused_with_a_reason(var, code):
    out = _run(_state_with(TABLE), "x", {"x": var})
    assert out["ok"] is False and out["error_code"] == code
    assert out["retryable"] is False and out["error"]


@pytest.mark.parametrize("value", [None, True, "n/a", float("nan"), [1, 2]])
def test_non_numeric_evidence_is_refused(value):
    state = _state_with(("s", "t", {"v": value}))
    out = _run(state, "x", {"x": {"ref": "e1", "path": "v"}})
    assert out["error_code"] == "evidence_not_numeric"


# ── literals are mathematics ─────────────────────────────────────────────────
@pytest.mark.parametrize("expr,want", [
    ("x / 1000000", 0.0012), ("x * 365", 438000.0), ("x / 12", 100.0),
    ("round(x / 7, 2)", 171.43), ("max(x, 5000) - x", 3800.0), ("abs(-x)", 1200.0),
])
def test_literals_of_any_magnitude_are_allowed_and_recorded(expr, want):
    out = _run(_state_with(REVENUE), expr, {"x": {"ref": "e1", "path": "value"}})
    assert out["ok"] is True and out["data"]["result"] == want
    assert out["data"]["provenance"] == "referenced"


# ── a typed number is computed with, never certified ─────────────────────────
def test_a_bare_number_as_a_variable_is_computed_but_marked_unreferenced():
    out = _run(RunState(), "a * 2", {"a": 10748221.5})
    assert out["ok"] is True
    assert out["data"]["result"] == 21496443.0
    assert out["data"]["provenance"] == "unreferenced"
    assert out["data"]["inputs"] == [{"name": "a", "value": 10748221.5, "referenced": False}]
    assert "không được coi là số liệu đã kiểm chứng" in out["data"]["note"]


def test_the_verifier_cannot_certify_a_result_built_on_an_invented_input():
    """End to end through the ledger: the unreferenced result is stored and
    referenceable, but its number never enters `state.evidence`."""
    state = RunState()
    out = _run(state, "a * 2", {"a": 777.0})
    state.record_evidence(out, tool="compute")
    assert 1554.0 not in state.evidence and 777.0 not in state.evidence
    assert "e1" in state.evidence_store


def test_a_referenced_result_enters_the_ledger_and_can_feed_another_formula():
    state = _state_with(REVENUE, PREVIOUS)
    first = _run(state, "cur - prev",
                 {"cur": {"ref": "e1", "path": "value"}, "prev": {"ref": "e2", "path": "value"}})
    ref = state.record_evidence(first, tool="compute")
    assert ref == "e3" and 200.0 in state.evidence
    second = _run(state, "d / prev * 100",
                  {"d": {"ref": "e3", "path": "result"}, "prev": {"ref": "e2", "path": "value"}})
    assert second["data"]["result"] == 20.0 and second["data"]["provenance"] == "referenced"


def test_mixing_one_typed_number_into_a_formula_makes_the_whole_result_unreferenced():
    out = _run(_state_with(REVENUE), "x - y", {"x": {"ref": "e1", "path": "value"}, "y": 5.0})
    assert out["data"]["provenance"] == "unreferenced"


# ── the evaluator is a whitelist ─────────────────────────────────────────────
@pytest.mark.parametrize("expr", [
    "x.__class__", "__import__('os')", "open('f')", "[x][0]", "x if x else 1",
    "lambda: 1", "x ** 50", "x / 0", "round(x, ndigits=2)", "True + x", "'a'", "y + 1",
    "(" * 60 + "x" + ")" * 60 + " + " + " + ".join(["x"] * 150),
])
def test_anything_outside_the_whitelist_is_refused_as_compute_invalid(expr):
    out = _run(_state_with(REVENUE), expr, {"x": {"ref": "e1", "path": "value"}})
    assert out["ok"] is False and out["error_code"] == "compute_invalid", expr


def test_a_malformed_variable_name_or_shape_is_a_bad_argument():
    assert _run(RunState(), "x", {"x y": 1})["error_code"] == "bad_argument"
    assert C.tool_compute(SimpleNamespace(), {"expression": "", "vars": {}})["error_code"] == "bad_argument"
    assert C.tool_compute(SimpleNamespace(), {"expression": "1", "vars": []})["error_code"] == "bad_argument"


# ── the store never mutates what it records ──────────────────────────────────
def test_recording_evidence_does_not_modify_the_result_object():
    result = {"ok": True, "kind": "value", "data": {"value": 5}}
    before = dict(result)
    RunState().record_evidence(result, tool="t")
    assert result == before


def test_a_failed_result_gets_no_reference():
    state = RunState()
    assert state.record_evidence({"ok": False, "error_code": "no_data"}, tool="t") is None
    assert state.evidence_store == {}


# ── wired through the registry, under the same gates as any tool ─────────────
def test_compute_runs_through_the_registry_as_a_read_only_derived_tool():
    spec = reg.all_tools()["compute"]
    assert spec.risk == "read_only" and spec.data_exposure == "derived"
    state = _state_with(REVENUE)
    ctx = SimpleNamespace(evidence_store=state.evidence_store, web_search=True,
                          read_rows=True, question="")
    out = reg.execute(ctx, "compute", {"expression": "x / 2", "vars": {"x": {"ref": "e1", "path": "value"}}},
                      allowed={"compute"})
    assert out["ok"] is True and out["data"]["result"] == 600.0



# ── found by adversarial review: ways an invented number got certified ───────
def _certified(state: RunState, out: dict) -> bool:
    before = len(state.evidence)
    state.record_evidence(out, tool="compute")
    return out["data"]["result"] in state.evidence[before:]


def test_a_formula_with_no_variables_is_not_certified():
    """`all([])` is True: "13590000" with no vars counted as referenced."""
    state = RunState()
    out = _run(state, "13590000", {})
    assert out["data"]["provenance"] == "unreferenced"
    assert not _certified(state, out)


@pytest.mark.parametrize("expr", ["x*0 + 13590001", "x - x + 13590001", "x / x * 13590001",
                                  "max(x, 5000) - min(x, 10)"])
def test_a_result_that_does_not_depend_on_its_evidence_is_not_certified(expr):
    state = _state_with(REVENUE)
    out = _run(state, expr, {"x": {"ref": "e1", "path": "value"}})
    assert out["data"]["provenance"] == "unreferenced", expr
    assert not _certified(state, out)


def test_an_unreferenced_result_cannot_be_laundered_through_a_second_formula():
    state = RunState()
    first = _run(state, "a * 1", {"a": 777.0})
    state.record_evidence(first, tool="compute")                      # e1, tainted
    second = _run(state, "y + 0.5", {"y": {"ref": "e1", "path": "result"}})
    assert second["data"]["provenance"] == "unreferenced"
    assert second["data"]["inputs"][0]["referenced"] is False
    assert not _certified(state, second)


def test_literals_themselves_are_never_certified():
    state = _state_with(REVENUE)
    out = _run(state, "x * 13590000", {"x": {"ref": "e1", "path": "value"}})
    state.record_evidence(out, tool="compute")
    assert 13590000.0 not in state.evidence
    assert out["data"]["result"] in state.evidence


@pytest.mark.parametrize("key", ["chart_id", "id", "dataset_id"])
def test_an_identifier_is_not_a_figure(key):
    state = _state_with(("read", "t", {key: 41, "value": 5}))
    out = _run(state, "x + 1", {"x": {"ref": "e1", "path": key}})
    assert out["error_code"] == "evidence_not_numeric"


def test_compute_is_never_served_from_the_cross_run_cache():
    """Refs restart at e1 in every run and the store is not in the cache key: a
    cached result served run B the figure run A computed, and certified it."""
    spec = reg.all_tools()["compute"]
    assert spec.cacheable is False

    def ctx_for(value):
        state = _state_with(("read", "total_measure", {"value": value}))
        return SimpleNamespace(evidence_store=state.evidence_store, web_search=True,
                               read_rows=True, question="", dashboard=SimpleNamespace(id=67),
                               public_filters=[], allowed_chart_ids={41}, excluded_columns=set(),
                               knowledge_scope={}, actor_type="public_session", actor_ref=None)

    args = {"expression": "x * 2", "vars": {"x": {"ref": "e1", "path": "value"}}}
    a = reg.execute(ctx_for(1000), "compute", args, allowed={"compute"})
    b = reg.execute(ctx_for(5), "compute", args, allowed={"compute"})
    assert a["data"]["result"] == 2000.0
    assert b["data"]["result"] == 10.0 and not b.get("cached")
