# -*- coding: utf-8 -*-
"""Nothing over the run's token ceiling reaches a prompt.

WHY THIS IS THE HARD INVARIANT AND `payload` IS NOT
---------------------------------------------------
`payload = small | medium | large | scales_with_report` is a classification that
helps an author reason about cost. Hard-failing on it would make CI red for a
legitimate change of dataset: a report with 10 charts and one with 184 cannot
produce the same size, and `scales_with_report` says so in as many words.

What CAN be a hard invariant is the ceiling: whatever a body returns, the caller
gets something inside `max_result_tokens`, or an explicit refusal. `_guard_payload`
implements that — trim first, refuse only what cannot be safely cut — and until
now nothing tested it, which is the worst combination: a mechanism everybody
believes in and nobody has run.
"""
from __future__ import annotations

import os

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_tool_ceiling.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.agent_flows.tools import registry as reg
from app.services.agent_flows.tools import result as R


class _Ctx:
    dashboard = None
    read_rows = True
    web_search = True
    max_result_tokens = 500


def _huge_rows(n: int) -> dict:
    return R.ok(
        {"columns": ["a", "b"], "rows": [{"a": i, "b": "x" * 40} for i in range(n)]},
        kind="table",
        coverage=R.Coverage(returned=n, total=n, truncated=False,
                            ordered_by="a", computed_over_all=True),
    )


@pytest.fixture
def oversized():
    """Replace one tool's body with something far over the ceiling.

    `object.__setattr__` because `ToolSpec` is frozen — deliberately, since a
    tool's declaration is what everything downstream trusts. The fixture restores
    it, so the freeze still holds everywhere except inside this file.
    """
    spec = reg.all_tools()["get_chart_data"]
    original = spec.fn

    def install(payload):
        object.__setattr__(spec, "fn", lambda c, a: payload)

    yield install
    object.__setattr__(spec, "fn", original)


def test_a_result_over_the_ceiling_does_not_reach_the_caller_intact(oversized):
    """THE INVARIANT. Not "the tool is well behaved" — the registry is the last
    place that can be, and it must be."""
    oversized(_huge_rows(4000))

    out = reg.execute(_Ctx(), "get_chart_data", {"chart_id": 1}, use_cache=False)

    size = reg._measure_tokens(out)
    assert size <= _Ctx.max_result_tokens * 1.2, (
        f"{size} tokens reached the caller against a {_Ctx.max_result_tokens} ceiling"
    )


def test_a_trimmed_result_says_it_was_trimmed(oversized):
    """A slice that does not announce itself is read as the whole — the failure
    that turned 50 of 72 categories into a confident, wrong ranking."""
    oversized(_huge_rows(4000))

    out = reg.execute(_Ctx(), "get_chart_data", {"chart_id": 1}, use_cache=False)

    if out.get("ok"):
        coverage = out.get("coverage") or {}
        assert coverage.get("truncated") is True, (
            "the result was cut and the payload does not admit it"
        )


def test_a_result_inside_the_ceiling_is_left_alone(oversized):
    """Trimming a result that fits would change answers for no reason."""
    payload = _huge_rows(3)
    oversized(payload)

    out = reg.execute(_Ctx(), "get_chart_data", {"chart_id": 1}, use_cache=False)

    assert out["ok"] is True
    assert len(out["data"]["rows"]) == 3


def test_a_shape_that_cannot_be_trimmed_is_refused_not_passed_through(oversized):
    """Trim first, refuse second — but refuse it must. Passing an untrimmable
    oversized payload through would spend the ceiling it was given to protect."""
    oversized(R.ok({"blob": "y" * 40000}, kind="narrative"))

    out = reg.execute(_Ctx(), "get_chart_data", {"chart_id": 1}, use_cache=False)

    size = reg._measure_tokens(out)
    assert size <= _Ctx.max_result_tokens * 1.2 or out["ok"] is False


def test_the_ceiling_comes_from_the_run_not_from_this_module(oversized):
    """It is a property of the deployment — a public link and a scheduled internal
    analysis want different numbers — so a context that raises it must be obeyed."""
    oversized(_huge_rows(4000))

    class Generous(_Ctx):
        max_result_tokens = 100000

    big = reg.execute(Generous(), "get_chart_data", {"chart_id": 1}, use_cache=False)
    small = reg.execute(_Ctx(), "get_chart_data", {"chart_id": 1}, use_cache=False)

    assert reg._measure_tokens(big) > reg._measure_tokens(small)


def test_a_context_with_no_ceiling_still_gets_one(oversized):
    """An ephemeral or preview context may not carry the field. Absent must not
    mean unlimited — that is how a preview burned a fortune in the old bot."""
    oversized(_huge_rows(8000))

    class Bare:
        dashboard = None
        read_rows = True
        web_search = True

    out = reg.execute(Bare(), "get_chart_data", {"chart_id": 1}, use_cache=False)

    assert reg._measure_tokens(out) < 200000, "no ceiling applied at all"
