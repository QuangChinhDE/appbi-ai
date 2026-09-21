# -*- coding: utf-8 -*-
"""What a reader is told an assistant can do, and what must never travel with it.

Two separate claims, and they fail for different reasons, so they are tested
separately:

1. THE BOUNDARY. The serialised payload must not carry tool names, pack names,
   node keys, document/chart/dataset ids or source names. Asserted on the SHAPE —
   the JSON is walked and forbidden keys must be literally absent — rather than on
   the intention of whoever wrote the dict.

2. THE RECOMPUTATION. Chat capability must be computed against Chat's own ceiling,
   not copied from the author's `coverage()`. A flow granted only `get_chart_data`
   can answer lookup questions on a dashboard and cannot here, because Chat sets
   `read_rows=False` and the registry refuses every `raw_rows` tool. Advertising
   it anyway is the failure that makes a reader trust the assistant MORE than they
   should, which is why this is a recomputation and not a projection.
"""
from __future__ import annotations

import json

import pytest

from app.services.agent_flows import reader_capability as rc
from app.services.agent_flows.contract import Flow, upgrade_body
from app.services.agent_flows.coverage import CLASSES, coverage


def flow_with(tools: list[str], *, knowledge: list | None = None) -> Flow:
    node: dict = {"key": "tra_loi", "type": "agent", "name": "Trả lời",
                  "prompt": "x", "tools": [{"tool": t} for t in tools]}
    if knowledge:
        node["knowledge"] = knowledge
    body = {"name": "t", "nodes": [node], "answer_node": "tra_loi"}
    return Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"}
    )


def walk_keys(obj) -> set[str]:
    """Every dict key anywhere in the payload, at any depth."""
    out: set[str] = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.add(str(k))
            out |= walk_keys(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            out |= walk_keys(v)
    return out


# ── 1. the boundary ─────────────────────────────────────────────────────────

def test_the_serialised_payload_carries_no_internal_key():
    """Walked, not reviewed. A field added later lands inside this assertion
    whether or not anyone remembers this file exists."""
    cap = rc.capability(flow_with(["rank_values", "search_knowledge"]))
    keys = walk_keys(json.loads(json.dumps(cap)))
    leaked = sorted(keys & set(rc.FORBIDDEN_KEYS))
    assert not leaked, f"reader capability carries internal keys: {leaked}"


def test_no_tool_name_appears_anywhere_in_the_serialised_text():
    """The key test above catches a `tools` FIELD. This catches a tool name that
    arrives some other way — inside a label, an example, a reason string."""
    from app.services.agent_flows.tools import registry as tool_registry

    cap = rc.capability(flow_with(["rank_values", "total_measure", "search_knowledge"]))
    blob = json.dumps(cap, ensure_ascii=False).lower()
    named = sorted(n for n in (tool_registry.all_tools() or {}) if n.lower() in blob)
    assert not named, f"tool names reached the reader: {named}"


def test_the_authors_coverage_view_would_have_failed_that_boundary():
    """The control. Without it, the test above could pass because the boundary is
    easy rather than because it is enforced — `coverage()` is what a projection
    would have shipped, and it carries exactly the keys that are banned."""
    raw = coverage(flow_with(["rank_values"]))
    keys = walk_keys(json.loads(json.dumps(raw)))
    assert keys & set(rc.FORBIDDEN_KEYS), (
        "coverage() no longer carries internal keys — if that is deliberate, this "
        "control has lost its meaning and the boundary needs a different one"
    )


def test_no_document_or_chart_id_travels_with_the_capability():
    cap = rc.capability(flow_with(
        ["search_knowledge"],
        knowledge=[{"source": "document", "ref": "26",
                   "description": "Quy ước tính GMV và phí vận chuyển của Olist"}],
    ))
    blob = json.dumps(cap, ensure_ascii=False)
    assert "26" not in blob and "Quy ước tính GMV" not in blob, (
        "an attached source's id or description reached the reader — naming what "
        "an assistant reads needs a per-reader permission check, not a projection"
    )


# ── 2. the recomputation ────────────────────────────────────────────────────

def test_chat_does_not_advertise_a_class_only_a_raw_rows_tool_could_answer():
    """THE POINT OF THE WHOLE MODULE. `get_chart_data` is `data_exposure:
    raw_rows`; Chat sets `read_rows=False` and the registry refuses it. So a flow
    granted only that tool answers lookup questions elsewhere and not here."""
    flow = flow_with(["get_chart_data"])
    author = {c["key"] for c in coverage(flow)["covered"]}
    assert "lookup" in author, "fixture drifted: the author's view must cover lookup"

    cap = rc.capability(flow, surface="chat")
    assert "lookup" not in {c["key"] for c in cap["can"]}, (
        "Chat advertised a capability its own runtime refuses"
    )
    assert "lookup" in {c["key"] for c in cap["cannot"]}


def test_a_class_answerable_within_the_ceiling_is_still_advertised():
    """The other half — a ceiling that removes everything would also pass the test
    above."""
    cap = rc.capability(flow_with(["rank_values"]), surface="chat")
    assert "ranking" in {c["key"] for c in cap["can"]}


def test_every_class_is_either_can_or_cannot_and_none_is_lost():
    cap = rc.capability(flow_with(["rank_values"]), surface="chat")
    seen = [c["key"] for c in cap["can"]] + [c["key"] for c in cap["cannot"]]
    assert sorted(seen) == sorted(c.key for c in CLASSES)
    assert len(seen) == len(set(seen))


def test_suggested_questions_are_derived_from_what_it_can_answer():
    """Derived, never authored, so they cannot advertise something `can` does
    not."""
    cap = rc.capability(flow_with(["rank_values", "share_of", "analyze_trend",
                                   "search_knowledge"]), surface="chat")
    examples = {c["example"] for c in cap["can"]}
    assert cap["suggested_questions"], "a capable assistant suggested nothing"
    assert set(cap["suggested_questions"]) <= examples
    assert len(cap["suggested_questions"]) <= 3


def test_an_assistant_that_can_answer_nothing_suggests_nothing():
    cap = rc.capability(flow_with([]), surface="chat")
    assert cap["can"] == [] and cap["suggested_questions"] == []
    assert len(cap["cannot"]) == len(CLASSES)


@pytest.mark.parametrize("lang, probe", [("vi", "Xếp hạng"), ("en", "Rank things")])
def test_both_languages_are_served(lang, probe):
    """The class list is Vietnamese-only because it was written for the author's
    canvas; a reader-facing string has to exist in both."""
    cap = rc.capability(flow_with(["rank_values"]), surface="chat", lang=lang)
    assert probe in {c["label"] for c in cap["can"]}


def test_the_ceiling_is_read_from_the_registry_not_hardcoded():
    """A tool that changes its `data_exposure` must move this answer with it."""
    import inspect

    src = inspect.getsource(rc.chat_ceiling)
    assert "all_tools()" in src and "data_exposure" in src
    assert "get_chart_data" not in src, (
        "the ceiling names a specific tool — a list here goes stale silently"
    )
