"""The context every tool runs in: one dashboard, its filters, and who is asking.

MOVED HERE FROM `dashboard_ai_bot/tool_context.py`, unchanged apart from this
docstring. It never belonged to a way of thinking: merging the dashboard's public
filters into a query, resolving the semantic layer, choosing snapshot or live,
coercing column types — that is the DATA PATH, and it is where dozens of hard-won
corrections live. The first-generation brain around it is being deleted; this is
not.

`knowledge_scope` is the field a brain step narrows before it runs, so an agent
granted `read_document` can only reach the documents that step attached.

The old location now re-exports from here, so there is one definition while the
first-generation brain is still standing.
"""
from __future__ import annotations

import logging
import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.models.models import Dashboard
from app.services.chart_service import ChartService

logger = logging.getLogger(__name__)


MAX_ROWS_FOR_PACK = 200  # internal sample for stats, not exposed to LLM
MAX_TOP_N = 50


# ── On-screen field semantics ──────────────────────────────────────────────
#
# The bot reads chart data as RAW SQL columns (e.g. ``dataset_table_47.sl_tm``)
# and previously had to GUESS which column is the measure. But the viewer sees
# friendly labels + an aggregation (e.g. "Tổng SL thương mại"). Without that
# vocabulary the answers drift "generic" — citing raw column names and
# un-framed numbers. We pull the chart's CONFIGURED roles (the same ones the
# dashboard renders) so the agent speaks in the viewer's terms.

_VIEW_PREFIX_RE = re.compile(r"^[A-Za-z0-9_]*dataset_table_\d+\.")


def _humanize_field(field_ref: str) -> str:
    """Best-effort friendly label for a raw field reference.

    ``dataset_table_47.sl_tm`` → ``Sl tm``; ``report_date`` → ``Report date``.
    Used only as a fallback when the chart config carries no explicit label.
    """
    if not field_ref:
        return ""
    name = str(field_ref).split(".")[-1].replace("_", " ").strip()
    if not name:
        return str(field_ref)
    return name[:1].upper() + name[1:]


def extract_chart_field_semantics(config: Any) -> dict[str, Any]:
    """Derive the chart's on-screen measure/dimension vocabulary from its config.

    Returns ``{"measures": [{field,label,agg}], "dimensions": [{field,label}],
    "label_by_field": {field: label}}``. Pure config parsing, no DB. Uses the
    canonical ``get_chart_active_role_config`` so it honors custom/generated
    role modes, and prefers Explore-2.0 ``measure_configs``/``dimension_configs``
    labels before falling back to a humanized field name.
    """
    empty = {"measures": [], "dimensions": [], "label_by_field": {}}
    if not isinstance(config, dict):
        return empty
    try:
        from app.services.chart_contracts import get_chart_active_role_config
        role = get_chart_active_role_config(config) or {}
    except Exception:
        role = config.get("roleConfig") if isinstance(config.get("roleConfig"), dict) else {}

    label_by_field: dict[str, str] = {}
    for cfg in (config.get("measure_configs") or []):
        if isinstance(cfg, dict) and cfg.get("field") and cfg.get("label"):
            label_by_field[str(cfg["field"])] = str(cfg["label"])
    for cfg in (config.get("dimension_configs") or []):
        if isinstance(cfg, dict) and cfg.get("field") and cfg.get("label"):
            label_by_field[str(cfg["field"])] = str(cfg["label"])

    def _label(field_ref: Any, explicit: Any = None) -> str:
        f = str(field_ref)
        if explicit:
            return str(explicit)
        return label_by_field.get(f) or _humanize_field(f)

    measures: list[dict[str, Any]] = []
    for metric in (role.get("metrics") or []):
        if not isinstance(metric, dict) or not metric.get("field"):
            continue
        field_ref = str(metric["field"])
        agg = str(metric.get("agg") or metric.get("function") or "").strip().lower() or None
        lbl = _label(field_ref, metric.get("label"))
        label_by_field.setdefault(field_ref, lbl)
        measures.append({"field": field_ref, "label": lbl, "agg": agg})

    dim_refs: list[str] = []
    primary_dim = role.get("dimension")
    if isinstance(primary_dim, str) and primary_dim:
        dim_refs.append(primary_dim)
    for d in (role.get("dimensions") or []):
        if isinstance(d, str) and d and d not in dim_refs:
            dim_refs.append(d)
    # Standard-table mode carries dimensions in selectedColumns, not metrics.
    if not measures and not dim_refs:
        for col in (role.get("selectedColumns") or []):
            ref = col.get("field") if isinstance(col, dict) else col
            if isinstance(ref, str) and ref and ref not in dim_refs:
                dim_refs.append(ref)

    dimensions: list[dict[str, Any]] = []
    for field_ref in dim_refs:
        lbl = _label(field_ref)
        label_by_field.setdefault(field_ref, lbl)
        dimensions.append({"field": field_ref, "label": lbl})

    return {"measures": measures, "dimensions": dimensions, "label_by_field": label_by_field}


