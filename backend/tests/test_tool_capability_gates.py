# -*- coding: utf-8 -*-
"""Capabilities the binding withheld, refused at the moment before the call.

THE GAP THESE CLOSE
-------------------
`allowed` answers one question — did the AUTHOR grant this tool to this step —
and the registry enforced only that. Two capabilities live on the BINDING, are
published in the contract, and were enforced somewhere else or nowhere:

  web_search   checked when the schema was built, so a model that names
               `web_search` anyway passes `allowed` (the author did grant it) and
               reaches the body on a binding that withheld it.

  read_rows    read in exactly ONE place in the whole codebase — the report-read
               node — and visible to no tool. Harmless while the chat surface had
               no charts; not harmless once chat gained a chart scope from its
               knowledge grants, at which point a chat flow granted
               `get_chart_data` read rows while its contract said it could not.

WHAT `read_rows` IS NOT
-----------------------
It is not "may not read rows". Every computing tool reads rows in order to
compute: `rank_values` reads all of them to rank, `total_measure` to total. A gate
on READING would disable the analytical half of the product to close a leak in the
exposure half. What it governs is whether row-level RECORDS reach a model's
context — `data_exposure == "raw_rows"` — and the tests below pin both directions.
"""
from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_tool_caps.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.agent_flows.tools.registry import all_tools, execute


class _Ctx(SimpleNamespace):
    """Only what the gate reads. A real `ToolContext` would drag a database in,
    and the gate runs before any body, so this is the honest surface."""


def _ctx(**kw):
    base = dict(dashboard=None, read_rows=True, web_search=True)
    base.update(kw)
    return _Ctx(**base)


RAW = sorted(n for n, s in all_tools().items() if s.data_exposure == "raw_rows")
DERIVED = sorted(n for n, s in all_tools().items() if s.data_exposure == "derived")
EXTERNAL = sorted(n for n, s in all_tools().items() if s.reaches_outside)


# ── read_rows ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", RAW)
def test_a_row_exposing_tool_is_refused_when_rows_are_withheld(name):
    out = execute(_ctx(read_rows=False), name, {"chart_id": 1}, use_cache=False)

    assert out["ok"] is False
    assert out["error_code"] == "not_granted"
    assert name in out["error"]


@pytest.mark.parametrize("name", ["rank_values", "total_measure", "share_of",
                                  "compare_periods", "forecast_measure",
                                  "aggregate_chart_data"])
def test_a_computing_tool_still_runs_when_rows_are_withheld(name):
    """THE HALF THAT MUST NOT BREAK.

    These read every row to produce their figure. If `read_rows=False` stopped
    them, the capability would have disabled analysis in order to prevent
    exposure — and the chat surface, which sets it, would answer nothing.

    The call fails for its own reasons here (no real context), but it must not
    fail with `not_granted`: the gate must have let it through.
    """
    out = execute(_ctx(read_rows=False), name, {"chart_id": 1}, use_cache=False)

    assert out.get("error_code") != "not_granted", (
        f"{name} computes over rows and must survive read_rows=False"
    )


def test_rows_are_allowed_when_the_binding_allows_them():
    out = execute(_ctx(read_rows=True), "get_chart_data", {"chart_id": 1}, use_cache=False)

    assert out.get("error_code") != "not_granted"


def test_a_context_that_never_heard_of_the_capability_is_not_punished():
    """Ephemeral and preview contexts do not carry every binding field. Absent
    must mean permitted, or the builder's preview starts refusing tools the run
    would allow."""
    out = execute(_Ctx(dashboard=None), "get_chart_data", {"chart_id": 1}, use_cache=False)

    assert out.get("error_code") != "not_granted"


# ── web_search ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", EXTERNAL)
def test_an_external_tool_is_refused_when_the_binding_withholds_web(name):
    """THE FORGED CALL. The node hides external tools from the schema when the
    binding says no — but `allowed` is built from the node's GRANT list, so a
    model that names the tool anyway passed that check. This is the one that
    refuses it.

    Distinct from the allowlist test: that one asks "did the author grant this
    tool", this one asks "did the deployment grant this capability". A tool can
    pass the first and must still fail the second.
    """
    out = execute(_ctx(web_search=False), name, {"query": "gdp vietnam"},
                  allowed=set(all_tools()), use_cache=False)

    assert out["ok"] is False
    assert out["error_code"] == "not_granted"


def test_the_capability_gate_is_not_the_allowlist():
    """Granted by the author AND named in `allowed`, still refused, because the
    binding withheld the capability. If this ever passes the tool through, the
    two checks have been collapsed into one."""
    name = EXTERNAL[0]
    out = execute(_ctx(web_search=False), name, {"query": "x"},
                  allowed={name}, use_cache=False)

    assert out["error_code"] == "not_granted"


def test_an_internal_tool_is_unaffected_by_the_web_capability():
    out = execute(_ctx(web_search=False), "rank_values", {"chart_id": 1}, use_cache=False)

    assert out.get("error_code") != "not_granted"


# ── the gate runs before the body, and before the cache ─────────────────────


def test_a_refusal_never_reaches_the_tool_body():
    """`not_granted` must be returned instead of running the function, not after.
    A body that ran and had its result discarded has already touched the
    warehouse, and for an external tool has already left the building."""
    ran = []
    spec = all_tools()["get_chart_data"]
    original = spec.fn
    object.__setattr__(spec, "fn", lambda c, a: ran.append(1) or {"ok": True})
    try:
        out = execute(_ctx(read_rows=False), "get_chart_data", {"chart_id": 1},
                      use_cache=False)
    finally:
        object.__setattr__(spec, "fn", original)

    assert out["error_code"] == "not_granted"
    assert ran == [], "the body ran despite the refusal"
