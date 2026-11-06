"""The Public Read MCP's tools: read the report the viewer has open, and steer that view.

Read tools return AppBI's numbers with a `source` block (report, chart, filters, as-of)
that the answer must cite. View tools change only the viewer's temporary view (filters,
page, focused chart, drill-down); AppBI validates each change before the tab applies it.
Nothing here can modify a dataset, model, chart, dashboard, revision or publish state:
the only AppBI routes reachable are the four read routes in `bridge.APPBI_PATHS`.
"""

from __future__ import annotations

import ast
import copy
import inspect
import json
import logging
import math
import operator
import time
from typing import Any

from mcp.server.mcpserver import Context
from mcp.types import ToolAnnotations

from ..context import Principal
from ..tools.runtime import _audit
from .bridge import Bridge, Refused

log = logging.getLogger("appbi_mcp.public.tools")

INSTRUCTIONS = """\
You are connected to ONE AppBI public report that a viewer has open in their browser
right now. You can read its published charts and steer what that viewer sees. You
cannot change the report itself (data, model, charts, layout or publishing).

Start with get_report_context: the report, its pages/sections, charts with their
metrics and dimensions, the filters the viewer may change, fixed filters, the current
view and (if the publisher shared it) the publisher's guide. Use the guide's
definitions and context when you explain the report.

Numbers — two kinds, never mixed up:
A. AppBI numbers: values read with read_chart. Quote them and cite the source block:
   report name, chart title, filters applied and as-of.
B. Numbers you compute (growth, share, difference, ratio, rank, average over rows...):
   compute them with the `calculate` tool (or your own code tool), never in your head.
   Present them with: report + chart(s) used, filters/period, the input values, the
   formula, and the note "Calculated by Claude from the chart data — not an AppBI
   metric". Cite every chart you used.
Never sum averages, ratios or distinct counts across rows; never derive a total from
a truncated read (truncated=true); if the data cannot answer, say so instead of guessing.

View changes (set_filters, reset_filters, go_to_page, focus_chart, drill_down,
clear_drill_down) change the viewer's screen immediately. Use them when the viewer
asks to see something, and say what you changed. A filter the report fixes cannot be
changed; tell the viewer instead of trying another way.
"""

READ = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
VIEW = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True, open_world_hint=False)


class Env:
    def __init__(self, bridge: Bridge, principal: Principal, row: dict[str, Any]):
        self.bridge, self.principal, self.row = bridge, principal, row
        self.sid = row["id"]
        self.appbi = bridge.appbi(bridge.grant_of(row) or "")

    def state(self) -> dict[str, Any]:
        fresh = self.bridge.session(self.sid) or self.row
        return self.bridge.view_state(fresh)

    def server_state(self, st: dict[str, Any] | None = None) -> dict[str, Any]:
        """What AppBI needs to read as the viewer sees: filters + drill, nothing the tab invents."""
        st = st if st is not None else self.state()
        out: dict[str, Any] = {}
        if isinstance(st.get("viewer_filters"), list):
            out["viewer_filters"] = st["viewer_filters"]
        if isinstance(st.get("filters"), dict):
            out["filters"] = st["filters"]
        if isinstance(st.get("drill"), dict):
            out["drill"] = st["drill"]
        return out


def _source(ctx_name: str, kind: str, title: Any, filters: Any, as_of: Any = None) -> dict[str, Any]:
    return {"report": ctx_name, "report_kind": kind, "chart": title, "filters_applied": filters, "as_of": as_of,
            "provided_by": "AppBI (published report data)"}


# ── read tools ────────────────────────────────────────────────────────────────

async def get_report_context(env: Env) -> dict[str, Any]:
    """The report the viewer has open: pages/sections, charts (metrics, dimensions), filters the viewer may change, fixed filters, current view, publisher guide (if shared)."""
    st = env.state()
    described = await env.appbi.post("/public/mcp/describe", {"state": env.server_state(st)})
    return {"status": "ok", "report": described, "current_view": st,
            "viewer_tab_connected": env.bridge.tab_online(env.bridge.session(env.sid) or env.row)}


