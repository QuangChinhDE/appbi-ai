"""Agent tools for the Dashboard AI Bot.

Five tools, all scoped to a single public dashboard token:

  - list_charts                : manifest only (no rows)
  - get_chart_summary          : Insight Pack (deterministic stats)
  - get_chart_data             : re-aggregate / top_n on existing chart
  - compare_segments           : compare two values of a dimension
  - compute                    : safe arithmetic with citation refs

Every tool execution carries a ``ToolContext`` which holds the dashboard's
public filters. These filters are ALWAYS merged into the underlying chart
query — so "what the dashboard sees" is exactly what the AI sees.
"""
from __future__ import annotations

import ast
import logging
import math
import operator as ops
from dataclasses import dataclass, field
from typing import Any, Callable

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.models.models import Dashboard
from app.services.chart_service import ChartService
from app.services.dashboard_ai_bot.insight_pack import (
    build_chart_manifest,
    build_insight_pack,
)


# Constants ───────────────────────────────────────────────────────────────────

MAX_ROWS_FOR_PACK = 200  # internal sample for stats, not exposed to LLM
MAX_TOP_N = 50


# Context ─────────────────────────────────────────────────────────────────────


@dataclass
class ToolContext:
    db: Session
    dashboard: Dashboard
    public_filters: list[dict]  # the filters the dashboard is currently showing
    allowed_chart_ids: set[int] = field(default_factory=set)
    chart_meta: dict[int, dict[str, Any]] = field(default_factory=dict)
    # Cache so repeated calls don't re-hit the DB unnecessarily within a turn
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
            raise ToolError(
                f"chart_id {chart_id} is not part of this dashboard."
            )


class ToolError(Exception):
    """User-facing tool error. The message is shown to the LLM."""


# Tool result envelope ─────────────────────────────────────────────────────────


def _ok(data: Any) -> dict:
    return {"ok": True, "data": data}


def _err(message: str) -> dict:
    return {"ok": False, "error": str(message)}


# Internal: chart data fetch with public_filters always applied ───────────────


