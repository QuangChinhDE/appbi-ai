# -*- coding: utf-8 -*-
"""WHAT EACH TRUSTED FIGURE MEANS: measure × breakdown × member × kind.

The evidence ledger answers "was this number read?". A BI answer also asserts
what the number IS — "Bang SP chiếm 9,26% tổng doanh thu" claims a revenue share
of one state — and every live wrong answer on V3 was a real figure with the wrong
meaning: a category's revenue given to a state, a row count read as 100%, an orders
share called a revenue share, a month-on-month change the model divided out itself
from the wrong months.

So every successful result registered through `record_evidence` is described by
the TOOL THAT PRODUCED IT — one adapter per result shape, reading the fields each
tool already returns (`measure`, `dimension`, `item`, `items[].label`,
`current.label`, …), never a regex over arbitrary keys. Each trusted figure gets:

    measure     the field it measures, when the result says
    dimension   the breakdown it belongs to (None for a whole-report figure)
    member      which member of that breakdown (None when unknown or whole)
    ratio       it IS a proportion/change the tool computed (a percentage may
                only be supported by one of these — never by `rows_counted: 1`)

A figure `compute` produced inherits the meaning of the references it was built
from. Only figures the ledger already trusts are described, so this adds no trust.
`claim_check` reads it at the answer.
"""
from __future__ import annotations

import re
from typing import Any

_NUM_RE = re.compile(r"^-?\d+(?:[.,]\d+)?$")
#: Results whose figure is a proportion or a change, by field NAME, per tool.
_RATIO_FIELDS = frozenset({
    "share_pct", "top_share_pct", "pct_change", "pct_change_vs_b", "change_pct",
    "growth_pct", "pct", "percent", "percentage", "rate", "ratio", "share",
    "achievement_pct", "attainment_pct", "progress_pct", "gap_pct", "yoy_pct",
    "mom_pct", "cagr_pct",
})
_RATIO_MEASURE = re.compile(r"(?:^|_)(?:rate|ratio|pct|percent|ty_le|tile)(?:_|$)", re.I)
#: A field NAMED as a proportion: *_pct, *_share*, *_rate, *_ratio, pct_*, share_*.
_RATIO_NAME = re.compile(r"(?:^|_)(?:pct|percent|percentage|share|ratio|rate)(?:_|\d|$)", re.I)
#: "top10_share_pct" names its own basis: the top 10%.
_TOP_N = re.compile(r"top_?(\d{1,3})", re.I)


def _is_ratio_name(k: Any) -> bool:
    return isinstance(k, str) and (k in _RATIO_FIELDS or bool(_RATIO_NAME.search(k)))


def _key(name: Any) -> str | None:
    if not isinstance(name, str) or not name.strip():
        return None
    from app.services.agent_flows.tools.packs.discover import field_key

    return field_key(name) or None


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and _NUM_RE.match(v.strip()):
        return float(v.strip().replace(",", "."))
    return None


def _entry(value: float, *, measure=None, dimension=None, member=None, ratio=False) -> dict:
    return {"value": value, "measure": _key(measure), "dimension": _key(dimension),
            "member": (str(member).strip() if member not in (None, "") else None), "ratio": bool(ratio)}


def _whole(data: dict, measure: Any, keys: tuple[str, ...]) -> list[dict]:
    ratio_measure = bool(isinstance(measure, str) and _RATIO_MEASURE.search(_key(measure) or ""))
    out = []
    for k in keys:
        n = _num(data.get(k))
        if n is not None:
            out.append(_entry(n, measure=measure, ratio=ratio_measure or k in _RATIO_FIELDS))
    return out


def _ratio_fields(d: dict, **scope) -> list[dict]:
    out = []
    for k, v in d.items():
        n = _num(v)
        if n is not None and _is_ratio_name(k):
            out.append(_entry(n, ratio=True, **scope))
            m = _TOP_N.search(k)
            if m:
                out.append({**_entry(float(m.group(1)), ratio=True, **scope), "basis": True})
    return out


# ── one adapter per result shape ────────────────────────────────────────────

def _member_list(data: dict, list_key: str, measure: Any, dimension: Any) -> list[dict]:
    out = []
    for it in data.get(list_key) or []:
        if not isinstance(it, dict):
            continue
        label = it.get("label", it.get("item", it.get("name")))
        for k, v in it.items():
            n = _num(v)
            if n is None or k in ("rank",):
                continue
            out.append(_entry(n, measure=measure, dimension=dimension, member=label,
                              ratio=_is_ratio_name(k) or bool(
                                  isinstance(measure, str) and _RATIO_MEASURE.search(_key(measure) or ""))))
    return out


