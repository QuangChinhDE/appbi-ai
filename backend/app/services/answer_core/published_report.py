"""The Answer Core's data scope for a PUBLIC link: its published charts, nothing more.

A viewer of a public link is not a person GQS knows (no principal, no EXPLORE
grant), so the Core never reads a semantic explore for them. What the viewer may
see is the report as published, and that is exactly what this scope reads:

  * the CATALOG is the link's published charts (draft tiles are already stripped
    by `public._get_dashboard_by_token`), each offered with the dimensions and
    measures it SHOWS - not the dataset behind it;
  * every READ is `agent_flows.tools.context._fetch_chart_data` on the link's
    tool context (`public._public_link_tool_context`): the chart's own governed
    query through ChartService, with the dashboard's filters, the link's locks
    and hidden filters, the chart's page slicers and page scope bounds, the
    AI-scope column exclusions and the link's freshness - the same path the
    viewer's tile renders through;
  * a filter on a dimension the chart shows narrows the chart's own rows (the
    viewer already sees them); a filter on any other field is pushed to the
    engine only if the LINK lets the viewer filter on it (`exposed_fields`), and
    the engine refuses one it cannot apply (never a silently dropped filter);
  * a grouping coarser than the chart's is only computed for additive measures
    (sum, count, min, max); an average or a distinct count is answered at the
    chart's own grouping or refused - never re-aggregated into a wrong number.

There is no SQL here, no dataset-wide read, no owner rights, and no way for the
planner (or an add-on) to name a chart the link does not publish.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Optional

from app.services.data_core.scope import Refusal

#: How many published charts the planner is shown (the viewer's page first).
MAX_CHARTS = 40
_ADDITIVE = frozenset({"sum", "count", "min", "max"})


@dataclass
class _Col:
    name: str
    ref: Optional[str]
    role: str


@dataclass
class PublishedResult:
    columns: list[_Col]
    rows: list[dict]
    truncated: bool
    meta: dict = field(default_factory=dict)


@dataclass
class _Chart:
    chart_id: int
    name: str
    pages: list[str]
    dataset_id: Optional[int]
    source_type: str
    dims: list[str]
    measures: dict[str, str]   # ref -> aggregation (sum, count, avg, count_distinct, min, max, unknown)


def _refuse(code: str, message: str, **detail) -> Refusal:
    """The Core's one refusal type: shown to the viewer as a refusal, never answered around."""
    return Refusal(code, message, detail)


def _as_date(v: Any) -> Optional[date]:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, str) and len(v) >= 10:
        try:
            return date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _bucket(d: date, grain: str) -> str:
    if grain == "year":
        return f"{d.year}-01-01"
    if grain == "quarter":
        return f"{d.year}-{(3 * ((d.month - 1) // 3) + 1):02d}-01"
    if grain == "month":
        return f"{d.year}-{d.month:02d}-01"
    if grain == "week":
        from datetime import timedelta

        return (d - timedelta(days=d.weekday())).isoformat()
    return d.isoformat()


def _passes(value: Any, cond: dict) -> bool:
    """A Core filter condition on one cell (the chart's own rows)."""
    from app.services.data_core.grounding import fold

    op = str(cond.get("operator") or "eq")
    want = cond.get("value")
    if op == "date_range" and isinstance(want, dict):
        d = _as_date(value)
        lo, hi = _as_date(want.get("from")), _as_date(want.get("to"))
        return d is not None and (lo is None or d >= lo) and (hi is None or d < hi)
    if op in ("eq", "ne", "in", "not_in"):
        wanted = want if isinstance(want, list) else [want]
        folded = {fold(str(w)).strip() for w in wanted if w is not None}
        hit = value is not None and fold(str(value)).strip() in folded
        return hit if op in ("eq", "in") else not hit
    if op == "contains":
        return value is not None and fold(str(want or "")).strip() in fold(str(value))
    a, b = _num(value), _num(want)
    if a is None or b is None:
        return False
    return {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}.get(op, False)


def _engine_filters(ref: str, cond: dict) -> list[dict]:
    """A Core condition on a field the chart does not show, as engine filter entries."""
    op = str(cond.get("operator") or "eq")
    value = cond.get("value")
    base = {"field": ref, "semanticField": ref}
    if op == "date_range" and isinstance(value, dict):
        out = []
        if value.get("from"):
            out.append({**base, "operator": "gte", "value": str(value["from"])})
        if value.get("to"):
            out.append({**base, "operator": "lt", "value": str(value["to"])})
        return out
    if op in ("eq", "ne", "in", "not_in", "contains", "gt", "gte", "lt", "lte"):
        return [{**base, "operator": op, "value": value}]
    raise _refuse("filter_unsupported", "Bộ lọc này không áp được trên báo cáo đã công khai.", field=ref)


