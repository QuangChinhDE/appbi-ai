# -*- coding: utf-8 -*-
"""A reused ReportRead must hand the verifier the same ledger the original did.

THE INVARIANT, which `_route_call` in the handler already states in prose: a chart
id of 1001 must never be allowed to vouch for a numerical claim of 1001. The
original execution enforces it by construction — data-bearing tool results go
through `_call`, which harvests them into `state.evidence`; routing calls go
through `_route_call`, which deliberately does not.

Reuse restored provenance with a blanket `state.add_evidence(value)` over the
WHOLE stored output. `RunState.add_evidence` recurses into every number it can
find, so `selection.matched_chart_ids`, `charts[].chart_id`, `scope.read` and
`scope.available` all entered the ledger — numbers the original read had kept out
of it on purpose. The same read, reused, verified claims the original would have
flagged.

THE PAYLOAD HERE IS NOT INVENTED. Every fixture below is produced by running the
real `run_report_read` against a stubbed tool registry, then storing what the node
published — which is exactly what `memory.vars` holds on the next turn. A fixture
written from memory of the shape is how the previous fix in this area shipped dead
(it read `entry["id"]`, a key the producer never writes), so the producer builds
the payload and the test reads it.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.services.agent_flows.contract import ReportReadNode
from app.services.agent_flows.envelope import FlowInput
from app.services.agent_flows.runtime import executor as E
from app.services.agent_flows.runtime.handlers import data as D
from app.services.agent_flows.runtime.state import RunState

#: The chart this read is about. Its id is also a plausible-looking figure, which
#: is the whole point: 41 must not become checkable evidence.
CHART_ID = 41

#: Real business numbers, and nothing else in the payload equals them.
REVENUE = [1200.0, 980.0]


def _envelope() -> dict:
    return {
        "request": {"id": "reuse", "trigger": "studio_test"},
        "question": {"raw": "Doanh thu theo danh mục?"},
        "report": {
            "dashboard_id": 67, "name": "Olist",
            "charts": [{"id": CHART_ID, "title": "Doanh thu", "chart_type": "BAR",
                        "measures": [{"field": "revenue"}],
                        "dimensions": [{"field": "category"}]}],
        },
        "binding": {
            "id": 1, "flow_version": 1, "allowed_chart_ids": [CHART_ID],
            "capabilities": {"web_search": False, "read_rows": True},
        },
        "runtime": {
            "provider": "openai", "model": "gpt-4o-mini",
            "budget": {"max_llm_calls": 12, "max_tool_calls": 40, "max_seconds": 60},
        },
    }


SUMMARY_RESULT = {
    "ok": True, "kind": "summary",
    "data": {"rows": 2, "columns": [
        {"name": "category", "kind": "text"},
        {"name": "revenue", "kind": "number", "min": 980, "max": 1200},
    ]},
}

DATA_RESULT = {
    "ok": True, "kind": "table",
    "data": {"columns": ["category", "revenue"],
             "rows": [["moveis", 1200], ["beleza", 980]]},
}


def _stub_registry(monkeypatch):
    """Stands in for the warehouse only. Every decision above it is real code."""
    def execute(ctx, name, args, allowed=None):
        if name == "get_chart_summary":
            return SUMMARY_RESULT
        if name == "get_chart_data":
            return DATA_RESULT
        if name == "inspect_filters":
            return {"ok": True, "data": {"filters": []}}
        return {"ok": False, "error_code": "unexpected", "error": name}

    from app.services.agent_flows.tools import registry as tool_registry
    monkeypatch.setattr(tool_registry, "execute", execute)


def _read(monkeypatch) -> tuple[RunState, dict]:
    """Run the REAL read handler once. Returns the state it built and the value it
    published — the same value `memory.vars` carries into the next turn."""
    _stub_registry(monkeypatch)
    node = ReportReadNode.model_validate({
        "key": "overview", "type": "report_read", "output_var": "bao_cao",
        "chart_ids": [CHART_ID], "include_summary": True, "include_data": True,
        "detail": "full",
    })
    state = RunState()
    rctx = SimpleNamespace(inp=FlowInput.model_validate(_envelope()),
                           ctx=SimpleNamespace(knowledge_scope=None))

    async def go():
        async for _ev in D.run_report_read(node, state, rctx):
            pass

    asyncio.run(go())
    return state, state.outputs["overview"]


def _reuse(stored: dict) -> RunState:
    """Replay that stored value through `_reuse`, as the next turn does."""
    node = SimpleNamespace(key="overview", type="report_read",
                           run_policy="when_stale", output_var="bao_cao")
    memory = SimpleNamespace(reusable_nodes=["overview"], vars={"bao_cao": stored})
    rctx = SimpleNamespace(inp=SimpleNamespace(memory=memory))
    state = RunState()
    E._reuse(node, state, rctx)
    return state


@pytest.fixture()
def original(monkeypatch):
    return _read(monkeypatch)


# ── what the stored payload actually contains ───────────────────────────────

def test_the_stored_payload_carries_both_data_and_routing_metadata(original):
    """Names the numbers this whole file is about, from the producer's own output.
    If the shape changes, this fails first and says so."""
    _state, stored = original
    assert stored["selection"]["mode"] == "explicit"
    assert stored["scope"]["read"] == 1 and stored["scope"]["available"] == 1
    assert [c["chart_id"] for c in stored["charts"]] == [CHART_ID]
    flat = str(stored)
    assert "1200" in flat and "980" in flat


# ── the equivalence ─────────────────────────────────────────────────────────

def test_a_reused_read_restores_the_business_numbers(original):
    state, stored = original
    reused = _reuse(stored)
    for n in REVENUE:
        assert n in reused.evidence, (
            f"{n} came from a `_call` result and the original counted it as "
            "evidence; a reused read that drops it makes a true figure unverifiable"
        )


def test_a_reused_read_does_not_promote_routing_metadata_to_evidence(original):
    """THE DEFECT. `add_evidence` over the whole stored value harvested the chart
    id and the scope counters, so a claim of 41 verified against the id of the
    chart that was read."""
    state, stored = original
    reused = _reuse(stored)
    assert float(CHART_ID) not in reused.evidence, (
        "a chart id must never vouch for a numerical claim equal to it"
    )
    assert float(CHART_ID) not in state.evidence, (
        "sanity: the ORIGINAL read never had it either — this is the standard "
        "reuse has to meet, not a stricter one invented here"
    )


def test_the_reused_ledger_is_equivalent_to_the_original_one(original):
    """Set equality, not ordering: the ledger is a pile to match figures against,
    and the order numbers were appended in carries no meaning."""
    state, stored = original
    reused = _reuse(stored)
    assert set(reused.evidence) == set(state.evidence)


def test_the_reused_labels_are_equivalent_too(original):
    """`_unknown_labels` reads these, so a divergence here makes a reused turn
    flag entities the original accepted."""
    state, stored = original
    reused = _reuse(stored)
    assert reused.evidence_labels == state.evidence_labels


def test_the_reused_citations_and_grounding_match_the_original(original):
    state, stored = original
    reused = _reuse(stored)
    assert [(c.kind, c.ref) for c in reused.citations] \
        == [(c.kind, c.ref) for c in state.citations]
    assert reused.question_grounding["overview"] == state.question_grounding["overview"]
    assert reused.evidence_sources == {"overview"}


# ── and what the equivalence is FOR ─────────────────────────────────────────

def test_a_claim_equal_to_a_chart_id_is_not_verified_by_a_reused_read(original):
    """The user-visible consequence, asserted through the real verifier rather
    than through the ledger it reads."""
    from app.services.dashboard_ai_bot.verifier import verify_answer

    _state, stored = original
    reused = _reuse(stored)
    got = verify_answer("Danh mục dẫn đầu đạt 41 đơn vị.", reused.evidence).to_dict()
    assert got["matched"] == 0 and got["unmatched"], (
        "41 is a chart id; a reused read must not make it check out"
    )


def test_a_claim_equal_to_a_real_figure_still_verifies_after_reuse(original):
    """The other half. Excluding metadata must not cost the run its real numbers."""
    from app.services.dashboard_ai_bot.verifier import verify_answer

    _state, stored = original
    reused = _reuse(stored)
    got = verify_answer("Moveis đạt 1200.", reused.evidence).to_dict()
    assert got["matched"] >= 1 and not got["unmatched"]