def _rows(data: dict, dimension_hint: Any = None) -> list[dict]:
    cols, rows = data.get("columns"), data.get("rows")
    if not isinstance(cols, list) or not isinstance(rows, list):
        return []
    names = [c if isinstance(c, str) else (c.get("name") if isinstance(c, dict) else None) for c in cols]
    out = []
    for row in rows[:5000]:
        cells = list(row) if isinstance(row, (list, tuple)) else [row.get(n) if isinstance(row, dict) else None for n in names]
        label_i = next((i for i, v in enumerate(cells) if isinstance(v, str) and v.strip()
                        and not _NUM_RE.match(v.strip())), None)
        member = cells[label_i] if label_i is not None else None
        dim = names[label_i] if label_i is not None and label_i < len(names) else dimension_hint
        for i, v in enumerate(cells):
            n = _num(v)
            if n is None or i == label_i:
                continue
            col = names[i] if i < len(names) else None
            out.append(_entry(n, measure=col, dimension=dim if member is not None else None,
                              member=member, ratio=bool(col and (_is_ratio_name(_key(col) or "")
                                                                 or _RATIO_MEASURE.search(_key(col) or "")))))
    return out


def _summary(data: dict, chart_dims: list[str]) -> list[dict]:
    measure = data.get("primary_measure")
    dim = data.get("primary_dimension") or (chart_dims[0] if chart_dims else None)
    out: list[dict] = []
    for k in ("top_5", "bottom_5"):
        out += _member_list(data, k, measure, dim)
    for col in data.get("columns") or []:
        if not isinstance(col, dict):
            continue
        m = col.get("name") or measure
        out += _whole(col, m, ("total", "avg", "average", "non_null", "null", "distinct"))
        for k in ("min", "max", "median"):
            n = _num(col.get(k))
            if n is not None:
                # On a grouped chart these ARE members' values (the max of revenue
                # by category is one category's revenue); on a KPI tile, whole.
                out.append(_entry(n, measure=m, dimension=dim if dim else None))
    top = _num(data.get("top_share_pct"))
    if top is not None and dim:
        # A KPI tile's summary carries top_share_pct = 100 always — not a share.
        first = (data.get("top_5") or [{}])[0] if isinstance(data.get("top_5"), list) else {}
        out.append(_entry(top, measure=measure, dimension=dim,
                          member=(first or {}).get("label"), ratio=True))
    out += _whole(data, measure, ("total_rows",))
    return out


