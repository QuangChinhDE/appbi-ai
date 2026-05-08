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
    items = []
    for chart_id in sorted(ctx.allowed_chart_ids):
        meta = ctx.chart_meta.get(chart_id, {})
        # Pull row count cheaply via the same fetch (cached for the turn)
        try:
            data = _fetch_chart_data(ctx, chart_id)
            columns = data["columns"]
            total_rows = len(data["rows"])
        except Exception as exc:
            columns = []
            total_rows = 0
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
    return _ok(pack.to_dict())


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


# Registry ────────────────────────────────────────────────────────────────────

ToolFn = Callable[[ToolContext, dict], dict]

TOOLS: dict[str, ToolFn] = {
    "list_charts": tool_list_charts,
    "get_chart_summary": tool_get_chart_summary,
    "get_chart_data": tool_get_chart_data,
    "compare_segments": tool_compare_segments,
    "compute": tool_compute,
}


# JSON-Schema-ish definitions for provider tool calling. Field names follow
# OpenAI/Anthropic shape. We translate per-provider in providers/*.

TOOL_DEFINITIONS: list[dict] = [
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
]


def execute_tool(ctx: ToolContext, name: str, args: dict | None) -> dict:
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
