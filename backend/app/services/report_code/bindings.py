"""Report data: bindings, viewer filters, and the DTO the sandbox receives.

A binding is a SAVED CHART — the same Chart Configuration + Query Core every
dashboard tile uses. New bindings are made exactly the way the report starter makes
its charts: candidates are enumerated from the dataset's semantic model, every pick is
RUN before it is kept, and the chart is created through `ChartService.create`. Nothing
here writes SQL or picks a field the semantic model does not declare.

The sandbox never sees a chart id, a dataset id, a field reference, SQL or debug. It
receives `ReportDataDTO`: rows re-keyed to opaque per-binding keys (d0, m0 …) plus
display descriptors. Which chart a binding reads and which filters a viewer may set
are resolved here, on the server, on every request.
"""
from __future__ import annotations

import datetime as _dt
import logging
import time
from decimal import Decimal
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

MAX_ROWS = 2000
from app.core.config import settings as _settings

# Page size limits come from settings (REPORT_MAX_*): an operator raises them in .env.
MAX_BINDINGS = int(_settings.REPORT_MAX_BINDINGS)
MAX_FILTERS = int(_settings.REPORT_MAX_FILTERS)
MAX_FILTER_VALUES = 200
PROBE_BUDGET_S = int(_settings.REPORT_PROBE_BUDGET_S)

_DATE_TYPES = {"date", "datetime", "timestamp", "time"}
_NUMERIC_TYPES = {"number", "numeric", "integer", "int", "float", "double", "decimal", "bigint", "real"}
_KIND_BY_TYPE = {"KPI": "kpi", "TIME_SERIES": "time", "LINE": "time", "AREA": "time", "BAR": "category",
                 "HORIZONTAL_BAR": "category", "PIE": "category", "DONUT": "category", "TABLE": "table"}


# ── Semantic catalog ──────────────────────────────────────────────────────────

def load_model(db: Session, dataset_id: int) -> Dict[str, Any]:
    from app.services.dataset_model_service import get_dataset_model

    model = get_dataset_model(db, dataset_id)
    if not model or not model.get("views"):
        raise ValueError("Dataset này chưa có semantic model — mở nó một lần trong Datasets để tạo.")
    return model


