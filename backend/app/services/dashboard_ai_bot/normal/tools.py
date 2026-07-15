"""5-tool registry for the Normal AI bot.

Faithful to the May-8 baseline (commit e38c0bc):
  - list_charts        — manifest only (no rows)
  - get_chart_summary  — Insight Pack (deterministic stats)
  - get_chart_data     — re-aggregate / top_n on existing chart
  - compare_segments   — compare two values of a dimension
  - compute            — safe arithmetic with citation refs

No reading_plan, no advanced analytics tools, no diagnostic tools.
Everything else lives in ``thinking/tools.py`` and ``thinking/
advanced_tools.py``.

The 5 functions use ``_fetch_chart_data`` from the shared
``tool_context`` module so the chart-fetch boundary is the same
across both bot variants.
"""
from __future__ import annotations

import ast
import logging
import operator as ops
from typing import Any, Callable

from app.services.dashboard_ai_bot.insight_pack import (
    build_chart_manifest,
    build_insight_pack,
)
from app.services.dashboard_ai_bot.tool_context import (
    MAX_ROWS_FOR_PACK,
    MAX_TOP_N,
    ToolContext,
    ToolError,
    _err,
    _fetch_chart_data,
    _ok,
    _round,
    fields_block as _fields_block,
    resolve_field_label as _resolve_label,
)

logger = logging.getLogger(__name__)


# Tool: list_charts ───────────────────────────────────────────────────────────


def tool_list_charts(ctx: ToolContext, args: dict) -> dict:
    items = []
    for chart_id in sorted(ctx.allowed_chart_ids):
        meta = ctx.chart_meta.get(chart_id, {})
        try:
            data = _fetch_chart_data(ctx, chart_id)
            columns = data["columns"]
            total_rows = len(data["rows"])
        except Exception as exc:
            logger.warning(
                "normal list_charts fetch failed chart_id=%s err=%s",
                chart_id, type(exc).__name__,
            )
            columns = []
            total_rows = 0
            meta = {**meta, "error": str(exc)[:200]}

        manifest = build_chart_manifest(
            chart_id=chart_id,
            chart_name=meta.get("name", f"Chart {chart_id}"),
            chart_type=meta.get("chart_type", ""),
            description=meta.get("description", ""),
            columns=columns,
            total_rows=total_rows,
            filters_applied=ctx.public_filters,
        )
        manifest["fields"] = _fields_block(meta)
        items.append(manifest)
    return _ok({
        "dashboard_name": ctx.dashboard.name or "",
        "dashboard_description": getattr(ctx.dashboard, "description", "") or "",
        "filters_applied": ctx.public_filters,
        "pages": ctx.pages,
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
        logger.exception("normal get_chart_summary failed chart_id=%s", chart_id)
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
        logger.exception("normal build_insight_pack failed chart_id=%s", chart_id)
        return _err(f"failed to summarize chart {chart_id}: {type(exc).__name__}: {exc}")
    pack_dict = pack.to_dict()
    # On-screen vocabulary: name numbers by viewer-facing labels + aggregation.
    pack_dict["fields"] = _fields_block(meta)
    label_by_field = (meta.get("fields") or {}).get("label_by_field") or {}
    pm_label = _resolve_label(pack_dict.get("primary_measure") or "", label_by_field)
    pd_label = _resolve_label(pack_dict.get("primary_dimension") or "", label_by_field)
    if pm_label:
        pack_dict["primary_measure_label"] = pm_label
    if pd_label:
        pack_dict["primary_dimension_label"] = pd_label
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

    sort = args.get("sort")
    sort_by = args.get("sort_by")

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        logger.exception("normal get_chart_data failed chart_id=%s", chart_id)
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
    measure = args.get("measure")

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


# Tool: compute ────────────────────────────────────────────────────────────────

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


TOOL_DEFINITIONS: list[dict] = [
    {
        "name": "list_charts",
        "description": (
            "List all charts in the dashboard with their columns, row counts "
            "and currently-applied filters. Returns no row data — call "
            "get_chart_summary or get_chart_data to drill into a specific chart."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_chart_summary",
        "description": (
            "Return a deterministic Insight Pack for one chart: per-column "
            "stats, top-5 / bottom-5 rows by primary measure, trend "
            "direction & % change if there is a time dimension, outliers, "
            "and the filters in effect. ALWAYS call this before quoting "
            "numbers from a chart."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"chart_id": {"type": "integer"}},
            "required": ["chart_id"],
        },
    },
    {
        "name": "get_chart_data",
        "description": (
            "Return rows from one chart, optionally re-sorted and truncated "
            "to top_n. Use this to fetch specific values you need to cite."
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
            "Q1 vs Q2 revenue. Returns metric for each segment plus "
            "absolute delta and % change."
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
            "any computation derived from previous tool results — never in "
            "your head. Supports + - * / % ** //. Pass `citations` listing "
            "where each variable came from."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "expression": {"type": "string"},
                "vars": {"type": "object", "additionalProperties": {"type": "number"}},
                "citations": {"type": "array", "items": {"type": "string"}},
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
        return _err(f"tool '{name}' raised {type(exc).__name__}: {str(exc)[:200]}")


# ── Learning tools ──────────────────────────────────────────────────────────
# Teaching + recall must work in Normal mode too (the router may keep a
# "remember: …" instruction here). Same handlers as the Thinking variant.
from app.services.dashboard_ai_bot.knowledge import (  # noqa: E402
    KNOWLEDGE_TOOL_DEFS,
    KNOWLEDGE_TOOLS,
)

TOOLS.update(KNOWLEDGE_TOOLS)
TOOL_DEFINITIONS.extend(KNOWLEDGE_TOOL_DEFS)
