"""The answer's words, computed from the governed rows — not written by a model.

Every number in the narrative is read from the result grid GQS returned, so an
answer can be checked against its own table (and an independent oracle can
recompute it). A model never states a figure here; that is what removes the
hallucinated-number failure mode from the first release.

Also: the result checks (`checks`) and the Chart Draft the answer proposes.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Optional

RECENT = 3  # "recent" = the last three COMPLETE calendar periods


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def fmt(v: Optional[float]) -> str:
    if v is None:
        return "—"
    a = abs(v)
    if a >= 1e9:
        return f"{v / 1e9:,.2f} tỷ"
    if a >= 1e6:
        return f"{v / 1e6:,.2f} triệu"
    if a >= 1e3:
        return f"{v:,.0f}"
    return f"{v:,.2f}".rstrip("0").rstrip(".")


def pct(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None or b is None or a == 0:
        return None
    return (b - a) / abs(a) * 100.0


def describe(columns: list[dict], rows: list[dict], *, time_ref: Optional[str], truncated: bool,
             grain: Optional[str] = None, today: Optional[date] = None,
             period: Optional[tuple[date, date]] = None, order: Optional[str] = None,
             top: Optional[int] = None) -> dict:
    """columns: [{name, ref, role, label}] in result order. `period` is the
    explicit range the question asked for ([from, to) on the time field): the
    trend then spans THAT range, not the default "recent" window."""
    measures = [c for c in columns if c["role"] == "measure"]
    dims = [c for c in columns if c["role"] == "dimension"]
    time_col = next((c for c in dims if c["ref"] == time_ref), None) if time_ref else None
    cat_col = next((c for c in dims if c is not time_col), None)
    checks = _checks(rows, measures, time_col, truncated)
    if not rows or not measures:
        return {"headline": "Không có dữ liệu cho câu hỏi này trong phạm vi được phép.", "bullets": [],
                "facts": [], "checks": checks}
    m = measures[0]
    # Only a SUM or a COUNT adds up across rows: a share of "the total" or a sum over
    # groups of an average / a rate / a distinct count is a number the data does not
    # hold (live 2026-10-28: a report showing 72.7% was explained with another %).
    # A column without an aggregation is read as before (a sum).
    additive = str(m.get("aggregation") or "sum").lower() in ("sum", "count")
    if truncated:
        # Rows stop at the bound mid-way (a period or a ranking cut short): any
        # trend, ranking or total read from them would be an artefact of the cut.
        return {"headline": (f"Kết quả vượt giới hạn {len(rows)} dòng nên chưa kết luận về {m['label']}. "
                             "Hãy thu hẹp câu hỏi (ví dụ theo nhóm thay vì từng mục, hoặc một khoảng thời gian)."),
                "bullets": [], "facts": [], "checks": checks, "incomplete": True}
    if time_col is not None:
        return _over_time(rows, m, time_col, cat_col, checks, grain or "month", today or date.today(), period,
                          additive=additive)
    if cat_col is not None:
        return _ranking(rows, m, cat_col, checks, order or "desc", top, additive=additive)
    total = _num(rows[0].get(m["name"]))
    return {"headline": f"{m['label']}: {fmt(total)}.", "bullets": [],
            "facts": [{"claim": m["label"], "value": total}], "checks": checks}


GRAIN_WORD = {"day": "ngày", "week": "tuần", "month": "tháng", "quarter": "quý", "year": "năm"}


def _to_date(v: Any) -> Optional[date]:
    """The start of the period a grouped time value names: a date/datetime, or
    text the engines return ("2024-03-01", "2024-03-01T00:00:00", "2024-03",
    "2024-Q1", "2024")."""
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v or "").strip()
    try:
        if len(s) >= 10 and s[4] == "-" and s[7] == "-":
            return date(int(s[:4]), int(s[5:7]), int(s[8:10]))
        if len(s) == 7 and s[4] == "-" and s[5:].isdigit():
            return date(int(s[:4]), int(s[5:7]), 1)
        if len(s) == 7 and s[4:6].upper() == "-Q":
            return date(int(s[:4]), (int(s[6]) - 1) * 3 + 1, 1)
        if len(s) == 4 and s.isdigit():
            return date(int(s), 1, 1)
    except ValueError:
        return None
    return None


def _start(d: date, grain: str) -> date:
    if grain == "month":
        return d.replace(day=1)
    if grain == "quarter":
        return date(d.year, (d.month - 1) // 3 * 3 + 1, 1)
    if grain == "year":
        return date(d.year, 1, 1)
    return d  # day; week keeps the engine's own week start (Monday on Postgres, Sunday on BigQuery)


def _next(d: date, grain: str) -> date:
    if grain == "day":
        return d + timedelta(days=1)
    if grain == "week":
        return d + timedelta(days=7)
    months = {"month": 1, "quarter": 3, "year": 12}[grain]
    y, m = divmod(d.month - 1 + months, 12)
    return date(d.year + y, m + 1, 1)


def _label(d: date, grain: str) -> str:
    if grain == "month":
        return f"{d.year}-{d.month:02d}"
    if grain == "quarter":
        return f"{d.year}-Q{(d.month - 1) // 3 + 1}"
    if grain == "year":
        return str(d.year)
    return d.isoformat()


def _member(v) -> str:
    """A group's name as the reader reads it: a blank member is "(trống)", never "None"."""
    return "(trống)" if v is None or (isinstance(v, str) and not v.strip()) else str(v)


