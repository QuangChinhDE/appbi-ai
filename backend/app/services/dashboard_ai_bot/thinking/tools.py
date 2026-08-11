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
from typing import Any, Callable

logger = logging.getLogger(__name__)

from app.services.dashboard_ai_bot.insight_pack import (
    build_chart_manifest,
    build_insight_pack,
)
# Phase 15.77 — shared infrastructure (ToolContext, _fetch_chart_data,
# helpers) lives at the top-level so the sibling ``normal/`` variant
# uses the SAME chart-fetch path. Drift in this layer was the root
# cause of the empty-data bug, so keep one source of truth.
from app.services.dashboard_ai_bot.tool_context import (
    MAX_ROWS_FOR_PACK,
    MAX_TOP_N,
    ToolContext,
    ToolError,
    _err,
    _fetch_chart_data,
    _hash_filters,
    _ok,
    _round,
    compute_related_charts as _compute_related_charts,
    fields_block as _fields_block,
    resolve_field_label as _resolve_label,
)


# On-screen vocabulary helpers (_fields_block, _resolve_label) are imported
# from tool_context so the normal/ variant shares one source of truth.


# Tool: list_charts ───────────────────────────────────────────────────────────


def tool_list_charts(ctx: ToolContext, args: dict) -> dict:
    # ``light=True`` skips per-chart data fetches and returns only metadata
    # (name, type, description, declared filters). Used by the recon endpoint
    # at chat-open time to avoid blocking on N live SQL queries when the
    # dashboard has many charts. The agent can still call
    # ``get_chart_summary`` lazily on the chart it actually needs.
    #
    # Phase 15.74 — light mode now reports total_rows=None (unknown), NOT
    # 0. Reporting 0 silently misled the LLM into thinking the dashboard
    # was empty when in fact we just hadn't checked yet. recon backfills
    # the real count from each parallel summary fetch when those succeed.
    light = bool(args.get("light"))

    # WHICH charts, and HOW MUCH about each.
    #
    # MEASURED: on a 70-chart dashboard this tool returned ~15,600 tokens while
    # declaring itself `cheap`. It is cheap in warehouse terms — it queries
    # nothing — and ruinous in the currency an agent actually spends, because the
    # whole listing is pasted into a prompt. Cost class only ever described one of
    # the two axes, and this was the tool where the other one mattered most.
    #
    # So the listing is now scopeable to one page (a report's own unit of
    # narrative) and compact by default. `full` restores the previous payload for
    # a caller that genuinely wants every manifest.
    detail = str(args.get("detail") or "compact").lower()
    if detail not in ("compact", "full"):
        return _err("detail must be 'compact' or 'full'")
    page_arg = args.get("page")
    if page_arg is not None and not isinstance(page_arg, (str, int)):
        return _err("page must be a page id or name")

    every = sorted(ctx.allowed_chart_ids)
    wanted = every
    page_used = None
    if page_arg is not None:
        needle = str(page_arg).strip().lower()
        for page in ctx.pages or []:
            pid = str(page.get("id") or "").lower()
            pname = str(page.get("name") or "").lower()
            if needle in (pid, pname) or (needle and needle in pname):
                allowed = set(page.get("chart_ids") or [])
                wanted = [c for c in every if c in allowed]
                page_used = page.get("name") or page.get("id")
                break
        else:
            return _err(
                f"page '{page_arg}' not found. Available: "
                + ", ".join(str(p.get("name") or p.get("id")) for p in (ctx.pages or []))
            )

    items = []
    for chart_id in wanted:
        meta = ctx.chart_meta.get(chart_id, {})
        columns: list[str] = []
        total_rows: int | None = None
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

        manifest = build_chart_manifest(
            chart_id=chart_id,
            chart_name=meta.get("name", f"Chart {chart_id}"),
            chart_type=meta.get("chart_type", ""),
            description=meta.get("description", ""),
            columns=columns,
            total_rows=total_rows,
            filters_applied=ctx.public_filters,
        )
        # On-screen vocabulary (configured measures + their aggregation, and
        # dimension labels) so the agent triages and names charts the way the
        # viewer sees them — not by raw column names.
        manifest["fields"] = _fields_block(meta)
        items.append(manifest)
    if detail == "full":
        # Related charts (sharing a measure) per chart — powers the guide flow's
        # "biểu đồ liên quan" chips so users jump between linked charts. Dropped
        # from `compact`: it is a cross-reference for a UI, and it grows with the
        # square of the chart count in the payload an agent pays for.
        related_map = _compute_related_charts(ctx.chart_meta)
        for it in items:
            it["related"] = related_map.get(it.get("chart_id"), [])
    else:
        items = [_compact_manifest(it) for it in items]

    out = {
        "dashboard_name": ctx.dashboard.name or "",
        "dashboard_description": getattr(ctx.dashboard, "description", "") or "",
        "filters_applied": ctx.public_filters,
        # The report's page flow (DA's narrative). Read/overview FOLLOWING this
        # order, page by page — not as a flat chart dump. Names and ids only in
        # compact mode: the per-page chart lists repeat what `charts` already says.
        "pages": (ctx.pages if detail == "full" else
                  [{"id": p.get("id"), "name": p.get("name"),
                    "chart_count": len(p.get("chart_ids") or [])}
                   for p in (ctx.pages or [])]),
        "charts": items,
        "coverage": {
            "returned": len(items),
            "total": len(every),
            "truncated": len(items) < len(every),
            "detail": detail,
        },
    }
    if page_used:
        out["coverage"]["page"] = page_used
        out["coverage"]["note"] = (
            f"Listing only {len(items)}/{len(every)} charts — those on page "
            f"\"{page_used}\". Omit `page` to see the whole report."
        )
    elif detail == "compact":
        out["coverage"]["note"] = (
            "Compact listing: name, type, measures and dimensions only — enough "
            "to choose a chart_id. Call get_chart_glossary for one chart's detail."
        )
    return _ok(out)


