# -*- coding: utf-8 -*-
"""What an assistant can answer, said to the person who talks to it.

WHY THIS IS NOT A PROJECTION OF `coverage()`.

`coverage()` answers an AUTHOR's question — which classes has this flow been
granted the tools for — and its output is full of things a reader must never
receive: `covered[].tools` and `.pack` name internals, and `unreadable_sources[]`
carries `step` (a node key), `ref` (a document id) and `needs_any_of` (tool
names). Serialising it and deleting a few keys on the way out would leave the
next person to add a field one `.update()` away from a leak.

WHY IT IS RECOMPUTED PER SURFACE, not copied.

`coverage()` reflects the FLOW's grants. What a reader can actually get depends on
the surface they are standing on, and the two differ: Direct Chat refuses every
tool whose `data_exposure` is `raw_rows`, so a flow granted only `get_chart_data`
can answer lookup questions on a dashboard and cannot here. Advertising that
capability on Chat would make a reader trust the assistant MORE than they should,
which is the one failure mode worth building a separate computation for.

The ceiling is read from the registry and the surface's own contract rather than
listed here. A tool that changes its `data_exposure` moves this answer with it;
a hardcoded list would not.

WHAT IS DELIBERATELY ABSENT.

The names of the things an assistant reads. `bound_sources()` carries refs, and
naming a document a reader may not otherwise open is a leak whatever the intent.
That needs a per-reader permission check, which is its own piece of work.
"""
from __future__ import annotations

from typing import Any

from app.services.agent_flows.contract import Flow
from app.services.agent_flows.coverage import CLASSES

#: EN alongside the VI the class list already carries. The reader picks the app's
#: language; the class list is Vietnamese-only because it was written for the
#: author's canvas, and a reader-facing string has to exist in both.
_EN: dict[str, tuple[str, str]] = {
    "lookup":     ("Look up a figure", "What is total GMV for the period?"),
    "ranking":    ("Rank things", "Which category is highest?"),
    "share":      ("Share of total", "What percentage does that group account for?"),
    "trend":      ("Trend over time", "Has it been rising or falling lately?"),
    "comparison": ("Compare", "How does the North compare with the South?"),
    "diagnosis":  ("Why / anomalies", "Is there anything unusual I should look at?"),
    "projection": ("Forecast", "At this rate, will we hit target by period end?"),
    "definition": ("Definitions and conventions", "How is a completed order counted here?"),
    "freshness":  ("How fresh the data is", "How recent is this data?"),
}


def _granted_tools(flow: Flow) -> set[str]:
    """Every tool any step may call. Same union `coverage()` takes, and for the
    same reason: a reader's question reaches whichever step answers it."""
    out: set[str] = set()
    for node in flow.all_nodes():
        for grant in getattr(node, "tools", None) or []:
            name = getattr(grant, "tool", None) or getattr(grant, "name", None)
            if name:
                out.add(str(name))
    return out


def chat_ceiling(flow: Flow) -> set[str]:
    """Tool names Direct Chat refuses, whatever the flow was granted.

    Read off the registry, because these are runtime refusals with a stated
    reason — `registry._capability_refusal` rejects `data_exposure == "raw_rows"`
    when the context says `read_rows` is false, and Chat's contract says exactly
    that. `web_search` is per-flow rather than per-surface, so it is asked of the
    flow.
    """
    from app.services.agent_flows.tools import registry as tool_registry

    refused: set[str] = set()
    for name, spec in (tool_registry.all_tools() or {}).items():
        if getattr(spec, "data_exposure", "") == "raw_rows":
            refused.add(name)
        if getattr(spec, "reaches_outside", False) and not flow.uses_capability("web_search"):
            refused.add(name)
    return refused


def capability(flow: Flow, *, surface: str = "chat", lang: str = "vi") -> dict[str, Any]:
    """The reader-safe summary for one assistant on one surface.

    Returns only static class metadata — a key, a label and an example question,
    all from the fixed `CLASSES` list. No tool name, no pack, no node key, no
    document/chart/dataset id, and no source name.
    """
    granted = _granted_tools(flow)
    effective = granted - (chat_ceiling(flow) if surface == "chat" else set())

    can: list[dict[str, str]] = []
    cannot: list[dict[str, str]] = []
    for qc in CLASSES:
        label, example = (qc.label_vi, qc.example_vi)
        if lang == "en":
            label, example = _EN.get(qc.key, (qc.label_vi, qc.example_vi))
        entry = {"key": qc.key, "label": label, "example": example}
        (can if effective & set(qc.any_of) else cannot).append(entry)

    return {
        "surface": surface,
        "can": can,
        # KEPT, and kept short. An assistant that can answer everything shows no
        # limits section at all; one that answers two classes out of nine is the
        # case a reader most needs to know about before typing.
        "cannot": cannot,
        # Deterministic: the first few supported classes in the fixed order the
        # class list already carries, which is roughly how often a reader asks
        # them. Derived, never authored, so it cannot drift from `can`.
        "suggested_questions": [c["example"] for c in can[:3]],
    }


#: Keys that must never appear anywhere in a serialised reader capability. Named
#: here so the boundary test asserts the SHAPE rather than someone's intention.
FORBIDDEN_KEYS: tuple[str, ...] = (
    "tools", "pack", "needs_any_of", "step", "ref", "unreadable_sources",
    "chart_id", "dataset_id", "doc_id", "document_id", "node_key", "sources",
)
