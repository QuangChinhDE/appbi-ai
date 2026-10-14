# -*- coding: utf-8 -*-
"""The authoring warning for a grant with no way in — and a lock against drift.

MEASURED during release certification, same question asked three ways:

    3 tools, no discovery   ->  1 of 3 answered; `rank_values(chart_out_of_scope)`
                                repeated to budget exhaustion on the other two
    6 tools, with discovery ->  3 of 3, in 2-3 calls
    24 tools                ->  3 of 3, FEWEST calls, ~2.5x prompt tokens

The certification recorded this as an OPEN item needing an author warning. It was
wrong: the warning already existed, and the first cases below are the evidence —
the exact certified grant is flagged, and adding one discovery tool clears it. So
breadth was never the defect and nothing new had to be built. Recorded here
rather than quietly dropped, because "we already had that" is the finding.

WHAT DOES NEED LOCKING is the thing that makes that warning correct.
`_CHART_KEYED_TOOLS` and `_CHART_LOOKUP_TOOLS` in `contract.py` are hand-written
literals, deliberately: the schema layer does not import the tool registry, or the
shape of a flow would depend on which packs happen to be installed. That decision
is sound and it has one failure mode — the lists go stale the day a tool is added.

So the lists stay where they are and this compares them against the registry.
A new tool that needs a `chart_id`, or one that hands them out, fails here with
its name rather than silently falling out of the warning.
"""
from __future__ import annotations

import pytest

from app.services.agent_flows.contract import (
    Flow, upgrade_body, _CHART_KEYED_TOOLS, _CHART_LOOKUP_TOOLS,
)

#: The sentence under test. Asserting a loose phrase let an earlier version of
#: this file pass against warnings that existed for other reasons.
MARKER = "công cụ cần chart_id"

NEEDS_ID = ["rank_values", "total_measure", "share_of"]
DISCOVERY = ["list_charts", "resolve_chart_candidates", "search_business_assets"]


def flow_with(tools, *, with_read=False):
    nodes = []
    if with_read:
        nodes.append({"key": "read", "type": "report_read", "output_var": "ctx"})
    nodes.append({"key": "a", "type": "agent", "prompt": "Trả lời bằng số.",
                  "tools": [{"tool": t} for t in tools]})
    body = {"name": "t", "nodes": nodes, "answer_node": "a"}
    return Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"})


def flagged(flow) -> list[str]:
    return [w for w in flow.warnings() if MARKER in w]


# ── the certified scenario is already covered ───────────────────────────────

def test_the_exact_grant_that_failed_certification_is_flagged():
    warn = flagged(flow_with(NEEDS_ID))
    assert warn, "the 3-tool no-discovery grant produced no warning"
    assert "rank_values" in warn[0], "the note must name the tools that need an id"


@pytest.mark.parametrize("finder", DISCOVERY)
def test_granting_any_discovery_tool_clears_it(finder):
    assert flagged(flow_with(NEEDS_ID)), "control: the warning fires without one"
    assert not flagged(flow_with(NEEDS_ID + [finder])), (
        f"{finder} hands out chart ids — it is a way in, and the warning should go"
    )


def test_a_read_step_alone_is_not_the_other_way_in():
    """STRICTER THAN EXPECTED, and right. Having a `report_read` upstream does
    not help a step whose prompt never reads its output — the index exists and
    the agent was never shown it. The warning says `{{ctx}}` by name."""
    warn = flagged(flow_with(NEEDS_ID, with_read=True))
    assert warn, "a read step the prompt ignores is not a way in"
    assert "{{ctx}}" in warn[0], "the note must name the variable to read"


def test_a_read_step_the_prompt_actually_reads_is_a_way_in():
    nodes = [
        {"key": "read", "type": "report_read", "output_var": "ctx"},
        {"key": "a", "type": "agent", "prompt": "Dựa trên {{ctx}}, trả lời bằng số.",
         "tools": [{"tool": t} for t in NEEDS_ID]},
    ]
    body = {"name": "t", "nodes": nodes, "answer_node": "a"}
    flow = Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"})
    assert not flagged(flow)


def test_a_knowledge_only_grant_is_not_warned():
    assert not flagged(flow_with(["search_knowledge", "read_document"]))


def test_breadth_alone_is_never_warned_about():
    """The evidence says the broad grant answered every question; a note telling
    authors to narrow would be recommending the thing that failed."""
    broad = NEEDS_ID + DISCOVERY + [
        "get_chart_data", "get_chart_summary", "compare_periods", "analyze_trend",
        "detect_anomaly", "forecast_measure", "describe_time_coverage",
    ]
    text = " ".join(flow_with(broad).warnings()).lower()
    assert "quá nhiều" not in text and "too many" not in text, text


# ── the drift lock ──────────────────────────────────────────────────────────

def _registry_sets():
    from app.services.agent_flows.tools import registry as R

    needs, hands_out = set(), set()
    for name, spec in (R.all_tools() or {}).items():
        required = ((spec.definition or {}).get("input_schema") or {}).get("required") or []
        if "chart_id" in required:
            needs.add(name)
        elif spec.result_kind == "catalogue":
            hands_out.add(name)
    return needs, hands_out


def test_every_tool_that_needs_a_chart_id_is_in_the_keyed_list():
    needs, _ = _registry_sets()
    missing = sorted(needs - set(_CHART_KEYED_TOOLS))
    assert not missing, (
        f"{missing} require a `chart_id` and are absent from `_CHART_KEYED_TOOLS`, "
        "so a grant containing only them would be warned about by nothing. The "
        "list is hand-written on purpose — the schema layer does not import the "
        "registry — which is exactly why it needs this lock."
    )


def test_the_keyed_list_names_no_tool_that_does_not_need_one():
    needs, _ = _registry_sets()
    from app.services.agent_flows.tools import registry as R

    known = set(R.all_tools() or {})
    stale = sorted((set(_CHART_KEYED_TOOLS) & known) - needs)
    assert not stale, (
        f"{stale} no longer require a `chart_id`; the warning would fire on a "
        "grant that is actually fine"
    )


def test_every_lookup_tool_really_can_resolve_a_chart():
    """The other direction of the lock, and narrower than "returns a catalogue".

    `inspect_filters` and `describe_semantic_model` also return catalogues and
    are NOT ways in: one reports the filter state, the other describes the model.
    Neither hands back a chart id. So the check is that every tool the warning
    accepts as a way in genuinely needs no chart id itself — a lookup tool that
    required one would be circular."""
    needs, _ = _registry_sets()
    from app.services.agent_flows.tools import registry as R

    known = set(R.all_tools() or {})
    unknown = sorted(set(_CHART_LOOKUP_TOOLS) - known)
    assert not unknown, f"{unknown} are named as lookup tools and do not exist"
    circular = sorted(set(_CHART_LOOKUP_TOOLS) & needs)
    assert not circular, (
        f"{circular} are offered as the way to FIND a chart id and require one"
    )