def fields_block(meta: dict) -> dict:
    """Compact, token-cheap on-screen vocabulary for a chart (for tool output)."""
    fields = meta.get("fields") if isinstance(meta, dict) else None
    if not isinstance(fields, dict):
        return {"measures": [], "dimensions": []}
    return {
        "measures": [
            {"label": m.get("label"), "agg": m.get("agg")}
            for m in (fields.get("measures") or [])
            if isinstance(m, dict)
        ],
        "dimensions": [
            d.get("label")
            for d in (fields.get("dimensions") or [])
            if isinstance(d, dict) and d.get("label")
        ],
    }


def compute_related_charts(chart_meta: dict) -> dict[int, list[dict]]:
    """Map each chart → other charts that SHARE a measure field.

    Used by the guide flow's chart-deep level to offer "related charts"
    chips (same measure → keeps the analysis thread). Matches by the
    field's last segment so aliased/qualified refs still link.
    """
    measures_by_chart: dict[int, dict[str, str]] = {}
    for cid, meta in (chart_meta or {}).items():
        segs: dict[str, str] = {}
        for m in ((meta or {}).get("fields") or {}).get("measures") or []:
            f = str((m or {}).get("field") or "")
            if f:
                segs[f.split(".")[-1]] = (m.get("label") or f)
        measures_by_chart[cid] = segs

    related: dict[int, list[dict]] = {}
    for cid, segs in measures_by_chart.items():
        rel: list[dict] = []
        for ocid, osegs in measures_by_chart.items():
            if ocid == cid or not segs:
                continue
            shared = set(segs) & set(osegs)
            if shared:
                rel.append({
                    "chart_id": ocid,
                    "chart_name": (chart_meta.get(ocid) or {}).get("name") or f"Chart {ocid}",
                    "shared_measure": segs.get(next(iter(shared))),
                })
        related[cid] = rel[:6]
    return related


def resolve_field_label(column: str, label_by_field: dict) -> str | None:
    """Map a raw result column to its on-screen label.

    Result columns are SQL aliases; config field refs may be fully-qualified
    (``dataset_table_47.sl_tm``). Try exact match, then match by last segment.
    """
    if not column or not isinstance(label_by_field, dict):
        return None
    if column in label_by_field:
        return label_by_field[column]
    tail = str(column).split(".")[-1]
    for field_ref, label in label_by_field.items():
        if str(field_ref).split(".")[-1] == tail:
            return label
    return None


class ToolError(Exception):
    """User-facing tool error. The message is shown to the LLM."""