class PublishedReportScope:
    """The Answer Core's scope for one public link's viewer (see module docstring)."""

    kind = "published_report"
    consent_enabled = False

    def __init__(self, db, *, ctx, link_id: int, turn_id: str, page_id: Optional[str] = None):
        self.db, self.ctx, self.turn_id = db, ctx, turn_id
        self.link_id, self.page_id = int(link_id), page_id
        self.subject = f"link:{link_id}"
        self._charts: dict[int, _Chart] = {}
        self._entries: Optional[list] = None
        self._reads = 0

    # ── what the planner may ask about ────────────────────────────────────────
    def catalog(self) -> list:
        if self._entries is None:
            self._entries = self._build_catalog()
        return self._entries

    def _build_catalog(self) -> list:
        from app.models.dataset import DatasetTable
        from app.models.models import Chart, DataSource
        from app.services.data_core.catalog import CatalogExplore, CatalogField

        ctx = self.ctx
        pages_of: dict[int, list[str]] = {}
        for p in ctx.pages or []:
            for cid in p.get("chart_ids") or []:
                pages_of.setdefault(int(cid), []).append(str(p.get("name") or ""))
        current = next((p for p in ctx.pages or [] if str(p.get("id")) == str(self.page_id or "")), None)
        first = [int(c) for c in (current or {}).get("chart_ids") or []]
        ordered = first + sorted(c for c in ctx.allowed_chart_ids if c not in first)

        vocab = _Vocabulary(self.db)
        out = []
        for chart_id in ordered:
            if len(out) >= MAX_CHARTS:
                break
            meta = ctx.chart_meta.get(chart_id) or {}
            fields = meta.get("fields") or {}
            chart = self.db.get(Chart, chart_id)
            if chart is None:
                continue
            table = self.db.get(DatasetTable, chart.dataset_table_id) if chart.dataset_table_id else None
            source = self.db.get(DataSource, table.datasource_id) if table is not None and table.datasource_id else None
            stype = str(getattr(getattr(source, "type", None), "value", None) or "derived")
            dataset_id = getattr(table, "dataset_id", None)
            excluded = {str(c).lower() for c in (ctx.excluded_columns or set())}
            cf, dims, measures = [], [], {}
            for d in fields.get("dimensions") or []:
                ref = str(d.get("field") or "")
                if not ref or ref.rsplit(".", 1)[-1].lower() in excluded or ref in dims:
                    continue
                dtype, desc, words = vocab.dimension(dataset_id, ref)
                cf.append(CatalogField(ref, "dimension", dtype, str(d.get("label") or ref), desc, words))
                dims.append(ref)
            for m in fields.get("measures") or []:
                ref = str(m.get("field") or "")
                if not ref or ref.rsplit(".", 1)[-1].lower() in excluded or ref in measures:
                    continue
                agg, desc, words = vocab.measure(dataset_id, ref, m.get("agg"))
                cf.append(CatalogField(ref, "measure", agg, str(m.get("label") or ref), desc, words))
                measures[ref] = agg
            if not measures:
                continue
            name = str(meta.get("name") or getattr(chart, "name", None) or f"Chart {chart_id}")
            pages = pages_of.get(chart_id, [])
            self._charts[chart_id] = _Chart(chart_id, name, pages, dataset_id, stype, dims, measures)
            label = name + (f" (trang {', '.join(pages)})" if pages else "")
            out.append(CatalogExplore(
                explore_id=chart_id, model_id=None, dataset_id=int(dataset_id or -chart_id),
                dataset_name=name, dataset_table_id=getattr(chart, "dataset_table_id", None),
                base_view=next(iter(measures)).rsplit(".", 1)[0], source_type=stype, label=label, fields=cf))
        return out

    def chart(self, chart_id: int) -> Optional[_Chart]:
        if self._entries is None:
            self.catalog()
        return self._charts.get(int(chart_id))

    # ── budgets and rights the Core asks about ─────────────────────────────────
    def exhausted(self) -> Optional[tuple]:
        return None  # the link's budget is checked by the turn and enforced per call by the Model Gateway

    def can_save(self, p) -> bool:
        return False  # an anonymous viewer saves nothing

    def find_value(self, p, question: str, unexplained: set, used: list) -> Optional[tuple]:
        from app.services.data_core.scope import find_value_via

        return find_value_via(self.read, p, question, unexplained)

    # ── the one read ───────────────────────────────────────────────────────────
    def read(self, p, dims, measures, filters, sorts, grains, max_rows: int) -> PublishedResult:
        from app.services.agent_flows.tools.context import ToolError, _fetch_chart_data

        chart = self.chart(p.explore.explore_id)
        if chart is None:
            raise _refuse("outside_published_scope", "Biểu đồ này không thuộc báo cáo được công khai.")
        dims, measures = list(dims or []), list(measures or [])
        missing = [r for r in dims if r not in chart.dims] + [r for r in measures if r not in chart.measures]
        missing += [r for r in (grains or {}) if r not in chart.dims]
        if missing:
            raise _refuse("outside_published_scope",
                          f"Biểu đồ “{chart.name}” không hiển thị phần dữ liệu này nên trợ lý không trả lời từ nó.",
                          fields=missing)
        local, pushed = {}, []
        for ref, cond in (filters or {}).items():
            if not isinstance(cond, dict):
                continue
            if ref in chart.dims:
                local[ref] = cond
            else:
                pushed.extend(_engine_filters(ref, cond))

        started = time.monotonic()
        try:
            data = _fetch_chart_data(self.ctx, chart.chart_id, extra_filters=pushed or None)
        except ToolError as ex:
            raise _refuse("filter_not_published", str(ex)) from ex
        except ValueError as ex:  # the engine refuses a filter it cannot apply - loudly
            raise _refuse("filter_unreachable", str(ex)[:300]) from ex
        self._reads += 1
        cols = [str(c) for c in data.get("columns") or []]
        rows = [dict(zip(cols, r)) for r in data.get("rows") or []]
        rows = [r for r in rows if all(_passes(r.get(ref), c) for ref, c in local.items())]

        groups: list[tuple[str, Optional[str]]] = [(d, (grains or {}).get(d)) for d in dims]
        regroup = set(dims) != set(chart.dims) or any(g for _, g in groups)

        def key_of(r):
            out = []
            for ref, grain in groups:
                v = r.get(ref)
                if grain:
                    d = _as_date(v)
                    v = _bucket(d, grain) if d else None
                out.append(v)
            return tuple(out)

        out_rows: list[dict] = []
        if not regroup:
            out_rows = [{**{d: r.get(d) for d in dims}, **{m: r.get(m) for m in measures}} for r in rows]
        else:
            buckets: dict[tuple, list[dict]] = {}
            for r in rows:
                buckets.setdefault(key_of(r), []).append(r)
            for key, members in buckets.items():
                row = {ref: key[i] for i, (ref, _) in enumerate(groups)}
                for m in measures:
                    agg = chart.measures.get(m, "unknown")
                    values = [_num(x.get(m)) for x in members]
                    known = [v for v in values if v is not None]
                    if len(members) > 1 and agg not in _ADDITIVE:
                        raise _refuse(
                            "not_additive",
                            f"Chỉ số “{_label(p, m)}” không cộng dồn được (trung bình/đếm phân biệt) nên trợ lý "
                            f"không gộp biểu đồ “{chart.name}” theo cách khác cách nó đang hiển thị.",
                            measure=m)
                    if not known:
                        row[m] = None
                    elif agg in ("min",):
                        row[m] = min(known)
                    elif agg in ("max",):
                        row[m] = max(known)
                    else:
                        row[m] = sum(known)
                out_rows.append(row)

        for s in reversed(list(sorts or [])):
            ref = s.get("field") if isinstance(s, dict) else None
            if ref in (dims + measures):
                desc = str(s.get("direction") or "asc") == "desc"
                present = [r for r in out_rows if r.get(ref) is not None]
                absent = [r for r in out_rows if r.get(ref) is None]
                try:
                    present.sort(key=lambda r: r.get(ref), reverse=desc)
                except TypeError:
                    present.sort(key=lambda r: str(r.get(ref)), reverse=desc)
                out_rows = present + absent
        truncated = len(out_rows) > max_rows
        out_rows = out_rows[:max_rows]
        columns = [_Col(d, d, "dimension") for d in dims] + [_Col(m, m, "measure") for m in measures]
        shown, withheld = self.ctx.disclosed_filters()
        meta = {
            "chart_id": chart.chart_id, "chart": chart.name, "pages": chart.pages, "source_type": chart.source_type,
            "dataset_id": chart.dataset_id, "rows_returned": len(out_rows),
            "duration_ms": int((time.monotonic() - started) * 1000),
            "filters_shown": [_describe_engine_filter(f) for f in shown][:12], "filters_withheld": withheld,
            "filters_not_applied": [str(f.get("field") or f.get("semanticField") or "")
                                    for f in data.get("filters_not_applied") or [] if isinstance(f, dict)],
            "data_as_of": data.get("data_as_of"), "regrouped": regroup,
        }
        return PublishedResult(columns=columns, rows=out_rows, truncated=truncated, meta=meta)

    def evidence(self, p, result: PublishedResult) -> dict:
        m = result.meta
        return {
            "query_id": f"pub-{self.turn_id[:12]}-{uuid.uuid4().hex[:6]}", "scope": "published_report",
            "source": m.get("chart") or p.explore.dataset_name, "source_type": m.get("source_type"),
            "chart_id": m.get("chart_id"), "pages": m.get("pages") or [], "explore_id": p.explore.explore_id,
            "datasets": [m["dataset_id"]] if m.get("dataset_id") else [],
            "filters_applied": m.get("filters_shown") or [], "filters_withheld": m.get("filters_withheld") or 0,
            "filters_dropped": m.get("filters_not_applied") or [], "rows_returned": m.get("rows_returned"),
            "duration_ms": m.get("duration_ms"), "freshness": m.get("data_as_of") or "live",
            "regrouped": bool(m.get("regrouped")),
        }


