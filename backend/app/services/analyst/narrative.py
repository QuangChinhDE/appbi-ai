"""The answer's words, computed from the governed rows — not written by a model.

Every number in the narrative is read from the result grid GQS returned, so an
answer can be checked against its own table (and an independent oracle can
recompute it). A model never states a figure here; that is what removes the
hallucinated-number failure mode from the first release.

Also: the result checks (`checks`) and the Chart Draft the answer proposes.
"""
from __future__ import annotations

from collections import OrderedDict, defaultdict
from typing import Any, Optional

RECENT = 3  # "recent" = the last three periods present in the data


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


def _period(v: Any) -> str:
    s = str(v)
    return s[:7] if len(s) >= 7 and s[4] == "-" else s[:10]


def describe(columns: list[dict], rows: list[dict], *, time_ref: Optional[str], truncated: bool) -> dict:
    """columns: [{name, ref, role, label}] in result order."""
    measures = [c for c in columns if c["role"] == "measure"]
    dims = [c for c in columns if c["role"] == "dimension"]
    time_col = next((c for c in dims if c["ref"] == time_ref), None) if time_ref else None
    cat_col = next((c for c in dims if c is not time_col), None)
    checks = _checks(rows, measures, time_col, truncated)
    if not rows or not measures:
        return {"headline": "Không có dữ liệu cho câu hỏi này trong phạm vi được phép.", "bullets": [],
                "facts": [], "checks": checks}
    m = measures[0]
    if time_col is not None:
        return _over_time(rows, m, time_col, cat_col, checks)
    if cat_col is not None:
        return _ranking(rows, m, cat_col, checks)
    total = _num(rows[0].get(m["name"]))
    return {"headline": f"{m['label']}: {fmt(total)}.", "bullets": [],
            "facts": [{"claim": m["label"], "value": total}], "checks": checks}


def _over_time(rows, m, tcol, ccol, checks) -> dict:
    series: dict[str, "OrderedDict[str, float]"] = defaultdict(OrderedDict)
    periods: list[str] = []
    for r in rows:
        p = _period(r.get(tcol["name"]))
        if p not in periods:
            periods.append(p)
        key = str(r.get(ccol["name"])) if ccol else m["label"]
        series[key][p] = (series[key].get(p) or 0.0) + (_num(r.get(m["name"])) or 0.0)
    periods.sort()
    window = periods[-RECENT:]
    facts, bullets = [], []
    totals = [sum(s.get(p, 0.0) for s in series.values()) for p in window]
    first, last = window[0], window[-1]
    change = pct(totals[0], totals[-1])
    headline = (f"{m['label']} {first} → {last}: {fmt(totals[0])} → {fmt(totals[-1])}"
                + (f" ({change:+.1f}%)." if change is not None else "."))
    facts.append({"claim": f"total {first}", "value": totals[0]})
    facts.append({"claim": f"total {last}", "value": totals[-1]})
    if ccol and len(window) >= 2:
        moves = []
        for k, s in series.items():
            a, b = s.get(first), s.get(last)
            if a is None and b is None:
                continue
            moves.append((k, a or 0.0, b or 0.0, (b or 0.0) - (a or 0.0), pct(a, b)))
        moves.sort(key=lambda x: x[3], reverse=True)
        for k, a, b, d, p in moves[:3]:
            if d > 0:
                bullets.append(f"{k}: tăng {fmt(d)} ({fmt(a)} → {fmt(b)}" + (f", {p:+.1f}%)" if p is not None else ")"))
                facts.append({"claim": f"{k} change {first}->{last}", "value": d})
        for k, a, b, d, p in sorted(moves, key=lambda x: x[3])[:3]:
            if d < 0:
                bullets.append(f"{k}: giảm {fmt(-d)} ({fmt(a)} → {fmt(b)}" + (f", {p:+.1f}%)" if p is not None else ")"))
                facts.append({"claim": f"{k} change {first}->{last}", "value": d})
        lead = max(series.items(), key=lambda kv: kv[1].get(last, 0.0))
        bullets.append(f"Lớn nhất kỳ {last}: {lead[0]} ({fmt(lead[1].get(last, 0.0))}).")
    note = (f"“Gần đây” được hiểu là {len(window)} kỳ cuối có dữ liệu ({first} → {last}); "
            f"dữ liệu trải từ {periods[0]} đến {periods[-1]}.")
    return {"headline": headline, "bullets": bullets, "facts": facts, "checks": checks, "note": note,
            "periods": {"first": periods[0], "last": periods[-1], "window": window}}


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
    if time_ref:
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
        "name": title[:120], "chart_type": chart_type, "dataset_table_id": plan.explore.dataset_table_id,
        "config": {"chartType": chart_type, "queryMode": "generated", "roleConfig": role,
                   "generatedRoleConfig": role, "customRoleConfig": {"metrics": []}, "filters": [],
                   "baseFilters": [], "styleConfig": {"chartTitle": title[:120]}},
    }