@dataclass
class ToolContext:
    db: Session
    dashboard: Dashboard
    # ALREADY-MERGED filters: callers MUST pass the output of
    # api/public.py:_build_public_chart_filters (dashboard filter-pane + slicer
    # defaults + link locks, with empty/hidden entries normalized), NEVER the
    # raw DashboardPublicLink.filters_config. _fetch_chart_data applies these
    # as-is on top of each chart's base filters.
    public_filters: list[dict]
    allowed_chart_ids: set[int] = field(default_factory=set)
    chart_meta: dict[int, dict[str, Any]] = field(default_factory=dict)
    # The report's PAGE flow (the narrative the DA designed): ordered list of
    # {id, name, chart_ids}. Charts repeat across pages, so a flat chart list
    # loses this structure — surface it so the bot reads/overviews by flow.
    pages: list[dict[str, Any]] = field(default_factory=list)
    # WHO is driving this turn. "public_session" = anonymous viewer of a shared
    # link (the default and by far the common case); "user" = an authenticated
    # in-app user. Governs whether a learning the bot is told may be written as
    # truth directly or must go through the review ledger — an anonymous viewer
    # must never be able to poison the memory every later viewer reads.
    actor_type: str = "public_session"
    actor_ref: str | None = None
    # Columns the business excluded from AI via GovernAIScope, folded (no
    # diacritics, lowercase). Enforced in _fetch_chart_data so an excluded
    # column never reaches ANY tool — filtering only the prompt's field list
    # (the pre-P0-05 behaviour) left the raw values readable via get_chart_data.
    excluded_columns: set[str] = field(default_factory=set)
    #: The CURRENT step's knowledge scope, set per step by the flow engine:
    #: ``{"doc_ids": [...], "metric_names": [...]}``. Empty/absent means the step
    #: may reach everything the report is entitled to.
    #:
    #: A NARROWING only. `govern_tools` computes the security scope first and then
    #: intersects, so an author listing an id they are not entitled to gains
    #: nothing — the ceiling is not theirs to raise.
    knowledge_scope: dict[str, Any] = field(default_factory=dict)
    _chart_data_cache: dict[tuple, dict] = field(default_factory=dict)

    @classmethod
    def from_dashboard(
        cls,
        db: Session,
        dashboard: Dashboard,
        public_filters: list[dict] | None,
        *,
        actor_type: str = "public_session",
        actor_ref: str | None = None,
    ) -> "ToolContext":
        allowed: set[int] = set()
        meta: dict[int, dict[str, Any]] = {}
        # chart_id → ordered list of page ids it appears on (from tile layout).
        page_charts: dict[str, list[int]] = {}
        for dc in dashboard.dashboard_charts or []:
            if not dc.chart_id or not dc.chart:
                continue
            allowed.add(dc.chart_id)
            layout = dc.layout if isinstance(dc.layout, dict) else {}
            _pid = layout.get("page") or layout.get("pageId")
            if _pid:
                page_charts.setdefault(str(_pid), [])
                if dc.chart_id not in page_charts[str(_pid)]:
                    page_charts[str(_pid)].append(dc.chart_id)
            custom_title = layout.get("custom_title") if isinstance(layout, dict) else None
            try:
                fields = extract_chart_field_semantics(getattr(dc.chart, "config", None))
            except Exception:
                logger.warning(
                    "dashboard_ai_bot field-semantics extract failed chart_id=%s",
                    dc.chart_id,
                )
                fields = {"measures": [], "dimensions": [], "label_by_field": {}}
            meta[dc.chart_id] = {
                "name": (custom_title or getattr(dc.chart, "name", "") or f"Chart {dc.chart_id}"),
                "chart_type": str(getattr(dc.chart, "chart_type", "") or ""),
                "description": getattr(dc.chart, "description", None) or "",
                "layout": layout,
                "fields": fields,
            }
        # Build ordered page flow from pages_config, attaching each page's
        # charts (in tile order). Pages with no resolvable charts are kept
        # (empty) so the flow/narrative names still surface.
        pages: list[dict[str, Any]] = []
        for p in (getattr(dashboard, "pages_config", None) or []):
            if not isinstance(p, dict):
                continue
            pid = str(p.get("id") or "")
            cids = page_charts.get(pid, [])
            # Fallback: some configs list chart ids directly on the page.
            if not cids:
                for raw in (p.get("chartIds") or p.get("charts") or []):
                    try:
                        ci = int(raw)
                    except (TypeError, ValueError):
                        continue
                    if ci in allowed and ci not in cids:
                        cids.append(ci)
            pages.append({
                "id": pid,
                "name": str(p.get("name") or p.get("title") or pid or "Trang"),
                "chart_ids": cids,
            })

        return cls(
            db=db,
            dashboard=dashboard,
            public_filters=[f for f in (public_filters or []) if isinstance(f, dict)],
            allowed_chart_ids=allowed,
            chart_meta=meta,
            pages=pages,
            actor_type=actor_type,
            actor_ref=actor_ref,
            excluded_columns=_resolve_excluded_columns(db, dashboard),
        )

    def assert_chart_in_scope(self, chart_id: int) -> None:
        if chart_id not in self.allowed_chart_ids:
            raise ToolError(f"chart_id {chart_id} is not part of this dashboard.")


