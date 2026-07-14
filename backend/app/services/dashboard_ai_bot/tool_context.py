"""Shared infrastructure used by both Normal and Thinking AI bot variants.

Phase 15.77 — split the bot into two physically-separated implementations
under ``normal/`` and ``thinking/``. Both need the same low-level
primitives for reaching the chart-data layer, applying the dashboard's
public filters, and shaping the returned rows. Those primitives live
here so any future fix to the chart-fetch path lands in one place.

Exports:
  - ``ToolContext``       — per-turn context: db session, dashboard,
                             public filters, allowed chart ids, chart
                             meta cache, intra-turn result cache.
  - ``ToolError``         — raised by tools when the LLM passes a bad
                             arg (e.g. chart_id outside the dashboard).
  - ``_ok`` / ``_err``    — tool result envelope.
  - ``_fetch_chart_data`` — single source of truth for "give me this
                             chart's rows under the link's filters". The
                             auto-memory warning ("MCP/AI tools drift
                             from BE schemas") applies here; keep this
                             aligned with the public chart endpoint.
  - ``_hash_filters``     — stable hash for the intra-turn cache key.
  - ``_round``            — float rounding helper used by tool outputs
                             to keep token cost down.
  - ``MAX_ROWS_FOR_PACK`` / ``MAX_TOP_N`` — output caps.
"""
from __future__ import annotations

import logging
import math
import re
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
    # AI data-scope enforcement (Intelligence "Phạm vi dữ liệu AI"): per-turn
    # precompute. chart_id → block reason (chart exposes an excluded field), and
    # chart_id → folded excluded field-name set (post-fetch column backstop).
    ai_scope_blocked: dict[int, str] = field(default_factory=dict)
    chart_excluded: dict[int, set] = field(default_factory=dict)
    _chart_data_cache: dict[tuple, dict] = field(default_factory=dict)

    @classmethod
    def from_dashboard(
        cls, db: Session, dashboard: Dashboard, public_filters: list[dict] | None
    ) -> "ToolContext":
        allowed: set[int] = set()
        meta: dict[int, dict[str, Any]] = {}
        tbl_by_chart: dict[int, Any] = {}
        # chart_id → ordered list of page ids it appears on (from tile layout).
        page_charts: dict[str, list[int]] = {}
        for dc in dashboard.dashboard_charts or []:
            if not dc.chart_id or not dc.chart:
                continue
            allowed.add(dc.chart_id)
            tbl_by_chart[dc.chart_id] = getattr(dc.chart, "dataset_table_id", None)
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

        # ── AI data-scope enforcement (fail-closed DATA gate, not prompt-only) ──
        # If a chart exposes a field the business excluded from the AI for that
        # chart's dataset, the bot is BLOCKED from fetching its rows. This is the
        # access-control half that the prompt-context redaction (knowledge_context)
        # does not provide. Best-effort precompute: any failure leaves scope OPEN
        # (never breaks a turn) — redaction still applies. Charts with no scope
        # row are untouched (empty exclusions), so existing dashboards keep working.
        ai_scope_blocked: dict[int, str] = {}
        chart_excluded: dict[int, set] = {}
        try:
            from app.services.governance_ai_service import GovernanceAIService, _fold
            from app.models.dataset import DatasetTable

            tbl_ids = {t for t in tbl_by_chart.values() if t}
            ds_by_tbl: dict[Any, int] = {}
            if tbl_ids:
                for row in (
                    db.query(DatasetTable.id, DatasetTable.dataset_id)
                    .filter(DatasetTable.id.in_(tbl_ids)).all()
                ):
                    if row[1]:
                        ds_by_tbl[row[0]] = row[1]
            excl_by_ds: dict[int, tuple[set, set]] = {}
            for dsid in set(ds_by_tbl.values()):
                excl_by_ds[dsid] = GovernanceAIService.scope_exclusions(db, {dsid})
            for cid, tbl in tbl_by_chart.items():
                dsid = ds_by_tbl.get(tbl) if tbl else None
                if dsid is None:
                    continue
                ex_cols, ex_meas = excl_by_ds.get(dsid, (set(), set()))
                if not ex_cols and not ex_meas:
                    continue
                chart_excluded[cid] = ex_cols | ex_meas
                fields = meta.get(cid, {}).get("fields") or {}
                hit = None
                for m in (fields.get("measures") or []):
                    seg = _fold(str(m.get("field") or "").split(".")[-1])
                    if seg and (seg in ex_meas or seg in ex_cols):
                        hit = m.get("label") or seg
                        break
                if not hit:
                    for d in (fields.get("dimensions") or []):
                        seg = _fold(str(d.get("field") or "").split(".")[-1])
                        if seg and (seg in ex_cols or seg in ex_meas):
                            hit = d.get("label") or seg
                            break
                if hit:
                    ai_scope_blocked[cid] = (
                        f'Chỉ số/cột "{hit}" nằm ngoài phạm vi dữ liệu AI được phép xem '
                        f"(quản trị đã loại khỏi phạm vi AI). Không thể đọc dữ liệu biểu đồ này."
                    )
        except Exception:  # noqa: BLE001
            logger.warning("dashboard_ai_bot ai-scope precompute failed", exc_info=True)
            ai_scope_blocked = {}
            chart_excluded = {}

        return cls(
            db=db,
            dashboard=dashboard,
            public_filters=[f for f in (public_filters or []) if isinstance(f, dict)],
            allowed_chart_ids=allowed,
            chart_meta=meta,
            pages=pages,
            ai_scope_blocked=ai_scope_blocked,
            chart_excluded=chart_excluded,
        )

    def assert_chart_in_scope(self, chart_id: int) -> None:
        if chart_id not in self.allowed_chart_ids:
            raise ToolError(f"chart_id {chart_id} is not part of this dashboard.")


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

    # AI data-scope gate (fail-closed): a chart exposing an excluded field is
    # blocked BEFORE any SQL runs. Precomputed in from_dashboard.
    _blocked = ctx.ai_scope_blocked.get(chart_id)
    if _blocked:
        raise ToolError(_blocked)

    merged: list[dict] = []
    for f in ctx.public_filters:
        if isinstance(f, dict):
            merged.append(dict(f))
    for f in extra_filters or []:
        if isinstance(f, dict):
            merged.append(dict(f))

    cache_key = (chart_id, _hash_filters(merged))
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

    # AI data-scope backstop: even if the chart config didn't reveal it, a
    # RETURNED column matching an excluded name for this chart's dataset must not
    # leak to the bot. Fail-closed on the actual result shape.
    _excluded = ctx.chart_excluded.get(chart_id)
    if _excluded and columns:
        from app.services.governance_ai_service import _fold as _f
        leak = next((c for c in columns if _f(str(c).split(".")[-1]) in _excluded), None)
        if leak is not None:
            raise ToolError(f'Cột "{leak}" nằm ngoài phạm vi dữ liệu AI được phép xem.')

    payload = {
        "columns": columns,
        "rows": rows,
        "filters_applied": merged,
    }
    ctx._chart_data_cache[cache_key] = payload
    return payload
