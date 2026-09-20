# -*- coding: utf-8 -*-
"""Two defects the release gate named, pinned at the boundary that produces them.

A. A SCOPE REFUSAL KEEPS ITS CODE.

`assert_chart_in_scope` refuses a chart outside the binding correctly, and
`result.classify()` used to guess the code from the message — matching "not in
scope" and "không thuộc", while the guard emits "is not part of this dashboard".
Nothing matched, so it fell through to `query_failed`.

That is not a cosmetic mislabel. `query_failed` is documented as retryable, so a
model refused a chart it may never read was told to try again, and never saw the
`chart_out_of_scope` recovery hint that would have sent it to
`search_business_assets`. Measured in a live run: seven consecutive refusals, the
whole tool budget, and a confident wrong answer.

B. A REFUSED READ IS NOT AN EMPTY ONE.

`binding._distinct_values` read a Loop's collection through `get_chart_data` — a
governed tool, so it can be refused — and turned every failure into `[]`. That is
the same value a dimension with genuinely no values produces, so a Loop ran zero
times and the run reported success. A viewer told "there was no data to loop over"
when the truth is "this link may not read that chart" has been given a correct
answer to a question nobody asked.
"""
from __future__ import annotations

import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_taxonomy.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows.tools import registry as reg  # noqa: E402
from app.services.agent_flows.tools.context import ToolContext, ToolError  # noqa: E402

#: Every tool that names a chart and can therefore refuse one. Derived from the
#: declaration, so a tool added tomorrow is covered the day it declares.
CHART_TOOLS = sorted(
    name for name, spec in reg.all_tools().items()
    if any(kind == "chart" for kind in spec.resource_refs.values())
)


class _Ctx:
    dashboard = None
    read_rows = True
    web_search = True
    allowed_chart_ids = {41}
    knowledge_scope: dict = {}
    max_result_tokens = 4000
    max_rows_per_call = 50
    public_filters: list = []
    pages: list = []
    chart_meta: dict = {}
    assert_chart_in_scope = ToolContext.assert_chart_in_scope



def _out_of_scope_args(name: str) -> dict:
    """Valid arguments for this tool, with every chart reference outside the binding.

    GENERATED FROM THE DECLARATION, not typed out. The hand-written version missed
    `benchmark_compare`'s required `query` and gave `correlate_charts` the same id
    twice — which it rightly refuses as `bad_argument` before it ever looks at
    scope. Both looked like taxonomy failures and were the test's own doing.

    Distinct ids for distinct chart arguments, and every other required argument
    filled with something its type accepts, so the ONLY thing wrong with the call
    is the thing under test.
    """
    spec = reg.all_tools()[name]
    schema = (spec.definition.get("input_schema")
              or spec.definition.get("parameters") or {})
    props = schema.get("properties") or {}
    args: dict = {}

    next_id = iter([999, 998, 997, 996])
    for arg in schema.get("required") or []:
        prop = props.get(arg) or {}
        if spec.resource_refs.get(arg) == "chart":
            args[arg] = next(next_id)
            continue
        kind = prop.get("type")
        if prop.get("enum"):
            args[arg] = prop["enum"][0]
        elif kind == "integer" or kind == "number":
            args[arg] = 1
        elif kind == "array":
            args[arg] = ["x"]
        elif kind == "object":
            args[arg] = {}
        elif kind == "boolean":
            args[arg] = True
        else:
            args[arg] = "x"

    # Optional chart references too. `describe_time_coverage` takes `chart_id` but
    # does not require it, and with none supplied it scans the whole binding and
    # answers `not_applicable` — a correct answer to a different question. The
    # invariant under test is "naming a chart outside the binding is refused",
    # which means the chart has to be named.
    for arg, kind_ in spec.resource_refs.items():
        if kind_ == "chart" and arg not in args:
            args[arg] = next(next_id)
    return args


# ── A. the code survives ────────────────────────────────────────────────────


def test_the_guard_raises_a_coded_error():
    """At the source. A refusal that knows its own code should never have to be
    recognised by its prose."""
    ctx = _Ctx()

    with pytest.raises(ToolError) as caught:
        ctx.assert_chart_in_scope(999)

    assert caught.value.code == "chart_out_of_scope"


def test_an_uncoded_tool_error_still_works():
    """Most `ToolError`s carry no code and are still classified from the message.
    Adding the field must not have broken them."""
    err = ToolError("something went wrong")

    assert err.code == ""
    assert str(err) == "something went wrong"


