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
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.models.models import Dashboard
from app.services.chart_service import ChartService

logger = logging.getLogger(__name__)


MAX_ROWS_FOR_PACK = 200  # internal sample for stats, not exposed to LLM
MAX_TOP_N = 50


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
    _chart_data_cache: dict[tuple, dict] = field(default_factory=dict)

    @classmethod
    def from_dashboard(
        cls, db: Session, dashboard: Dashboard, public_filters: list[dict] | None
    ) -> "ToolContext":
        allowed: set[int] = set()
        meta: dict[int, dict[str, Any]] = {}
        for dc in dashboard.dashboard_charts or []:
            if not dc.chart_id or not dc.chart:
                continue
            allowed.add(dc.chart_id)
            layout = dc.layout if isinstance(dc.layout, dict) else {}
            custom_title = layout.get("custom_title") if isinstance(layout, dict) else None
            meta[dc.chart_id] = {
                "name": (custom_title or getattr(dc.chart, "name", "") or f"Chart {dc.chart_id}"),
                "chart_type": str(getattr(dc.chart, "chart_type", "") or ""),
                "description": getattr(dc.chart, "description", None) or "",
                "layout": layout,
            }
        return cls(
            db=db,
            dashboard=dashboard,
            public_filters=[f for f in (public_filters or []) if isinstance(f, dict)],
            allowed_chart_ids=allowed,
            chart_meta=meta,
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

    payload = {
        "columns": columns,
        "rows": rows,
        "filters_applied": merged,
    }
    ctx._chart_data_cache[cache_key] = payload
    return payload
