"""Public Read MCP — what a customer's own Claude may read of ONE public link.

Not a second Core. Every number comes from the path the link's own viewer reads:

- dashboard link: the link's ToolContext (`public_link_scope.link_tool_context`, i.e.
  `api/public.py:_public_link_tool_context` — layered filters, 🔒/🚫 locks, page
  bounds, exposed fields, freshness) and `_fetch_chart_data`, the AI Bot's read;
- report (Vibe) link: `bindings.mint_dto`, the very DTO the page draws, under
  `public_links.effective_state` (a lock override is refused, not ignored).

No model is called here, no Model Gateway, no owner AI key: the reasoning runs in the
customer's Claude. This module only reads, and only what the link serves.

Authority is a GRANT (`grant_encode`): one link, at one security generation
(`auth_version`: password / expiry / active changes revoke), at one publisher epoch
(`mcp_access.epoch`: the publisher's "disconnect every Claude"), for one viewer
session (`sid`). Every request re-resolves the link through the official resolver,
so a closed, expired or switched-off link stops answering on the next call.
"""
from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Dict, List, Optional

from app.services.public_mcp import access as A

log = logging.getLogger("app.public_mcp")

DASHBOARD = "dashboard"
REPORT = "report"
KINDS = (DASHBOARD, REPORT)
GRANT_TTL = timedelta(hours=8)
#: rows handed to Claude per chart read; more is reported as truncated, never cut silently
MAX_ROWS = 500
#: frontend/src/lib/dashboard-pages.ts DEFAULT_DASHBOARD_PAGE_ID: a tile with no pageId is on it
DEFAULT_PAGE_ID = "page-1"


class Refused(Exception):
    """A request this link does not serve. `code` is stable for the MCP; the message is
    safe to show (never names a hidden lock)."""

    def __init__(self, code: str, message: str, status: int = 403):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# ── grants ────────────────────────────────────────────────────────────────────

def grant_encode(kind: str, link: Any, sid: Optional[str] = None) -> Dict[str, Any]:
    from app.core import tokens

    sid = sid or ("vs_" + secrets.token_urlsafe(18))
    claims = {"k": kind, "lid": int(link.id), "av": int(link.auth_version or 0),
              "ep": A.settings_of(link.appearance_config)["epoch"], "sid": sid}
    token = tokens.encode(tokens.PUBLIC_MCP_GRANT, claims, ttl=GRANT_TTL)
    return {"grant": token, "sid": sid, "expires_in": int(GRANT_TTL.total_seconds())}


def grant_decode(grant: Optional[str]) -> Dict[str, Any]:
    from app.core import tokens

    data = tokens.decode(grant, tokens.PUBLIC_MCP_GRANT)
    if not data or data.get("k") not in KINDS or not isinstance(data.get("lid"), int) or not data.get("sid"):
        raise Refused("invalid_grant", "This Claude connection is not valid or has expired. Reconnect from the report.", 401)
    return data


def check_grant_against(link: Any, claims: Dict[str, Any]) -> None:
    """The live link still serves this grant: same security generation, MCP on, same epoch."""
    if int(link.auth_version or 0) != int(claims.get("av", -1)):
        raise Refused("link_changed", "The publisher changed this link's access. Reconnect from the report.", 401)
    cfg = A.settings_of(link.appearance_config)
    if not cfg["enabled"]:
        raise Refused("mcp_disabled", "The publisher has turned off Claude access for this report.", 403)
    if cfg["epoch"] != int(claims.get("ep", -1)):
        raise Refused("mcp_revoked", "The publisher disconnected Claude from this report. Reconnect from the report.", 401)


# ── an opened link ────────────────────────────────────────────────────────────

@dataclass
class Handle:
    kind: str
    link: Any
    sid: str
    name: str
    appearance: Dict[str, Any]
    filters_config: List[Dict[str, Any]]
    dash: Any = None
    art: Any = None
    rev: Any = None
    extra: Dict[str, Any] = field(default_factory=dict)


def _num(v: Any) -> Any:
    from decimal import Decimal

    return float(v) if isinstance(v, Decimal) else v