async def get_view_state(env: Env) -> dict[str, Any]:
    """What the viewer is looking at right now: page/section, focused chart, filters, drill-down."""
    row = env.bridge.session(env.sid) or env.row
    return {"status": "ok", "current_view": env.bridge.view_state(row), "viewer_tab_connected": env.bridge.tab_online(row)}


async def read_chart(env: Env, chart: str) -> dict[str, Any]:
    """Read one published chart's data exactly as the viewer's current view shows it (their filters and drill-down; fixed filters always apply). `chart` = chart_id (dashboard) or binding id (AI Vibe report) from get_report_context."""
    st = env.state()
    out = await env.appbi.post("/public/mcp/chart-data", {"chart": chart, "state": env.server_state(st)})
    name = str(json.loads(env.row.get("report_json") or "{}").get("name") or "")
    if "dto" in out:  # AI Vibe report: the DTO the page draws
        dto = out.get("dto") or {}
        prov = dto.get("provenance") or {}
        return {"status": "ok", "chart": out.get("binding"), "title": out.get("title"), "data": _trim_dto(dto),
                "source": _source(name, "ai_vibe_report", out.get("title"), dto.get("state") or st.get("filters"),
                                  prov.get("asOf"))}
    return {"status": "ok", "chart": out.get("chart_id"), "title": out.get("title"), "columns": out.get("columns"),
            "rows": out.get("rows"), "row_count": out.get("row_count"), "truncated": out.get("truncated"),
            "source": _source(name, "dashboard", out.get("title"), out.get("filters_applied"))}


def _trim_dto(dto: dict[str, Any]) -> dict[str, Any]:
    keep = {k: dto[k] for k in ("kind", "fields", "rows", "columns", "value", "values", "series", "total", "truncated",
                                 "row_count", "state", "provenance", "unit", "format") if k in dto}
    return keep or dto


async def list_filter_values(env: Env, key: str, search: str = "") -> dict[str, Any]:
    """Values a viewer may pick for one filter of an AI Vibe report (dashboards: read a chart's dimension instead)."""
    out = await env.appbi.post("/public/mcp/filter-values", {"key": key, "search": search, "state": env.server_state()})
    return {"status": "ok", **out}


# ── view tools (temporary, this viewer only) ─────────────────────────────────

async def _apply(env: Env, desired: dict[str, Any], cmd: dict[str, Any]) -> dict[str, Any]:
    await env.appbi.post("/public/mcp/check-state", {"state": env.server_state(desired)})
    res = await env.bridge.send(env.sid, cmd)
    if not res.get("ok"):
        if res.get("error") == "viewer_not_responding":
            return {"status": "viewer_not_connected",
                    "message": "The viewer's report tab did not respond. Ask them to keep the report open (with Claude connected) and try again."}
        return {"status": "not_applied", "message": res.get("error") or "The report could not apply this change."}
    return {"status": "applied", "current_view": env.state()}


def _dashboard_filters(st: dict[str, Any], changes: dict[str, Any]) -> list[dict[str, Any]]:
    current = copy.deepcopy(st.get("viewer_filters") or [])
    controls = {str(c.get("key")): c for c in st.get("controls") or [] if isinstance(c, dict)}
    by_id = {str(f.get("id")): f for f in current if isinstance(f, dict)}
    for key, value in changes.items():
        f = by_id.get(str(key))
        if f is None:
            if str(key) not in controls:
                raise Refused("unknown_filter", f"'{key}' is not a filter this viewer can change. Use the keys from get_report_context/current_view.controls.")
            c = controls[str(key)]
            f = {"id": c.get("key"), "field": c.get("field"), "operator": c.get("operator") or "in"}
            current.append(f)
            by_id[str(key)] = f
        f["value"] = value
    return current


async def set_filters(env: Env, changes: dict[str, Any]) -> dict[str, Any]:
    """Change filters on the viewer's screen. `changes` maps filter key -> value (list of values for a category; [from, to] for a date range). Only filters the report lets viewers change; fixed filters are refused."""
    st = env.state()
    if not isinstance(changes, dict) or not changes:
        raise Refused("bad_request", "changes must map filter keys to values.")
    if st.get("kind") == "dashboard":
        filters = _dashboard_filters(st, changes)
        desired = {**st, "viewer_filters": filters}
        return await _apply(env, desired, {"type": "set_filters", "viewer_filters": filters})
    filters = {**(st.get("filters") or {}), **changes}
    return await _apply(env, {**st, "filters": filters}, {"type": "set_filters", "filters": filters})


