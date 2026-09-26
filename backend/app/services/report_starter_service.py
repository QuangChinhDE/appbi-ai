"""Start a report from a dataset and a goal.

The user picks data and says what the report is for; this builds a first
draft of real, bound charts they then shape on the canvas (and hand to AI
Design). It is NOT a second report system: every chart is created through
`ChartService.create` exactly as the Explore editor would, the dashboard is an
ordinary dashboard, and nothing here renders anything.

How a candidate becomes a chart:

  1. candidates are enumerated from the dataset's SEMANTIC MODEL — its declared
     measures (with their formats and aggregation) and dimensions (time vs
     category) — never from raw column names or guesses;
  2. every candidate is RUN through the chart engine (`preview_chart_data`,
     the path saved charts use) and kept only if it returns rows with a number:
     a measure that cannot reach a dimension, or a series with no data, never
     becomes a tile;
  3. a model may ORDER and NAME the surviving candidates for the goal — by id,
     from the list it was given — and never invents a field. Without a model
     the deterministic ranking is used, so the feature works offline.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

ADDITIVE = {"sum", "count", "count_distinct"}
MAX_KPIS = 4
MAX_TIME = 2
MAX_CATEGORY = 3
PAGE = "page-1"
MAX_DATE_AXES = 2
MAX_CATEGORY_AXES = 8
#: Wall-clock budget for running candidates; what ran by then is what is kept.
PROBE_BUDGET_S = 40


def _is_date(dim: Dict[str, Any]) -> bool:
    t = str(dim.get("type") or "").lower()
    return t in ("date", "datetime", "timestamp", "time")


def _label(item: Dict[str, Any]) -> str:
    raw = str(item.get("label") or "").strip()
    name = str(item.get("name") or "")
    if raw and raw != name:
        return raw
    words = name.replace("_", " ").strip()
    words = re.sub(r"\b(english|name)\b", "", words).strip() or words
    return words[:1].upper() + words[1:]


def _id_like(dim: Dict[str, Any]) -> bool:
    name = str(dim.get("name") or "").lower()
    return name == "id" or name.endswith("_id") or name.endswith("_uuid") or "zip" in name or "prefix" in name


def _measure_rank(m: Dict[str, Any]) -> int:
    """Headline measures first: money, then ratios, then volumes."""
    kind = str(((m.get("format") or {}) if isinstance(m.get("format"), dict) else {}).get("kind") or "")
    mtype = str(m.get("type") or "").lower()
    if kind == "currency" and mtype in ("sum", "formula"):
        return 0 if mtype == "sum" else 2
    if kind == "percent" or mtype == "formula":
        return 3
    if mtype == "count_distinct":
        return 1
    if mtype in ("sum", "count"):
        return 4
    return 5


def _category_rank(d: Dict[str, Any]) -> int:
    n = str(d.get("name") or "").lower()
    for i, good in enumerate(("english", "category", "state", "region", "type", "status", "channel", "segment")):
        if good in n:
            return i
    if "city" in n or "name" in n:
        return 20  # usually thousands of values
    return 10


_NUMERIC_TYPES = ("number", "numeric", "integer", "int", "float", "double", "decimal", "bigint", "real")


def _is_numeric(d: Dict[str, Any]) -> bool:
    return str(d.get("type") or "").lower() in _NUMERIC_TYPES


def enumerate_candidates(model: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every chart the model can support, before any is run."""
    views = [v for v in (model.get("views") or []) if not v.get("system_managed") and v.get("dataset_table_id")]
    measures: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    date_dims: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    cat_dims: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    for v in views:
        for m in v.get("measures") or []:
            if isinstance(m, dict) and m.get("name") and not m.get("hidden"):
                measures.append((v, m))
        for d in v.get("dimensions") or []:
            if not isinstance(d, dict) or not d.get("name") or d.get("hidden") or _id_like(d):
                continue
            if _is_date(d):
                date_dims.append((v, d))
            elif not _is_numeric(d):
                # A numeric column ("revenue") is a measure's input, not a
                # breakdown: "Revenue by revenue" is one bar per amount.
                cat_dims.append((v, d))

    # Bound the search before anything runs: the likeliest time axes first
    # (an order/creation date before an estimated/approval one) and at most a
    # few of each per measure. The engine still decides what is valid.
    def date_rank(pair):
        n = str(pair[1].get("name") or "").lower()
        score = 0
        for good in ("purchase", "created", "order", "date", "month", "day"):
            if good in n:
                score -= 2
        for weak in ("estimated", "approved", "shipping", "limit", "answer", "carrier"):
            if weak in n:
                score += 3
        return (score, n)

    date_dims = sorted(date_dims, key=date_rank)[:MAX_DATE_AXES]
    cat_dims = sorted(cat_dims, key=lambda pair: _category_rank(pair[1]))[:MAX_CATEGORY_AXES]
    measures = sorted(measures, key=lambda pair: _measure_rank(pair[1]))

    def ref(v, item):
        return f"{v['name']}.{item['name']}"

    out: List[Dict[str, Any]] = []
    for v, m in measures:
        out.append({"kind": "kpi", "type": "KPI", "table": v["dataset_table_id"],
                    "role": {"metrics": [{"field": ref(v, m), "agg": "auto"}]},
                    "title": _label(m), "measure": _label(m), "measure_type": str(m.get("type") or ""),
                    "rank": _measure_rank(m)})
    for v, m in measures:
        additive = str(m.get("type") or "").lower() in ADDITIVE or m.get("type") == "formula"
        for dv, d in date_dims:
            field = ref(dv, d)
            out.append({"kind": "time", "type": "TIME_SERIES", "table": v["dataset_table_id"],
                        "role": {"metrics": [{"field": ref(v, m), "agg": "auto"}], "timeField": field,
                                 "dimension": field, "timeGrains": {field: "month"}},
                        "title": f"{_label(m)} by month", "measure": _label(m), "additive": additive,
                        "rank": _measure_rank(m)})
        for cv, d in cat_dims:
            out.append({"kind": "category", "type": "BAR", "table": v["dataset_table_id"],
                        "role": {"metrics": [{"field": ref(v, m), "agg": "auto"}], "dimension": ref(cv, d)},
                        "style": {"dataLimit": 10, "dataLimitDirection": "top"},
                        "title": f"{_label(m)} by {_label(d).lower()}", "measure": _label(m),
                        "dimension_label": _label(d), "rank": _measure_rank(m) * 30 + _category_rank(d)})
    for i, c in enumerate(out):
        c["id"] = f"c{i + 1}"
    return out


