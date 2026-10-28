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

import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Optional

from app.services.data_core.scope import Refusal

#: How many published charts the catalog holds (the viewer's page first): every chart
#: of a large report is rankable. Raised from 40 (2026-10-28): a report of 85 charts
#: left 45 of them unreachable however the question named them.
MAX_CHARTS = 150
#: How many of them the planner is SHOWN for one question - the most relevant
#: (`PublishedReportScope.shortlist`). Live 2026-10-28: all 85 charts of a report were
#: ~60k input tokens per question, the cost and the latency of every turn.
SHORTLIST = 12
#: words that say nothing about WHICH chart (question scaffolding); "bang" (a state)
#: is a word here even though grounding stops it as "bằng" (by/with)
_RANK_STOP = frozenset("""
a ai bao bieu cac cai cho chi co con cua cung da dang de den do duoc gi hay hien khong khi la lam
len mot moi nao nay nhieu nhu nhung nhat nua o ra sao so the thi thu tren trong tu va ve voi xem
top cao thap lon nho bao cao so lieu du lieu chart page trang
is the of in for by and what how which show me
""".split())
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


_UNDERIVABLE = object()


def _period_key(v: Any, grain: str) -> Any:
    """The bucket of a PERIOD a chart shows ("2024-03" of a calendar view's month,
    "2024" of its year) at `grain`: the period itself at its own grain, a coarser one
    derived, a finer one underivable. Not a period: no bucket (None)."""
    s = str(v or "").strip()
    if len(s) == 7 and s[4] == "-" and s[:4].isdigit() and s[5:].isdigit():
        y, m = s[:4], int(s[5:])
        own = {"month": s, "quarter": f"{y}-Q{(m - 1) // 3 + 1}", "year": y}
    elif len(s) == 4 and s.isdigit():
        own = {"year": s}
    else:
        return None
    return own.get(grain, _UNDERIVABLE)


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
        #: the publisher's guide (`publisher_guide.PublisherGuide`), set before the catalog is built
        self.guide = None

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
        # the publisher's glossary (`ai_bot_guide`): their words for a field, offered
        # to the planner and the chart ranking as that field's synonyms
        from app.services.answer_core.publisher_guide import synonyms as _guide_synonyms

        glossary = _guide_synonyms(getattr(self, "guide", None))
        exposed = {str(r) for r in ((ctx.exposed_fields or (set(), set()))[0] or set()) if "." in str(r)}
        slicer_labels = {}
        for s in (getattr(ctx.dashboard, "slicers_config", None) or []):
            if isinstance(s, dict) and s.get("label"):
                for k in ("semanticField", "fieldKey"):
                    if s.get(k):
                        slicer_labels[str(s[k])] = str(s["label"])
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
            name = str(meta.get("name") or getattr(chart, "name", None) or f"Chart {chart_id}")
            metric_words, breakdown_words = _title_parts(name)
            one_dim = len(fields.get("dimensions") or []) == 1
            for d in fields.get("dimensions") or []:
                ref = str(d.get("field") or "")
                if not ref or ref.rsplit(".", 1)[-1].lower() in excluded or ref in dims:
                    continue
                dtype, desc, words = vocab.dimension(dataset_id, ref)
                if slicer_labels.get(ref):
                    # the word the report itself gives a viewer for this field ("Khu vực")
                    words = tuple(dict.fromkeys([slicer_labels[ref], *words]))[:12]
                if one_dim and breakdown_words:
                    # the breakdown the report's title names ("sản phẩm" of "Doanh thu theo sản phẩm")
                    words = tuple(dict.fromkeys([*words, breakdown_words]))[:12]
                if glossary.get(ref):
                    words = tuple(dict.fromkeys([*glossary[ref], *words]))[:16]
                cf.append(CatalogField(ref, "dimension", dtype, str(d.get("label") or ref), desc, words))
                dims.append(ref)
            only = len(fields.get("measures") or []) == 1
            for m in fields.get("measures") or []:
                ref = str(m.get("field") or "")
                if not ref or ref.rsplit(".", 1)[-1].lower() in excluded or ref in measures:
                    continue
                agg, desc, words = vocab.measure(dataset_id, ref, m.get("agg"))
                if only and metric_words:
                    # the words the report's title gives a viewer for its one metric
                    # ("Doanh thu" of "Doanh thu theo sản phẩm") over an English label
                    words = tuple(dict.fromkeys([*words, metric_words]))[:12]
                if glossary.get(ref):
                    words = tuple(dict.fromkeys([*glossary[ref], *words]))[:16]
                cf.append(CatalogField(ref, "measure", agg, str(m.get("label") or ref), desc, words))
                measures[ref] = agg
            if not measures:
                continue
            # The fields this LINK lets a viewer filter by (its slicers / filter pane), from
            # the chart's own dataset: offered for FILTERING only. `read` refuses them as a
            # grouping, so they never become a breakdown the report does not show.
            for ref in sorted(exposed):
                view_name = ref.rpartition(".")[0]
                if ref in dims or ref in measures or ref.rsplit(".", 1)[-1].lower() in excluded or \
                        vocab._view(dataset_id, view_name)[0] is None:
                    continue
                dtype, _desc, words = vocab.dimension(dataset_id, ref)
                cf.append(CatalogField(ref, "filter", dtype, slicer_labels.get(ref) or ref.rsplit(".", 1)[-1],
                                       "Chỉ dùng để lọc: biểu đồ không chia theo trường này.", words))
            pages = pages_of.get(chart_id, [])
            self._charts[chart_id] = _Chart(chart_id, name, pages, dataset_id, stype, dims, measures)
            label = name + (f" (trang {', '.join(pages)})" if pages else "")
            out.append(CatalogExplore(
                explore_id=chart_id, model_id=None, dataset_id=int(dataset_id or -chart_id),
                dataset_name=name, dataset_table_id=getattr(chart, "dataset_table_id", None),
                base_view=next(iter(measures)).rsplit(".", 1)[0], source_type=stype, label=label, fields=cf,
                published=True))
        return out

    def chart(self, chart_id: int) -> Optional[_Chart]:
        if self._entries is None:
            self.catalog()
        return self._charts.get(int(chart_id))

    def rank(self, question: str) -> list:
        """The published charts of this link by relevance to the question (`rank_entries`)."""
        pages = getattr(self.ctx, "pages", None) or []
        current = next((p for p in pages if str(p.get("id")) == str(self.page_id or "")), None)
        page = frozenset(int(c) for c in (current or {}).get("chart_ids") or [])
        return rank_entries(question, self.catalog(), self._charts, notes=getattr(self, "notes", None),
                            page_charts=page)

    def shortlist(self, question: str, catalog: list, previous: Optional[dict] = None) -> list:
        """What the planner is shown: the SHORTLIST charts most relevant to the question
        among `catalog`, plus the previous answer's chart on a follow-up. The plan is
        still validated and read against the full link (nothing outside it is reachable
        either way); a smaller report is shown whole."""
        if len(catalog) <= SHORTLIST:
            return catalog
        offered = {e.explore_id for e in catalog}
        keep = [e for e in self.rank(question) if e.explore_id in offered][:SHORTLIST]
        prev = (previous or {}).get("explore_id") if isinstance(previous, dict) else None
        if prev is not None and all(e.explore_id != prev for e in keep):
            keep += [e for e in catalog if e.explore_id == prev]
        return keep

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
        if len(dims) == 1 and not measures and dims[0] not in chart.dims and not filters and not grains:
            # A value lookup on a field this chart only FILTERS by (the Core checking
            # "Central" is a real region): the distinct values another published chart
            # of the same dataset SHOWS - data the viewer already sees.
            other = self._chart_showing(dims[0], chart.dataset_id)
            if other is not None:
                return self._values_of(other, dims[0])
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
        dropped = [f for f in data.get("filters_not_applied") or [] if isinstance(f, dict)]
        if dropped:
            # A filter in force that THIS chart could not apply (another dataset's
            # slicer, an engine soft-drop): its rows are not the rows the report shows
            # under that filter. Live 2026-10-28: asked about period T08, the bot summed
            # every period. Never a number over different filters than the report's -
            # the same rule as GQS `filter_would_drop` (PO decision: refuse, name it).
            names = "; ".join(_describe_engine_filter(f) for f in dropped[:3])
            raise _refuse("filter_not_applied",
                          f"Biểu đồ “{chart.name}” không lọc được theo {names}, nên số của nó không phải số "
                          "đang hiển thị với bộ lọc này. Hãy hỏi về biểu đồ có lọc theo trường đó, hoặc bỏ chọn "
                          "bộ lọc rồi hỏi lại.", chart=chart.name)
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
                    v = _bucket(d, grain) if d else _period_key(v, grain)
                    if v is _UNDERIVABLE:
                        raise _refuse("grain_not_shown",
                                      f"Biểu đồ “{chart.name}” hiển thị theo kỳ “{r.get(ref)}”, không chia nhỏ "
                                      f"hơn được theo “{grain}”.", field=ref)
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
        # The filters THIS chart ran with (disclosable ones named, hidden ones counted)
        # - not the link's global list, which named a filter the chart had dropped.
        shown = [f for f in data.get("filters_applied") or [] if isinstance(f, dict)]
        withheld = int(data.get("restricted_by_author") or 0)
        meta = {
            "chart_id": chart.chart_id, "chart": chart.name, "pages": chart.pages, "source_type": chart.source_type,
            "dataset_id": chart.dataset_id, "rows_returned": len(out_rows),
            "duration_ms": int((time.monotonic() - started) * 1000),
            "filters_shown": [_describe_engine_filter(f) for f in shown][:12], "filters_withheld": withheld,
            "filters_not_applied": [],
            "data_as_of": data.get("data_as_of"), "regrouped": regroup,
        }
        return PublishedResult(columns=columns, rows=out_rows, truncated=truncated, meta=meta)

    def _chart_showing(self, ref: str, dataset_id) -> Optional[_Chart]:
        return next((c for c in self._charts.values() if ref in c.dims and c.dataset_id == dataset_id), None)

    def _values_of(self, chart: _Chart, ref: str) -> PublishedResult:
        from app.services.agent_flows.tools.context import _fetch_chart_data

        data = _fetch_chart_data(self.ctx, chart.chart_id)
        cols = [str(c) for c in data.get("columns") or []]
        values = []
        for row in data.get("rows") or []:
            v = dict(zip(cols, row)).get(ref)
            if v is not None and v not in values:
                values.append(v)
        return PublishedResult(columns=[_Col(ref, ref, "dimension")], rows=[{ref: v} for v in values],
                               truncated=False, meta={"chart_id": chart.chart_id, "chart": chart.name,
                                                      "rows_returned": len(values), "duration_ms": 0})

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


