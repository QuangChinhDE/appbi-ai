# -*- coding: utf-8 -*-
"""WHAT A FIGURE IS A FIGURE OF — recorded where evidence is recorded.

The ledger (`RunState.evidence`) says "this number was read". It could not say
"this number is health_beauty's revenue" or "this number is the all-states total"
or "this number is a count of rows" — and each of those was, live, presented as a
state's share: "Bang SP … 1,258,681.34 … 9.26%" (a category's figures), "Bang SP
chiếm 100%" (100 matched `rows_counted: 1` read as a percentage). Every digit
verified; every answer wrong.

So every result registered through `record_evidence` is also sorted, by the
STRUCTURE the tools already return — never by prose:

    MEMBER   a figure of one member of a breakdown. The breakdown is what the
             result declares (`dimension`, `primary_dimension`, `group_by`) or,
             for rows, the columns that carry labels; the figures are those under
             the per-member keys (`items`, `top_5`, `rows`, `segment_a`, …) —
             or the whole result when it is about ONE member (`share_of`'s `item`).
    WHOLE    every other figure the ledger kept: a total, an average, a count.
    RATIO    a figure that IS a proportion: under a share/pct/rate/change key, or
             any figure of a measure the metadata declares non-additive
             (`measure_meta.NON_ADDITIVE_KINDS`).

Only figures the ledger already trusts are sorted (caller numbers, identifiers and
`evidence_paths` exclusions happen first), so this adds no trust — it only says
what the trusted numbers are about. `dimension_attribution` reads it at the answer.
"""
from __future__ import annotations

import re
from typing import Any

#: Keys whose value belongs to ONE member of the declared breakdown.
_MEMBER_KEYS = frozenset({"items", "top_5", "bottom_5", "rows", "sample_rows", "segment_a",
                          "segment_b", "top_values", "outliers", "groups"})
#: On a GROUPED result these statistics are a member's value too: the max of
#: revenue-by-category IS health_beauty's revenue, its `top_share_pct` IS
#: health_beauty's share. Measured: both were the figures given to "Bang SP".
_MEMBER_STAT_KEYS = frozenset({"min", "max", "minimum", "maximum", "median", "top_share_pct"})
#: A proportion by name: share_pct, pct_change_vs_b, top_share_pct, change_pct, rate…
_RATIO_KEY = re.compile(r"(?:^|_)(?:pct|percent|percentage|share|ratio|rate|change|growth)(?:_|$)",
                        re.IGNORECASE)
_NUM_RE = re.compile(r"^-?\d+(?:[.,]\d+)?$")


def _key(name: str) -> str:
    from app.services.agent_flows.tools.packs.discover import field_key

    return field_key(str(name or ""))


def _numbers(payload: Any, depth: int = 0) -> list[float]:
    """Every number in a payload (numbers and numeric strings), bounded."""
    if depth > 6:
        return []
    if isinstance(payload, bool):
        return []
    if isinstance(payload, (int, float)):
        return [float(payload)]
    if isinstance(payload, str):
        s = payload.strip()
        return [float(s.replace(",", "."))] if _NUM_RE.match(s) else []
    if isinstance(payload, dict):
        return [n for v in payload.values() for n in _numbers(v, depth + 1)]
    if isinstance(payload, (list, tuple)):
        return [n for v in payload[:500] for n in _numbers(v, depth + 1)]
    return []


def per_member_dimensions(data: Any) -> set[str]:
    """The breakdowns a result is per-member OF, as field keys."""
    if not isinstance(data, dict):
        return set()
    out: set[str] = set()
    for k in ("dimension", "primary_dimension"):
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            out.add(_key(v))
    group_by = data.get("group_by")
    for g in ([group_by] if isinstance(group_by, str) else group_by or []):
        if isinstance(g, str) and g.strip():
            out.add(_key(g))
    # ROWS: the columns that carry LABELS are the breakdown the rows are per.
    cols, rows = data.get("columns"), data.get("rows")
    if isinstance(cols, list) and isinstance(rows, list) and rows:
        names = [c if isinstance(c, str) else (c.get("name") if isinstance(c, dict) else None)
                 for c in cols]
        for i, name in enumerate(names):
            if not name:
                continue
            for row in rows[:50]:
                v = row[i] if isinstance(row, (list, tuple)) and i < len(row) else (
                    row.get(name) if isinstance(row, dict) else None)
                if isinstance(v, str) and v.strip() and not _NUM_RE.match(v.strip()):
                    out.add(_key(name))
                    break
    return {k for k in out if k}


def member_numbers(data: Any) -> list[float]:
    """The figures of a (grouped) result that belong to single members of it."""
    if not isinstance(data, dict):
        return []
    if data.get("item") is not None and per_member_dimensions(data):
        return _numbers(data)            # the whole result is about one member
    return _member_walk(data, 0)


def _member_walk(v: Any, depth: int) -> list[float]:
    if depth > 6:
        return []
    if isinstance(v, dict):
        out: list[float] = []
        for k, x in v.items():
            if k in _MEMBER_KEYS or k in _MEMBER_STAT_KEYS:
                out += _numbers(x)
            elif isinstance(x, (dict, list)):
                out += _member_walk(x, depth + 1)
        return out
    if isinstance(v, list):
        return [n for x in v[:500] for n in _member_walk(x, depth + 1)]
    return []


def ratio_numbers(data: Any, depth: int = 0) -> list[float]:
    """The figures that ARE proportions, by key or by the measure's declared kind."""
    if not isinstance(data, dict) or depth > 6:
        return []
    from app.services.agent_flows.tools.packs.measure_meta import NON_ADDITIVE_KINDS

    if str(data.get("format_kind") or "").lower() in NON_ADDITIVE_KINDS:
        return [n for k in ("value", "average", "min", "max", "total", "median")
                for n in _numbers(data.get(k))] + \
            [n for v in data.values() if isinstance(v, (dict, list)) for n in _ratio_walk(v, depth + 1)]
    out: list[float] = []
    for k, v in data.items():
        if isinstance(v, (int, float, str)) and _RATIO_KEY.search(str(k)):
            out += _numbers(v)
        elif isinstance(v, (dict, list)):
            out += _ratio_walk(v, depth + 1)
    return out


def _ratio_walk(v: Any, depth: int) -> list[float]:
    if isinstance(v, dict):
        return ratio_numbers(v, depth)
    if isinstance(v, list):
        return [n for x in v[:500] for n in _ratio_walk(x, depth + 1)]
    return []


def sort_figures(result: Any, trusted: list[float]) -> tuple[dict[str, list[float]], list[float], list[float]]:
    """(member figures by breakdown, whole figures, ratio figures) of one result —
    each a subset of `trusted`, the figures the ledger just kept from it."""
    data = result.get("data") if isinstance(result, dict) and isinstance(result.get("data"), dict) else {}
    if not trusted or not data:
        return {}, list(trusted), []
    dims = per_member_dimensions(data)
    members = set(member_numbers(data)) if dims else set()
    # A member's share is the member's figure, not a proportion of the whole.
    ratios = set(ratio_numbers(data)) - members
    by_dim: dict[str, list[float]] = {}
    whole: list[float] = []
    for n in trusted:
        if n in members:
            for d in dims:
                by_dim.setdefault(d, []).append(n)
        else:
            whole.append(n)
    return by_dim, whole, [n for n in trusted if n in ratios]
