# -*- coding: utf-8 -*-
"""A figure given to a member of a breakdown must BE a figure of that breakdown.

    "Bang SP chiếm bao nhiêu phần trăm tổng doanh thu?"      (the report has no
                                                             revenue by state)
    → "Bang SP … 1,258,681.34 … 9.26%"   health_beauty's revenue and share
    → "Bang SP chiếm 100%"               100 matched `rows_counted: 1`

Measured live, both recorded `ok`. The tool gate refuses a GROUPED call on the
wrong chart; neither route made one.

THE CHECK, from the evidence's own grain (`runtime/grain.py`) and nothing else:

  * the question names breakdown D — the gate's own resolution
    (`requested_dimension`); a TIME breakdown is out of scope here, because time
    is what `compare_periods`/trend tools are FOR and its scope rules live in
    `qualifiers.py`;
  * if the run holds ANY figure of a member of D, it can answer about members of
    D and nothing here fires — whatever else the answer says, correct answers
    recovered through the right chart are never touched;
  * otherwise, a figure in the answer is flagged only when its evidence proves it
    cannot be D's:
      - it is supported ONLY as a figure of members of ANOTHER breakdown the
        question does not name (health_beauty's revenue given to a state), or
      - it is written as a percentage and no proportion the run read produces it
        (100% from a row count; a share the model divided out itself).
    A whole-report figure (a total) is never flagged: stating the total is not a
    member claim, and an honest "không tách được theo bang; tổng là …" keeps it.

It does not read what the prose attributes a number TO — that would be a second
resolver. It asks what the number IS, which the run already knows.
"""
from __future__ import annotations

from typing import Any


def _supported(value: float, pool: list[float]) -> bool:
    from app.services.dashboard_ai_bot.verifier import DEFAULT_TOLERANCE, _matches

    return bool(pool) and _matches(value, pool, DEFAULT_TOLERANCE)


def check(state: Any, ctx: Any, text: str) -> dict:
    """The attribution fact for the trace, with `flagged` figures (possibly none)."""
    from app.services.agent_flows.tools.dimension_gate import (
        dimension_label,
        field_key,
        question_names_dimension,
        requested_dimension,
    )
    from app.services.dashboard_ai_bot.verifier import extract_answer_claims
    from app.services.time_semantics import looks_like_time_name

    try:
        wanted = requested_dimension(ctx) if ctx is not None else None
    except Exception:                                           # noqa: BLE001
        wanted = None
    if not wanted or looks_like_time_name(wanted):
        return {}
    key = field_key(wanted)
    fact: dict[str, Any] = {"requested": key, "label": dimension_label(ctx, wanted)}
    members = getattr(state, "member_figures", None) or {}
    if members.get(key):
        return {**fact, "delivered": True, "flagged": []}
    whole = list(getattr(state, "whole_figures", None) or [])
    ratios = list(getattr(state, "ratio_figures", None) or [])
    others = {d: nums for d, nums in members.items() if d != key and nums
              and not question_names_dimension(ctx, d)}
    flagged: list[dict] = []
    for value, is_pct in extract_answer_claims(text):
        of = sorted(d for d, nums in others.items() if _supported(value, nums))
        if of and not _supported(value, whole) and not _supported(value, ratios):
            flagged.append({"value": value, "why": "member_of", "of": of,
                            "of_labels": [dimension_label(ctx, d) for d in of]})
        elif is_pct and not _supported(value, ratios):
            flagged.append({"value": value, "why": "no_proportion"})
    return {**fact, "delivered": False, "flagged": flagged}


def kept_whole(state: Any, text: str) -> int:
    """How many of the answer's figures are whole-report figures — a correction
    must not buy a clean check by dropping a legitimate total."""
    from app.services.dashboard_ai_bot.verifier import extract_answer_claims

    whole = list(getattr(state, "whole_figures", None) or [])
    # A percentage is never a total — and the verifier's ×100 reading would let
    # "100%" count as one against `rows_counted: 1`, the very figure at issue.
    return sum(1 for v, pct in extract_answer_claims(text) if not pct and _supported(v, whole))