def _thin_edges(series: dict, present: set, grain: str, today: date) -> list[date]:
    """The edge periods `chart_value_normalization.time_completeness` calls
    `edge_low_volume`, computed on the periods' totals."""
    from datetime import datetime as _datetime

    from app.services.chart_value_normalization import time_completeness

    rows = [{"t": _datetime(p.year, p.month, p.day),
             "v": sum(v for s in series.values() for v in [s.get(p)] if v is not None)} for p in sorted(present)]
    out = time_completeness(rows, "t", grain, "v", now=_datetime(today.year, today.month, today.day)) or {}
    thin = {p["bucket"] for p in out.get("partial") or [] if p.get("reason") == "edge_low_volume"}
    return [r["t"].date() for r in rows if r["t"] in thin]


def _over_time(rows, m, tcol, ccol, checks, grain: str, today: date,
               period: Optional[tuple[date, date]] = None, *, additive: bool = True) -> dict:
    grain = grain if grain in GRAIN_WORD else "month"
    word = GRAIN_WORD[grain]
    # A period with no row is MISSING; a row whose measure is NULL is UNKNOWN.
    # Neither is zero, and neither is compared as if it were a number.
    series: dict[str, dict[date, Optional[float]]] = defaultdict(dict)
    present: set[date] = set()
    for r in rows:
        d = _to_date(r.get(tcol["name"]))
        if d is None:
            continue  # counted by the time_nulls check
        d = _start(d, grain)
        present.add(d)
        key = _member(r.get(ccol["name"])) if ccol else m["label"]
        v = _num(r.get(m["name"]))
        prev = series[key].get(d, 0.0)
        series[key][d] = None if v is None or prev is None else prev + v
    if not present:
        return {"headline": f"Không đọc được mốc thời gian của {m['label']} để nói về xu hướng.",
                "bullets": [], "facts": [], "checks": checks}
    calendar: list[date] = []  # every calendar period first..last, gaps included
    # An asked range ("năm 2025") spans the whole range, so a period at either
    # edge with no row is reported missing instead of silently shortening it.
    d = _start(period[0], grain) if period else min(present)
    end_ok = (lambda p: p < period[1]) if period else (lambda p: p <= max(present))
    while end_ok(d) and len(calendar) < 5000:
        calendar.append(d)
        d = _next(d, grain)
    # A period that has not ended yet (today falls inside it, or it is in the
    # future) holds part of its data: comparing it with a full one is a fake drop.
    partial = [p for p in calendar if _next(p, grain) > today]
    # A first or last period far below a typical one is probably cut off - a data set
    # that ends mid-month (live 2026-10-28: Olist 2018-09 held a few orders and the
    # headline read "-100%"). The rule the chart's own footnote uses.
    # (volume-based: an average per period has no volume to tell a thin period by)
    thin = [p for p in _thin_edges(series, present, grain, today) if p not in partial] if additive else []
    complete = [p for p in calendar if p not in partial and p not in thin]
    notes = []
    if partial:
        notes.append(f"Kỳ {', '.join(_label(p, grain) for p in partial)} chưa kết thúc nên không dùng để so sánh.")
    if thin:
        notes.append(f"Kỳ {', '.join(_label(p, grain) for p in thin)} ở đầu hoặc cuối dữ liệu thấp hơn nhiều so với "
                     "một kỳ thông thường (có thể chưa đầy đủ) nên không dùng để so sánh.")
    partial = partial + thin
    if not complete:
        return {"headline": f"Dữ liệu {m['label']} mới có ở {word} chưa kết thúc, chưa đủ để nói về xu hướng.",
                "bullets": [], "facts": [], "checks": checks, "note": " ".join(notes), "incomplete": True}
    window = complete if period else complete[-RECENT:]
    missing = [p for p in window if p not in present]
    if missing:
        notes.append(f"Không có dữ liệu ở {word} {', '.join(_label(p, grain) for p in missing)} "
                     "(khác với giá trị 0).")

    def total(p):
        vals = [s[p] for s in series.values() if p in s]
        if not vals or any(v is None for v in vals):
            return None
        return sum(vals)

    first, last = window[0], window[-1]
    across = not additive and ccol is not None and len(series) > 1
    t0, t1 = (None, None) if across else (total(first), total(last))
    L0, L1 = _label(first, grain), _label(last, grain)
    if across:
        headline = (f"{m['label']} theo {word} của từng nhóm ({L0} → {L1}): chỉ số này không cộng gộp được "
                    "giữa các nhóm nên không có một con số chung; xem từng nhóm bên dưới.")
    elif len(window) < 2:
        headline = f"{m['label']} {word} {L1}: {fmt(t1)}. Mới có một {word} đầy đủ nên chưa nói về xu hướng."
    elif t0 is None or t1 is None:
        headline = (f"{m['label']} {L0} → {L1}: {fmt(t0)} → {fmt(t1)}. "
                    "Thiếu dữ liệu ở kỳ đầu hoặc kỳ cuối nên không tính mức thay đổi.")
    else:
        change = pct(t0, t1)
        headline = (f"{m['label']} {L0} → {L1}: {fmt(t0)} → {fmt(t1)}"
                    + (f" ({change:+.1f}%)." if change is not None else "."))
    facts = [] if across else [{"claim": f"total {L0}", "value": t0}, {"claim": f"total {L1}", "value": t1}]
    bullets = []
    if ccol and len(window) == 1:
        # One complete period asked for ("theo vùng năm 2025"): rank the groups in it.
        known = sorted(((k, s[last]) for k, s in series.items() if s.get(last) is not None),
                       key=lambda kv: kv[1], reverse=True)
        for k, v in known[:5]:
            bullets.append(f"{k}: {fmt(v)}" + (f" ({v / t1 * 100:.1f}%)" if t1 and additive else ""))
            facts.append({"claim": f"{k} {L1}", "value": v})
    if ccol and len(window) >= 2:
        moves = []
        for k, s in series.items():
            a, b = s.get(first), s.get(last)
            if a is None or b is None:
                continue  # absent or unknown at one end: no measurable change
            moves.append((k, a, b, b - a, pct(a, b)))
        for k, a, b, dlt, p in sorted(moves, key=lambda x: x[3], reverse=True)[:3]:
            if dlt > 0:
                bullets.append(f"{k}: tăng {fmt(dlt)} ({fmt(a)} → {fmt(b)}" + (f", {p:+.1f}%)" if p is not None else ")"))
                facts.append({"claim": f"{k} change {L0}->{L1}", "value": dlt})
        for k, a, b, dlt, p in sorted(moves, key=lambda x: x[3])[:3]:
            if dlt < 0:
                bullets.append(f"{k}: giảm {fmt(-dlt)} ({fmt(a)} → {fmt(b)}" + (f", {p:+.1f}%)" if p is not None else ")"))
                facts.append({"claim": f"{k} change {L0}->{L1}", "value": dlt})
        known = [(k, s[last]) for k, s in series.items() if s.get(last) is not None]
        if known:
            lead = _leaders(known)
            top = max(v for _, v in known)
            bullets.append(f"Lớn nhất {word} {L1}: {', '.join(lead)} ({fmt(top)})"
                           + (" - bằng nhau." if len(lead) > 1 else "."))
        one_end = sorted(k for k, s in series.items() if (first in s) != (last in s))
        if one_end:
            bullets.append(f"Không so sánh được (chỉ có dữ liệu ở một đầu): {', '.join(one_end[:5])}.")
    if period:
        notes.insert(0, f"So sánh {word} đầu và cuối của kỳ được hỏi ({L0} → {L1}).")
    else:
        notes.insert(0, f"“Gần đây” là {len(window)} {word} đầy đủ cuối cùng ({L0} → {L1}); "
                        f"dữ liệu trải từ {_label(calendar[0], grain)} đến {_label(calendar[-1], grain)}.")
    return {"headline": headline, "bullets": bullets, "facts": facts, "checks": checks, "note": " ".join(notes),
            "periods": {"first": _label(calendar[0], grain), "last": _label(calendar[-1], grain),
                        "window": [_label(p, grain) for p in window],
                        "missing": [_label(p, grain) for p in missing],
                        "partial": [_label(p, grain) for p in partial]}}