def field_meta(model: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Every declared measure and dimension by `view.field`, with its meaning."""
    from app.services.report_starter_service import _label

    out: Dict[str, Dict[str, Any]] = {}
    for v in model.get("views") or []:
        vname = v.get("name")
        for m in v.get("measures") or []:
            if isinstance(m, dict) and m.get("name"):
                # The semantic model's own format, never guessed from a label: a percent
                # measure holds a ratio (the platform convention), as Manual renders it.
                fmt = m.get("format") if isinstance(m.get("format"), dict) else None
                out[f"{vname}.{m['name']}"] = {
                    "label": _label(m), "role": "measure", "kind": "number",
                    "aggregation": str(m.get("type") or "").lower() or None, "format": _public_format(fmt),
                }
        for d in v.get("dimensions") or []:
            if isinstance(d, dict) and d.get("name"):
                t = str(d.get("type") or "").lower()
                out[f"{vname}.{d['name']}"] = {
                    "label": _label(d), "role": "dimension",
                    "kind": "date" if t in _DATE_TYPES else ("number" if t in _NUMERIC_TYPES else "string"),
                }
    return out


def _public_format(fmt: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not fmt:
        return None
    keep = {k: fmt[k] for k in ("kind", "currency", "symbol", "decimals") if k in fmt and fmt[k] not in (None, "")}
    return keep or None


def filter_dimensions(model: Dict[str, Any], dataset_id: int) -> List[Dict[str, Any]]:
    """Dimensions a viewer may filter by: declared, visible, not identifiers."""
    from app.services.report_starter_service import _category_rank, _id_like, _label

    cats, dates = [], []
    for v in model.get("views") or []:
        if v.get("system_managed") or not v.get("dataset_table_id"):
            continue
        for d in v.get("dimensions") or []:
            if not isinstance(d, dict) or not d.get("name") or d.get("hidden") or _id_like(d):
                continue
            t = str(d.get("type") or "").lower()
            if t in _NUMERIC_TYPES:
                continue
            entry = {"label": _label(d), "kind": "date" if t in _DATE_TYPES else "category",
                     "fieldKey": f"{v['name']}.{d['name']}", "field": str(d.get("sql") or d["name"]),
                     "datasetId": dataset_id, "_rank": _category_rank(d)}
            (dates if entry["kind"] == "date" else cats).append(entry)
    cats.sort(key=lambda e: (e["_rank"], e["label"]))

    def date_rank(e):
        n = e["fieldKey"].lower()
        score = -sum(2 for good in ("purchase", "created", "order", "date", "month", "day") if good in n)
        score += sum(3 for weak in ("estimated", "approved", "shipping", "limit", "answer", "carrier") if weak in n)
        return (score, n)

    dates.sort(key=date_rank)
    out = cats[:24] + dates[:10]
    # Two views can expose the same label ("Customer state"); say which is which.
    counts: Dict[str, int] = {}
    for e in out:
        counts[e["label"]] = counts.get(e["label"], 0) + 1
    labels = {str(v.get("name")): str(v.get("table_display_name") or v.get("label") or "") for v in model.get("views") or []}
    for e in out:
        if counts[e["label"]] > 1:
            view = e["fieldKey"].split(".")[0]
            e["label"] = f"{e['label']} ({labels.get(view) or view.replace('dataset_table_', 'bảng ')})"
    for i, e in enumerate(out):
        e.pop("_rank", None)
        e["id"] = f"f{i + 1}"
    return out


def candidates(model: Dict[str, Any]) -> List[Dict[str, Any]]:
    from app.services.report_starter_service import enumerate_candidates

    return enumerate_candidates(model)


# ── Bindings ──────────────────────────────────────────────────────────────────

def _role_config(config: Dict[str, Any]) -> Dict[str, Any]:
    for key in ("roleConfig", "generatedRoleConfig"):
        rc = config.get(key)
        if isinstance(rc, dict) and rc:
            return rc
    return {}


def describe_fields(config: Dict[str, Any], meta: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """What each result column of a chart MEANS, keyed by its `view.field` ref."""
    rc = _role_config(config or {})
    out: Dict[str, Dict[str, Any]] = {}
    grains = rc.get("timeGrains") if isinstance(rc.get("timeGrains"), dict) else {}
    dim_refs = []
    for key in ("timeField", "dimension", "breakdown", "series", "legend", "secondaryDimension"):
        v = rc.get(key)
        if isinstance(v, str) and v and v not in dim_refs:
            dim_refs.append(v)
    for v in rc.get("dimensions") or rc.get("columns") or []:
        ref = v.get("field") if isinstance(v, dict) else v
        if isinstance(ref, str) and ref and ref not in dim_refs:
            dim_refs.append(ref)
    for ref in dim_refs:
        m = dict(meta.get(ref) or {"label": ref.split(".")[-1].replace("_", " "), "kind": "string"})
        m["role"] = "dimension"
        if ref == rc.get("timeField") or ref in grains:
            m["kind"] = "date"
            m["grain"] = grains.get(ref) or "month"
        out[ref] = m
    for item in rc.get("metrics") or []:
        ref = item.get("field") if isinstance(item, dict) else item
        if isinstance(ref, str) and ref:
            m = dict(meta.get(ref) or {"label": ref.split(".")[-1].replace("_", " "), "kind": "number"})
            m["role"] = "measure"
            agg = item.get("agg") if isinstance(item, dict) else None
            if agg and agg != "auto":
                m["aggregation"] = str(agg).lower()
            out[ref] = m
    return out


def make_binding(bid: str, chart, title: str, meta: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    cfg = chart.config if isinstance(chart.config, dict) else {}
    ctype = str(getattr(chart.chart_type, "value", chart.chart_type) or cfg.get("chartType") or "")
    fields = describe_fields(cfg, meta)
    # `fields` is stored as JSONB, and Postgres REORDERS an object's keys (shorter first): the
    # chart's metric order (m0, m1, ...) must be kept explicitly or two measures swap places.
    return {"id": bid, "chart_id": chart.id, "title": (title or chart.name or "")[:160],
            "kind": _KIND_BY_TYPE.get(ctype.upper(), "category"), "fields": fields, "order": list(fields)}


def run_candidate(db: Session, cand: Dict[str, Any]) -> bool:
    """True when the candidate returns numbers. A False leaves ``why`` ("error" | "empty")
    for the import note (per thread: two imports never read each other's reasons)."""
    from app.services.report_starter_service import _runs

    why: Dict[str, Any] = {}
    ok = bool(_runs(db, cand, why))
    _last_why.value = why
    return ok


_last_why = threading.local()


def drop_note(title: str, why: Dict[str, Any]) -> str:
    """Why a place got no data: a query the system could not run is not an empty result."""
    if why.get("reason") == "error":
        return (f"Bỏ '{title}' — truy vấn bị lỗi khi chạy qua BI Core (không phải do dữ liệu rỗng). "
                "Kiểm tra Dataset (tên cột, measure, snapshot) rồi gắn lại.")
    return f"Bỏ '{title}' — truy vấn chạy được nhưng không trả về số liệu."


def create_candidate_chart(db: Session, cand: Dict[str, Any], title: str, *, owner_id, dataset_id: int, prefix: str):
    """The chart for a candidate that already ran, created as the Explore editor would."""
    from app.schemas.schemas import ChartCreate
    from app.services.chart_service import ChartService
    from app.services.report_starter_service import _unique_chart

    shown = (title or cand["title"])[:120]
    cfg = {"chartType": cand["type"], "queryMode": "generated", "roleConfig": cand["role"],
           "generatedRoleConfig": cand["role"], "customRoleConfig": {"metrics": []},
           "filters": [], "baseFilters": [], "dataset_id": dataset_id,
           "styleConfig": {"chartTitle": shown, **(cand.get("style") or {})}}
    return ChartService.create(
        db, ChartCreate(name=_unique_chart(db, f"{prefix} · {shown}"), chart_type=cand["type"],
                        dataset_table_id=cand["table"], config=cfg),
        owner_id=owner_id, commit=False)


def _localize_title(title: str) -> str:
    """Candidate titles are built in English ("Revenue by month"); the report speaks Vietnamese."""
    import re

    t = re.sub(r"\s+by month$", " theo tháng", title or "")
    return re.sub(r"\s+by\s+", " theo ", t)


def serves(db: Session, binding: Dict[str, Any], cand: Dict[str, Any]) -> bool:
    """Does this binding's chart already compute this candidate (same table, chart type
    and role config)? The match of a re-import, by meaning - not by a positional id."""
    from app.models.models import Chart

    cid = binding.get("chart_id") if isinstance(binding, dict) else None
    chart = db.get(Chart, cid) if db is not None and isinstance(cid, int) else None
    if chart is None:
        return False
    cfg = chart.config if isinstance(chart.config, dict) else {}
    ctype = str(getattr(chart.chart_type, "value", chart.chart_type) or cfg.get("chartType") or "")
    return (chart.dataset_table_id == cand.get("table") and ctype.upper() == str(cand.get("type") or "").upper()
            and (cfg.get("roleConfig") or {}) == (cand.get("role") or {}))


def next_binding_id(bindings: List[Dict[str, Any]]) -> str:
    used = {b.get("id") for b in bindings}
    n = 1
    while f"b{n}" in used:
        n += 1
    return f"b{n}"


def bind_candidates(db: Session, picks: List[Tuple[Dict[str, Any], str]], *, existing: List[Dict[str, Any]],
                    owner_id, dataset_id: int, prefix: str, meta: Dict[str, Dict[str, Any]],
                    pool: Optional[List[Dict[str, Any]]] = None, limits: Optional[Dict[str, int]] = None,
                    budget_s: float = PROBE_BUDGET_S, reuse: Optional[List[Dict[str, Any]]] = None,
                    ) -> Tuple[List[Dict[str, Any]], Dict[str, str], List[str]]:
    """Run each pick; keep what returns data; create its chart. A refused pick is
    replaced by the next pool candidate of the same kind (when a pool is given).

    `reuse`: bindings the report already had. A pick that one of them already serves
    (same table, chart type and role config) gets THAT binding and its id back - no new
    chart, no renumbering. A reused binding not in `existing` is returned as new.

    Returns (new bindings, {candidate id: binding id}, notes)."""
    started = time.time()
    notes: List[str] = []
    mapping: Dict[str, str] = {}
    out: List[Dict[str, Any]] = []
    in_existing = {b.get("id") for b in existing}
    taken: set = set()
    left = []
    for cand, title in picks:
        b = next((b for b in (reuse or []) if b.get("id") not in taken and serves(db, b, cand)), None)
        if b is None:
            left.append((cand, title))
            continue
        taken.add(b.get("id"))
        mapping[cand["id"]] = b["id"]
        if b.get("id") not in in_existing:
            out.append(b)
    picks = left
    existing = list(existing) + out
    tried = set()
    picked_ids = {c["id"] for c, _ in picks}
    queue = list(picks) + [(c, "") for c in (pool or []) if c["id"] not in picked_ids]
    kind_count: Dict[str, int] = {}
    wanted_kinds = {c["kind"] for c, _ in picks}
    # The pool only replaces picks that were refused: per kind, never more than asked.
    targets: Dict[str, int] = {}
    for c, _ in picks:
        targets[c["kind"]] = targets.get(c["kind"], 0) + 1
    room = MAX_BINDINGS - len(existing)
    kept: List[Tuple[Dict[str, Any], str]] = []
    # Run everything BEFORE creating anything: a refused run rolls the session back,
    # which would discard a chart created earlier in the same loop.
    for cand, title in queue:
        if cand["id"] in tried:
            continue
        tried.add(cand["id"])
        from_pool = cand["id"] not in picked_ids
        if from_pool and (cand["kind"] not in wanted_kinds or kind_count.get(cand["kind"], 0) >= targets.get(cand["kind"], 0)):
            continue
        if limits and kind_count.get(cand["kind"], 0) >= limits.get(cand["kind"], 99):
            continue
        if len(kept) >= room or time.time() - started > budget_s:
            # never a silent cut: name every pick left out (each of its places stays
            # unbound, which the readiness report lists and publishing refuses)
            over = [t or _localize_title(c["title"]) for c, t in queue
                    if c["id"] not in tried and c["id"] in picked_ids] + ([] if from_pool else [title or _localize_title(cand["title"])])
            over = list(dict.fromkeys(over))
            why = (f"vượt giới hạn {MAX_BINDINGS} nguồn dữ liệu của một báo cáo (REPORT_MAX_BINDINGS)"
                   if len(kept) >= room else f"hết {int(budget_s)} giây chạy thử truy vấn (REPORT_PROBE_BUDGET_S)")
            if over:
                notes.append(f"Không gắn {len(over)} dữ liệu do {why}: " + ", ".join(f"'{t}'" for t in over[:20])
                             + (f" và {len(over) - 20} dữ liệu khác" if len(over) > 20 else "")
                             + ". Các vị trí đó chưa gắn dữ liệu — báo cáo chưa xuất bản được cho đến khi gắn lại.")
            break
        _last_why.value = {}
        if not run_candidate(db, cand):
            if not from_pool:
                notes.append(drop_note(title or cand['title'], getattr(_last_why, "value", {}) or {}))
            continue
        kept.append((cand, title))
        kind_count[cand["kind"]] = kind_count.get(cand["kind"], 0) + 1

    all_bindings = list(existing)
    for cand, title in kept:
        title = title or _localize_title(cand["title"])
        chart = create_candidate_chart(db, cand, title, owner_id=owner_id, dataset_id=dataset_id, prefix=prefix)
        bid = next_binding_id(all_bindings)
        b = make_binding(bid, chart, title, meta)
        all_bindings.append(b)
        out.append(b)
        mapping[cand["id"]] = bid
    return out, mapping, notes


# ── Filters ───────────────────────────────────────────────────────────────────

def declare_filters(dims: List[Dict[str, Any]], ids: List[str]) -> List[Dict[str, Any]]:
    by_id = {d["id"]: d for d in dims}
    out = []
    for i, fid in enumerate(ids):
        d = by_id.get(fid)
        if d and len(out) < MAX_FILTERS and all(o["fieldKey"] != d["fieldKey"] for o in out):
            out.append({"key": f"f{len(out) + 1}", "label": d["label"], "kind": d["kind"],
                        "fieldKey": d["fieldKey"], "field": d["field"], "datasetId": d["datasetId"]})
    return out


def _atom_ok(v: Any) -> bool:
    return isinstance(v, (str, int, float)) and not isinstance(v, bool) and len(str(v)) <= 200


def _iso_date(v: Any) -> Optional[str]:
    if v in (None, ""):
        return None
    s = str(v)[:10]
    try:
        _dt.date.fromisoformat(s)
        return s
    except ValueError:
        raise ValueError("Ngày lọc không hợp lệ (định dạng YYYY-MM-DD).")


def clean_state(decl: List[Dict[str, Any]], state: Any) -> Dict[str, Any]:
    """A viewer's filter state, reduced to declared keys and well-formed values."""
    if not state:
        return {}
    if not isinstance(state, dict):
        raise ValueError("Bộ lọc không hợp lệ.")
    by_key = {f["key"]: f for f in decl}
    out: Dict[str, Any] = {}
    for key, value in state.items():
        f = by_key.get(key)
        if f is None:
            raise ValueError(f"Bộ lọc '{str(key)[:40]}' không có trong báo cáo.")
        if value in (None, [], ""):
            continue
        if f["kind"] == "date":
            if not isinstance(value, list) or len(value) != 2:
                raise ValueError("Bộ lọc ngày cần [từ, đến].")
            lo, hi = _iso_date(value[0]), _iso_date(value[1])
            if is_period(f):
                if not lo:
                    raise ValueError("Bộ lọc kỳ cần một tháng.")
                out[key] = _month_bounds(lo)  # a period is a whole month, whatever was sent
                continue
            if lo or hi:
                out[key] = [lo, hi]
            continue
        if not isinstance(value, list) or len(value) > MAX_FILTER_VALUES or not all(_atom_ok(v) for v in value):
            raise ValueError("Giá trị lọc không hợp lệ.")
        if f.get("single") and len(value) > 1:
            raise ValueError(f"Bộ lọc '{f['label']}' chỉ chọn một giá trị.")
        out[key] = [str(v) for v in value]
    return out


def conditions(decl: List[Dict[str, Any]], state: Dict[str, Any], *, skip: Optional[str] = None,
               enforced: Any = ()) -> List[Dict[str, Any]]:
    """Engine filter conditions, built ONLY from the report's declared filters.

    A key in `enforced` (a public link's lock / hidden constraint) carries the engine's
    authoritative marker: it is APPLIED or the query is refused - never skipped softly
    (unreachable view, no join path), which would return data wider than the link's scope.
    The same marker a Manual dashboard's locks carry (chart_contracts.AUTHORITATIVE_KEY)."""
    from app.services.chart_contracts import AUTHORITATIVE_KEY

    out = []
    by_key = {f["key"]: f for f in decl}
    enforced = set(enforced or ())
    for key, value in state.items():
        f = by_key.get(key)
        if f is None or key == skip:
            continue
        base = {"field": f["field"], "fieldKey": f["fieldKey"], "semanticField": f["fieldKey"], "datasetId": f["datasetId"]}
        if key in enforced:
            base[AUTHORITATIVE_KEY] = True
        if f["kind"] == "date":
            lo, hi = value
            if lo and hi:
                out.append({**base, "operator": "between", "value": [lo, hi]})
            elif lo:
                out.append({**base, "operator": "gte", "value": lo})
            elif hi:
                out.append({**base, "operator": "lte", "value": hi})
        else:
            out.append({**base, "operator": "in", "value": list(value)})
    return out


def _month_bounds(iso: str) -> List[str]:
    """[first day, last day] of the month of an ISO date."""
    import calendar

    y, m = int(iso[:4]), int(iso[5:7])
    return [f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{calendar.monthrange(y, m)[1]:02d}"]


def _months(db: Session, f: Dict[str, Any], decl: List[Dict[str, Any]], state: Dict[str, Any], key: str,
            enforced: Any = ()) -> List[str]:
    """The months the filter's field holds (newest first) — BI Core distinct values."""
    from app.services.dataset_model_service import get_distinct_field_values

    res = get_distinct_field_values(db, f["datasetId"], f["fieldKey"], limit=MAX_FILTER_VALUES,
                                    filters=conditions(decl, state, skip=key, enforced=enforced) or None)
    seen = set()
    for v in res.get("values") or []:
        iso = _plain(v, "date")
        if isinstance(iso, str) and len(iso) >= 7 and iso[4] == "-":
            seen.add(iso[:7] + "-01")
    return sorted(seen, reverse=True)


def is_period(f: Dict[str, Any]) -> bool:
    return f.get("kind") == "date" and f.get("grain") == "month"


# resolve_state is asked once per BINDING of the same page load (13+ concurrent requests, each
# running the same distinct query on the warehouse). One computation per (filters, state,
# enforced locks) for a short time; concurrent askers wait for it instead of repeating it.
# The result depends only on the report's declared filters and the data - never on the caller
# (every endpoint has checked the caller's rights before asking) - and a lock is part of the key.
RESOLVE_TTL_S = 30
_resolve_memo: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_resolve_locks: Dict[str, Any] = {}
_resolve_guard = __import__("threading").Lock()


def resolve_state(db: Session, decl: List[Dict[str, Any]], state: Dict[str, Any], enforced: Any = ()) -> Dict[str, Any]:
    import json as _json

    if not any(f.get("default") == "latest" or f.get("default_value") not in (None, "") for f in decl or []):
        return dict(state or {})  # nothing to resolve: no query, no memo
    key = _json.dumps([decl, state or {}, sorted(set(enforced or ()))], sort_keys=True, default=str)
    hit = _resolve_memo.get(key)
    if hit and time.time() - hit[0] < RESOLVE_TTL_S:
        return dict(hit[1])
    with _resolve_guard:
        lock = _resolve_locks.setdefault(key, __import__("threading").Lock())
    with lock:
        hit = _resolve_memo.get(key)
        if hit and time.time() - hit[0] < RESOLVE_TTL_S:
            return dict(hit[1])
        out = _resolve_state(db, decl, state, enforced)
        if len(_resolve_memo) > 512:
            _resolve_memo.clear()
        _resolve_memo[key] = (time.time(), dict(out))
    with _resolve_guard:
        _resolve_locks.pop(key, None)
    return out


def _resolve_state(db: Session, decl: List[Dict[str, Any]], state: Dict[str, Any], enforced: Any = ()) -> Dict[str, Any]:
    """THE state a report's numbers are computed with: the caller's (viewer + locks), then
    each declared default for a filter nobody set. `default: "latest"` on a month filter =
    the newest month the data holds. One function for every surface (studio /data, public
    /data, export, the AI Bot), so a headline and the numbers under it cannot disagree."""
    out = dict(state or {})
    for f in decl:
        if f["key"] in out:
            continue
        if f.get("default_value") not in (None, "") and f.get("kind") != "date":
            out[f["key"]] = [str(f["default_value"])]  # e.g. Đơn vị = "Tập đoàn" until a viewer picks one
            continue
        if f.get("default") != "latest":
            continue
        if is_period(f):
            months = _months(db, f, decl, out, f["key"], enforced)
            if months:
                out[f["key"]] = _month_bounds(months[0])
        elif f.get("kind") != "date":
            vals = filter_values(db, decl, out, f["key"], enforced=enforced)
            if vals:
                out[f["key"]] = [str(sorted(vals, key=lambda v: str(v))[-1])]
    return out


def filter_values(db: Session, decl: List[Dict[str, Any]], state: Dict[str, Any], key: str, search: str = "",
                  enforced: Any = ()) -> List[Any]:
    from app.services.dataset_model_service import get_distinct_field_values

    f = next((x for x in decl if x["key"] == key), None)
    if f is None:
        raise ValueError("Bộ lọc không có trong báo cáo.")
    if is_period(f):
        return _months(db, f, decl, state, key, enforced)  # the month list a period picker offers
    if f["kind"] == "date":
        return []
    res = get_distinct_field_values(db, f["datasetId"], f["fieldKey"], limit=MAX_FILTER_VALUES,
                                    filters=conditions(decl, state, skip=key, enforced=enforced) or None, search=(search or "")[:80] or None)
    return [v for v in (res.get("values") or []) if v is not None][:MAX_FILTER_VALUES]


# ── The DTO ───────────────────────────────────────────────────────────────────

def _plain(v: Any, kind: Optional[str]) -> Any:
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (_dt.datetime, _dt.date)):
        return v.isoformat()[:10] if kind == "date" else v.isoformat()
    if kind == "date" and isinstance(v, str) and len(v) >= 10 and v[4] == "-":
        return v[:10]
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return str(v)


def _debug_get(debug: Any, key: str) -> Any:
    if debug is None:
        return None
    return debug.get(key) if isinstance(debug, dict) else getattr(debug, key, None)


def mint_dto(db: Session, binding: Dict[str, Any], decl: List[Dict[str, Any]], state: Dict[str, Any],
             *, source_label: Optional[str] = None, public: bool = False,
             disclose: Optional[Any] = None, enforced: Any = (), limit: Optional[int] = None) -> Dict[str, Any]:
    """Run one binding through the chart engine and reduce the result to the DTO.

    The DTO carries `state`: the filter values these numbers were computed with (declared
    defaults resolved), so text bound to a filter shows the period the numbers cover.
    `disclose` limits it to the keys the reader may know (a public link's hidden lock is
    never named); None = every declared key. `enforced` = the keys that are security
    constraints (fail closed: a lock the engine cannot apply refuses the binding)."""
    from app.services.chart_contracts import AuthoritativeFilterNotApplied
    from app.services.chart_service import ChartService

    bid = binding["id"]
    state = resolve_state(db, decl, state, enforced)
    allowed = {f["key"] for f in decl} if disclose is None else set(disclose)
    base = {"bindingId": bid, "title": binding.get("title") or "", "kind": binding.get("kind") or "",
            "state": {k: v for k, v in state.items() if k in allowed}}
    conds = conditions(decl, state, enforced=enforced)
    try:
        result = ChartService.get_chart_data(db, int(binding["chart_id"]), extra_filters=conds or None,
                                             filter_context="dashboard")
    except AuthoritativeFilterNotApplied as exc:
        db.rollback()
        # names no field and no value: the constraint may be a hidden one
        return {**base, "status": "refused", "error": str(exc), "rows": [], "fields": []}
    except ValueError as exc:
        db.rollback()
        msg = "Không tải được dữ liệu cho phần này." if public else _author_error(db, str(exc), bid)
        return {**base, "status": "error", "error": msg, "rows": [], "fields": []}
    except Exception:  # noqa: BLE001 - one broken binding must not take the page down
        db.rollback()
        logger.exception("report-code: binding %s chart %s failed", bid, binding.get("chart_id"))
        return {**base, "status": "error", "error": "Không tải được dữ liệu cho phần này.", "rows": [], "fields": []}

    data = result.get("data") if isinstance(result, dict) else getattr(result, "data", None)
    rows = list(data or [])
    debug = result.get("debug") if isinstance(result, dict) else getattr(result, "debug", None)
    if enforced:
        # Defence in depth: whatever path served the result (a cache hit included), a
        # security constraint the engine reports as dropped refuses the binding.
        locked_refs = {f["fieldKey"] for f in decl if f["key"] in set(enforced)} |                       {f["field"] for f in decl if f["key"] in set(enforced)}
        for drop in _debug_get(debug, "dropped_filters") or []:
            if isinstance(drop, dict) and (drop.get("semantic_field") or drop.get("fieldKey") or drop.get("field")) in locked_refs:
                return {**base, "status": "refused", "rows": [], "fields": [],
                        "error": AuthoritativeFilterNotApplied("dropped").args[0]}
    described: Dict[str, Dict[str, Any]] = binding.get("fields") or {}

    keyed = [r for r in (binding.get("order") or []) if r in described] + \
            [r for r in described if r not in (binding.get("order") or [])]
    order: List[str] = [r for r in keyed if described[r].get("role") != "measure"] + \
                       [r for r in keyed if described[r].get("role") == "measure"]
    for row in rows[:5]:
        if isinstance(row, dict):
            for k, v in row.items():
                if k not in order:
                    order.append(k)
                    described = {**described, k: {"label": k.split(".")[-1].replace("_", " "),
                                                  "role": "measure" if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool) else "dimension",
                                                  "kind": "number" if isinstance(v, (int, float, Decimal)) else "string"}}
    by_field_key = {f["fieldKey"]: f["key"] for f in decl}
    fields, key_of, di, mi = [], {}, 0, 0
    for ref in order:
        d = described.get(ref) or {}
        if d.get("role") == "measure":
            key = f"m{mi}"
            mi += 1
        else:
            key = f"d{di}"
            di += 1
        key_of[ref] = key
        from app.services.report_starter_service import _label

        shown = _label({"label": d.get("label"), "name": ref.split(".")[-1]}) if d.get("label") else key
        f = {"key": key, "label": shown, "role": d.get("role") or "dimension", "kind": d.get("kind") or "string"}
        for extra in ("grain", "aggregation", "format"):
            if d.get(extra):
                f[extra] = d[extra]
        if f["role"] != "measure" and ref in by_field_key:
            f["filterKey"] = by_field_key[ref]
        fields.append(f)
    kinds = {key_of[r]: (described.get(r) or {}).get("kind") for r in order}
    out_rows = []
    cap = min(MAX_ROWS, int(limit)) if limit and int(limit) > 0 else MAX_ROWS
    for row in rows[:cap]:
        if isinstance(row, dict):
            out_rows.append({key_of[k]: _plain(v, kinds.get(key_of[k])) for k, v in row.items() if k in key_of})

    partial: List[str] = []
    tc = result.get("time_completeness") if isinstance(result, dict) else getattr(result, "time_completeness", None)
    if isinstance(tc, dict):
        for item in tc.get("partial") or tc.get("buckets") or []:
            if isinstance(item, dict) and item.get("bucket") is not None:
                partial.append(str(_plain(item.get("bucket"), "date")))

    not_applied, ignored = [], []
    labels = {f["fieldKey"]: f["label"] for f in decl if f["key"] in allowed}  # a hidden filter is never named
    key_by_ref = {f["fieldKey"]: f["key"] for f in decl if f["key"] in allowed}
    for drop in _debug_get(debug, "dropped_filters") or []:
        if isinstance(drop, dict):
            ref = drop.get("semantic_field") or drop.get("fieldKey") or drop.get("field")
            if ref in labels and labels[ref] not in not_applied:
                not_applied.append(labels[ref])
            if ref in key_by_ref and key_by_ref[ref] not in ignored:
                ignored.append(key_by_ref[ref])

    as_of = _debug_get(debug, "result_as_of") or _debug_get(debug, "snapshot_as_of")
    prov: Dict[str, Any] = {"asOf": str(as_of) if as_of else _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"}
    if source_label and not public:
        prov["source"] = source_label
    out = {**base, "status": "ready" if out_rows else "empty", "rows": out_rows, "fields": fields,
           "truncated": len(rows) > cap, "partial": partial, "notApplied": not_applied, "provenance": prov}
    if ignored:
        # filter keys this binding's engine dropped: a change to ONLY these keys cannot change it
        out["ignoredFilters"] = ignored
    top = _top_n(db, binding)
    if top:
        out["topN"] = top  # the chart keeps only its N first rows: never a whole population
    return out


def _top_n(db: Session, binding: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The chart's own row limit (Chart Configuration `dataLimit`), as a reader must know it."""
    from app.models.models import Chart

    try:
        chart = db.get(Chart, int(binding["chart_id"]))
        cfg = chart.config if chart is not None and isinstance(chart.config, dict) else {}
    except Exception:  # noqa: BLE001 - a missing chart already failed above; no limit to tell
        return None
    style = cfg.get("styleConfig") if isinstance(cfg, dict) and isinstance(cfg.get("styleConfig"), dict) else {}
    try:
        n = int(style.get("dataLimit") or 0)
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        return None
    return {"n": n, "direction": "bottom" if str(style.get("dataLimitDirection") or "").lower() == "bottom" else "top"}


# A raw warehouse/driver error (BigQuery job ids, SQL fragments, dialect names) is for the
# log, never for the page: an author gets what to check, the details stay server-side.
_ENGINE_ERROR = re.compile(r"Job ID|Location:|invalidQuery|dialect|\bSELECT\b|\b[45]\d\d (?:POST|GET|Bad Request)|"
                           r"googleapis|psycopg|duckdb|Traceback|EXCEPT", re.I)


def _author_error(db: Session, text: str, bid: Any = None) -> str:
    if _ENGINE_ERROR.search(text or ""):
        logger.warning("report-code: binding %s engine error: %s", bid, (text or "")[:2000])
        return ("Truy vấn của phần này bị lỗi khi chạy trên kho dữ liệu. Kiểm tra Dataset "
                "(tên cột chuẩn, công thức measure, snapshot) — chi tiết lỗi đã ghi vào log hệ thống.")
    return _humanize(db, text)


def _humanize(db: Session, text: str) -> str:
    try:
        from app.services.dataset_model_service import humanize_view_tokens

        return humanize_view_tokens(text, db, 0)[:400]
    except Exception:  # noqa: BLE001
        return text[:400]


UNBOUND_CODE = "BINDING_UNBOUND"


def unbound_dto(binding_id: Any) -> Dict[str, Any]:
    """/data for a place whose binding this revision does not have ("missing" left by an
    import, a deleted binding): its own status, so a viewer sees "not bound" - never the
    404 of a revoked link nor the 403/404 of lost rights or a deleted chart."""
    return {"bindingId": str(binding_id or "")[:80], "status": "unbound", "code": UNBOUND_CODE,
            "error": "Chưa gắn dữ liệu — vị trí này chưa được nối với dữ liệu BI Core.",
            "rows": [], "fields": []}


def public_bindings(bindings: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """What a viewer (and the sandbox) may know about a binding."""
    return [{"id": b["id"], "title": b.get("title") or "", "kind": b.get("kind") or ""} for b in bindings]


def public_filters(decl: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out = []
    for f in decl:
        item = {"key": f["key"], "label": f["label"], "kind": f["kind"]}
        for extra in ("grain", "default", "single", "default_value"):
            if f.get(extra) not in (None, "", False):
                item[extra] = f[extra]
        out.append(item)
    return out


# ── Batched data (one request per page chunk) + the public DTO cache ─────────────
# A page asked its data one binding per request: 40 HTTP round trips, each re-reading the
# chart, dataset, model, views, explores and sources (~28 Postgres queries) before the
# result cache was even probed. A batch shares the request-level work; on a public link a
# DTO is reused while nothing it depends on has changed (data_epoch) - never longer than
# DTO_CACHE_TTL_S, which stays under the live-query cache's own TTL.

DTO_CACHE_TTL_S = 60
_DTO_CACHE_MAX = 256
_dto_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_dto_guard = threading.Lock()

# Every table whose rows decide a binding's result. A write bumps updated_at (onupdate) and
# a delete changes the count: either moves the epoch, so the cache never outlives an edit.
_EPOCH_TABLES = ("datasets", "dataset_tables", "dataset_table_snapshots", "data_sources",
                 "semantic_models", "semantic_views", "semantic_explores")


def data_epoch(db: Session, chart_ids: List[int]) -> str:
    """A stamp that changes whenever anything a set of charts' results depend on is edited."""
    from sqlalchemy import text

    parts = " UNION ALL ".join(f"SELECT '{t}', MAX(updated_at)::text, COUNT(*) FROM {t}" for t in _EPOCH_TABLES)
    rows = [tuple(r) for r in db.execute(text(parts)).fetchall()]
    ids = sorted({int(i) for i in chart_ids})
    if ids:
        rows += [tuple(r) for r in db.execute(
            text("SELECT id, updated_at::text, md5(config::text) FROM charts WHERE id = ANY(:ids) ORDER BY id"),
            {"ids": ids}).fetchall()]
        rows += [tuple(r) for r in db.execute(
            text("SELECT chart_id, md5(string_agg(to_jsonb(p)::text, ',' ORDER BY p.id)) FROM chart_parameters p "
                 "WHERE chart_id = ANY(:ids) GROUP BY chart_id ORDER BY chart_id"), {"ids": ids}).fetchall()]
    import hashlib

    return hashlib.sha256(repr(rows).encode()).hexdigest()[:24]


def _dto_key(scope: str, epoch: str, binding: Dict[str, Any], state: Dict[str, Any], enforced: Any,
             disclose: Any, limit: Optional[int]) -> str:
    import json as _json

    return _json.dumps([scope, epoch, binding, state, sorted(set(enforced or ())),
                        sorted(set(disclose)) if disclose is not None else None, limit], sort_keys=True, default=str)


def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    hit = _dto_cache.get(key)
    if hit and time.time() - hit[0] < DTO_CACHE_TTL_S:
        return hit[1]
    return None


def _cache_put(key: str, dto: Dict[str, Any]) -> None:
    if dto.get("status") not in ("ready", "empty"):
        return  # an error or a refusal is recomputed every time
    with _dto_guard:
        if len(_dto_cache) >= _DTO_CACHE_MAX:
            now = time.time()
            for k in [k for k, (at, _) in _dto_cache.items() if now - at >= DTO_CACHE_TTL_S]:
                _dto_cache.pop(k, None)
            while len(_dto_cache) >= _DTO_CACHE_MAX:
                _dto_cache.pop(next(iter(_dto_cache)))
        _dto_cache[key] = (time.time(), dto)


def mint_batch(db: Session, revision_bindings: List[Dict[str, Any]], ids: List[str], decl: List[Dict[str, Any]],
               state: Dict[str, Any], *, limits: Optional[Dict[str, int]] = None, cache_scope: Optional[str] = None,
               **kw: Any) -> Dict[str, Dict[str, Any]]:
    """DTOs for several bindings of ONE revision, in one call - exactly what mint_dto returns
    for each (an unknown id answers as unbound). `cache_scope` (a public link) turns on the
    DTO cache; it is part of the key, with the data epoch, the resolved state and the locks."""
    by_id = {b.get("id"): b for b in revision_bindings or [] if isinstance(b, dict)}
    wanted = list(dict.fromkeys(str(i) for i in ids))[:MAX_BINDINGS]
    resolved = resolve_state(db, decl, state, kw.get("enforced") or ())
    epoch = None
    if cache_scope:
        epoch = data_epoch(db, [int(b["chart_id"]) for i in wanted if (b := by_id.get(i)) and b.get("chart_id")])
    out: Dict[str, Dict[str, Any]] = {}
    for bid in wanted:
        b = by_id.get(bid)
        if b is None:
            out[bid] = unbound_dto(bid)
            continue
        lim = (limits or {}).get(bid)
        key = _dto_key(cache_scope, epoch, b, resolved, kw.get("enforced"), kw.get("disclose"), lim) if cache_scope else None
        dto = _cache_get(key) if key else None
        if dto is None:
            dto = mint_dto(db, b, decl, resolved, limit=lim, **kw)
            if key:
                _cache_put(key, dto)
        out[bid] = dto
    return out