#: The fields a manifest keeps in compact mode: enough to choose a chart, not
#: enough to answer from. Choosing is the job; answering is what the measuring
#: tools are for, and they are given a `chart_id` from exactly this list.
_COMPACT_KEEP = ("chart_id", "chart_name", "name", "chart_type", "description",
                 "total_rows")


def _compact_manifest(item: dict) -> dict:
    """One chart, described in what it takes to pick it out of a list."""
    out = {k: item[k] for k in _COMPACT_KEEP if item.get(k) not in (None, "")}
    fields = item.get("fields") or {}
    if isinstance(fields, dict):
        # Labels, not the full field blocks: the label is what a viewer says and
        # therefore what a question has to be matched against.
        for key in ("measures", "dimensions"):
            vals = [
                (f.get("label") or f.get("field"))
                for f in (fields.get(key) or []) if isinstance(f, dict)
            ]
            if vals:
                out[key] = [v for v in vals if v][:6]
    return out


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

    meta = ctx.chart_meta.get(chart_id, {})

    def _enrich(pack: dict) -> dict:
        """Attach the chart's on-screen vocabulary to the stats pack.

        Kept OUT of the summary cache (which keys on SQL stats only) so label
        changes take effect without a cache bust.
        """
        pack = dict(pack)
        pack["fields"] = _fields_block(meta)
        label_by_field = (meta.get("fields") or {}).get("label_by_field") or {}
        pm_label = _resolve_label(pack.get("primary_measure") or "", label_by_field)
        pd_label = _resolve_label(pack.get("primary_dimension") or "", label_by_field)
        if pm_label:
            pack["primary_measure_label"] = pm_label
        if pd_label:
            pack["primary_dimension_label"] = pd_label
        # Related charts (sharing a measure) so the guide's chart-deep level can
        # offer "biểu đồ liên quan" chips without a separate list_charts call.
        pack["related"] = _compute_related_charts(ctx.chart_meta).get(chart_id, [])
        return pack

    dashboard_id = getattr(ctx.dashboard, "id", None)
    if isinstance(dashboard_id, int):
        cached = get_cached_pack(dashboard_id, ctx.public_filters, chart_id)
        if cached is not None:
            logger.debug(
                "dashboard_ai_bot summary cache HIT dashboard_id=%s chart_id=%s",
                dashboard_id, chart_id,
            )
            return _ok(_enrich(cached))

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        logger.exception("dashboard_ai_bot get_chart_summary failed chart_id=%s", chart_id)
        # The exception TEXT is not repeated: it comes from the shared chart
        # service, which speaks the UI's language (Vietnamese here) because a
        # person reads it in the app. Pasting it into a tool result puts a
        # second language inside a machine contract that is otherwise English —
        # found by the group-2 audit. The type is enough to act on; the full
        # text is in the server log for whoever is debugging.
        logger.warning("chart %s failed: %s", chart_id, exc)
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

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
        logger.warning("chart %s summary failed: %s", chart_id, exc)
        return _err(f"failed to summarize chart {chart_id}: {type(exc).__name__}")
    pack_dict = pack.to_dict()
    if isinstance(dashboard_id, int):
        # Cache the raw SQL-stats pack; vocabulary is layered on at read time.
        put_cached_pack(dashboard_id, ctx.public_filters, chart_id, pack_dict)
    return _ok(_enrich(pack_dict))