@pytest.mark.parametrize("name", CHART_TOOLS)
def test_every_chart_tool_reports_chart_out_of_scope(name):
    """THE REGRESSION, at the boundary a caller actually reads.

    Not on `classify()` — on `execute()`, which is what a model, a ToolNode and a
    flow all see. If the code is ever inferred again from English, this goes red
    for every tool at once.
    """
    out = reg.execute(_Ctx(), name, _out_of_scope_args(name), use_cache=False)

    assert out["ok"] is False
    assert out.get("error_code") == "chart_out_of_scope", (
        f"{name} reported {out.get('error_code')!r} for a chart outside the "
        f"binding. `query_failed` tells a model to retry a call that can never "
        f"succeed, and withholds the recovery hint that would have helped."
    )


def test_the_refusal_carries_a_recovery_hint():
    """The half that makes the code worth having: a model reading it is told where
    to go instead."""
    out = reg.execute(_Ctx(), "get_chart_summary", {"chart_id": 999}, use_cache=False)

    hint = str(out.get("recovery") or "")
    assert hint, "chart_out_of_scope came back with no recovery hint"
    assert "search_business_assets" in hint or "resolve_chart_candidates" in hint


def test_a_chart_inside_the_binding_is_not_refused():
    """The control. Without it, a tool that refused everything would pass above."""
    out = reg.execute(_Ctx(), "get_chart_summary", {"chart_id": 41}, use_cache=False)

    assert out.get("error_code") != "chart_out_of_scope"


# ── B. empty is not failed ──────────────────────────────────────────────────


def _entry(chart_id=41, field="category"):
    from app.services.agent_flows.binding import ResolveEntry

    return ResolveEntry(key="segments", kind="dimension",
                        chart_id=chart_id, field=field)


def test_a_refused_read_reports_the_code_not_an_empty_list(monkeypatch):
    from app.services.agent_flows import binding as B

    monkeypatch.setattr(
        reg, "execute",
        lambda *a, **k: {"ok": False, "error_code": "not_granted",
                         "error": "link này không cho đưa dòng thô"},
    )

    values, error = B._distinct_values(_Ctx(), _entry())

    assert values == []
    assert error == "not_granted", (
        "a refusal arrived as an empty list — indistinguishable from a dimension "
        "that genuinely has no values"
    )


def test_a_raising_read_reports_a_code_too(monkeypatch):
    from app.services.agent_flows import binding as B

    def boom(*a, **k):
        raise RuntimeError("warehouse down")

    monkeypatch.setattr(reg, "execute", boom)

    values, error = B._distinct_values(_Ctx(), _entry())

    assert values == []
    assert error == "internal"


def test_a_genuinely_empty_dimension_reports_no_error(monkeypatch):
    """THE DISTINCTION, from the other side. Reporting an error here would make
    every legitimately empty dimension look broken."""
    from app.services.agent_flows import binding as B

    monkeypatch.setattr(
        reg, "execute",
        lambda *a, **k: {"ok": True, "kind": "table",
                         "data": {"columns": ["category"], "rows": []}},
    )

    values, error = B._distinct_values(_Ctx(), _entry())

    assert values == []
    assert error == ""


def test_values_that_are_read_come_back_with_no_error(monkeypatch):
    from app.services.agent_flows import binding as B

    monkeypatch.setattr(
        reg, "execute",
        lambda *a, **k: {"ok": True, "kind": "table",
                         "data": {"columns": ["category"],
                                  "rows": [["moveis"], ["beleza"]]}},
    )

    values, error = B._distinct_values(_Ctx(), _entry())

    assert values == ["moveis", "beleza"]
    assert error == ""


def test_a_ref_with_no_chart_is_empty_but_not_failed():
    from app.services.agent_flows import binding as B

    values, error = B._distinct_values(_Ctx(), _entry(chart_id=None))

    assert (values, error) == ([], "")


def test_the_resolved_ref_can_carry_the_reason():
    from app.services.agent_flows.envelope import ResolvedRef

    ref = ResolvedRef(kind="dimension", values_error="not_granted")

    assert ref.values == []
    assert ref.values_error == "not_granted"
    # And it survives serialisation, which is how it reaches the run's variables.
    assert ref.model_dump(mode="json")["values_error"] == "not_granted"


def test_a_loop_over_a_failed_source_says_so_not_that_there_was_no_data():
    """What a person ends up reading. The notice code is the contract; the prose
    is for them."""
    from app.services.agent_flows.runtime.executor import _loop_source_error
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    state.vars["segments__ref"] = {"kind": "dimension", "values": [],
                                   "values_error": "not_granted"}
    node = type("N", (), {"over": "{{segments}}"})()

    assert _loop_source_error(node, state) == "not_granted"


def test_a_loop_over_a_genuinely_empty_source_reports_nothing():
    from app.services.agent_flows.runtime.executor import _loop_source_error
    from app.services.agent_flows.runtime.state import RunState

    state = RunState()
    state.vars["segments__ref"] = {"kind": "dimension", "values": [],
                                   "values_error": ""}
    node = type("N", (), {"over": "{{segments}}"})()

    assert _loop_source_error(node, state) == ""
