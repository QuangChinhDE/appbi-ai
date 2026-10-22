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
             period: Optional[tuple[date, date]] = None) -> dict:
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
    if truncated:
        # Rows stop at the bound mid-way (a period or a ranking cut short): any
        # trend, ranking or total read from them would be an artefact of the cut.
        return {"headline": (f"Kết quả vượt giới hạn {len(rows)} dòng nên chưa kết luận về {m['label']}. "
                             "Hãy thu hẹp câu hỏi (ví dụ theo nhóm thay vì từng mục, hoặc một khoảng thời gian)."),
                "bullets": [], "facts": [], "checks": checks, "incomplete": True}
    if time_col is not None:
        return _over_time(rows, m, time_col, cat_col, checks, grain or "month", today or date.today(), period)
    if cat_col is not None:
        return _ranking(rows, m, cat_col, checks)
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


def _over_time(rows, m, tcol, ccol, checks, grain: str, today: date,
               period: Optional[tuple[date, date]] = None) -> dict:
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
        key = str(r.get(ccol["name"])) if ccol else m["label"]
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
    complete = [p for p in calendar if p not in partial]
    notes = []
    if partial:
        notes.append(f"Kỳ {', '.join(_label(p, grain) for p in partial)} chưa kết thúc nên không dùng để so sánh.")
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
    t0, t1 = total(first), total(last)
    L0, L1 = _label(first, grain), _label(last, grain)
    if len(window) < 2:
        headline = f"{m['label']} {word} {L1}: {fmt(t1)}. Mới có một {word} đầy đủ nên chưa nói về xu hướng."
    elif t0 is None or t1 is None:
        headline = (f"{m['label']} {L0} → {L1}: {fmt(t0)} → {fmt(t1)}. "
                    "Thiếu dữ liệu ở kỳ đầu hoặc kỳ cuối nên không tính mức thay đổi.")
    else:
        change = pct(t0, t1)
        headline = (f"{m['label']} {L0} → {L1}: {fmt(t0)} → {fmt(t1)}"
                    + (f" ({change:+.1f}%)." if change is not None else "."))
    facts = [{"claim": f"total {L0}", "value": t0}, {"claim": f"total {L1}", "value": t1}]
    bullets = []
    if ccol and len(window) == 1:
        # One complete period asked for ("theo vùng năm 2025"): rank the groups in it.
        known = sorted(((k, s[last]) for k, s in series.items() if s.get(last) is not None),
                       key=lambda kv: kv[1], reverse=True)
        for k, v in known[:5]:
            bullets.append(f"{k}: {fmt(v)}" + (f" ({v / t1 * 100:.1f}%)" if t1 else ""))
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
            lead = max(known, key=lambda kv: kv[1])
            bullets.append(f"Lớn nhất {word} {L1}: {lead[0]} ({fmt(lead[1])}).")
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


def _ranking(rows, m, ccol, checks) -> dict:
    vals = [(str(r.get(ccol["name"])), _num(r.get(m["name"])) or 0.0) for r in rows]
    vals.sort(key=lambda kv: kv[1], reverse=True)
    total = sum(v for _, v in vals) or None
    bullets = [f"{k}: {fmt(v)}" + (f" ({v / total * 100:.1f}%)" if total else "") for k, v in vals[:5]]
    return {"headline": f"{m['label']} cao nhất: {vals[0][0]} ({fmt(vals[0][1])}).", "bullets": bullets,
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


def chart_draft(plan, title: str) -> dict:
    """A chart config for the EXISTING chart API (POST /charts): the person saves
    it with their own rights; the Analyst never saves on their behalf."""
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
                   "generatedRoleConfig": role, "customRoleConfig": {"metrics": []}, "filters": [],
                   "baseFilters": [], "styleConfig": {"chartTitle": title[:140]}},
    }
