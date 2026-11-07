"""Edit an EXISTING dashboard the way the Manual Builder does: in the caller's draft.

Every operation maps onto the Builder's own draft endpoint, so AppBI enforces the
same rules (edit access, row lock, per-author draft buckets, `base_rev` on the
shared draft, responsive layout validation, "edit chart for this report only" as
a fork). Nothing here is visible to viewers, public links or embeds until the user
approves a separate publish (request_publish). Removing a published tile is a
draft removal (restorable), never a delete.

Preview: chart changes are run through AppBI's chart dry-run at plan time (real
query, real numbers on the approval page); after staging, the Builder at
/dashboards/<id> renders the author's draft with the real renderer, and the publish
approval links both views.
"""

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..operations import OperationError, Run
from .dashboard import GRID_COLS, ChartType, pin_measure_aggregations
from .runtime import Env, tool

MAX_OPS = 40


class LayoutOp(BaseModel):
    op: Literal["layout"]
    tile_id: int
    x: int | None = Field(default=None, ge=0, le=GRID_COLS - 1)
    y: int | None = Field(default=None, ge=0, le=2000)
    w: int | None = Field(default=None, ge=1, le=GRID_COLS)
    h: int | None = Field(default=None, ge=1, le=200)
    page_id: str | None = Field(default=None, max_length=200, description="Move the tile to this page")
    title: str | None = Field(default=None, max_length=200, description="Tile title shown on this dashboard only")


class RemoveOp(BaseModel):
    op: Literal["remove"]
    tile_id: int


class RestoreOp(BaseModel):
    op: Literal["restore"]
    tile_id: int


class WidgetOp(BaseModel):
    op: Literal["widget"]
    tile_id: int
    widget_config: dict[str, Any] = Field(description="The non-chart widget's full config (e.g. text/markdown content)")


class EditChartOp(BaseModel):
    op: Literal["edit_chart"]
    tile_id: int
    config: dict[str, Any] = Field(description="Full chart config ('<view>.<field>' names, as in plan_dashboard)")
    chart_type: ChartType | None = None
    name: str | None = Field(default=None, max_length=200)


class SwapChartOp(BaseModel):
    op: Literal["swap_chart"]
    tile_id: int
    chart_id: int


class ResponsiveOp(BaseModel):
    op: Literal["responsive"]
    page_id: str = Field(max_length=200)
    breakpoint: Literal["md", "xs"] = Field(description="md = tablet, xs = phone")
    auto: bool = Field(default=False, description="Reset this page/breakpoint to AppBI's derived layout")
    items: dict[str, dict[str, int]] = Field(default_factory=dict, description="{tile_id: {x, y, w, h}} on a 36-column grid, every tile of the page")


class RemoveFilterOp(BaseModel):
    op: Literal["remove_filter"]
    filter_id: str = Field(max_length=200)


EditOp = Annotated[Union[LayoutOp, RemoveOp, RestoreOp, WidgetOp, EditChartOp, SwapChartOp, ResponsiveOp, RemoveFilterOp],
                   Field(discriminator="op")]