async def reset_filters(env: Env) -> dict[str, Any]:
    """Put the viewer's filters back to the report's defaults."""
    res = await env.bridge.send(env.sid, {"type": "reset_filters"})
    return {"status": "applied", "current_view": env.state()} if res.get("ok") else {"status": "viewer_not_connected" if res.get("error") == "viewer_not_responding" else "not_applied", "message": res.get("error")}


async def go_to_page(env: Env, page: str) -> dict[str, Any]:
    """Show another page (dashboard page_id) or scroll to another section (AI Vibe report section_id)."""
    res = await env.bridge.send(env.sid, {"type": "go_to_page", "page": str(page)})
    return {"status": "applied", "current_view": env.state()} if res.get("ok") else {"status": "not_applied", "message": res.get("error")}


async def focus_chart(env: Env, chart: str) -> dict[str, Any]:
    """Bring one chart into view and highlight it on the viewer's screen (switching page if needed)."""
    res = await env.bridge.send(env.sid, {"type": "focus", "chart": str(chart)})
    return {"status": "applied", "current_view": env.state()} if res.get("ok") else {"status": "not_applied", "message": res.get("error")}


async def drill_down(env: Env, chart: str, field: str, value: Any) -> dict[str, Any]:
    """Drill into one value of a chart's dimension on the viewer's screen (dashboards: the other charts filter to it, as a click does; AI Vibe report: the matching filter is set). Use clear_drill_down to undo."""
    st = env.state()
    if st.get("kind") == "dashboard":
        try:
            cid = int(chart)
        except (TypeError, ValueError):
            raise Refused("bad_chart", "chart must be a chart_id of this dashboard.")
        drill = {"chart_id": cid, "field": field, "value": value}
        return await _apply(env, {**st, "drill": drill}, {"type": "drill", **drill})
    filters = {**(st.get("filters") or {}), field: [value]}
    return await _apply(env, {**st, "filters": filters}, {"type": "set_filters", "filters": filters})


async def clear_drill_down(env: Env) -> dict[str, Any]:
    """Remove the drill-down (cross-filter) from the viewer's screen."""
    res = await env.bridge.send(env.sid, {"type": "clear_drill"})
    return {"status": "applied", "current_view": env.state()} if res.get("ok") else {"status": "not_applied", "message": res.get("error")}


# ── a verifiable calculator ───────────────────────────────────────────────────

_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.Mod: operator.mod, ast.FloorDiv: operator.floordiv}
_UN = {ast.USub: operator.neg, ast.UAdd: operator.pos}
_FN = {"sum": lambda *a: math.fsum(_flat(a)), "avg": lambda *a: math.fsum(_flat(a)) / max(1, len(_flat(a))),
       "min": lambda *a: min(_flat(a)), "max": lambda *a: max(_flat(a)), "abs": abs, "round": round,
       "sqrt": math.sqrt, "count": lambda *a: len(_flat(a))}


def _flat(a: Any) -> list[float]:
    out: list[float] = []
    for x in a:
        if isinstance(x, (list, tuple)):
            out.extend(_flat(x))
        else:
            out.append(x)
    return out