#: What "no sort" means, spelled out. A named constant because it lives inside
#: an f-string and an apostrophe there is a syntax error before Python 3.12 —
#: the kind of breakage that only shows up at import time in the container.
_UNORDERED = "the chart's own order (NOT a ranking)"


# Tool: get_chart_data ────────────────────────────────────────────────────────


def tool_get_chart_data(ctx: ToolContext, args: dict) -> dict:
    chart_id = args.get("chart_id")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    # The run's ceiling, not this module's. A binding that grants more rows is
    # honoured; one that grants none falls back to the historical default.
    ceiling = getattr(ctx, "max_rows_per_call", None) or MAX_TOP_N

    top_n = args.get("top_n")
    if top_n is not None and (not isinstance(top_n, int) or top_n <= 0):
        return _err("top_n must be a positive integer")
    asked_for = top_n if isinstance(top_n, int) else None
    # THE CEILING APPLIES WHETHER OR NOT THE CALLER REMEMBERED IT.
    #
    # MEASURED: with `top_n` omitted this returned every row of the chart — up to
    # ~1,444,000 tokens in one call. `top_n` was optional, so the bounded path
    # was the one a caller had to think of, and a model that simply did not pass
    # it got an unbounded read. The cap is the run's ceiling
    # (`capabilities.max_rows_per_call`, default 50); an explicit smaller ask
    # still wins.
    top_n = min(top_n, ceiling) if isinstance(top_n, int) else ceiling

    sort = args.get("sort")  # "asc" | "desc" | None
    sort_by = args.get("sort_by")  # column name

    try:
        data = _fetch_chart_data(ctx, chart_id)
    except Exception as exc:
        logger.exception("dashboard_ai_bot get_chart_data failed chart_id=%s", chart_id)
        # The exception TEXT is not repeated: it comes from the shared chart
        # service, which speaks the UI's language (Vietnamese here) because a
        # person reads it in the app. Pasting it into a tool result puts a
        # second language inside a machine contract that is otherwise English —
        # found by the group-2 audit. The type is enough to act on; the full
        # text is in the server log for whoever is debugging.
        logger.warning("chart %s failed: %s", chart_id, exc)
        return _err(f"failed to load chart {chart_id}: {type(exc).__name__}")

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

    # How many there ACTUALLY are, captured before the cut. Reporting only the
    # post-truncation count is what let a fifty-row fragment of a seventy-two-row
    # chart pass for the whole thing: `row_count: 50` is true of the payload and
    # says nothing about the data, and a reader with no other signal treats it as
    # both. See `agent_flows/tools/result.py` for the contract this feeds.
    total_rows = len(rows)

    if isinstance(top_n, int):
        rows = rows[:top_n]

    # ALWAYS say how the rows were ordered, including when nothing sorted them.
    # The audit found a truncated result whose note named no order at all, so
    # "the first 5 rows" described a slice of nothing in particular — exactly the
    # silence the coverage contract exists to break.
    ordered_by = f"{sort_by} {sort}" if (sort and sort_by) else _UNORDERED
    truncated = len(rows) < total_rows
    coverage: dict[str, Any] = {
        "returned": len(rows),
        "total": total_rows,
        "truncated": truncated,
    }
    coverage["ordered_by"] = ordered_by
    if asked_for is not None and asked_for > ceiling:
        # The caller asked for more than the run permits. Said out loud, because
        # the alternative is an operator raising a limit and watching nothing
        # change.
        coverage["capped_by_policy"] = {"asked_for": asked_for, "allowed": ceiling}
    if truncated:
        # Spelled out in words as well as flags. A model reading a boolean deep
        # in a nested object does not reliably act on it, and the entire cost of
        # this defect was a model not acting on the fact that it held a fragment.
        coverage["note"] = (
            f"ONLY {len(rows)}/{total_rows} rows, ordered by "
            f"{ordered_by}. "
            "Do not state a highest/lowest/total from this fragment — call "
            "rank_values or total_measure, which compute over every row."
        )

    return _ok({
        "chart_id": chart_id,
        "columns": columns,
        "rows": rows,
        # Kept for readers that already depend on it; `coverage` is what a new
        # reader should use, because this one cannot express partiality.
        "row_count": len(rows),
        "coverage": coverage,
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
        # Refused by the AST allowlist: an unsupported node, an unknown variable,
        # a disallowed operator. The caller wrote something this tool will not
        # evaluate — a bad argument, not a failure of anything downstream.
        return _err(f"expression not allowed: {exc}")
    except SyntaxError as exc:
        return _err(f"invalid expression syntax: {exc.msg}")
    except ZeroDivisionError:
        return _err("bad argument: division by zero")
    except OverflowError:
        # Every constant is coerced to float before evaluation, so an enormous
        # power overflows immediately instead of exploding into a big integer —
        # the reason `**` can stay allowed without a CPU bomb. It is still the
        # caller asking for something unrepresentable.
        return _err("bad argument: result is too large to represent")
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

def tool_web_search(ctx: ToolContext, args: dict) -> dict:
    """Domain/market know-how lookup. External web context, NOT report data."""
    from app.services.dashboard_ai_bot.web_search import search_web
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        return _err("query (str) is required")
    max_results = args.get("max_results")
    res = search_web(
        query.strip(),
        max_results=max_results if isinstance(max_results, int) else 5,
    )
    return _ok(res) if res.get("ok") else _err(res.get("error") or "web search failed")


def tool_fetch_url(ctx: ToolContext, args: dict) -> dict:
    """Read ONE specific external URL the DA/user trusts. External context."""
    from app.services.dashboard_ai_bot.web_search import fetch_url
    url = args.get("url")
    if not isinstance(url, str) or not url.strip():
        return _err("url (str) is required")
    res = fetch_url(url.strip())
    return _ok(res) if res.get("ok") else _err(res.get("error") or "fetch failed")


def tool_benchmark_compare(ctx: ToolContext, args: dict) -> dict:
    """Anchor a report metric against an external benchmark in ONE call.

    Deterministically computes the report's own headline number from the named
    chart (so the comparison is anchored on real data, not the model's memory),
    then runs a focused web search for the industry/market benchmark. Returns a
    structured envelope that forces an explicit "ours vs outside" framing.
    """
    from app.services.dashboard_ai_bot.web_search import search_web
    chart_id = args.get("chart_id")
    metric = args.get("metric")
    query = args.get("query")
    if not isinstance(chart_id, int):
        return _err("chart_id (int) is required — the chart holding our own number")
    if not isinstance(metric, str) or not metric.strip():
        return _err("metric (what we're benchmarking, e.g. 'gross margin') is required")
    if not isinstance(query, str) or not query.strip():
        return _err("query (benchmark search terms, e.g. 'gross margin benchmark retail Vietnam 2025') is required")
    try:
        ctx.assert_chart_in_scope(chart_id)
    except ToolError as exc:
        return _err(str(exc))

    # Deterministic report-side anchor: total of the chart's primary measure.
    report_value = None
    report_measure = None
    try:
        from app.services.dashboard_ai_bot.thinking.advanced_tools import (
            _detect_measure_idx,
            _to_number,
        )
        data = _fetch_chart_data(ctx, chart_id)
        cols, rows = data["columns"], data["rows"]
        m_idx = _detect_measure_idx(cols, rows)
        if m_idx is not None:
            report_measure = cols[m_idx]
            nums = [_to_number(r[m_idx]) for r in rows if m_idx < len(r)]
            nums = [n for n in nums if n is not None]
            if nums:
                report_value = round(sum(nums), 4)
    except Exception:  # noqa: BLE001 — report anchor is best-effort
        pass

    web = search_web(query.strip(), max_results=5)
    if not web.get("ok"):
        return _err(web.get("error") or "benchmark web search failed")
    return _ok({
        "metric": metric.strip(),
        "report": {
            "chart_id": chart_id,
            "measure": report_measure,
            "value": report_value,
        },
        "external": {
            "provider": web.get("provider"),
            "query": web.get("query"),
            "answer": web.get("answer"),
            "results": web.get("results"),
        },
        "instruction": (
            "Compare report.value against the external benchmark figures. State "
            "explicitly whether we are ABOVE / BELOW / IN-LINE, quantify the gap, "
            "and cite each external source URL. External figures are indicative, "
            "not authoritative — our report data is the source of truth."
        ),
    })


TOOLS: dict[str, ToolFn] = {
    "emit_reading_plan": tool_emit_reading_plan,
    "list_charts": tool_list_charts,
    "get_chart_summary": tool_get_chart_summary,
    "get_chart_data": tool_get_chart_data,
    "compare_segments": tool_compare_segments,
    "compute": tool_compute,
    # Always registered; only OFFERED to the LLM when the admin enables web
    # research (see EXTERNAL_TOOL_DEFS + the thinking agent's per-turn list).
    "web_search": tool_web_search,
    "fetch_url": tool_fetch_url,
    "benchmark_compare": tool_benchmark_compare,
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
    from app.services.dashboard_ai_bot.thinking.advanced_tools import (
        tool_aggregate_chart_data,
        tool_compare_periods,
        tool_correlate_charts,
        tool_describe_distribution,
        tool_detect_anomaly,
        tool_smart_drilldown,
        tool_explain_change,
        tool_forecast_measure,
        tool_analyze_trend,
        tool_segment_compare,
        # Phase 15.73 — diagnostic + lookup tools
        tool_inspect_filters,
        tool_get_chart_glossary,
    )
    TOOLS["compare_periods"] = tool_compare_periods
    TOOLS["describe_distribution"] = tool_describe_distribution
    TOOLS["correlate_charts"] = tool_correlate_charts
    TOOLS["detect_anomaly"] = tool_detect_anomaly
    TOOLS["smart_drilldown"] = tool_smart_drilldown
    TOOLS["aggregate_chart_data"] = tool_aggregate_chart_data
    TOOLS["explain_change"] = tool_explain_change
    TOOLS["forecast_measure"] = tool_forecast_measure
    TOOLS["analyze_trend"] = tool_analyze_trend
    TOOLS["segment_compare"] = tool_segment_compare
    TOOLS["inspect_filters"] = tool_inspect_filters
    TOOLS["get_chart_glossary"] = tool_get_chart_glossary


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
            "List the dashboard's charts — name, type, and the measures and "
            "dimensions each one shows — so you can pick the right chart_id. "
            "Returns no row data; call a measuring tool with the chart_id you "
            "chose. On a large report, pass `page` to list one page at a time: "
            "the full listing of a 70-chart report is several thousand tokens."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "page": {
                    "type": "string",
                    "description": (
                        "Only charts on this page, by page name or id. Omit for "
                        "the whole report."
                    ),
                },
                "detail": {
                    "type": "string",
                    "enum": ["compact", "full"],
                    "description": (
                        "compact (default) = name, type, measures, dimensions — "
                        "enough to choose. full = every column and related-chart "
                        "cross-reference; much larger."
                    ),
                },
            },
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
            "'which groups is it concentrated in', 'is the distribution even', "
            "'is there a long tail')."
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
            "appear in BOTH. Use when the user asks 'is A related to "
            "B' or for cross-chart hypothesis testing."
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
            "time). Use when the user asks 'is anything unusual', 'spike', "
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
            "for a specific segment (one department, one customer tier, "
            "one owner). Ops: eq, neq, contains, startswith, gt, "
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
            "already display directly — e.g. 'which department has the highest "
            "overdue rate' on a task list with one row per "
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
    # ── Driver analysis & projection ─────────────────────────────────────
    {
        "name": "explain_change",
        "description": (
            "Explain WHY a total changed and WHO drove it — contribution / "
            "driver decomposition. Needs a chart whose rows carry a BREAKDOWN "
            "column (e.g. department, product) AND a SPLIT column with two "
            "states (two periods, or 'Actual' vs 'Plan'). Returns each "
            "segment's before/after/delta and its % share of the TOTAL change, "
            "ranked by impact. Use for 'why did revenue fall', 'which group "
            "drove it', 'where does actual differ from plan'. One deterministic "
            "call instead of aggregate+compute by hand."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
                "breakdown": {"type": "string", "description": "Column to attribute the change to (e.g. department)."},
                "split_column": {"type": "string", "description": "Column holding the two states (e.g. month, scenario)."},
                "value_a": {"description": "The AFTER / current state value in split_column."},
                "value_b": {"description": "The BEFORE / baseline state value in split_column."},
            },
            "required": ["chart_id", "breakdown", "split_column", "value_a", "value_b"],
        },
    },
    {
        "name": "forecast_measure",
        "description": (
            "Project a time-series chart's measure forward N periods. "
            "method='linear' (least-squares trend) or 'cagr' (compound growth). "
            "Returns the projected points + trend rate + an explicit caveat. "
            "Use for 'forecast', 'where does this trend land by year end', "
            "or 'what is the trend from here'. NOT a real forecast model — "
            "always present it as an indicative "
            "projection. Requires a time axis."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer"},
                "horizon": {"type": "integer", "description": "Number of future periods to project (default 3, max 12)."},
                "method": {"type": "string", "enum": ["linear", "cagr"]},
            },
            "required": ["chart_id"],
        },
    },
    {
        "name": "analyze_trend",
        "description": (
            "Robust time-series trend read — USE THIS (not get_chart_summary's "
            "raw trend) whenever the question is 'is it growing / declining / "
            "seasonal'. Trims incomplete edge periods (launch month, data "
            "cutoff), derives direction from least-squares SLOPE (never "
            "endpoint ratio), and returns slope, R², CAGR, peak, trough, "
            "plateau flag, excluded_periods and caveats. Prevents the "
            "'partial last month → false decline' trap."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"chart_id": {"type": "integer"}},
            "required": ["chart_id"],
        },
    },
    {
        "name": "segment_compare",
        "description": (
            "Compare ONE segment against the rest. Given a chart grouped by a "
            "dimension and a target value (e.g. chart 'AOV by state' + value "
            "'SP'), returns that segment's metric PLUS rank, percentile, "
            "share-of-total, and the cross-segment distribution (min/median/"
            "mean/max) + % vs the mean. Use for 'X versus the whole / versus "
            "the other groups', or to split a metric by a condition. Prevents "
            "reporting the overall number as if it were the segment's."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chart_id": {"type": "integer", "description": "A chart grouped by the comparison dimension."},
                "value": {"description": "The segment value to isolate (e.g. 'SP')."},
                "dimension": {"type": "string", "description": "Optional explicit dimension column; defaults to the chart's primary dimension."},
            },
            "required": ["chart_id", "value"],
        },
    },
    # ── Phase 15.73 — Diagnostic & lookup tools ──────────────────────────
    {
        "name": "inspect_filters",
        "description": (
            "Return the filter set currently being applied to every data "
            "tool you call (the dashboard's public_filters + any viewer "
            "slicer filters). USE THIS FIRST when a chart returns 0 rows "
            "or you want to NAME the active filter scope in your answer "
            "instead of speaking vaguely. No data is read."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_chart_glossary",
        "description": (
            "Return business-glossary metadata for the dataset behind a "
            "chart: column descriptions, dataset description, common "
            "user questions, and the local-language aliases captured by the "
            "Knowledge System. Use when the user asks what a metric means, "
            "which column a business term maps to, or which chart covers a "
            "given entity — translate alias → real column → right chart. "
            "No row data exposed."
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


# Offered to the LLM ONLY when the admin enabled web search for the link
# (appended to the per-turn tool list by the thinking agent). Kept out of the
# default TOOL_DEFINITIONS so it never appears when disabled / unconfigured.
WEB_SEARCH_TOOL_DEF: dict = {
    "name": "web_search",
    "description": (
        "Search the public web for DOMAIN / MARKET know-how about the topic "
        "the user is asking about (industry benchmarks, definitions, typical "
        "drivers, regulations). Use this to enrich analysis beyond the admin "
        "system prompt — NOT for the report's own numbers (those always come "
        "from the chart tools). Always attribute web facts as external and "
        "keep the report's data as the source of truth. Call at most twice "
        "per turn with focused queries."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Focused search query."},
            "max_results": {"type": "integer", "description": "1-8 (default 5)."},
        },
        "required": ["query"],
    },
}

FETCH_URL_TOOL_DEF: dict = {
    "name": "fetch_url",
    "description": (
        "Read ONE specific web page the user/DA points to (an industry report, "
        "a competitor page, a government statistics portal) and return its "
        "cleaned text. Use when a trusted source URL is given or surfaced by "
        "web_search and you need to read it deeply — NOT to discover pages "
        "(use web_search for that). External context: attribute it, never treat "
        "it as the report's own data."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Full http(s) URL to read."},
        },
        "required": ["url"],
    },
}

BENCHMARK_COMPARE_TOOL_DEF: dict = {
    "name": "benchmark_compare",
    "description": (
        "Compare ONE of the report's own metrics against an external market / "
        "industry benchmark in a single structured call. Pass the chart that "
        "holds our number, what the metric is, and a benchmark search query. "
        "Returns our anchored value + external findings + a framing instruction "
        "(above/below/in-line + cite sources). Use when the user wants to "
        "compare against the industry, the market or competitors — "
        "'where do we stand against the outside'. "
        "Our report data stays the source of truth; web figures are indicative."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "chart_id": {"type": "integer", "description": "Chart holding our own number."},
            "metric": {"type": "string", "description": "What we're benchmarking, e.g. 'gross margin'."},
            "query": {"type": "string", "description": "Benchmark search terms, e.g. 'gross margin benchmark retail Vietnam 2025'."},
        },
        "required": ["chart_id", "metric", "query"],
    },
}