def _runs(db: Session, cand: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Run a candidate through the chart engine; None when it has no data."""
    from app.services.chart_service import ChartService

    cfg = {"chartType": cand["type"], "queryMode": "generated", "roleConfig": cand["role"],
           "generatedRoleConfig": cand["role"], "styleConfig": dict(cand.get("style") or {})}
    try:
        result = ChartService.preview_chart_data(db, cand["table"], cand["type"], cfg)
    except Exception as exc:  # unreachable dimension, engine refusal — not a tile
        db.rollback()
        logger.debug("report starter: candidate %s refused: %s", cand["id"], exc)
        return None
    rows = result.get("data") or []
    metric = cand["role"]["metrics"][0]["field"]
    numeric = [r for r in rows if isinstance(r, dict) and isinstance(r.get(metric), (int, float))]
    if not numeric:
        return None
    return {"rows": len(rows), "distinct": len({str(r.get(cand['role'].get('dimension'))) for r in rows})}


def _deterministic_order(cands: List[Dict[str, Any]], spares: bool = False) -> List[str]:
    """Importance order: headline measures as KPIs, the leading measures over
    time, the most readable breakdowns. With `spares`, everything in that order."""
    ranked = sorted(cands, key=lambda c: (c.get("rank", 9), c["id"]))
    if spares:
        return [c["id"] for c in ranked]
    pick: List[Dict[str, Any]] = []
    for kind, cap in (("kpi", MAX_KPIS), ("time", MAX_TIME), ("category", MAX_CATEGORY)):
        seen = set()
        for c in ranked:
            if c["kind"] != kind or len([p for p in pick if p["kind"] == kind]) >= cap:
                continue
            key = c["measure"] if kind != "category" else c.get("dimension_label")
            if key in seen:
                continue
            seen.add(key)
            pick.append(c)
    return [c["id"] for c in pick]


def _model_order(goal: str, cands: List[Dict[str, Any]]) -> Optional[List[Dict[str, str]]]:
    """Ask a model to choose and name charts for the goal, by id. None → fallback."""
    try:
        from app.services.llm_client import LLMClient
    except Exception:
        return None
    ranked = sorted(cands, key=lambda c: (c.get("rank", 9), c["id"]))[:120]
    listing = "\n".join(f"{c['id']}: {c['type']} — {c['title']}" for c in ranked)
    prompt = (
        f"GOAL OF THE REPORT: {goal.strip()[:600]}\n\n"
        f"CANDIDATE CHARTS (bound to the dataset; each will be run before it is kept):\n{listing}\n\n"
        "Choose at most 4 KPI and at most 5 other charts that serve the goal best, in reading order. "
        "You may give each a clearer title in plain words (no digits). Use only ids from the list. "
        'Return JSON: {"charts": [{"id": "c1", "title": "..."}], "name": "a short report name"}'
    )
    result = LLMClient.complete_json(prompt=prompt, system="You design BI reports. Reply with JSON only.", max_tokens=700)
    if not isinstance(result, dict) or not isinstance(result.get("charts"), list):
        return None
    known = {c["id"] for c in cands}
    out = []
    for item in result["charts"]:
        if isinstance(item, dict) and item.get("id") in known:
            title = str(item.get("title") or "").strip()
            out.append({"id": item["id"], "title": "" if re.search(r"\d", title) else title[:80]})
    if result.get("name") and isinstance(result["name"], str) and not re.search(r"\d", result["name"]):
        out.append({"id": "__name__", "title": result["name"][:120]})
    return out or None


def _layout(kind: str, index_in_kind: int, count_in_kind: int, cursor: Dict[str, int]) -> Dict[str, Any]:
    """A plain starter grid the user (or a design direction) reshapes."""
    if kind == "kpi":
        w = 36 // max(1, count_in_kind)
        return {"x": index_in_kind * w, "y": cursor.get("top", 0), "w": w, "h": 6}
    if kind == "table":
        if cursor["col"] == 1:  # an odd breakdown left half a row open
            cursor["y"] += 14
            cursor["col"] = 0
        lay = {"x": 0, "y": cursor["y"], "w": 36, "h": 14}
        cursor["y"] += 14
        return lay
    y = cursor["y"]
    if kind == "time":
        lay = {"x": 0, "y": y, "w": 36, "h": 14}
        cursor["y"] += 14
        return lay
    col = cursor["col"]
    if col == 0 and index_in_kind == count_in_kind - 1:
        # The last of an odd number of breakdowns takes the row, not half of it.
        cursor["y"] += 14
        return {"x": 0, "y": y, "w": 36, "h": 14}
    lay = {"x": col * 18, "y": y, "w": 18, "h": 14}
    if col == 1:
        cursor["y"] += 14
    cursor["col"] = 1 - col
    return lay


def build_report_starter(db: Session, *, dataset_id: int, goal: str, name: Optional[str], owner_id: Any) -> Dict[str, Any]:
    """Create a draft report of real charts for `goal`. Returns ids + a trace."""
    from app.models.models import Chart, Dashboard, DashboardChart
    from app.schemas.schemas import ChartCreate
    from app.services.chart_service import ChartService
    from app.services.dataset_model_service import get_dataset_model

    started = time.time()
    model = get_dataset_model(db, dataset_id)
    if not model:
        raise ValueError("This dataset has no semantic model yet — open it once in Datasets to build one.")
    cands = enumerate_candidates(model)
    by_id = {c["id"]: c for c in cands}
    order = _model_order(goal, cands) if goal.strip() else None
    source = "model" if order else "rules"
    report_name = next((o["title"] for o in (order or []) if o["id"] == "__name__"), None)
    titles = {o["id"]: o.get("title") or "" for o in (order or []) if o["id"] in by_id}
    wanted = [by_id[i] for i in titles] or [by_id[i] for i in _deterministic_order(cands)]
    # Backfill pool: the deterministic ranking, so a refused pick is replaced by
    # the next best of the SAME kind rather than leaving a hole.
    pool = [by_id[i] for i in _deterministic_order(cands, spares=True)]
    limits = {"kpi": MAX_KPIS, "time": MAX_TIME, "category": MAX_CATEGORY}
    chosen: List[Tuple[Dict[str, Any], str]] = []
    probed = 0
    tried = set()
    for c in wanted + pool:
        if c["id"] in tried:
            continue
        tried.add(c["id"])
        if sum(1 for x, _ in chosen if x["kind"] == c["kind"]) >= limits[c["kind"]]:
            continue
        # One view of a measure per kind: "Revenue by month" on the purchase
        # date and again on the delivery date is the same line twice.
        if c["kind"] != "category" and any(x["kind"] == c["kind"] and x["measure"] == c["measure"] for x, _ in chosen):
            continue
        if time.time() - started > PROBE_BUDGET_S:
            break
        probed += 1
        if _runs(db, c):
            chosen.append((c, titles.get(c["id"], "")))
    if not chosen:
        raise ValueError("None of this dataset's measures returned data; nothing to put in a report.")
    kind_order = {"kpi": 0, "time": 1, "category": 2}
    chosen.sort(key=lambda pair: kind_order[pair[0]["kind"]])
    kept = [c for c, _ in chosen]
    # Detail: the lead breakdown as a table of the headline measures, run like
    # every other chart; only when the dataset supports one.
    detail = _detail_table(db, kept) if time.time() - started <= PROBE_BUDGET_S else None
    if detail:
        chosen.append((detail, ""))

    dash = Dashboard(name=_unique_name(db, name or report_name or "New report"),
                     description=goal.strip()[:500] or None, owner_id=owner_id,
                     pages_config=[{"id": PAGE, "name": "Overview"}], theme_config={})
    db.add(dash)
    db.flush()
    counts: Dict[str, int] = {}
    for c, _t in chosen:
        counts[c["kind"]] = counts.get(c["kind"], 0) + 1
    seen: Dict[str, int] = {}
    top = HEADLINE_H
    cursor = {"y": top + (6 if counts.get("kpi") else 0), "col": 0, "top": top}
    created = []
    placed: Dict[str, List[int]] = {}
    for c, title in chosen:
        k = c["kind"]
        idx = seen.get(k, 0)
        seen[k] = idx + 1
        shown = title or c["title"]
        cfg = {"chartType": c["type"], "queryMode": "generated", "roleConfig": c["role"],
               "generatedRoleConfig": c["role"], "customRoleConfig": {"metrics": []},
               "filters": [], "baseFilters": [], "dataset_id": dataset_id,
               "styleConfig": {"chartTitle": shown, **(c.get("style") or {})}}
        chart = ChartService.create(db, ChartCreate(name=_unique_chart(db, f"{dash.name} · {shown}"),
                                                    chart_type=c["type"], dataset_table_id=c["table"], config=cfg),
                                    owner_id=owner_id)
        lay = _layout(k, idx, counts[k], cursor)
        dc = DashboardChart(dashboard_id=dash.id, chart_id=chart.id, widget_type="chart",
                            layout={**lay, "gv": 2, "pageId": PAGE})
        db.add(dc)
        db.flush()
        placed.setdefault(k, []).append(dc.id)
        created.append({"chart_id": chart.id, "type": c["type"], "title": shown})

    # The report's opening: what it is for (the author's own words, when given)
    # and the lead findings — bound by key to the charts above, computed live,
    # so no number here is written by anyone.
    headline = _headline_items(placed)
    if headline or goal.strip():
        db.add(DashboardChart(
            dashboard_id=dash.id, chart_id=None, widget_type="narrative",
            widget_config={"variant": "headline", "items": headline, "origin": "ai",
                           **({"prose": goal.strip()[:280]} if goal.strip() else {})},
            layout={"x": 0, "y": 0, "w": 36, "h": HEADLINE_H, "gv": 2, "pageId": PAGE},
        ))
    slicer = _slicer_for(model, kept, dataset_id)
    if slicer:
        dash.slicers_config = [slicer]
    db.commit()
    return {"dashboard_id": dash.id, "name": dash.name, "charts": created, "source": source,
            "candidates": len(cands), "probed": probed, "headline": [i["finding"] for i in headline],
            "slicer": slicer["fieldKey"] if slicer else None, "detail_table": bool(detail),
            "elapsed_ms": round((time.time() - started) * 1000)}


HEADLINE_H = 5


def _headline_items(placed: Dict[str, List[int]]) -> List[Dict[str, str]]:
    """Finding keys for the opening block: how the lead series changed against
    its comparable period (else its trend) and the leader of the lead breakdown.
    Keys only — the sentence and its numbers are computed from the rendered
    charts, and a finding the data does not support is not stated."""
    items: List[Dict[str, str]] = []
    series = (placed.get("time") or [None])[0]
    breakdown = (placed.get("category") or [None])[0]
    if series is not None:
        items.append({"finding": f"period_comparison:{series}"})
        items.append({"finding": f"trend:{series}"})
    if breakdown is not None:
        items.append({"finding": f"top_item:{breakdown}"})
    return items


def _detail_table(db: Session, kept: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The lead breakdown as a table of up to three headline measures."""
    lead = next((c for c in kept if c["kind"] == "category"), None)
    if not lead:
        return None
    metrics = [lead["role"]["metrics"][0]]
    for c in kept:
        m = c["role"]["metrics"][0]
        if c["kind"] == "kpi" and m["field"] != metrics[0]["field"] and len(metrics) < 3:
            metrics.append(m)
    for attempt in (metrics, metrics[:1]):
        cand = {"id": f"{lead['id']}-table", "kind": "table", "type": "TABLE", "table": lead["table"],
                "role": {"metrics": attempt, "dimension": lead["role"]["dimension"]},
                "title": f"{lead.get('dimension_label') or 'Detail'} — detail", "measure": lead["measure"],
                "style": {"dataLimit": 25}}
        if _runs(db, cand):
            return cand
    return None


def _slicer_for(model: Dict[str, Any], kept: List[Dict[str, Any]], dataset_id: int) -> Optional[Dict[str, Any]]:
    """A dropdown slicer on the lead breakdown's dimension (every chart filters by it)."""
    lead = next((c for c in kept if c["kind"] == "category"), None)
    if not lead:
        return None
    ref = lead["role"]["dimension"]
    view_name, _, dim_name = ref.partition(".")
    view = next((v for v in model.get("views") or [] if v.get("name") == view_name), None)
    dim = next((d for d in (view or {}).get("dimensions") or [] if d.get("name") == dim_name), None)
    if not dim:
        return None
    return {"id": f"slicer-{dim_name}", "field": str(dim.get("sql") or dim_name), "fieldKey": ref, "semanticField": ref,
            "datasetId": dataset_id, "type": "dropdown", "operator": "in", "value": [],
            "label": lead.get("dimension_label") or _label(dim), "scope": "all"}


def _unique_name(db: Session, base: str) -> str:
    from app.models.models import Dashboard
    name, n = base, 2
    while db.query(Dashboard).filter(Dashboard.name == name).first() is not None:
        name, n = f"{base} ({n})", n + 1
    return name


def _unique_chart(db: Session, base: str) -> str:
    from sqlalchemy import func

    from app.models.models import Chart
    name, n = base[:240], 2
    while db.query(Chart).filter(func.lower(Chart.name) == name.lower()).first() is not None:
        name, n = f"{base[:230]} ({n})", n + 1
    return name
