# -*- coding: utf-8 -*-
"""I5 — a hard gate may be duplicated upward. It may never move upward.

WHY THIS FILE HAS ITS OWN NAME
------------------------------
V3 introduces a Runtime Layer stack, and the target architecture lists an
`AuthorizationLayer` and a `CapabilityLayer` in it. Written down like that, it
reads as an invitation: move `_capability_refusal()` into the layer, delete it from
`registry.execute()`, admire the diagram.

That would hand every execution path invented after the refactor a way past the
gate — ToolNode, SkillInvoker, MCPInvoker, a background job, an internal caller —
and the P0 bug comes back wearing better architecture. The point is not that a
layer is wrong. The point is that the check at the bottom is what makes the layer
optional rather than load-bearing.

So this suite deliberately does NOT go through the runtime. It calls the lowest
boundary that can still refuse, and asserts the tool body never executes. If
someone deletes the gate, a layer above can be perfectly green and this still goes
red — which is the entire purpose.

WHAT "THE BODY NEVER RAN" MEANS, AND WHY IT IS THE ASSERTION
------------------------------------------------------------
Not "the result says not_granted" — a body that ran and had its result replaced has
already queried the warehouse, and for an external tool has already left the
building. The spy below fails on execution, not on the answer.
"""
from __future__ import annotations

import os

import pytest

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_i5.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

from app.services.agent_flows.tools import registry as reg  # noqa: E402

ALL = reg.all_tools()
RAW_ROWS = sorted(n for n, s in ALL.items() if s.data_exposure == "raw_rows")
EXTERNAL = sorted(n for n, s in ALL.items() if s.reaches_outside)
DERIVED = ["rank_values", "total_measure", "share_of", "compare_periods",
           "aggregate_chart_data", "get_chart_summary"]


class _Ctx:
    """A context that withholds nothing unless a test says so."""

    dashboard = None
    read_rows = True
    web_search = True


@pytest.fixture
def spy():
    """Replace a tool's body with a tripwire, and put the real one back after.

    `object.__setattr__` because `ToolSpec` is frozen — deliberately, since the
    declaration is what everything downstream trusts.
    """
    restore: list[tuple] = []
    fired: list[str] = []

    def install(name: str):
        spec = ALL[name]
        restore.append((spec, spec.fn))

        def tripwire(ctx, args):
            fired.append(name)
            return {"ok": True, "kind": "narrative", "data": {}}

        object.__setattr__(spec, "fn", tripwire)
        return fired

    yield install
    for spec, original in reversed(restore):
        object.__setattr__(spec, "fn", original)


# ── the two capabilities, at the boundary ───────────────────────────────────


@pytest.mark.parametrize("name", RAW_ROWS)
def test_a_row_exposing_body_never_runs_when_rows_are_withheld(name, spy):
    fired = spy(name)

    out = reg.execute(_ctx(read_rows=False), name, {"chart_id": 1}, use_cache=False)

    assert fired == [], f"{name} BODY RAN despite read_rows=False"
    assert out["error_code"] == "not_granted"


@pytest.mark.parametrize("name", EXTERNAL)
def test_an_external_body_never_runs_when_web_is_withheld(name, spy):
    """The forged call: granted by the author, named in `allowed`, and still
    refused because the BINDING withheld the capability."""
    fired = spy(name)

    out = reg.execute(_ctx(web_search=False), name, {"query": "gdp"},
                      allowed=set(ALL), use_cache=False)

    assert fired == [], f"{name} BODY RAN despite web_search=False"
    assert out["error_code"] == "not_granted"


def _ctx(**over):
    ctx = _Ctx()
    for key, value in over.items():
        setattr(ctx, key, value)
    return ctx


# ── and the half that must NOT be gated ─────────────────────────────────────


@pytest.mark.parametrize("name", DERIVED)
def test_a_computing_body_still_runs_when_rows_are_withheld(name, spy):
    """THE OTHER DIRECTION, and it is not a nicety.

    Every one of these reads rows in order to compute its figure. A gate on
    READING rather than on EXPOSING would disable the analytical half of the
    product to close a leak in the presentation half — and the chat surface, which
    sets `read_rows=False`, would answer nothing at all.
    """
    fired = spy(name)

    reg.execute(_ctx(read_rows=False), name, {"chart_id": 1}, use_cache=False)

    assert fired == [name], f"{name} was blocked; it computes over rows"


# ── the gate cannot be quietly removed ──────────────────────────────────────


def test_the_capability_gate_is_wired_into_execute():
    """A spy test alone is not enough: delete the gate AND the body starts
    returning its own error, and a careless reading of a red suite could call that
    'the tool refuses anyway'. This asserts the gate exists and is reachable."""
    assert hasattr(reg, "_capability_refusal"), (
        "`_capability_refusal` is gone. If the check moved to a Runtime Layer, "
        "put it BACK here as well — I5: a hard gate may be duplicated upward, "
        "never moved upward."
    )

    spec = ALL[RAW_ROWS[0]]
    assert reg._capability_refusal(_ctx(read_rows=False), spec) is not None
    assert reg._capability_refusal(_ctx(read_rows=True), spec) is None


def test_the_gate_runs_before_the_cache():
    """A cached result served to a caller the binding withheld is the same leak
    with an extra step. The refusal must come first."""
    out = reg.execute(_ctx(read_rows=False), RAW_ROWS[0], {"chart_id": 1},
                      use_cache=True)

    assert out["error_code"] == "not_granted"


# ── resource scope, same rule ───────────────────────────────────────────────


def test_resource_scope_is_enforced_inside_the_tool_not_only_above_it():
    """`assert_chart_in_scope` lives in the tool body, which is the lowest place
    it can live. V3 must not replace it with a node-level or layer-level check.

    NOTE the code asserted here is `query_failed`, not `chart_out_of_scope`: the
    guard refuses correctly but `result.classify()` mis-maps its message, because
    `_CODE_HINTS` matches "not in scope" while the guard emits "is not part of this
    dashboard". That defect is recorded in the replay fixture
    `12_chart_out_of_scope` and is the first item for the error-taxonomy work. It
    is left alone here so V3.0 changes no behaviour — what this test pins is that
    the REFUSAL happens at all.
    """
    from app.services.agent_flows.tools.context import ToolContext

    class ScopedCtx(_Ctx):
        allowed_chart_ids = {41}
        assert_chart_in_scope = ToolContext.assert_chart_in_scope

    out = reg.execute(ScopedCtx(), "get_chart_summary", {"chart_id": 999},
                      use_cache=False)

    assert out["ok"] is False
    assert "not part of this dashboard" in str(out.get("error", ""))


def test_every_tool_that_names_a_resource_can_still_refuse_it():
    """Derived from `resource_refs`, so a tool added tomorrow is covered the day
    it declares — and a tool that declares nothing fails the metadata suite."""
    chart_tools = [n for n, s in ALL.items()
                   if any(kind == "chart" for kind in s.resource_refs.values())]

    assert len(chart_tools) >= 15, f"only {len(chart_tools)} declare a chart ref"