# Appended to the per-turn tool list ONLY when the admin enabled web research.
# Kept out of the default TOOL_DEFINITIONS so they never appear when disabled.
EXTERNAL_TOOL_DEFS: list[dict] = [
    WEB_SEARCH_TOOL_DEF,
    FETCH_URL_TOOL_DEF,
    BENCHMARK_COMPARE_TOOL_DEF,
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


# ── Learning tools (institutional memory) ───────────────────────────────────
# remember_fact / recall_knowledge are ALWAYS offered (independent of the web
# flag) so the bot can persist what the user TEACHES it and recall accumulated
# company knowledge. Registered here at import — after TOOLS + TOOL_DEFINITIONS
# both exist — so execute_tool dispatch AND the offered tool list see them.
# knowledge.py imports tool_context lazily (no import cycle with this module).
from app.services.dashboard_ai_bot.knowledge import (  # noqa: E402
    KNOWLEDGE_TOOL_DEFS,
    KNOWLEDGE_TOOLS,
)

TOOLS.update(KNOWLEDGE_TOOLS)
TOOL_DEFINITIONS.extend(KNOWLEDGE_TOOL_DEFS)

# ── Company knowledge (Govern) ──────────────────────────────────────────────
# search_knowledge / read_document. Registered here for the same reason the
# learning tools are: dispatch and the offered-tool list must see one registry.
# Unlike the learning tools these are NOT always offered — they reach real
# documents, so a step only gets them when its capabilities say so.
from app.services.dashboard_ai_bot.govern_tools import (  # noqa: E402
    GOVERN_TOOL_DEFS,
    GOVERN_TOOLS,
)

TOOLS.update(GOVERN_TOOLS)
TOOL_DEFINITIONS.extend(GOVERN_TOOL_DEFS)