def _label(p, ref: str) -> str:
    return next((f.label for f in p.explore.fields if f.ref == ref), ref)


def _describe_engine_filter(f: dict) -> str:
    field_name = str(f.get("label") or f.get("field") or f.get("semanticField") or "").rsplit(".", 1)[-1]
    value = f.get("value")
    shown = ", ".join(str(v) for v in value) if isinstance(value, list) else str(value)
    return f"{field_name} {f.get('operator') or f.get('op') or '='} {shown}".strip()


class _Vocabulary:
    """Field types and business words of a chart's fields, from the semantic model
    the chart is built on (definitions, governed metric aliases, glossary terms) -
    the same vocabulary AI Chat's catalog offers the planner."""

    def __init__(self, db):
        self.db = db
        self._views: dict[Optional[int], dict[str, Any]] = {}

    def _view(self, dataset_id: Optional[int], view_name: str):
        if dataset_id not in self._views:
            from app.models.dataset import DatasetTable
            from app.models.semantic import SemanticView
            from app.services.data_core.catalog import governed_aliases

            rows = []
            if dataset_id is not None:
                rows = (self.db.query(SemanticView).join(DatasetTable, DatasetTable.id == SemanticView.dataset_table_id)
                        .filter(DatasetTable.dataset_id == dataset_id).all())
            self._views[dataset_id] = {"views": {v.name: v for v in rows},
                                       "aliases": governed_aliases(self.db, [dataset_id]) if dataset_id else {}}
        return self._views[dataset_id]["views"].get(view_name), self._views[dataset_id]["aliases"]

    def _defn(self, dataset_id, ref: str, kind: str) -> tuple[dict, dict]:
        view_name, _, name = ref.rpartition(".")
        view, aliases = self._view(dataset_id, view_name)
        defs = (view.dimensions if kind == "dimension" else view.measures) if view is not None else []
        defn = next((d for d in defs or [] if isinstance(d, dict) and d.get("name") == name), {})
        return defn, aliases

    def dimension(self, dataset_id, ref: str) -> tuple[str, str, tuple]:
        from app.services.data_core.catalog import _synonyms

        defn, _ = self._defn(dataset_id, ref, "dimension")
        return str(defn.get("type") or "string"), str(defn.get("description") or "")[:200], _synonyms(defn)

    def measure(self, dataset_id, ref: str, chart_agg: Any) -> tuple[str, str, tuple]:
        from app.services.data_core.catalog import _synonyms

        defn, aliases = self._defn(dataset_id, ref, "measure")
        agg = str(chart_agg or "").strip().lower()
        if agg in ("", "auto", "none"):
            agg = str(defn.get("type") or "unknown").strip().lower()
        if agg in ("countdistinct", "count_distinct", "distinct_count", "unique"):
            agg = "count_distinct"
        if agg in ("average", "mean"):
            agg = "avg"
        words = tuple(dict.fromkeys([*_synonyms(defn), *(aliases.get(ref) or aliases.get(ref.rsplit(".", 1)[-1])
                                                          or ())]))[:12]
        return agg, str(defn.get("description") or "")[:200], words