def _leaders(known: list[tuple[str, float]], lowest: bool = False) -> list[str]:
    """Every group holding the top (or bottom) value: a tie has no single "highest"."""
    if not known:
        return []
    top = (min if lowest else max)(v for _, v in known)
    return [k for k, v in known if abs(v - top) <= 1e-9 * max(1.0, abs(top))]


def _ranking(rows, m, ccol, checks, order: str = "desc", top: Optional[int] = None, *,
             additive: bool = True) -> dict:
    # A NULL measure is UNKNOWN, not zero: it is neither ranked nor summed.
    known = [(_member(r.get(ccol["name"])), _num(r.get(m["name"]))) for r in rows]
    unknown = [k for k, v in known if v is None]
    vals = sorted(((k, v) for k, v in known if v is not None), key=lambda kv: kv[1], reverse=(order != "asc"))
    if not vals:
        return {"headline": f"Không có giá trị {m['label']} nào để so sánh.", "bullets": [], "facts": [],
                "checks": checks}
    # a share of the total only where rows add up, and never of a top-N cut's sum
    total = (sum(v for _, v in vals) or None) if additive and not top else None
    bullets = [f"{k}: {fmt(v)}" + (f" ({v / total * 100:.1f}%)" if total else "") for k, v in vals[:5]]
    if unknown:
        bullets.append(f"Không có giá trị (không tính là 0): {', '.join(unknown[:5])}.")
    word = "thấp nhất" if order == "asc" else "cao nhất"
    lead = _leaders(vals, lowest=(order == "asc"))
    if top:
        headline = (f"{len(vals)} {ccol['label']} có {m['label']} {word}: "
                    + ", ".join(f"{k} ({fmt(v)})" for k, v in vals) + ".")
        if len(vals) < top:
            headline += f" Dữ liệu chỉ có {len(vals)} nhóm."
    elif len(lead) == len(vals) and len(vals) > 1:
        headline = f"{m['label']} bằng nhau ở tất cả {len(vals)} nhóm ({fmt(vals[0][1])} mỗi nhóm)."
    elif len(lead) > 1:
        headline = f"{m['label']} {word} (bằng nhau): {', '.join(lead)} ({fmt(vals[0][1])})."
    else:
        headline = f"{m['label']} {word}: {vals[0][0]} ({fmt(vals[0][1])})."
    return {"headline": headline, "bullets": bullets,
            "facts": [{"claim": k, "value": v} for k, v in vals[:5]], "checks": checks}


