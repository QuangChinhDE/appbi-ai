"""The AI Bot of a Report-as-Code public link — the dashboard bot's Answer Core, on a report.

Nothing here answers a question. It builds, for one report link, the same thing the
dashboard bot builds for a dashboard link (api/public.py:_public_link_tool_context):
the ToolContext the Answer Core reads through. The Core, the Semantic Model, the
governance (GovernAIScope exclusions), the Model Gateway and its budget are the ones
every public bot uses (services/answer_core/public_turn.py).

What the bot may read is what the link serves, and nothing else:
- charts: the PUBLISHED revision's binding charts (a draft binding is never in scope);
- filters: the link's locks applied server-side, hidden locks applied but never named,
  then the viewer's own choices on the filters the link lets them set;
- model-added filters: only on the filters the viewer may set — a lock cannot be
  loosened by asking (ToolContext.exposed_fields).
An Agent Flow add-on is a dashboard-link binding today; a report link has none.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.services.report_code import bindings as B
from app.services.report_code import public_links as PL


def ledger_link_id(link_id: int) -> int:
    """The link's id in the shared AI usage ledger (ai_usage_ledger.link_id, no FK).
    Report links live in the negative namespace there, so a report link never shares
    a dashboard link's daily USD budget or advisory lock just because their row ids match."""
    return -int(link_id)


def bot_enabled(appearance: Any) -> bool:
    return isinstance(appearance, dict) and bool(appearance.get("ai_bot_enabled"))


def build_context(db: Session, rev, link, viewer_state: Any):
    """The link's ToolContext: published charts, locks, the viewer's filters."""
    from app.models.models import Chart
    from app.services.agent_flows.tools.context import ToolContext

    decl = list(rev.filters or [])
    state = PL.effective_state(decl, link.filters_config, viewer_state or {}, link.appearance_config)
    enforced = PL.enforced_keys(decl, link.filters_config, link.appearance_config)
    state = B.resolve_state(db, decl, state, enforced)  # the report's default period, as the page shows it
    hidden_keys = {str(e.get("field")) for e in (link.filters_config or [])
                   if isinstance(e, dict) and e.get("hidden")}
    public_filters: List[Dict[str, Any]] = []
    from app.services.filter_layered_merge import DISCLOSE_KEY

    for key, value in state.items():
        for cond in B.conditions(decl, {key: value}, enforced=enforced):
            # a hidden lock is enforced and counted, never named to the model or the
            # viewer - the marker every public surface's disclosure reads
            public_filters.append({**cond, DISCLOSE_KEY: False} if key in hidden_keys else cond)

    chart_ids = {int(b["chart_id"]) for b in rev.bindings or [] if isinstance(b.get("chart_id"), int)}
    charts = db.query(Chart).filter(Chart.id.in_(chart_ids)).all() if chart_ids else []
    dataset_ids = sorted({f["datasetId"] for f in decl if f.get("datasetId")}
                         | {int(c.config.get("dataset_id")) for c in charts
                            if isinstance(c.config, dict) and c.config.get("dataset_id")})
    viewer, _, _ = PL.scope(decl, link.filters_config, link.appearance_config)
    exposed = ({str(f["fieldKey"]) for f in viewer if f.get("fieldKey")},
               {str(f["field"]) for f in viewer if f.get("field") and "." not in str(f["field"])})
    ctx = ToolContext(db=db, dashboard=None, public_filters=public_filters,
                      exposed_fields=exposed,
                      snapshot_ttl_minutes=None)
    ctx.served_table_ids = {c.dataset_table_id for c in charts if c.dataset_table_id is not None}
    ctx.adopt_scope(chart_ids, dataset_ids)
    # the report's own titles for its charts (what the viewer reads on the page)
    for b in rev.bindings or []:
        cid = b.get("chart_id")
        if cid in ctx.chart_meta and b.get("title"):
            ctx.chart_meta[cid]["name"] = str(b["title"])
    return ctx


def resolver(token: str, session_token: Optional[str], viewer_state: Any):
    """(db) -> LinkTurnContext, re-authenticated on the session it is given (the turn
    runs on a worker's own session; the link may have closed since admission)."""
    from app.services.answer_core.public_turn import LinkTurnContext

    def resolve(db: Session):
        art, rev, link = PL.resolve(db, token, session_token, track=False)
        if not bot_enabled(link.appearance_config):
            raise PermissionError("ai bot disabled")
        return LinkTurnContext(ctx=build_context(db, rev, link, viewer_state),
                               appearance=dict(link.appearance_config or {}), flow_key=None)

    return resolve