def describe(tool: str, result: Any, *, chart_dims: dict[int, list[str]] | None = None,
             ledger: list[dict] | None = None) -> list[dict]:
    """Every figure this result carries, with what it means (see module doc)."""
    data = result.get("data") if isinstance(result, dict) and isinstance(result.get("data"), dict) else {}
    if not data:
        return []
    dims_of = (chart_dims or {}).get(data.get("chart_id")) if isinstance(data.get("chart_id"), int) else None
    dims_of = list(dims_of or [])
    measure = data.get("measure") if isinstance(data.get("measure"), str) else None
    dimension = data.get("dimension") if isinstance(data.get("dimension"), str) else None
    name = tool.split(":", 1)[-1] if tool else ""

    if str(tool or "").startswith("skill"):
        # A Skill's NUMBER means what that figure meant in the child run, whose
        # ledger was merged first. Otherwise a category's revenue returned by a
        # Skill would arrive here as a whole-report figure (found by review).
        n = _num(data.get("value"))
        if n is None:
            return []
        same = [e for e in (ledger or []) if abs(float(e["value"]) - n) <= 1e-6 * max(1.0, abs(n))]
        base = same[0] if same else {}
        return [{"value": n, "measure": base.get("measure"), "dimension": base.get("dimension"),
                 "member": base.get("member"), "ratio": bool(base.get("ratio"))}]
    if name == "share_of":
        member = data.get("item")
        out = [_entry(n, measure=measure, dimension=dimension, member=member,
                      ratio=k in _RATIO_FIELDS)
               for k in ("value", "share_pct") if (n := _num(data.get(k))) is not None]
        return out + _whole(data, measure, ("total", "group_count"))
    if name == "rank_values":
        return _member_list(data, "items", measure, dimension) + _whole(data, measure, ("total", "group_count"))
    if name in ("compare_periods",) or ("current" in data and "baseline" in data):
        out = []
        for side in ("current", "baseline"):
            s = data.get(side) if isinstance(data.get(side), dict) else {}
            n = _num(s.get("value"))
            if n is not None:
                # A RATE's value per period is a proportion (t_pp_vs_pct: 78.64% and
                # 84.0% for two months were withheld as percentages nothing produced).
                out.append(_entry(n, measure=measure, dimension="__time__", member=s.get("label"),
                                  ratio=bool(isinstance(measure, str)
                                             and _RATIO_MEASURE.search(_key(measure) or ""))))
        # THE CHANGE IS BETWEEN TWO PERIODS, and says which: a -5.23% between
        # 2018-08 and 2018-07 is not a whole-report figure (found in acceptance:
        # it was flagged as another period's number), and a change between two
        # OTHER periods than the ones asked is (`claim_check._wrong_period`).
        between = [str((data.get(side) or {}).get("label") or "") for side in ("current", "baseline")
                   if isinstance(data.get(side), dict)]
        change = _whole(data, measure, ("delta",)) + _ratio_fields(data, measure=measure)
        return out + [{**e, "dimension": "__time__", "periods": between} for e in change]
    if name in ("compare_segments", "segment_compare") or ("segment_a" in data and "segment_b" in data):
        out = []
        for side in ("segment_a", "segment_b"):
            s = data.get(side) if isinstance(data.get(side), dict) else {}
            for k in ("metric", "value"):
                n = _num(s.get(k))
                if n is not None and not isinstance(s.get(k), str):
                    out.append(_entry(n, measure=measure, dimension=dimension, member=s.get("value")
                                      if isinstance(s.get("value"), str) else None))
        return out + _whole(data, measure, ("delta",)) + _ratio_fields(data, measure=measure)
    if name == "get_chart_summary" or "primary_measure" in data:
        return _summary(data, dims_of)
    if name in ("get_chart_data", "aggregate_chart_data") or ("rows" in data and "columns" in data):
        group_by = data.get("group_by")
        hint = group_by if isinstance(group_by, str) else (group_by[0] if isinstance(group_by, list) and group_by else None)
        out = _rows(data, hint or (dims_of[0] if dims_of else None))
        totals = data.get("totals") if isinstance(data.get("totals"), dict) else {}
        return out + [_entry(n, measure=k) for k, v in totals.items() if (n := _num(v)) is not None]
    if name == "compute" or ("expression" in data and "result" in data):
        n = _num(data.get("result"))
        if n is None:
            return []
        inherited = _inherit(data.get("inputs") or [], ledger or [])
        return [{**inherited, "value": n, "ratio": True, "derived": True}]
    if name == "total_measure":
        out = _whole(data, measure, ("value", "average", "rows_counted"))
        # min / max over a grouped chart are single members' values.
        for k in ("min", "max"):
            n = _num(data.get(k))
            if n is not None:
                out.append(_entry(n, measure=measure, dimension=dims_of[0] if dims_of else None))
        return out
    # Everything else — an ANALYSIS of the chart it names (distribution,
    # anomalies, drill-down…): its figures are about that chart's breakdown, so
    # they carry it; declared dimension first. Ratios by field name.
    analysed = dimension or (dims_of[0] if dims_of else None)
    out = []
    for k, v in data.items():
        n = _num(v)
        if n is None or k in ("chart_id",):
            continue
        out.append(_entry(n, measure=measure, dimension=analysed, ratio=_is_ratio_name(k)
                          or bool(measure and _RATIO_MEASURE.search(_key(measure) or ""))))
    return out + _ratio_fields(data, measure=measure, dimension=analysed)


def _inherit(inputs: list, ledger: list[dict]) -> dict:
    """A derived figure means what its inputs meant: the first input that belongs
    to a member gives it its member; one shared measure gives it that measure."""
    scopes = []
    for i in inputs:
        if not isinstance(i, dict):
            continue
        ref, value = i.get("ref"), _num(i.get("value"))
        match = [e for e in ledger if e.get("ref") == ref and value is not None
                 and abs(float(e["value"]) - value) <= 1e-6 * max(1.0, abs(value))]
        if match:
            scopes.append(match[0])
    member = next((s for s in scopes if s.get("member") or s.get("dimension")), None)
    measures = {s.get("measure") for s in scopes if s.get("measure")}
    return {"measure": measures.pop() if len(measures) == 1 else None,
            "dimension": (member or {}).get("dimension"), "member": (member or {}).get("member")}