def _checks(rows, measures, tcol, truncated) -> list[dict]:
    out = [{"name": "rows", "ok": bool(rows), "detail": f"{len(rows)} dòng"}]
    out.append({"name": "complete", "ok": not truncated,
                "detail": "Kết quả bị cắt theo giới hạn số dòng." if truncated else "Đủ toàn bộ kết quả."})
    if measures:
        nulls = sum(1 for r in rows if _num(r.get(measures[0]["name"])) is None)
        out.append({"name": "measure_nulls", "ok": nulls == 0, "detail": f"{nulls} dòng không có giá trị"})
    if tcol is not None:
        blank = sum(1 for r in rows if r.get(tcol["name"]) in (None, ""))
        out.append({"name": "time_nulls", "ok": blank == 0, "detail": f"{blank} dòng thiếu thời gian"})
    return out


#: Analyst filter operator -> the chart contract's operator (chart_contracts._OPERATOR_MAP).
#: A saved chart's base filters are applied on every surface and refused, never
#: dropped, when they cannot be applied (enforce_no_hard_dropped_filters).
_CHART_OPS = {"eq": "eq", "ne": "neq", "in": "in", "not_in": "not_in",
              "gt": "gt", "gte": "gte", "lt": "lt", "lte": "lte"}


def chart_filters(plan) -> Optional[list[dict]]:
    """The plan's filters as chart base filters that select EXACTLY the same rows, or
    None when one of them has no exact chart equivalent (the draft is then withheld)."""
    out = []
    for ref, cond in plan.filters.items():
        op, value = cond.get("operator"), cond.get("value")
        if op == "date_range" and isinstance(value, dict):
            # [from, to) on a certified DATE field == BETWEEN from AND to-1 day (inclusive),
            # the same conversion the governed query itself applies.
            try:
                last = (date.fromisoformat(str(value["to"])) - timedelta(days=1)).isoformat()
                first = date.fromisoformat(str(value["from"])).isoformat()
            except (KeyError, ValueError):
                return None
            out.append({"field": ref, "semanticField": ref, "operator": "between", "value": [first, last]})
        elif op in _CHART_OPS:
            if op in ("in", "not_in") and not isinstance(value, list):
                value = [value]
            out.append({"field": ref, "semanticField": ref, "operator": _CHART_OPS[op], "value": value})
        else:
            return None
    return out