def _fetch_chart_data(
    ctx: ToolContext,
    chart_id: int,
    *,
    extra_filters: list[dict] | None = None,
) -> dict[str, Any]:
    """Fetch chart data honoring the dashboard's public filters.

    Returns a dict with keys: ``columns`` (list[str]), ``rows`` (list[list]),
    ``filters_applied`` (list[dict]).
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
    # list[dict]. Some legacy callers expect {"data": {"columns": [...], "rows": [[]]}}.
    # Normalize both shapes here so downstream insight pack code is happy.
    if isinstance(raw, dict):
        columns = [str(c) for c in (raw.get("columns") or [])]
        rows = [list(r) if isinstance(r, (list, tuple)) else [r] for r in (raw.get("rows") or [])]
    elif isinstance(raw, list):
        # Discover columns from the first non-empty dict, falling back to dict keys union.
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


def _hash_filters(filters: list[dict]) -> str:
    try:
        import json
        return json.dumps(filters, sort_keys=True, default=str)
    except Exception:
        return repr(filters)


# Tool: list_charts ───────────────────────────────────────────────────────────


def tool_list_charts(ctx: ToolContext, args: dict) -> dict:
    # ``light=True`` skips per-chart data fetches and returns only metadata
    # (name, type, description, declared filters). Used by the recon endpoint
    # at chat-open time to avoid blocking on N live SQL queries when the
    # dashboard has many charts. The agent can still call
    # ``get_chart_summary`` lazily on the chart it actually needs.
    light = bool(args.get("light"))
    items = []
    for chart_id in sorted(ctx.allowed_chart_ids):
        meta = ctx.chart_meta.get(chart_id, {})
        columns: list[str] = []
        total_rows = 0
        if not light:
            # Pull row count via the same fetch (cached for the turn)
            try:
                data = _fetch_chart_data(ctx, chart_id)
                columns = data["columns"]
                total_rows = len(data["rows"])
            except Exception as exc:
                logger.warning(
                    "dashboard_ai_bot list_charts fetch failed chart_id=%s err=%s",
                    chart_id,
                    type(exc).__name__,
                )
                meta = {**meta, "error": str(exc)[:200]}

        items.append(
            build_chart_manifest(
                chart_id=chart_id,
                chart_name=meta.get("name", f"Chart {chart_id}"),
                chart_type=meta.get("chart_type", ""),
                description=meta.get("description", ""),
                columns=columns,
                total_rows=total_rows,
                filters_applied=ctx.public_filters,
            )
        )
    return _ok({
        "dashboard_name": ctx.dashboard.name or "",
        "dashboard_description": getattr(ctx.dashboard, "description", "") or "",
        "filters_applied": ctx.public_filters,
        "charts": items,
    })


# Tool: get_chart_summary ─────────────────────────────────────────────────────


def tool_get_chart_summary(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    # Phase 15.72 — cross-turn LRU. Turn-2 with the same dashboard +
    # filters lands on cached pack instantly, avoiding the live SQL +
    # stats rebuild.
    from app.services.dashboard_ai_bot.summary_cache import (
        get_cached_pack,
        put_cached_pack,
    )

    dashboard_id = getattr(ctx.dashboard, "id", None)
    if isinstance(dashboard_id, int):
        cached = get_cached_pack(dashboard_id, ctx.public_filters, chart_id)
        if cached is not None:
            logger.debug(
                "dashboard_ai_bot summary cache HIT dashboard_id=%s chart_id=%s",
                dashboard_id, chart_id,
            )
            return _ok(dict(cached))

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        logger.exception("dashboard_ai_bot get_chart_summary failed chart_id=%s", chart_id)
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}: {exc}")

    meta = ctx.chart_meta.get(chart_id, {})
    try:
        pack = build_insight_pack(
            chart_id=chart_id,
            chart_name=meta.get("name", f"Chart {chart_id}"),
            chart_type=meta.get("chart_type", ""),
            description=meta.get("description", ""),
            columns=data["columns"],
            rows=data["rows"][:MAX_ROWS_FOR_PACK],
            total_rows=len(data["rows"]),
            filters_applied=data["filters_applied"],
        )
    except Exception as exc:
        logger.exception("dashboard_ai_bot build_insight_pack failed chart_id=%s", chart_id)
        return _err(f"failed to summarize chart {chart_id}: {type(exc).__name__}: {exc}")
    pack_dict = pack.to_dict()
    if isinstance(dashboard_id, int):
        put_cached_pack(dashboard_id, ctx.public_filters, chart_id, pack_dict)
    return _ok(pack_dict)


# Tool: get_chart_data ────────────────────────────────────────────────────────


def tool_get_chart_data(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    top_n = args.get("top_n")
    if top_n is not None and (not isinstance(top_n, int) or top_n <= 0):
        return _err("top_n must be a positive integer")
    if isinstance(top_n, int):
        top_n = min(top_n, MAX_TOP_N)

    sort = args.get("sort")  # "asc" | "desc" | None
    sort_by = args.get("sort_by")  # column name

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        logger.exception("dashboard_ai_bot get_chart_data failed chart_id=%s", chart_id)
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}: {exc}")

    columns: list[str] = data["columns"]
    rows: list[list] = data["rows"]

    if sort and sort_by:
        if sort_by not in columns:
            return _err(f"sort_by '{sort_by}' not in columns {columns}")
        idx = columns.index(sort_by)
        rev = (sort == "desc")
        try:
            rows = sorted(
                rows,
                key=lambda r: (
                    r[idx] is None,
                    _coerce_for_sort(r[idx]) if idx < len(r) else None,
                ),
                reverse=rev,
            )
        except TypeError:
            # Mixed types — fall back to string-cast
            rows = sorted(
                rows,
                key=lambda r: ("" if (idx >= len(r) or r[idx] is None) else str(r[idx])),
                reverse=rev,
            )

    if isinstance(top_n, int):
        rows = rows[:top_n]

    return _ok({
        "chart_id": chart_id,
        "columns": columns,
        "rows": rows,
        "row_count": len(rows),
        "filters_applied": data["filters_applied"],
    })


def _coerce_for_sort(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        try:
            return float(v)
        except (TypeError, ValueError):
            return v
    return v


# Tool: compare_segments ──────────────────────────────────────────────────────


def tool_compare_segments(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    dimension = args.get("dimension")
    segment_a = args.get("segment_a")
    segment_b = args.get("segment_b")
    measure = args.get("measure")  # optional, autodetect if absent

    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    if not isinstance(dimension, str) or not dimension:
        return _err("dimension (str) is required")
    if segment_a is None or segment_b is None:
        return _err("segment_a and segment_b are required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

    columns = data["columns"]
    rows = data["rows"]
    if dimension not in columns:
        return _err(f"dimension '{dimension}' not in columns {columns}")
    dim_idx = columns.index(dimension)

    # Pick measure: explicit or last numeric column != dimension
    measure_idx: int | None = None
    if measure and measure in columns and measure != dimension:
        measure_idx = columns.index(measure)
    else:
        for i in range(len(columns) - 1, -1, -1):
            if i == dim_idx:
                continue
            sample = next(
                (r[i] for r in rows if i < len(r) and r[i] is not None),
                None,
            )
            if isinstance(sample, (int, float)):
                measure_idx = i
                break
            if isinstance(sample, str):
                try:
                    float(sample)
                    measure_idx = i
                    break
                except (TypeError, ValueError):
                    continue
    if measure_idx is None:
        return _err("no numeric measure column detected; pass `measure`")

    def _agg(target: Any) -> tuple[float | None, int]:
        total = 0.0
        count = 0
        for r in rows:
            if dim_idx >= len(r) or measure_idx >= len(r):
                continue
            if str(r[dim_idx]) != str(target):
                continue
            try:
                total += float(r[measure_idx]) if r[measure_idx] is not None else 0.0
                count += 1
            except (TypeError, ValueError):
                continue
        return (total if count else None, count)

    a_val, a_count = _agg(segment_a)
    b_val, b_count = _agg(segment_b)

    if a_val is None or b_val is None:
        return _err(
            f"segment not found: a={segment_a!r} ({a_count} rows), "
            f"b={segment_b!r} ({b_count} rows)"
        )

    delta = a_val - b_val
    pct = None if b_val == 0 else (delta / abs(b_val)) * 100.0

    return _ok({
        "chart_id": chart_id,
        "dimension": dimension,
        "measure": columns[measure_idx],
        "segment_a": {"value": segment_a, "metric": _round(a_val), "rows": a_count},
        "segment_b": {"value": segment_b, "metric": _round(b_val), "rows": b_count},
        "delta": _round(delta),
        "pct_change_vs_b": _round(pct),
    })


def _round(value: float | None) -> float | None:
    if value is None or not isinstance(value, (int, float)):
        return value
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return round(float(value), 4)


# Tool: compute ────────────────────────────────────────────────────────────────
#
# Safe arithmetic evaluator. AI passes an expression like "(a-b)/b*100" with
# `vars` mapping names → numbers. The numbers MUST come from prior tool
# results (the agent is responsible for citing) — we only enforce arithmetic
# safety here.

_ALLOWED_BINOPS: dict[type, Callable[[Any, Any], Any]] = {
    ast.Add: ops.add,
    ast.Sub: ops.sub,
    ast.Mult: ops.mul,
    ast.Div: ops.truediv,
    ast.Mod: ops.mod,
    ast.Pow: ops.pow,
    ast.FloorDiv: ops.floordiv,
}
_ALLOWED_UNARY: dict[type, Callable[[Any], Any]] = {
    ast.UAdd: ops.pos,
    ast.USub: ops.neg,
}


def _safe_eval(node: ast.AST, vars_: dict[str, float]) -> float:
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body, vars_)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return float(node.value)
        raise ToolError(f"unsupported constant: {node.value!r}")
    if isinstance(node, ast.Name):
        if node.id not in vars_:
            raise ToolError(f"undefined variable: {node.id}")
        return float(vars_[node.id])
    if isinstance(node, ast.BinOp):
        op_fn = _ALLOWED_BINOPS.get(type(node.op))
        if op_fn is None:
            raise ToolError(f"operator not allowed: {type(node.op).__name__}")
        return op_fn(_safe_eval(node.left, vars_), _safe_eval(node.right, vars_))
    if isinstance(node, ast.UnaryOp):
        op_fn = _ALLOWED_UNARY.get(type(node.op))
        if op_fn is None:
            raise ToolError(f"unary not allowed: {type(node.op).__name__}")
        return op_fn(_safe_eval(node.operand, vars_))
    raise ToolError(f"unsupported expression: {ast.dump(node)}")


def tool_compute(ctx: ToolContext, args: dict) -> dict:
    expression = args.get("expression")
    vars_ = args.get("vars") or {}
    citations = args.get("citations") or []
    if not isinstance(expression, str) or not expression.strip():
        return _err("expression (str) is required")
    if not isinstance(vars_, dict):
        return _err("vars must be an object of {name: number}")

    clean_vars: dict[str, float] = {}
    for k, v in vars_.items():
        try:
            clean_vars[str(k)] = float(v)
        except (TypeError, ValueError):
            return _err(f"vars[{k!r}] must be numeric")

    try:
        tree = ast.parse(expression, mode="eval")
        result = _safe_eval(tree, clean_vars)
    except ToolError as exc:
        return _err(str(exc))
    except SyntaxError as exc:
        return _err(f"invalid expression syntax: {exc.msg}")
    except ZeroDivisionError:
        return _err("division by zero")
    except Exception as exc:
        return _err(f"evaluation failed: {type(exc).__name__}")

    return _ok({
        "expression": expression,
        "vars": clean_vars,
        "result": _round(result),
        "citations": citations,
    })


def tool_emit_reading_plan(ctx: ToolContext, args: dict) -> dict:
    """Phase-15.71 — pseudo-tool. Validates and echoes back the
    structured reading plan. The agent loop intercepts the result and
    emits an SSE ``reading_plan`` event to the FE; the LLM gets a
    plain ack so it continues to the actual data calls.

    Validation:
      - items must be a non-empty list of dicts
      - chart_id (if present) must be in allowed_chart_ids
      - phase must match the enum
    """
    raw_items = args.get("items") if isinstance(args, dict) else None
    if not isinstance(raw_items, list) or not raw_items:
        return _err("emit_reading_plan: items phải là list non-empty.")
    allowed_phases = {"triage", "health_check", "drilldown", "compare", "synthesize"}
    cleaned: list[dict] = []
    for i, item in enumerate(raw_items):
        if not isinstance(item, dict):
            continue
        phase = str(item.get("phase") or "").strip().lower()
        if phase not in allowed_phases:
            phase = "triage"
        question = str(item.get("question") or "").strip()
        if not question:
            continue
        cid_raw = item.get("chart_id")
        cid: int | None = None
        if cid_raw is not None:
            try:
                cid_int = int(cid_raw)
                # Silently drop charts outside this dashboard rather
                # than fail the whole plan — the LLM might hallucinate
                # an id and we'd rather let the rest of the plan flow.
                if cid_int in ctx.allowed_chart_ids:
                    cid = cid_int
            except (TypeError, ValueError):
                pass
        cleaned.append({
            "step": i + 1,
            "chart_id": cid,
            "phase": phase,
            "question": question,
        })
    if not cleaned:
        return _err("emit_reading_plan: không có item hợp lệ sau khi validate.")
    overall_goal = str(args.get("overall_goal") or "").strip()
    return _ok({
        "items": cleaned,
        "overall_goal": overall_goal or None,
        "ack": f"Plan ghi nhận — {len(cleaned)} bước. Tiếp tục đọc dữ liệu theo thứ tự.",
    })


# Registry ────────────────────────────────────────────────────────────────────

ToolFn = Callable[[ToolContext, dict], dict]

TOOLS: dict[str, ToolFn] = {
    "emit_reading_plan": tool_emit_reading_plan,
    "list_charts": tool_list_charts,
    "get_chart_summary": tool_get_chart_summary,
    "get_chart_data": tool_get_chart_data,
    "compare_segments": tool_compare_segments,
    "compute": tool_compute,
}


def _register_advanced_tools() -> None:
    """Late import + register so we never form a circular import.

    advanced_tools.py imports helpers from THIS module (``_fetch_chart_data``,
    ``_ok`` etc.). If we import advanced_tools at module top, ``import tools``
    would re-enter ``import advanced_tools`` mid-load and ImportError. Instead
    we register on first ``execute_tool`` call and on ``TOOL_DEFINITIONS``
    materialisation.
    """
    if "compare_periods" in TOOLS:
        return
    from app.services.dashboard_ai_bot.advanced_tools import (
        tool_aggregate_chart_data,
        tool_compare_periods,
        tool_correlate_charts,
        tool_describe_distribution,
        tool_detect_anomaly,
        tool_get_dashboard_overview_image,
        tool_get_chart_image,
        tool_smart_drilldown,
    )
    TOOLS["compare_periods"] = tool_compare_periods
    TOOLS["describe_distribution"] = tool_describe_distribution
    TOOLS["correlate_charts"] = tool_correlate_charts
    TOOLS["detect_anomaly"] = tool_detect_anomaly
    TOOLS["get_dashboard_overview_image"] = tool_get_dashboard_overview_image
    TOOLS["get_chart_image"] = tool_get_chart_image
    TOOLS["smart_drilldown"] = tool_smart_drilldown
    TOOLS["aggregate_chart_data"] = tool_aggregate_chart_data


# JSON-Schema-ish definitions for provider tool calling. Field names follow
# OpenAI/Anthropic shape. We translate per-provider in providers/*.

TOOL_DEFINITIONS: list[dict] = [
    {
        # Phase-15.71 — pseudo-tool: the LLM uses this to declare WHICH
        # charts it will read and WHY, BEFORE pulling data. The agent
        # loop catches the call, emits a `reading_plan` SSE event to the
        # FE (which renders a collapsible "AI đang đọc dashboard" panel)
        # and returns ack so the LLM continues with the actual analysis.
        # This makes the analyst-style reasoning VISIBLE — user sees the
        # report flow, not just the final answer.
        "name": "emit_reading_plan",
        "description": (
            "ALWAYS call this FIRST for any non-trivial question (skip "
            "only for one-liner greetings). Declare the chart-by-chart "
            "reading plan BEFORE fetching data so the user can follow "
            "your analyst flow. Items should reflect the dashboard's "
            "narrative order — KPI overviews first, then drill-down "
            "breakdowns, then outliers/correlations. After this call, "
            "proceed with get_chart_summary / get_chart_data on each "
            "chart in turn."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "description": "Ordered reading steps.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "chart_id": {
                                "type": "integer",
                                "description": "Chart to read next (must be in the dashboard).",
                            },
                            "phase": {
                                "type": "string",
                                "enum": ["triage", "health_check", "drilldown", "compare", "synthesize"],
                                "description": (
                                    "What this step achieves. triage = quick scan to "
                                    "rule charts in/out; health_check = is the KPI good/bad; "
                                    "drilldown = examine breakdown rows; compare = vs period/segment; "
                                    "synthesize = combine findings across charts."
                                ),
                            },
                            "question": {
                                "type": "string",
                                "description": "The specific analyst question this step answers (one sentence in Vietnamese).",
                            },
                        },
                        "required": ["phase", "question"],
                    },
                },
                "overall_goal": {
                    "type": "string",
                    "description": "One sentence summarising what the whole reading should produce.",
                },
            },
            "required": ["items"],
        },
    },
    {
        "name": "list_charts",
        "description": (
            "List all charts in the dashboard with their columns, row counts "
            "and currently-applied filters. Returns no row data — call "
            "get_chart_summary or get_chart_data to drill into a specific chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "get_chart_summary",
        "description": (
            "Return a deterministic Insight Pack for one chart: per-column "
            "stats (total/min/max/avg/median, top values), top-5 and bottom-5 "
            "rows by primary measure, trend direction & % change if there is "
            "a time dimension, outlier rows, and the filters in effect. "
            "ALWAYS call this before quoting numbers from a chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
            },
            "required": ["chart_id"],
        },
    },
    {
        "name": "get_chart_data",
        "description": (
            "Return rows from one chart, optionally re-sorted and truncated "
            "to top_n. The chart's own dimension/measure/filter definition "
            "is unchanged — you cannot ask for a different breakdown here. "
            "Use this to fetch specific values you need to cite."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
                "top_n": {"type": "integer", "description": f"Cap rows (max {MAX_TOP_N})"},
                "sort": {"type": "string", "enum": ["asc", "desc"]},
                "sort_by": {"type": "string", "description": "Column name to sort by"},
            },
            "required": ["chart_id"],
        },
    },
    {
        "name": "compare_segments",
        "description": (
            "Compare two values of a dimension within one chart, e.g. "
            "Q1 vs Q2 revenue. Returns the metric for each segment plus "
            "absolute delta and % change. The chart's primary numeric "
            "measure is used unless `measure` is provided."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
                "dimension": {"type": "string"},
                "segment_a": {},
                "segment_b": {},
                "measure": {"type": "string", "description": "Optional column name"},
            },
            "required": ["chart_id", "dimension", "segment_a", "segment_b"],
        },
    },
    {
        "name": "compute",
        "description": (
            "Evaluate an arithmetic expression over named variables. Use for "
            "any computation derived from numbers you got from previous tool "
            "results — never compute in your head. Supports + - * / % ** //. "
            "Pass `citations` listing where each variable came from."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "expression": {"type": "string"},
                "vars": {
                    "type": "object",
                    "additionalProperties": {"type": "number"},
                },
                "citations": {
                    "type": "array",
                    "items": {"type": "string"},
                },
            },
            "required": ["expression", "vars"],
        },
    },
    # ── Phase C: advanced analytical tools ────────────────────────────────
    {
        "name": "compare_periods",
        "description": (
            "Compare a chart's measure across two time periods. Modes: 'auto' "
            "or 'mom' = last vs prior point; 'qoq' = last vs 3 points back; "
            "'yoy' = last vs 12 points back; 'custom' = pass period_a / "
            "period_b (literal labels in the time dimension). Returns delta, "
            "pct_change, and a verdict (improving/worsening/flat). Use this "
            "INSTEAD of compare_segments when comparing the same metric across "
            "time."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
                "mode": {"type": "string", "enum": ["auto", "mom", "qoq", "yoy", "custom"]},
                "period_a": {"type": "string", "description": "Required for mode=custom"},
                "period_b": {"type": "string", "description": "Required for mode=custom"},
            },
            "required": ["chart_id"],
        },
    },
    {
        "name": "describe_distribution",
        "description": (
            "Return distribution stats for a chart's primary measure: P50/P90/"
            "P95, mean, std, skewness, Gini coefficient, top-10% / top-20% "
            "share of total, and the % of segments needed to reach 80% (Pareto "
            "threshold). Use when the question is about CONCENTRATION ("
            "'tập trung vào nhóm nào', 'phân phối có đều không', 'có long tail "
            "không')."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
            },
            "required": ["chart_id"],
        },
    },
    {
        "name": "correlate_charts",
        "description": (
            "Correlate two charts that share a common DIMENSION column (same "
            "name in both). Pass chart_a, chart_b, and 'on' = column name. "
            "Returns Pearson and Spearman coefficients on the values that "
            "appear in BOTH. Use when the user asks 'liệu A có liên quan tới "
            "B không' or for cross-chart hypothesis testing."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_a": {"type": "integer"},
                "chart_b": {"type": "integer"},
                "on": {"type": "string", "description": "Column name shared by both charts"},
            },
            "required": ["chart_a", "chart_b", "on"],
        },
    },
    {
        "name": "detect_anomaly",
        "description": (
            "Find outlier rows / points. method='zscore' (|z|≥threshold, default "
            "2), 'iqr' (Tukey fences), 'rolling' (rolling z over a time series, "
            "window=3), or 'changepoint' (find a meaningful shift in level over "
            "time). Use when the user asks 'có gì bất thường', 'spike', "
            "'breakout'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
                "method": {"type": "string", "enum": ["zscore", "iqr", "rolling", "changepoint"]},
                "threshold": {"type": "number", "description": "Optional override for zscore"},
            },
            "required": ["chart_id"],
        },
    },
    # ── Phase I: smart drilldown on user-named segment ──────────────────
    {
        "name": "smart_drilldown",
        "description": (
            "Filter the rows of one chart by a named column = value, then "
            "rank by the chart's primary measure. Use when the user asks "
            "for a specific segment ('chỉ phòng IT', 'khách hàng VIP', "
            "'task của user X'). Ops: eq, neq, contains, startswith, gt, "
            "lt, gte, lte. Returns matching rows + totals on the measure."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
                "column": {"type": "string"},
                "match": {"description": "Value to match (string or number)"},
                "op": {"type": "string", "enum": ["eq", "ne", "contains", "starts_with", "gt", "lt", "gte", "lte"]},
                "top_n": {"type": "integer"},
            },
            "required": ["chart_id", "column", "match"],
        },
    },
    # ── Phase J: group-by aggregation over a chart's rows ────────────────
    {
        "name": "aggregate_chart_data",
        "description": (
            "GROUP BY one or more columns of a chart's rows and compute "
            "aggregations (count, count_truthy, count_distinct, sum, avg, "
            "min, max, ratio_truthy, ratio_truthy_pct). Use this whenever "
            "the user asks for a derived breakdown that the chart does NOT "
            "already display directly — e.g. 'top phòng ban có tỷ lệ task "
            "quá hạn cao nhất' on a Priority Task List that has one row per "
            "task carrying both `department_name` and `is_overdue`. Pass "
            "`group_by` (1-3 columns), `aggregations` (each with `column` "
            "and `op`; column='*' allowed only with op='count'), optional "
            "`filters` (row-level pre-filter), `sort_by` (output column), "
            "`order` (asc/desc), and `top_n`. Returns aggregated rows + "
            "totals across the population so you can frame relative shares "
            "without an extra `compute` call."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
                "group_by": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Categorical column(s) to group by (1-3).",
                },
                "aggregations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": {
                                "type": "string",
                                "description": "Source column name. Use '*' with op='count' to count all rows.",
                            },
                            "op": {
                                "type": "string",
                                "enum": [
                                    "count", "count_truthy", "count_distinct",
                                    "sum", "avg", "min", "max",
                                    "ratio_truthy", "ratio_truthy_pct",
                                ],
                            },
                            "as": {
                                "type": "string",
                                "description": "Optional output column name; defaults to '{op}_{column}'.",
                            },
                        },
                        "required": ["column", "op"],
                    },
                },
                "filters": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": {"type": "string"},
                            "op": {
                                "type": "string",
                                "enum": ["eq", "neq", "contains", "truthy", "falsy", "not_null"],
                            },
                            "value": {},
                        },
                        "required": ["column", "op"],
                    },
                },
                "sort_by": {"type": "string", "description": "Output column to sort by."},
                "order": {"type": "string", "enum": ["asc", "desc"]},
                "top_n": {"type": "integer", "description": f"Cap rows (max {MAX_TOP_N})."},
            },
            "required": ["chart_id", "group_by", "aggregations"],
        },
    },
    # ── Phase D: visual perception ───────────────────────────────────────
    {
        "name": "get_dashboard_overview_image",
        "description": (
            "Render one overview PNG of the whole dashboard/report surface "
            "using the current public filters and chart layout/order. Active "
            "filters are stamped on the image so you know what you're looking "
            "at. Use this when the user asks to look at the report visually, "
            "review the overall dashboard from a viewer/user perspective, or "
            "asks for a screenshot-style analysis instead of only numbers. "
            "ONE call per turn is enough — its output stays in the message "
            "history; do not re-invoke."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "max_charts": {
                    "type": "integer",
                    "description": "Optional cap on charts included in the overview image; default 12.",
                },
                "page_id": {
                    "type": "string",
                    "description": "Optional dashboard page id. Use only when the user asks about a specific page of a multi-page dashboard.",
                },
            },
        },
    },
    {
        "name": "get_chart_image",
        "description": (
            "Render a tiny ASCII sparkline + shape summary for a chart so you "
            "can REASON ABOUT THE SHAPE (not just numbers). Useful when the "
            "user asks about trend shape: 'có flatten ở cuối không', 'có spike "
            "đột biến không', 'biến động mạnh không'. Return includes a unicode "
            "block sparkline and a one-line shape diagnosis."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
            },
            "required": ["chart_id"],
        },
    },
]


# Eagerly register at import time when the cycle is not active. If we are
# being imported FROM advanced_tools.py (the partial-module case), this call
# raises ImportError — we swallow it; ``execute_tool`` will retry.
try:
    _register_advanced_tools()
except ImportError:
    pass


def execute_tool(ctx: ToolContext, name: str, args: dict | None) -> dict:
    _register_advanced_tools()
    fn = TOOLS.get(name)
    if fn is None:
        return _err(f"unknown tool: {name}")
    try:
        return fn(ctx, args or {})
    except ToolError as exc:
        return _err(str(exc))
    except Exception as exc:
        # Don't leak stack traces to the LLM
        return _err(f"tool '{name}' raised {type(exc).__name__}: {str(exc)[:200]}")