def _terms(text: str) -> set[str]:
    """The words of a text that can say WHICH chart, and their adjacent pairs
    ("thanh toan"), accent-folded."""
    from app.services.data_core.grounding import fold

    ws = [w for w in re.split(r"[^0-9a-z]+", fold(text).replace("_", " ")) if w]
    words = {w for w in ws if len(w) > 1 and w not in _RANK_STOP}
    return words | {f"{a} {b}" for a, b in zip(ws, ws[1:]) if a not in _RANK_STOP or b not in _RANK_STOP}


def _glossary(question: str, notes: Optional[str]) -> set[str]:
    """The terms the publisher's prompt adds to a question: a line that shares a term
    with the question ("bang là Customer State") lends the question its other terms."""
    asked, out = _terms(question), set()
    for line in re.split(r"[\n;]+", notes or ""):
        terms = _terms(line)
        if terms & asked:
            out |= terms - asked
    return out


def rank_entries(question: str, entries: list, charts: dict, *, notes: Optional[str] = None,
                 page_charts: frozenset = frozenset()) -> list:
    """The published charts by relevance to the question - deterministic, no model:
    a term of the chart's title or page outweighs one of its fields, a word pair
    outweighs a word, a term most charts share weighs nothing (IDF), the publisher's
    glossary counts half, the viewer's page breaks ties. Stable: equal scores keep the
    catalog's order (the viewer's page first)."""
    import math

    asked, lent = _terms(question), _glossary(question, notes)
    named = []
    for e in entries:
        c = charts.get(e.explore_id)
        title = _terms(f"{c.name if c else e.label} {' '.join(c.pages) if c else ''}")
        fields = set()
        for f in e.fields:
            fields |= _terms(f"{f.label} {' '.join(f.synonyms)} {f.ref.rsplit('.', 1)[-1]}")
        named.append((e, title, fields - title))
    n = len(named) or 1
    df: dict[str, int] = {}
    for _e, title, fields in named:
        for t in title | fields:
            df[t] = df.get(t, 0) + 1

    def weight(t: str) -> float:
        return math.log((n + 1) / (df.get(t, 0) + 0.5)) * (2.0 if " " in t else 1.0)

    def score(item) -> float:
        e, title, fields = item
        s = sum(2 * weight(t) for t in asked & title) + sum(weight(t) for t in asked & fields)
        s += 0.5 * (sum(2 * weight(t) for t in lent & title) + sum(weight(t) for t in lent & fields))
        return s + (0.25 if e.explore_id in page_charts else 0.0)

    scored = [(score(item), i, item[0]) for i, item in enumerate(named)]
    return [e for _s, _i, e in sorted(scored, key=lambda x: (-x[0], x[1]))]


def _title_parts(title: str) -> tuple[str, str]:
    """(metric phrase, breakdown phrase) of a chart title's last "·" segment:
    "QA Bot · Doanh thu theo sản phẩm" -> ("Doanh thu", "sản phẩm"); "Tổng doanh thu"
    -> ("Tổng doanh thu", ""). The report's own words for its metric and breakdown."""
    text = title.rsplit("·", 1)[-1].strip()
    parts = re.split(r"\s+(?:theo|by|per|từng)\s+", text, maxsplit=1, flags=re.IGNORECASE)
    metric = re.split(r"\s+(?:của|trong|of|in)\s+", parts[0], maxsplit=1, flags=re.IGNORECASE)[0]
    breakdown = parts[1] if len(parts) > 1 else ""
    return metric.strip(" -–—:")[:60], breakdown.strip(" -–—:")[:60]


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