def fold_column(name: Any) -> str:
    """Diacritic-insensitive, case-insensitive key for column matching.

    Mirrors GovernanceAIService._fold so a scope authored as "Khách hàng" also
    matches a column physically named "khach_hang".
    """
    s = unicodedata.normalize("NFKD", str(name or ""))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s).strip().lower()


def _resolve_excluded_columns(db: Session, dashboard: Dashboard) -> set[str]:
    """Columns GovernAIScope hides from the AI, for the datasets behind this
    dashboard's charts. Best-effort: a resolve failure must never break a turn,
    but it MUST fail OPEN-with-a-log rather than silently pretend nothing is
    excluded on a partial read — so we log loudly.
    """
    if db is None or getattr(dashboard, "id", None) is None:
        # Unit-test / synthetic context with no metadata store to consult.
        return set()
    try:
        from app.models.dataset import DatasetTable
        from app.models.models import Chart, DashboardChart
        from app.services.governance_ai_service import GovernanceAIService

        table_ids = [
            r[0]
            for r in db.query(Chart.dataset_table_id)
            .join(DashboardChart, DashboardChart.chart_id == Chart.id)
            .filter(DashboardChart.dashboard_id == dashboard.id)
            .distinct()
            .all()
            if r[0] is not None
        ]
        if not table_ids:
            return set()
        dataset_ids = {
            t.dataset_id
            for t in db.query(DatasetTable).filter(DatasetTable.id.in_(table_ids)).all()
            if t.dataset_id
        }
        if not dataset_ids:
            return set()
        cols, _measures = GovernanceAIService.scope_exclusions(db, dataset_ids)
        return {fold_column(c) for c in cols}
    except Exception:  # noqa: BLE001
        logger.warning(
            "dashboard_ai_bot: AI-scope resolve failed dashboard_id=%s — "
            "no column exclusion applied this turn",
            getattr(dashboard, "id", None),
            exc_info=True,
        )
        return set()


def _ok(data: Any) -> dict:
    return {"ok": True, "data": data}


def _err(message: str) -> dict:
    return {"ok": False, "error": str(message)}


def _hash_filters(filters: list[dict]) -> str:
    try:
        import json
        return json.dumps(filters, sort_keys=True, default=str)
    except Exception:
        return repr(filters)


def _round(value: float | None) -> float | None:
    if value is None or not isinstance(value, (int, float)):
        return value
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return round(float(value), 4)