def _clip_rows(columns: List[str], rows: List[list]) -> Dict[str, Any]:
    out = {"columns": columns, "rows": [[_num(v) for v in r] for r in rows[:MAX_ROWS]],
           "row_count": len(rows), "truncated": len(rows) > MAX_ROWS}
    return out


def _guide(h: Handle) -> Optional[Dict[str, Any]]:
    """The publisher guide, only when the publisher shares it with an external AI (D2)."""
    if not A.settings_of(h.appearance)["share_guide"]:
        return None
    from app.services.answer_core import publisher_guide as PG

    g = PG.load(h.appearance)
    out = g.model_dump(mode="json") if g is not None else {}
    # the publisher's own instructions to the report's assistant: the AppBI AI Bot's system
    # prompt (`ai_bot_report_context_note`), the same foundation for both engines
    from app.services.dashboard_ai_bot.public_link_config import sanitize_report_context_note

    note = sanitize_report_context_note(h.appearance.get("ai_bot_report_context_note"))
    if note:
        out["instructions"] = note
    return out or None


# ── dashboard links ───────────────────────────────────────────────────────────

def _dash_ctx(db, h: Handle, viewer_filters: List[dict]):
    from app.services.public_link_scope import link_tool_context

    return link_tool_context(db, dashboard=h.dash, filters_config=h.filters_config,
                             appearance_config=h.appearance, viewer_filters=viewer_filters,
                             context_for_log="public_mcp")


def _locked_fields(filters_config: List[dict]) -> set:
    out = set()
    for e in filters_config or []:
        if isinstance(e, dict):
            for k in ("field", "semanticField", "fieldKey"):
                if e.get(k):
                    out.add(str(e[k]))
    return out


def _filter_field(f: dict) -> str:
    return str(f.get("semanticField") or f.get("fieldKey") or f.get("field") or "")


def check_dashboard_filters(db, h: Handle, viewer_filters: List[dict]) -> None:
    """The viewer filters Claude asks for: only fields the page lets a viewer set, never a
    locked field. Refused loudly (the page would silently keep the lock)."""
    if viewer_filters and h.appearance.get("allow_viewer_filters") is False:
        raise Refused("filters_not_allowed", "This report does not let viewers change filters.")
    ctx = _dash_ctx(db, h, [])
    locked = _locked_fields(h.filters_config)
    from app.services.filter_layered_merge import filter_names_only_exposed_fields

    for f in viewer_filters or []:
        if not isinstance(f, dict):
            raise Refused("bad_filter", "A filter must be an object.", 400)
        name = _filter_field(f)
        if not name or name in locked or (ctx.exposed_fields and not filter_names_only_exposed_fields(f, *ctx.exposed_fields)):
            raise Refused("filter_not_adjustable", f"The filter on '{name or '?'}' is not one a viewer of this report can change.")


def _drill_filter(drill: Optional[dict]) -> Optional[dict]:
    if not drill:
        return None
    fld, val = drill.get("field"), drill.get("value")
    if not fld or val is None:
        raise Refused("bad_drill", "A drill-down needs a field and a value.", 400)
    return {"field": str(fld), "operator": "in", "value": [val]}