def chart_draft(plan, title: str, *, rows: Optional[list] = None, columns: Optional[list] = None) -> tuple:
    """(draft, reason): a chart config for the EXISTING chart API (POST /charts) that
    reproduces the answer EXACTLY, or (None, why not). The person saves it with their
    own rights; the Analyst never saves on their behalf."""
    filters = chart_filters(plan)
    if filters is None:
        return None, "Câu trả lời có bộ lọc mà biểu đồ chưa biểu diễn chính xác được, nên không đề xuất lưu."
    limit_style = {}
    if plan.limit:
        # A chart cuts with SQL LIMIT on its FIRST metric: equal to the answer only for
        # one metric, one breakdown, no tie at the cut and no unknown (NULL) value.
        m = next((c["name"] for c in (columns or []) if c["role"] == "measure"), None)
        vals = [r.get(m) for r in rows or []] if m else []
        direction = next((s.get("direction") for s in plan.sorts if s.get("field") in plan.measures), "desc")
        if (len(plan.measures) != 1 or len(plan.dimensions) != 1 or plan.time_grains
                or any(v is None for v in vals) or len(vals) > plan.limit):
            return None, ("Câu trả lời xếp hạng có giá trị bằng nhau tại ngưỡng hoặc giá trị không xác định; "
                          "biểu đồ cắt bằng LIMIT sẽ khác câu trả lời nên không đề xuất lưu.")
        limit_style = {"dataLimit": int(plan.limit), "dataLimitDirection": "bottom" if direction == "asc" else "top"}
    time_ref = next(iter(plan.time_grains), None)
    others = [d for d in plan.dimensions if d != time_ref]
    metrics = [{"field": m, "agg": "auto"} for m in plan.measures[:1]]
    if len(others) > 1 or len(plan.measures) > 1:
        # Browser acceptance: "doanh số theo vùng VÀ kênh hằng quý" drafted a LINE
        # by region only - the chart said less than the answer. A shape a line or
        # bar cannot carry whole is drafted as a TABLE of every answered column.
        chart_type = "TABLE"
        role = {"selectedColumns": [*plan.dimensions, *plan.measures],
                "metrics": [{"field": m, "agg": "auto"} for m in plan.measures]}
        if time_ref:
            role["timeGrains"] = {time_ref: plan.time_grains[time_ref]}
    elif time_ref:
        chart_type = "LINE"
        role = {"metrics": metrics, "dimension": time_ref, "timeField": time_ref,
                "timeGrains": {time_ref: plan.time_grains[time_ref]}}
        if others:
            role["breakdown"] = others[0]
    elif others:
        chart_type = "BAR"
        role = {"metrics": metrics, "dimension": others[0]}
    else:
        chart_type = "KPI"
        role = {"metrics": metrics}
    return {
        "name": title[:140], "chart_type": chart_type, "dataset_table_id": plan.explore.dataset_table_id,
        "config": {"chartType": chart_type, "queryMode": "generated", "roleConfig": role,
                   "generatedRoleConfig": role, "customRoleConfig": {"metrics": []}, "filters": filters,
                   "baseFilters": filters, "styleConfig": {"chartTitle": title[:140], **limit_style}},
    }, None