def _tiles(d: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {int(t["id"]): t for t in d.get("dashboard_charts", []) or []}


def _current_layout(d: dict[str, Any], tile_id: int) -> dict[str, Any]:
    """What the caller's Builder shows for this tile: their draft layout, else the live one."""
    draft = (d.get("draft_layouts") or {}).get(str(tile_id))
    return dict(draft or (_tiles(d).get(tile_id) or {}).get("layout") or {})


def _label(t: dict[str, Any]) -> str:
    if t.get("chart"):
        return (t.get("layout") or {}).get("custom_title") or t["chart"].get("name") or f"tile {t['id']}"
    return f"{t.get('widget_type') or 'widget'} {t['id']}"


def _fingerprint(d: dict[str, Any], tile_ids: set[int]) -> dict[str, Any]:
    tiles = _tiles(d)
    return {
        "shared_rev": (d.get("shared_draft") or {}).get("rev"),
        "tiles": {str(i): [(tiles.get(i) or {}).get("chart_id"), ((tiles.get(i) or {}).get("layout") or {}).get("_v"),
                           _current_layout(d, i)] for i in sorted(tile_ids)},
        "responsive": d.get("responsive_layouts"),
    }


@tool(scope=sc.READ, title="Plan edits to an existing dashboard", read_only=True)
async def plan_dashboard_edit(env: Env, dashboard_id: int, operations: Annotated[list[EditOp], Field(min_length=1, max_length=MAX_OPS)]) -> dict[str, Any]:
    """Plan Manual-Builder edits to an EXISTING dashboard, in your draft. Writes nothing.

    Operations: layout (move/resize/retitle/move page), remove / restore a tile
    (draft removal, restorable), widget (text/markdown content), edit_chart (this
    report only: AppBI forks the chart; validated by AppBI's chart dry-run with real
    numbers), swap_chart (show another saved chart in the tile), responsive (tablet
    'md' / phone 'xs' layout of a page, or auto), remove_filter (a report slicer).
    To ADD charts or filters use plan_dashboard with dashboard_id. Read the
    dashboard first with get_dashboard (tile ids, pages, layouts).
    """
    d = await env.appbi.get(f"/dashboards/{dashboard_id}")
    if d.get("user_permission") not in ("edit", "full", "owner"):
        return {"status": "forbidden", "message": "Your AppBI account can view this dashboard but not edit it."}
    tiles = _tiles(d)
    pages = {p.get("id") for p in d.get("pages_config") or [] if isinstance(p, dict)}
    errors: list[str] = []
    rows: list[dict[str, Any]] = []
    steps: list[dict[str, Any]] = []
    previews: list[dict[str, Any]] = []
    touched: set[int] = set()
    model_cache: dict[int, dict[str, str]] = {}

    for i, op in enumerate(operations):
        o = op.model_dump()
        tid = o.get("tile_id")
        if tid is not None:
            if tid not in tiles:
                errors.append(f"op {i}: tile {tid} is not on dashboard {dashboard_id}")
                continue
            touched.add(tid)
        t = tiles.get(tid) if tid is not None else None
        if op.op == "layout":
            cur = _current_layout(d, tid)
            new = dict(cur)
            for k in ("x", "y", "w", "h"):
                if o[k] is not None:
                    new[k] = o[k]
            if o["page_id"]:
                if pages and o["page_id"] not in pages:
                    errors.append(f"op {i}: page '{o['page_id']}' does not exist")
                    continue
                new["pageId"] = o["page_id"]
            if o["title"] is not None:
                new["custom_title"] = o["title"]
                new["styleConfigOverride"] = {**(cur.get("styleConfigOverride") or {}), "chartTitle": o["title"]}
            if int(new.get("x", 0)) + int(new.get("w", 1)) > GRID_COLS:
                errors.append(f"op {i}: tile {tid} would extend past the {GRID_COLS}-column grid")
                continue
            # Draft-row keys (draftOnly/draftOwner/draftRemoved*) are AppBI's bookkeeping,
            # not layout: the server strips them too; they are never sent.
            row_keys = {"_v", "draftOnly", "draftOwner", "draftRemoved", "draftRemovedBy"}
            steps.append({"op": "layout", "tile_id": tid, "layout": {k: v for k, v in new.items() if k not in row_keys}})
            rows.append({"change": "move / resize", "tile": _label(t),
                         "before": f"x{cur.get('x')} y{cur.get('y')} {cur.get('w')}x{cur.get('h')} page {cur.get('pageId') or '-'}",
                         "after": f"x{new.get('x')} y{new.get('y')} {new.get('w')}x{new.get('h')} page {new.get('pageId') or '-'}"
                                  + (f" title '{o['title']}'" if o["title"] is not None else "")})
        elif op.op in ("remove", "restore"):
            steps.append({"op": op.op, "tile_id": tid})
            rows.append({"change": "remove (in your draft; restorable)" if op.op == "remove" else "restore a removed tile",
                         "tile": _label(t), "before": "shown" if op.op == "remove" else "removed in your draft",
                         "after": "removed" if op.op == "remove" else "shown"})
        elif op.op == "widget":
            if not t.get("widget_type") or t.get("widget_type") == "chart":
                errors.append(f"op {i}: tile {tid} is a chart, not a widget")
                continue
            steps.append({"op": "widget", "tile_id": tid, "widget_config": o["widget_config"]})
            rows.append({"change": "widget content", "tile": _label(t), "before": str(t.get("widget_config"))[:300],
                         "after": str(o["widget_config"])[:300]})
        elif op.op == "edit_chart":
            chart = t.get("chart") or {}
            if not t.get("chart_id"):
                errors.append(f"op {i}: tile {tid} has no chart")
                continue
            table_id = chart.get("dataset_table_id")
            ctype = o["chart_type"] or chart.get("chart_type")
            if table_id not in model_cache:
                try:
                    detail = await env.appbi.get(f"/charts/{t['chart_id']}")
                    table_id = detail.get("dataset_table_id", table_id)
                    ctype = o["chart_type"] or detail.get("chart_type")
                except AppbiError:
                    pass
            config, notes = pin_measure_aggregations(dict(o["config"]), {})
            config.setdefault("chartType", ctype)
            name = o["name"] or chart.get("name") or f"Chart {t['chart_id']}"
            dry = await env.appbi.post("/charts/dry-run-create", {"name": name, "chart_type": ctype, "dataset_table_id": table_id, "config": config})
            if not dry.get("ok"):
                errors.append(f"op {i}: AppBI rejected the chart: {dry.get('validation_errors') or dry.get('runtime_errors') or dry.get('runtime_refusal')}")
                continue
            sample = (dry.get("runtime_preview_sample") or [])[:5]
            steps.append({"op": "edit_chart", "tile_id": tid, "body": {"name": name, "chart_type": ctype, "dataset_table_id": table_id,
                                                                      "config": dry["normalized_config"]}})
            rows.append({"change": "edit chart (this report only)", "tile": _label(t), "before": f"chart #{t['chart_id']} {chart.get('chart_type')}",
                         "after": f"{ctype}, AppBI-validated"})
            previews.append({"tile": _label(t), "rows": sample})
        elif op.op == "swap_chart":
            try:
                other = await env.appbi.get(f"/charts/{o['chart_id']}")
            except AppbiError as exc:
                errors.append(f"op {i}: chart {o['chart_id']}: {exc.message}")
                continue
            steps.append({"op": "swap_chart", "tile_id": tid, "chart_id": o["chart_id"]})
            rows.append({"change": "show another chart", "tile": _label(t), "before": f"chart #{t.get('chart_id')}",
                         "after": f"chart #{o['chart_id']} '{other.get('name')}'"})
        elif op.op == "responsive":
            if pages and o["page_id"] not in pages:
                errors.append(f"op {i}: page '{o['page_id']}' does not exist")
                continue
            published = (((d.get("responsive_layouts") or {}).get("pages") or {}).get(o["page_id"]) or {}).get(o["breakpoint"]) or {}
            profile = {"mode": "auto"} if o["auto"] else {"mode": "custom", "cols": GRID_COLS, "items": o["items"]}
            steps.append({"op": "responsive", "page_id": o["page_id"], "breakpoint": o["breakpoint"], "profile": profile,
                          "base_rev": int(published.get("rev") or 0)})
            rows.append({"change": f"{'tablet' if o['breakpoint'] == 'md' else 'phone'} layout", "tile": f"page {o['page_id']}",
                         "before": "custom" if published else "auto", "after": "auto" if o["auto"] else f"custom ({len(o['items'])} tiles)"})
        elif op.op == "remove_filter":
            have = [f for f in d.get("slicers_config") or [] if isinstance(f, dict)]
            if o["filter_id"] not in {str(f.get("id")) for f in have}:
                errors.append(f"op {i}: filter '{o['filter_id']}' is not a report filter")
                continue
            steps.append({"op": "remove_filter", "filter_id": o["filter_id"]})
            label = next((f.get("label") for f in have if str(f.get("id")) == o["filter_id"]), o["filter_id"])
            rows.append({"change": "remove report filter", "tile": label, "before": "applies to the report", "after": "removed (draft)"})

    if errors:
        return {"status": "invalid", "errors": errors}

    summary = {
        "sections": [
            {"title": "Dashboard", "items": [{"name": d.get("name"), "id": dashboard_id, "visibility": "Your draft only until a separate publish"}]},
            {"title": "Changes", "items": rows},
            *([{"title": f"Real data preview (AppBI dry-run): {p['tile']}", "items": p["rows"] or ["(no rows)"]} for p in previews]),
            {"title": "Your current draft in the Builder (real renderer)", "links": [env.link(f"/dashboards/{dashboard_id}")]},
            {"title": "What happens", "items": [
                "AppBI applies each change to YOUR draft, exactly as the Builder does; viewers, public links and embeds see nothing until you publish.",
                "Removed tiles are removed in your draft only and can be restored; nothing is deleted.",
                "If a co-author changed this dashboard after this plan, the run stops instead of overwriting their work.",
            ]},
        ],
        "warnings": [],
    }
    plan = env.plans.create(user_id=env.principal.user_id, grant_id=env.principal.grant_id, kind="dashboard_edit",
                            body={"dashboard_id": dashboard_id, "steps": steps}, summary=summary, fingerprint=_fingerprint(d, touched))
    return {"status": "awaiting_approval", "plan_id": plan.id, "plan_hash": plan.plan_hash, "approval_url": env.approval_url(plan.id),
            "changes": rows, "previews": previews,
            "next": "Ask the user to approve in the browser, then call execute_plan(plan_id). Publishing is a separate request_publish."}


async def run_dashboard_edit(env: Env, run: Run) -> dict[str, Any]:
    body = run.plan.body
    did = int(body["dashboard_id"])
    touched = {int(s["tile_id"]) for s in body["steps"] if s.get("tile_id") is not None}
    if env.plans.step(run.plan.id, "start_check") is None:
        current = await env.appbi.get(f"/dashboards/{did}")
        if _fingerprint(current, touched) != run.plan.fingerprint:
            raise OperationError("stale_plan", "This dashboard changed after the plan was approved (a co-author or another edit). Plan again.",
                                 step="start_check")
        env.plans.mark(run.plan.id, "start_check", "done", result={"ok": True})

    base = f"/dashboards/{did}"
    for i, s in enumerate(body["steps"]):
        key = f"{s['op']}:{i}"
        try:
            if s["op"] == "layout":
                await run.write(key, lambda s=s: env.appbi.put(f"{base}/draft-layout", {"chart_layouts": [{"id": s["tile_id"], "layout": s["layout"]}]}))
            elif s["op"] == "remove":
                await run.write(key, lambda s=s: env.appbi.request("DELETE", f"{base}/charts/{s['tile_id']}", params={"draft": "true"}))
            elif s["op"] == "restore":
                await run.write(key, lambda s=s: env.appbi.post(f"{base}/charts/{s['tile_id']}/restore"))
            elif s["op"] == "widget":
                await run.write(key, lambda s=s: env.appbi.request("PATCH", f"{base}/widgets/{s['tile_id']}", params={"draft": "true"},
                                                                     json={"widget_config": s["widget_config"]}))
            elif s["op"] == "edit_chart":
                await run.write(key, lambda s=s: env.appbi.post(f"{base}/charts/{s['tile_id']}/fork-chart", s["body"]))
            elif s["op"] == "swap_chart":
                await run.write(key, lambda s=s: env.appbi.post(f"{base}/charts/{s['tile_id']}/swap-chart", {"chart_id": s["chart_id"]}))
            elif s["op"] == "responsive":
                await run.write(key, lambda s=s: env.appbi.put(f"{base}/draft-responsive", {
                    "page_id": s["page_id"], "breakpoint": s["breakpoint"], "profile": s["profile"], "base_rev": s["base_rev"]}))
            elif s["op"] == "remove_filter":
                async def drop(s: dict[str, Any] = s) -> dict[str, Any]:
                    current = await env.appbi.get(base)
                    kept = [f for f in current.get("slicers_config") or [] if str(f.get("id")) != s["filter_id"]]
                    await env.appbi.put(f"{base}/draft-filters", {"slicers_config": kept, "base_rev": (current.get("shared_draft") or {}).get("rev")})
                    return {"removed": s["filter_id"]}
                await run.write(key, drop)
        except AppbiError as exc:
            if exc.status == 409:
                raise OperationError("conflict", f"AppBI refused to overwrite a co-author's change: {exc.message}", step=key, detail=exc.detail) from exc
            raise

    after = await env.appbi.get(base)
    run.resources.append({"type": "dashboard", "id": did, "url": env.link(base), "state": "draft"})
    return {"status": "draft_ready", "dashboard_id": did, "has_draft": after.get("has_draft"),
            "preview_url": env.link(base), "applied": [s["op"] for s in body["steps"]],
            "next": "Open preview_url to see your draft in the Builder. To make it live call request_publish(resource_type='dashboard')."}
