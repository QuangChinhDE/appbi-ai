# -*- coding: utf-8 -*-
"""ONE path from a business question to the assets that answer it.

WHY THIS EXISTS

`list_charts` matches a question against chart names and on-screen field labels,
folded and tokenised. That is enough for "doanh thu theo danh mục" and not enough
for real BI language:

    question: "phân tích biến động mrr qua từng tháng"
    chart:    "[Demo_NetSuite] MRR Active by time"
    measure:  mrr_active          dimension: year_month

Only `mrr` overlaps. "biến động" and "qua từng tháng" are correct business
language that appears nowhere in the English metadata, so the lexical pass
returns `ambiguous` and the caller falls back to report order — reading whatever
happens to be first and presenting it as an answer to the question.

WHAT THIS IS NOT

Not a new matching algorithm, and not an LLM guess. It COMPOSES paths that
already exist and are already audited:

    lexical    list_charts                 name + on-screen labels
    semantic   search_business_assets      governed metrics, glossary terms,
                                           semantic fields, descriptions
    bridge     resolve_chart_candidates    metric/field -> the charts realising it

The bridge is the part that was missing. Matching "mrr" to the governed metric
`mrr_active` was already possible; nothing walked from that metric back to the
chart that plots it.

PERMISSION

Resolution MAY NARROW scope and MUST NEVER DEFINE OR WIDEN it. Every id returned
is intersected with the caller's already-authorised set, here, once — not left to
a caller to remember.

AMBIGUITY STAYS VISIBLE

The status vocabulary is the point. "Could not tell which chart this is about" is
not "the first charts are relevant", and a deterministic step must not make a
semantic guess it cannot justify.
"""
from __future__ import annotations

from typing import Any, Callable, Literal

Status = Literal["exact", "semantic", "ambiguous", "none"]

#: How this module reaches a tool: `call(name, args) -> normalised result`.
#:
#: INJECTED RATHER THAN IMPORTED, and the reason is a defect this shipped with for
#: one commit. Calling the tool functions directly meant passing a context, the
#: caller passed the RunContext instead of the ToolContext inside it, and the whole
#: question-matching path died with `'RunContext' object has no attribute
#: 'allowed_chart_ids'` — while the unit tests stayed green, because they stubbed
#: both searches and never exercised a real context.
#:
#: Taking a `call` removes the parameter that was wrong. It also puts these calls
#: back through `tool_registry.execute`, which is what counts them against the
#: turn's tool budget and records them in the run's tool log; calling the functions
#: directly silently bypassed both.
Call = Callable[[str, dict], Any]

#: Above this many distinct concepts behind the candidates, the question is not
#: pointing at one thing. Two charts realising ONE metric is a ranked answer; two
#: charts arriving from two unrelated metrics is a question we did not understand.
_AMBIGUOUS_AT = 2


def _lexical(call: Call, question: str) -> tuple[str, list[int]]:
    """`list_charts`' own verdict. Its fallback listing is never a match."""
    res = call("list_charts", {"query": question})
    if not isinstance(res, dict) or not res.get("ok"):
        return "lookup_failed", []
    data = res.get("data") if isinstance(res.get("data"), dict) else res
    selection = data.get("selection") if isinstance(data.get("selection"), dict) else {}
    status = str(selection.get("status") or "")
    ids = [c for c in (selection.get("selected_ids") or []) if isinstance(c, int)]
    if not status:
        coverage = data.get("coverage") if isinstance(data.get("coverage"), dict) else {}
        if "query_matched_nothing" in coverage:
            return "none", []
        ids = ids or [
            c.get("chart_id") for c in (data.get("charts") or [])
            if isinstance(c, dict) and isinstance(c.get("chart_id"), int)
        ]
        return ("matched" if ids else "none"), ids
    return status, ids


def _semantic(call: Call, question: str) -> list[dict]:
    """Charts reached through a governed metric or a semantic field.

    Returns one entry per (concept, chart) so the caller can see how many
    DISTINCT concepts the question touched — which is what separates a ranked
    answer from an ambiguous one.
    """
    found = call("search_business_assets", {"query": question})
    if not isinstance(found, dict) or not found.get("ok"):
        return []
    data = found.get("data") if isinstance(found.get("data"), dict) else found

    out: list[dict] = []
    for asset in (data.get("results") or []):
        if not isinstance(asset, dict):
            continue
        kind = asset.get("type")
        if kind not in ("metric", "field"):
            continue
        # `id` carries the IDENTIFIER (governed metric name / semantic field
        # name); `name` is the display label. `resolve_chart_candidates` matches
        # on the identifier, so passing the label finds nothing.
        ident = asset.get("id") or asset.get("name") or ""
        if not ident:
            continue
        args = {"metric": ident} if kind == "metric" else {"measure": ident}
        res = call("resolve_chart_candidates", args)
        if not isinstance(res, dict) or not res.get("ok"):
            continue
        payload = res.get("data") if isinstance(res.get("data"), dict) else res
        for cand in (payload.get("candidates") or payload.get("charts") or []):
            if not isinstance(cand, dict) or not isinstance(cand.get("chart_id"), int):
                continue
            # `same_table` is explicitly NOT a match. A chart on the same table may
            # plot something else entirely, and presenting it at the same
            # confidence is how a caller picks a plausible wrong chart.
            if cand.get("match") != "measure":
                continue
            out.append({
                "chart_id": cand["chart_id"],
                "chart_name": cand.get("chart_name") or "",
                "via": kind,
                "concept": str(ident),
                "why": f"{kind} “{asset.get('name') or ident}” is plotted by this chart",
            })
    return out


def resolve_charts(question: str, allowed: list[int], *, call: Call) -> dict:
    """Which charts this question is about, with the evidence for saying so.

    Returns `{status, chart_ids, candidates, concepts}` where status is
    exact / semantic / ambiguous / none. `chart_ids` is meaningful only for
    `exact` and `semantic`; for `ambiguous` the candidates are the answer and the
    caller must not pick one.
    """
    keep = set(allowed or [])
    empty = {"status": "none", "chart_ids": [], "candidates": [], "concepts": []}
    if not question.strip() or not keep:
        return empty

    lex_status, lex_ids = _lexical(call, question)
    lex_ids = [c for c in lex_ids if c in keep]
    if lex_status == "matched" and lex_ids:
        return {"status": "exact", "chart_ids": lex_ids, "concepts": [],
                "candidates": [{"chart_id": c, "via": "name", "why": "chart name or "
                                "on-screen field labels match"} for c in lex_ids]}

    # The lexical pass could not tell. Ask the business vocabulary before giving
    # up — this is the step that was missing, not a second opinion on the first.
    cands = [c for c in _semantic(call, question) if c["chart_id"] in keep]
    if not cands:
        # An `ambiguous` lexical verdict is still ambiguity, not absence: the
        # caller may want to offer those candidates rather than say "no chart".
        if lex_status == "ambiguous" and lex_ids:
            return {"status": "ambiguous", "chart_ids": [], "concepts": [],
                    "candidates": [{"chart_id": c, "via": "name",
                                    "why": "one shared word only"} for c in lex_ids]}
        return empty

    concepts = sorted({c["concept"] for c in cands if c["concept"]})
    ids: list[int] = []
    for c in cands:
        if c["chart_id"] not in ids:
            ids.append(c["chart_id"])

    if len(concepts) >= _AMBIGUOUS_AT:
        return {"status": "ambiguous", "chart_ids": [], "candidates": cands,
                "concepts": concepts}
    return {"status": "semantic", "chart_ids": ids, "candidates": cands,
            "concepts": concepts}
