"""Stage 5 — Dashboard.

Tools for assembling charts into dashboards: layout, filters, public links.
Prefer the blueprint flow (`propose_dashboard_blueprint` →
`commit_dashboard_blueprint`) for multi-chart builds — these granular tools
are for incremental edits to an existing dashboard.

Filters: AppBI uses a hybrid model where dashboard filters are stored as a
JSON array on the dashboard itself (`filters_config`). There is no separate
filter CRUD endpoint, so add/remove operations go through `update_dashboard`.
"""
from __future__ import annotations

from typing import Any

from appbi_core import (
    Context,
    _append_session_log,
    _confirmation_required_for_destructive,
    _drop_none,
    _query_path,
    _request,
    _requires_confirmation,
    tool,
)


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@tool("report")
async def list_dashboards(
    skip: int = 0,
    limit: int = 50,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List dashboards (full rows incl. placements + filters).

    Use `list_accessible_dashboards_summary` for a slim picker payload.
    """
    items = await _request(
        "GET",
        _query_path("/dashboards/", {"skip": skip, "limit": limit}),
    )
    return {"items": items}


@tool("all")
async def list_accessible_dashboards_summary(
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Slim dashboard list: {id, name, description, permission}.

    Use for pickers (avoids full DashboardResponse payload).
    """
    items = await _request("GET", "/dashboards/accessible-summary")
    return {"items": items}


@tool("report")
async def get_dashboard(
    dashboard_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Fetch one dashboard with its full chart placements + layout + filters."""
    return await _request("GET", f"/dashboards/{int(dashboard_id)}")


@tool("report")
async def get_dashboard_filter_fields(
    dashboard_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Return the slicer-style filter slots a dashboard exposes.

    Each entry: {datasetId, semanticField:'view.col', label, type, ...}.
    Use when designing public-link filter presets or workboard dashboard
    screen role_filter_mapping / static_filters.
    """
    return await _request(
        "GET", f"/dashboards/{int(dashboard_id)}/filter-fields"
    )


@tool("all")
async def list_public_links(
    dashboard_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List user-created public links on a dashboard.

    Workboard-managed links (source='workboard') are hidden — those belong
    to a workboard dashboard screen and self-regenerate on save.
    """
    items = await _request(
        "GET", f"/dashboards/{int(dashboard_id)}/public-links"
    )
    return {
        "items": items,
        "note": (
            "Backend only returns links with source='user'. Workboard-managed "
            "links are hidden here on purpose."
        ),
    }


# ---------------------------------------------------------------------------
# Write — dashboard CRUD
# ---------------------------------------------------------------------------


@tool("all")
async def create_dashboard(
    name: str,
    description: str | None = None,
    charts: list[dict[str, Any]] | None = None,
    filters_config: list[dict[str, Any]] | None = None,
    public_filters_config: list[dict[str, Any]] | None = None,
    pages_config: list[dict[str, Any]] | None = None,
    layout_mode: str = "grid",
    theme_config: dict[str, Any] | None = None,
    canvas_config: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a dashboard with optional pre-populated charts.

    **For a new dashboard build, use `build_dashboard_from_design`
    instead** — it reads the Phase 1 design log and creates charts +
    dashboard together. This granular tool is for assembling a
    dashboard from charts that already exist.

    `charts`: [{chart_id, layout:{x,y,w,h}, parameters?, widget_type?}]
      OR non-chart [{widget_type, widget_config, layout}].
    `filters_config`: [{id, name, type:text|number|date|dropdown,
      field:'view.col', default_value?, scope}].
    `public_filters_config`: same shape, baked into the public-share
      token (viewers can't change).
    `pages_config`: [{id, name, order?}] for tab pages; charts pin via
      layout.pageId.
    `layout_mode`: "grid"|"canvas".
    `theme_config` keys: mode, accent, font, background, density,
      cardStyle, cardRadius, cardShadow, hoverAnimation.
    """
    body = _drop_none(
        {
            "name": name,
            "description": description,
            "charts": charts or [],
            "filters_config": filters_config,
            "public_filters_config": public_filters_config,
            "pages_config": pages_config,
            "layout_mode": layout_mode,
            "theme_config": theme_config,
            "canvas_config": canvas_config,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "create_dashboard",
            {
                "name": name,
                "chart_count": len(charts or []),
                "filter_count": len(filters_config or []),
                "public_filter_count": len(public_filters_config or []),
                "page_count": len(pages_config or []),
                "layout_mode": layout_mode,
            },
        )
    result = await _request("POST", "/dashboards/", json_body=body)
    dashboard_id = result.get("id") if isinstance(result, dict) else None
    _append_session_log(
        "report",
        "create_dashboard",
        {
            "dashboard_id": dashboard_id,
            "name": name,
            "layout_mode": layout_mode,
            "initial_chart_count": len(charts or []),
            "filter_count": len(filters_config or []),
        },
    )
    return result


@tool("all")
async def update_dashboard(
    dashboard_id: int,
    name: str | None = None,
    description: str | None = None,
    filters_config: list[dict[str, Any]] | None = None,
    public_filters_config: list[dict[str, Any]] | None = None,
    pages_config: list[dict[str, Any]] | None = None,
    layout_mode: str | None = None,
    theme_config: dict[str, Any] | None = None,
    canvas_config: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Patch a dashboard. To replace the filters list, pass `filters_config`.

    Note: filters are stored as a JSON array on the dashboard itself —
    there is no separate filter CRUD. Use the `add_dashboard_filter` /
    `remove_dashboard_filter` helpers for safer additive operations.
    """
    changes = _drop_none(
        {
            "name": name,
            "description": description,
            "filters_config": filters_config,
            "public_filters_config": public_filters_config,
            "pages_config": pages_config,
            "layout_mode": layout_mode,
            "theme_config": theme_config,
            "canvas_config": canvas_config,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "update_dashboard",
            {
                "dashboard_id": int(dashboard_id),
                "fields": sorted(changes.keys()),
            },
        )
    return await _request(
        "PUT", f"/dashboards/{int(dashboard_id)}", json_body=changes
    )


@tool("all")
async def delete_dashboard(
    dashboard_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete a dashboard. Cascades to public links and chart placements."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_dashboard",
            {"dashboard_id": int(dashboard_id)},
            reversible=False,
        )
    await _request(
        "DELETE", f"/dashboards/{int(dashboard_id)}", expect_json=False
    )
    return {"status": "deleted", "dashboard_id": int(dashboard_id)}


# ---------------------------------------------------------------------------
# Write — chart placements
# ---------------------------------------------------------------------------


@tool("all")
async def add_chart_to_dashboard(
    dashboard_id: int,
    chart_id: int,
    layout: dict[str, Any],
    parameters: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Place an existing chart on an existing dashboard.

    **For a new dashboard build, do NOT use this** —
    `build_dashboard_from_design` creates charts AND places them. This
    granular tool is for adding a single chart to a dashboard later.

    `layout` {i?,x,y,w,h} react-grid-layout 12-col × 80px. Defaults:
    KPI=3×2, LINE/BAR/AREA/PIE=6×4, TABLE/PIVOT=12×5, SCATTER=6×5,
    COMBO=12×4. Min w≥3, h≥2.
    `parameters` is optional runtime parameter overrides for THIS placement.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "add_chart_to_dashboard",
            {
                "dashboard_id": int(dashboard_id),
                "chart_id": int(chart_id),
                "layout": layout,
                "parameters": parameters,
            },
        )
    body = _drop_none(
        {
            "chart_id": int(chart_id),
            "layout": layout,
            "parameters": parameters,
            "widget_type": "chart",
        }
    )
    result = await _request(
        "POST", f"/dashboards/{int(dashboard_id)}/charts", json_body=body
    )
    _append_session_log(
        "report",
        "add_chart_to_dashboard",
        {
            "dashboard_id": int(dashboard_id),
            "chart_id": int(chart_id),
            "layout": layout,
        },
    )
    return result


@tool("all")
async def add_widget_to_dashboard(
    dashboard_id: int,
    widget_type: str,
    layout: dict[str, Any],
    widget_config: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Place a non-chart widget on a dashboard.

    `widget_type` ∈ {'text', 'countdown', 'image', 'shape',
    'parameter_switcher'}. `widget_config` shape depends on the type
    (text: {markdown} or {template}, image: {url, alt},
    countdown: {target_date} or {target}, shape: {shape} or {kind}, etc.).
    """
    if widget_type == "chart":
        raise ValueError("Use add_chart_to_dashboard for chart widgets.")
    if not user_confirmed:
        return _requires_confirmation(
            "add_widget_to_dashboard",
            {
                "dashboard_id": int(dashboard_id),
                "widget_type": widget_type,
                "layout": layout,
                "widget_config_keys": sorted((widget_config or {}).keys()),
            },
        )
    body = _drop_none(
        {
            "layout": layout,
            "widget_type": widget_type,
            "widget_config": widget_config or {},
        }
    )
    return await _request(
        "POST", f"/dashboards/{int(dashboard_id)}/widgets", json_body=body
    )


@tool("all")
async def update_widget_config(
    dashboard_id: int,
    dashboard_chart_id: int,
    widget_config: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Edit a non-chart widget placement in place (no delete+re-add).

    `dashboard_chart_id` is the placement id (`dashboard_charts[].id`),
    not chart id. `widget_config` shape by widget_type:
      text → {markdown} or {template}
      image → {url, alt?}
      countdown → {target_date} or {target}
      shape → {shape, color?} or {kind}
      parameter_switcher → {parameter_id, options:[{label,value}]}
    400 if placement is a chart (use update_chart).
    """
    if not user_confirmed:
        return _requires_confirmation(
            "update_widget_config",
            {
                "dashboard_id": int(dashboard_id),
                "dashboard_chart_id": int(dashboard_chart_id),
                "config_keys": sorted(widget_config.keys()),
            },
        )
    return await _request(
        "PATCH",
        f"/dashboards/{int(dashboard_id)}/widgets/{int(dashboard_chart_id)}",
        json_body={"widget_config": widget_config},
    )


@tool("all")
async def remove_chart_from_dashboard(
    dashboard_id: int,
    dashboard_chart_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Remove a chart/widget placement from a dashboard.

    `dashboard_chart_id` is the placement ID (from `dashboard_charts[].id`),
    NOT the chart's own ID. The same chart can appear multiple times on a
    dashboard with different placement IDs.
    """
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "remove_chart_from_dashboard",
            {
                "dashboard_id": int(dashboard_id),
                "dashboard_chart_id": int(dashboard_chart_id),
            },
            reversible=False,
        )
    return await _request(
        "DELETE",
        f"/dashboards/{int(dashboard_id)}/charts/{int(dashboard_chart_id)}",
    )


@tool("report")
async def update_dashboard_layout(
    dashboard_id: int,
    chart_layouts: list[dict[str, Any]],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update layouts for multiple chart placements at once.

    `chart_layouts` items: {id (DashboardChart ID), layout: {x, y, w, h}}.
    Use after a re-arrangement that touches several charts.

    Phase-15.56 — writes into the dashboard's DRAFT snapshot, not the
    live layout. Public share viewers stay on the last-published bố cục
    until a human clicks "Lưu" in the editor (or calls
    `publish_dashboard_draft` explicitly). MCP-driven dashboard builds
    therefore always land as a draft for human review first — that is
    the intentional safety contract: AI proposes, human publishes.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "update_dashboard_layout",
            {
                "dashboard_id": int(dashboard_id),
                "placement_count": len(chart_layouts),
                "target": "draft_snapshot (Phase-15.56)",
                "publish_step": (
                    "Call `publish_dashboard_draft(dashboard_id)` after human review, "
                    "or have them click 'Lưu' in the editor toolbar."
                ),
            },
        )
    return await _request(
        "PUT",
        f"/dashboards/{int(dashboard_id)}/draft-layout",
        json_body={"chart_layouts": chart_layouts},
    )


@tool("report")
async def publish_dashboard_draft(
    dashboard_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Publish the dashboard's draft snapshot — copy draft layout onto
    live rows so public share viewers see the new state.

    Phase-15.56 contract: MCP edits land as a draft; the draft only
    becomes the public version when this tool is called (or when a
    human clicks "Lưu" in the editor toolbar). DO NOT auto-call this
    after every MCP edit — that would defeat the safety net the draft
    workflow exists for. Only invoke when the user EXPLICITLY asks to
    publish ("xuất bản", "publish", "đẩy bản mới ra share link").
    """
    if not user_confirmed:
        return _requires_confirmation(
            "publish_dashboard_draft",
            {
                "dashboard_id": int(dashboard_id),
                "effect": "Draft layout sẽ ghi đè live + public viewer thấy bản mới.",
            },
        )
    return await _request(
        "POST",
        f"/dashboards/{int(dashboard_id)}/publish",
    )


@tool("report")
async def discard_dashboard_draft(
    dashboard_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Throw away the dashboard's pending draft. Live + public viewer
    are untouched. Use when the user says "huỷ bản nháp", "bỏ thay
    đổi", or asks to revert to the published version.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "discard_dashboard_draft",
            {
                "dashboard_id": int(dashboard_id),
                "effect": "Draft snapshot bị xoá; live không đổi.",
            },
        )
    return await _request(
        "POST",
        f"/dashboards/{int(dashboard_id)}/discard-draft",
    )


# ---------------------------------------------------------------------------
# Write — filters (managed via update_dashboard.filters_config)
# ---------------------------------------------------------------------------


@tool("report")
async def add_dashboard_filter(
    dashboard_id: int,
    filter_def: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Append a filter to the dashboard's filters_config.

    `filter_def`: {id (unique), name, type:text|number|date|dropdown,
    field ('orders.country' qualified), default_value?, scope:'global' or
    'page:<page_id>'}. GET/append/PUT to avoid overwriting concurrent edits.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "add_dashboard_filter",
            {
                "dashboard_id": int(dashboard_id),
                "filter_summary": {
                    "id": filter_def.get("id"),
                    "name": filter_def.get("name"),
                    "type": filter_def.get("type"),
                    "field": filter_def.get("field"),
                },
            },
        )
    dash = await _request("GET", f"/dashboards/{int(dashboard_id)}")
    existing = list(dash.get("filters_config") or [])
    existing.append(filter_def)
    return await _request(
        "PUT",
        f"/dashboards/{int(dashboard_id)}",
        json_body={"filters_config": existing},
    )


@tool("all")
async def remove_dashboard_filter(
    dashboard_id: int,
    filter_id: str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Remove a filter (by its `id`) from the dashboard's `filters_config`."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "remove_dashboard_filter",
            {"dashboard_id": int(dashboard_id), "filter_id": filter_id},
            reversible=True,
        )
    dash = await _request("GET", f"/dashboards/{int(dashboard_id)}")
    existing = [
        f for f in (dash.get("filters_config") or [])
        if f.get("id") != filter_id
    ]
    return await _request(
        "PUT",
        f"/dashboards/{int(dashboard_id)}",
        json_body={"filters_config": existing},
    )


# ---------------------------------------------------------------------------
# Write — legacy single share token
# ---------------------------------------------------------------------------


@tool("all")
async def share_dashboard(
    dashboard_id: int,
    public_filters_config: list[dict[str, Any]] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Legacy single share-token (URL = <BASE>/public/dashboard/<token>).

    Idempotent — repeated calls return the existing token unless
    filter list changes. For multi-link sharing with independent
    filters/appearance prefer `create_public_link`.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "share_dashboard",
            {
                "dashboard_id": int(dashboard_id),
                "preset_filter_count": len(public_filters_config or []),
                "warning": (
                    "Creates a publicly accessible URL. Anyone with the "
                    "share token can view the dashboard."
                ),
            },
        )
    body = _drop_none({"public_filters_config": public_filters_config})
    return await _request(
        "POST",
        f"/dashboards/{int(dashboard_id)}/share",
        json_body=body or {},
    )


@tool("all")
async def unshare_dashboard(
    dashboard_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Phase-15.14: revoke the legacy single share token + clear public filters.

    Destructive — any existing share URL stops working. Multi-link tokens
    created via `create_public_link` are independent and stay active.
    """
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "unshare_dashboard",
            {"dashboard_id": int(dashboard_id)},
            reversible=True,  # the user can re-share to mint a new token
        )
    return await _request(
        "DELETE",
        f"/dashboards/{int(dashboard_id)}/share",
    )


# ---------------------------------------------------------------------------
# Write — public links
# ---------------------------------------------------------------------------


@tool("report")
async def create_public_link(
    dashboard_id: int,
    name: str,
    filters_config: list[dict[str, Any]] | None = None,
    appearance_config: dict[str, Any] | None = None,
    password: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a shareable public link for a dashboard.

    The returned record's `token` field is the URL slug — share it as
    `<APPBI_BASE_URL>/public/dashboard/<token>`. `filters_config` lets you
    bake in filter presets that public viewers cannot change.

    A `password` (optional) gates the link with a shared secret. Communicate
    that password through a separate channel.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "create_public_link",
            {
                "dashboard_id": int(dashboard_id),
                "name": name,
                "preset_filter_count": len(filters_config or []),
                "password_protected": bool(password),
                "warning": (
                    "This creates a publicly accessible URL. Anyone with "
                    "the link can view the dashboard."
                ),
            },
        )
    body = _drop_none(
        {
            "name": name,
            "filters_config": filters_config,
            "appearance_config": appearance_config,
            "password": password,
        }
    )
    return await _request(
        "POST",
        f"/dashboards/{int(dashboard_id)}/public-links",
        json_body=body,
    )


@tool("all")
async def update_public_link(
    dashboard_id: int,
    link_id: int,
    name: str | None = None,
    filters_config: list[dict[str, Any]] | None = None,
    appearance_config: dict[str, Any] | None = None,
    is_active: bool | None = None,
    password: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update a public link's name/filters/active state/password.

    Pass `password=""` (empty string) to clear an existing password.
    Pass `password=None` (default) to leave it unchanged.
    """
    changes = _drop_none(
        {
            "name": name,
            "filters_config": filters_config,
            "appearance_config": appearance_config,
            "is_active": is_active,
            "password": password,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "update_public_link",
            {
                "dashboard_id": int(dashboard_id),
                "link_id": int(link_id),
                "fields": sorted(changes.keys()),
            },
        )
    return await _request(
        "PATCH",
        f"/dashboards/{int(dashboard_id)}/public-links/{int(link_id)}",
        json_body=changes,
    )


@tool("all")
async def delete_public_link(
    dashboard_id: int,
    link_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete a public link (revokes URL permanently).

    Workboard-managed links → 403; remove via workboard builder instead.
    """
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_public_link",
            {"dashboard_id": int(dashboard_id), "link_id": int(link_id)},
            reversible=False,
        )
    try:
        return await _request(
            "DELETE",
            f"/dashboards/{int(dashboard_id)}/public-links/{int(link_id)}",
        )
    except RuntimeError as exc:
        msg = str(exc)
        if "managed by a workboard" in msg or "403" in msg:
            return {
                "ok": False,
                "error": "workboard_managed_link",
                "message": (
                    "This public link is managed by a workboard dashboard "
                    "screen and cannot be deleted directly. Edit or remove "
                    "the dashboard screen in the workboard builder instead."
                ),
                "backend_error": msg,
            }
        raise


__all__: list[str] = []