def page_charts(pages: List[Dict[str, Any]], tiles: Dict[int, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Each page with the charts whose tiles sit on it (a tile without a pageId is on the default page)."""
    return [{"page_id": p.get("id"), "name": p.get("name"),
             "chart_ids": sorted({cid for cid, ts in tiles.items() for t in ts if t["page_id"] == str(p.get("id"))})}
            for p in pages]


def describe_dashboard(db, h: Handle, state: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.filter_layered_merge import DISCLOSE_KEY, link_filters_a_viewer_may_see

    ctx = _dash_ctx(db, h, state.get("viewer_filters") or [])
    tiles: Dict[int, List[Dict[str, Any]]] = {}
    for dc in h.dash.dashboard_charts or []:
        if dc.chart_id in ctx.allowed_chart_ids:
            layout = dc.layout if isinstance(dc.layout, dict) else {}
            tiles.setdefault(dc.chart_id, []).append({"tile_id": dc.id, "page_id": str(layout.get("pageId") or "").strip() or DEFAULT_PAGE_ID})
    charts = []
    for cid in sorted(ctx.allowed_chart_ids):
        meta = ctx.chart_meta.get(cid) or {}
        fields = meta.get("fields") or {}
        charts.append({
            "chart_id": cid, "title": meta.get("name") or f"Chart {cid}", "type": meta.get("chart_type") or "",
            "description": meta.get("description") or "",
            "measures": [{"field": m.get("field"), "label": m.get("label"), "aggregation": m.get("agg")} for m in fields.get("measures") or []],
            "dimensions": [{"field": d.get("field"), "label": d.get("label")} for d in fields.get("dimensions") or []],
            "tiles": tiles.get(cid, []),
        })
    visible_locks = link_filters_a_viewer_may_see(h.filters_config)
    hidden_count = sum(1 for e in h.filters_config or [] if isinstance(e, dict) and e.get("hidden"))
    return {
        "kind": DASHBOARD, "name": h.name,
        # A chart is on the page its tile is placed on (the viewer renders by tile pageId) — not on
        # the page record's own chart_ids, which can lag the layout.
        "pages": page_charts(ctx.pages or [], tiles),
        "charts": charts,
        "viewer_filters_allowed": h.appearance.get("allow_viewer_filters") is not False,
        "locked_filters": [{"field": _filter_field(e), "operator": e.get("operator"), "value": e.get("value")}
                           for e in visible_locks if isinstance(e, dict) and e.get(DISCLOSE_KEY, True) is not False],
        "other_fixed_filters": hidden_count,
        "publisher_guide": _guide(h),
    }


def dashboard_chart_data(db, h: Handle, chart_id: int, state: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.agent_flows.tools.context import ToolError, _fetch_chart_data

    ctx = _dash_ctx(db, h, state.get("viewer_filters") or [])
    if int(chart_id) not in ctx.allowed_chart_ids:
        raise Refused("chart_not_published", f"Chart {chart_id} is not part of this public report.", 404)
    drill = state.get("drill") if isinstance(state.get("drill"), dict) else None
    extra = None
    if drill and int(drill.get("chart_id") or 0) != int(chart_id):
        extra = [_drill_filter(drill)]  # a cross-filter filters every OTHER chart, as on the page
    try:
        data = _fetch_chart_data(ctx, int(chart_id), extra_filters=extra)
    except ToolError as exc:
        raise Refused(getattr(exc, "code", "") or "read_refused", str(exc), 400)
    out = _clip_rows(list(data.get("columns") or []), list(data.get("rows") or []))
    meta = ctx.chart_meta.get(int(chart_id)) or {}
    out.update({"chart_id": int(chart_id), "title": meta.get("name"),
                "filters_applied": _disclosed(data.get("filters_applied") or [])})
    return out


def _disclosed(filters: List[dict]) -> List[dict]:
    from app.services.filter_layered_merge import DISCLOSE_KEY

    shown = []
    for f in filters:
        if not isinstance(f, dict) or f.get(DISCLOSE_KEY) is False:
            continue
        shown.append({"field": _filter_field(f), "operator": f.get("operator"), "value": f.get("value")})
    return shown


# ── report (Vibe) links ───────────────────────────────────────────────────────

def _report_state(h: Handle, filters: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.report_code import public_links as PL

    try:
        return PL.effective_state(h.rev.filters or [], h.link.filters_config, filters or {}, h.link.appearance_config)
    except ValueError:
        raise Refused("filter_not_adjustable", "One of these filters is not one a viewer of this report can change.")


def check_report_filters(h: Handle, filters: Dict[str, Any]) -> None:
    _report_state(h, filters)


def describe_report(db, h: Handle, state: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.report_code import bindings as B
    from app.services.report_code import public_bot as PB
    from app.services.report_code import public_links as PL

    viewer, _, banner = PL.scope(h.rev.filters or [], h.link.filters_config, h.link.appearance_config)
    shown = PB.page_bindings(h.rev)
    sections = PB.page_sections(h.rev, {str(b["id"]): b.get("chart_id") for b in shown})
    ctx = PB.build_context(db, h.rev, h.link, state.get("filters") or {})
    charts = []
    for b in shown:
        cid = b.get("chart_id")
        meta = ctx.chart_meta.get(cid) or {}
        fields = meta.get("fields") or {}
        charts.append({
            "binding": str(b["id"]), "title": b.get("title") or meta.get("name") or "", "kind": b.get("kind") or "",
            "measures": [{"field": m.get("field"), "label": m.get("label"), "aggregation": m.get("agg")} for m in fields.get("measures") or []],
            "dimensions": [{"field": d.get("field"), "label": d.get("label")} for d in fields.get("dimensions") or []],
        })
    hidden_count = sum(1 for e in h.link.filters_config or [] if isinstance(e, dict) and e.get("hidden"))
    return {
        "kind": REPORT, "name": h.name, "version": h.rev.number,
        "sections": [{"section_id": s["id"], "name": s["name"],
                      "bindings": [str(b["id"]) for b in shown if b.get("chart_id") in s["chart_ids"]]} for s in sections],
        "charts": charts,
        "viewer_filters": B.public_filters(viewer),
        "locked_filters": banner,
        "other_fixed_filters": hidden_count,
        "publisher_guide": _guide(h),
    }


def report_chart_data(db, h: Handle, binding_id: str, state: Dict[str, Any]) -> Dict[str, Any]:
    from app.services.report_code import bindings as B
    from app.services.report_code import public_bot as PB
    from app.services.report_code import public_links as PL

    shown = {str(b["id"]): b for b in PB.page_bindings(h.rev)}
    binding = shown.get(str(binding_id))
    if binding is None:
        raise Refused("chart_not_published", f"'{binding_id}' is not a chart of this public report.", 404)
    st = _report_state(h, state.get("filters") or {})
    hidden = {str(e.get("field")) for e in (h.link.filters_config or []) if isinstance(e, dict) and e.get("hidden")}
    decl = h.rev.filters or []
    dto = B.mint_dto(db, binding, decl, st, public=True,
                     disclose=[f["key"] for f in decl if f["key"] not in hidden],
                     enforced=PL.enforced_keys(decl, h.link.filters_config, h.link.appearance_config))
    return {"binding": str(binding_id), "title": binding.get("title") or "", "dto": dto}


def report_filter_values(db, h: Handle, key: str, search: str, state: Dict[str, Any]) -> List[Any]:
    from app.services.report_code import bindings as B
    from app.services.report_code import public_links as PL

    decl = h.rev.filters or []
    viewer, _, _ = PL.scope(decl, h.link.filters_config, h.link.appearance_config)
    if key not in {f["key"] for f in viewer}:
        raise Refused("filter_not_adjustable", "This filter is not one a viewer of this report can change.")
    st = _report_state(h, state.get("filters") or {})
    return B.filter_values(db, decl, st, key, search or "",
                           enforced=PL.enforced_keys(decl, h.link.filters_config, h.link.appearance_config))


# ── one entry point per operation ─────────────────────────────────────────────

def describe(db, h: Handle, state: Dict[str, Any]) -> Dict[str, Any]:
    out = describe_dashboard(db, h, state) if h.kind == DASHBOARD else describe_report(db, h, state)
    from app.services.public_mcp.brief import render

    out["assistant_brief"] = render(out)
    return out


def chart_data(db, h: Handle, ref: Any, state: Dict[str, Any]) -> Dict[str, Any]:
    if h.kind == DASHBOARD:
        try:
            cid = int(ref)
        except (TypeError, ValueError):
            raise Refused("bad_chart", "chart must be a chart_id of this dashboard.", 400)
        return dashboard_chart_data(db, h, cid, state)
    return report_chart_data(db, h, str(ref), state)


def check_state(db, h: Handle, state: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a view state Claude wants the viewer's page to show. Raises Refused."""
    if h.kind == DASHBOARD:
        check_dashboard_filters(db, h, state.get("viewer_filters") or [])
        if state.get("drill"):
            _drill_filter(state["drill"])
            dashboard_chart_data(db, h, int(state["drill"].get("chart_id") or 0), {"viewer_filters": state.get("viewer_filters") or []})
    else:
        check_report_filters(h, state.get("filters") or {})
    return {"ok": True}


def audit(h: Handle, op: str, **fields: Any) -> None:
    log.info("public_mcp op=%s kind=%s link=%s sid=%s %s", op, h.kind, h.link.id, h.sid[:10],
             " ".join(f"{k}={v}" for k, v in fields.items()))