def _fetch_chart_data(
    ctx: ToolContext,
    chart_id: int,
    *,
    extra_filters: list[dict] | None = None,
) -> dict[str, Any]:
    """Fetch chart data honoring the dashboard's public filters.

    Returns ``{columns: list[str], rows: list[list], filters_applied: list[dict]}``.
    """
    ctx.assert_chart_in_scope(chart_id)

    merged: list[dict] = []
    for f in ctx.public_filters:
        if isinstance(f, dict):
            merged.append(dict(f))
    for f in extra_filters or []:
        if isinstance(f, dict):
            merged.append(dict(f))

    # The AI-scope exclusion set is part of the cache identity: flipping a
    # column's visibility must not be served a pre-exclusion payload.
    cache_key = (
        chart_id,
        _hash_filters(merged),
        ",".join(sorted(ctx.excluded_columns)) if ctx.excluded_columns else "",
    )
    cached = ctx._chart_data_cache.get(cache_key)
    if cached is not None:
        return cached

    result = ChartService.get_chart_data(
        ctx.db,
        chart_id,
        extra_filters=merged or None,
        filter_context="dashboard",
    )
    raw = result.get("data") if isinstance(result, dict) else None

    columns: list[str] = []
    rows: list[list] = []

    # ChartService.get_chart_data returns {"data": rows} where rows is a
    # list[dict]. Some legacy callers expect {"data": {"columns": [...],
    # "rows": [[]]}}. Normalize both so insight_pack downstream is happy.
    if isinstance(raw, dict):
        columns = [str(c) for c in (raw.get("columns") or [])]
        rows = [list(r) if isinstance(r, (list, tuple)) else [r] for r in (raw.get("rows") or [])]
    elif isinstance(raw, list):
        seen: list[str] = []
        seen_set: set[str] = set()
        for item in raw:
            if isinstance(item, dict):
                for k in item.keys():
                    if k not in seen_set:
                        seen_set.add(k)
                        seen.append(str(k))
        columns = seen
        for item in raw:
            if isinstance(item, dict):
                rows.append([item.get(c) for c in columns])
            elif isinstance(item, (list, tuple)):
                rows.append(list(item))

    # Normalize Decimal → float at the fetch boundary so EVERY downstream
    # tool sees consistent numeric types. Without this, chart-type code paths
    # that return SQL NUMERIC as Decimal (vs str/float on others) made the
    # pack's measure-detector misclassify the column as 'string' → unsorted
    # top_5 → wrong "leading segment" (ds67 HORIZONTAL_BAR revenue bug).
    from decimal import Decimal as _Decimal

    def _norm(v):
        return float(v) if isinstance(v, _Decimal) else v

    rows = [[_norm(v) for v in r] for r in rows]

    # ── AI data scope (GovernAIScope) ──────────────────────────────────────
    # Drop excluded columns from BOTH the header and every row, here at the
    # single fetch boundary, so no tool downstream can ever see the values.
    dropped: list[str] = []
    if ctx.excluded_columns and columns:
        keep_idx = [
            i for i, c in enumerate(columns) if fold_column(c) not in ctx.excluded_columns
        ]
        if len(keep_idx) != len(columns):
            dropped = [c for i, c in enumerate(columns) if i not in set(keep_idx)]
            if not keep_idx:
                # Everything this chart renders is out of the AI's scope. Fail
                # LOUD — returning an empty grid would read as "no data", and
                # the bot would happily conclude the metric is zero.
                raise ToolError(
                    f"chart {chart_id}: toàn bộ cột của biểu đồ này đã bị loại khỏi "
                    "phạm vi dữ liệu AI (Phạm vi dữ liệu AI trong Govern). "
                    "Không thể phân tích biểu đồ này."
                )
            columns = [columns[i] for i in keep_idx]
            rows = [[r[i] if i < len(r) else None for i in keep_idx] for r in rows]

    payload = {
        "columns": columns,
        "rows": rows,
        "filters_applied": merged,
    }
    if dropped:
        # Tell the caller (and through it the LLM) that something was withheld,
        # so it says "không được phép xem" instead of inventing a reason.
        payload["excluded_columns"] = dropped
    ctx._chart_data_cache[cache_key] = payload
    return payload