def _eval(node: ast.AST, names: dict[str, Any]) -> Any:
    if isinstance(node, ast.Expression):
        return _eval(node.body, names)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.Name):
        if node.id not in names:
            raise ValueError(f"unknown name {node.id}")
        return names[node.id]
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_eval(e, names) for e in node.elts]
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        left, right = _eval(node.left, names), _eval(node.right, names)
        if isinstance(node.op, ast.Pow) and abs(right) > 64:
            raise ValueError("exponent too large")
        return _BIN[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UN:
        return _UN[type(node.op)](_eval(node.operand, names))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FN and not node.keywords:
        return _FN[node.func.id](*[_eval(a, names) for a in node.args])
    raise ValueError("only numbers, + - * / % ** //, parentheses, lists and sum/avg/min/max/count/abs/round/sqrt are allowed")


async def calculate(env: Env, expression: str, values: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compute a derived number exactly and show the work, e.g. expression="(cur - prev) / prev * 100", values={"cur": 52783, "prev": 43428}. Name every input after where it came from. The result is a Claude calculation, not an AppBI metric."""
    if not isinstance(expression, str) or len(expression) > 500:
        raise Refused("bad_request", "expression must be a string of at most 500 characters.")
    names: dict[str, Any] = {}
    for k, v in (values or {}).items():
        if isinstance(v, bool) or not (isinstance(v, (int, float)) or (isinstance(v, list) and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in _flat(v)))):
            raise Refused("bad_request", f"value '{k}' must be a number or a list of numbers.")
        names[str(k)] = v
    try:
        result = _eval(ast.parse(expression, mode="eval"), names)
    except (SyntaxError, ValueError, TypeError, ZeroDivisionError, OverflowError) as exc:
        return {"status": "error", "message": f"Could not compute: {exc}"}
    return {"status": "ok", "expression": expression, "inputs": names, "result": result,
            "note": "Calculated by Claude from chart data — not an AppBI metric."}


TOOLS: list[tuple[Any, ToolAnnotations]] = [
    (get_report_context, READ), (get_view_state, READ), (read_chart, READ), (list_filter_values, READ),
    (calculate, READ),
    (set_filters, VIEW), (reset_filters, VIEW), (go_to_page, VIEW), (focus_chart, VIEW), (drill_down, VIEW),
    (clear_drill_down, VIEW),
]


def register_public_tools(mcp: Any, ctx: Any, bridge: Bridge) -> None:
    for fn, ann in TOOLS:
        _register(mcp, ctx, bridge, fn, ann)


def _register(mcp: Any, app: Any, bridge: Bridge, fn: Any, ann: ToolAnnotations) -> None:
    sig = inspect.signature(fn)
    params = [p for name, p in sig.parameters.items() if name != "env"]
    ctx_param = inspect.Parameter("ctx", inspect.Parameter.KEYWORD_ONLY, annotation=Context)
    new_sig = sig.replace(parameters=[*params, ctx_param], return_annotation=dict[str, Any])

    async def wrapper(*args: Any, **kwargs: Any) -> dict[str, Any]:
        started = time.monotonic()
        ctx: Context = kwargs.pop("ctx")
        request = ctx.request_context.request
        principal: Principal | None = getattr(getattr(request, "state", None), "principal", None) if request is not None else None
        bound = new_sig.bind_partial(*args, **kwargs).arguments
        if principal is None or not principal.user_id.startswith("viewer:"):
            return {"status": "unauthenticated", "message": "Reconnect from the report."}
        row = bridge.session(principal.user_id.split(":", 1)[1])
        if row is None:
            app.provider.revoke_grant(principal.grant_id, "view_session_ended")
            _audit(app, principal, fn.__name__, bound, "session_ended", None, [], started)
            return {"status": "disconnected", "message": "The viewer closed this report session. Open the report and connect Claude again."}
        status_code: int | None = None
        try:
            result = await fn(Env(bridge, principal, row), **kwargs)
        except Refused as exc:
            status_code = exc.status
            if exc.code in ("link_closed", "link_expired", "link_changed", "mcp_disabled", "mcp_revoked", "invalid_grant"):
                bridge.end(row["id"], exc.code)
                result = {"status": "access_ended", "reason": exc.code, "message": exc.message}
            else:
                result = {"status": "refused", "reason": exc.code, "message": exc.message}
        outcome = str(result.get("status", "ok"))
        _audit(app, principal, fn.__name__, bound, outcome, status_code, [], started)
        return result

    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    wrapper.__signature__ = new_sig  # type: ignore[attr-defined]
    annotations = {name: p.annotation for name, p in new_sig.parameters.items() if p.annotation is not inspect.Parameter.empty}
    annotations["return"] = dict[str, Any]
    wrapper.__annotations__ = annotations
    wrapper.__module__ = fn.__module__
    mcp.tool(name=fn.__name__, description=fn.__doc__, annotations=ann, structured_output=False)(wrapper)
