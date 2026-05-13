"""Stage 5 — Dashboard.

Tools for assembling charts into dashboards: layout, filters, public links.

The HTML import flow from the legacy MCP is intentionally absent — this MCP
This module focuses on programmatic dashboard assembly via the granular
endpoints below, not by emitting an HTML artifact.

HTML import note: `appbi_html_import` is available in this MCP for mockup-driven
or bulk builds. This module is the granular path for assembling existing charts.

Filters: AppBI uses a hybrid model where dashboard filters are stored as a
JSON array on the dashboard itself (`filters_config`). There is no separate
filter CRUD endpoint, so add/remove operations go through `update_dashboard`.
"""
from __future__ import annotations

from typing import Any

from appbi_core import (
    Context,
    _confirmation_required_for_destructive,
    _drop_none,
    _request,
    _requires_confirmation,
    tool,
)


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@tool("report")
async def list_dashboards(ctx: Context | None = None) -> dict[str, Any]:
    """List every dashboard the authenticated user can view."""
    items = await _request("GET", "/dashboards/")
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
    """Return the slicer-style filter slots exposed by a dashboard.

    Mirrors what the public link runtime exposes: each entry is
    ``{datasetId, semanticField:'view.col', label, type, ...}``. When the
    DA has pinned Access filters via the share dialog, those slots are
    returned verbatim; otherwise the backend scans chart semantic
    bindings.

    Use this when:
      - designing dashboard public-link filter presets (``create_public_link``
        filters_config slots must reference one of these),
      - configuring a workboard ``dashboard`` screen's
        ``role_filter_mapping`` / ``static_filters`` — copy ``datasetId``
        and ``semanticField`` straight from this response (the workboard
        runtime silently drops slots that don't match).
    """
    return await _request(
        "GET", f"/dashboards/{int(dashboard_id)}/filter-fields"
    )


@tool("all")
async def list_public_links(
    dashboard_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List public links created on a dashboard (each link has its own
    filters preset and access stats).

    Note: workboard-managed links (``source='workboard'``) are filtered out
    by the backend and never appear here. Those links are owned by a
    workboard dashboard screen and re-created automatically on every
    workboard save / app-user change — manage them through the workboard
    builder, not this endpoint.
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


@tool("report")
async def create_dashboard(
    name: str,
    description: str | None = None,
    charts: list[dict[str, Any]] | None = None,
    filters_config: list[dict[str, Any]] | None = None,
    layout_mode: str = "grid",
    theme_config: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a dashboard, optionally pre-populated with charts.

    This is **Path B** (Direct API) — suited when charts already exist and
    you are assembling them into a new shell. For a new dashboard from raw
    data, prefer **Path A** (HTML Import):
      get_html_dashboard_spec → write HTML → analyze_html_import → build_dashboard_from_html

    `charts` items: {chart_id, layout: {x, y, w, h}, parameters?, widget_type?}.
    `filters_config` items: dashboard filter configs (text/number/date/dropdown).
    `layout_mode`: 'grid' (default) or 'canvas'.

    Workflow: prefer creating empty + adding charts one-by-one when you
    want individual confirmations. Use the bundled form for fast bulk
    creation when the user has already approved the layout.
    """
    body = _drop_none(
        {
            "name": name,
            "description": description,
            "charts": charts or [],
            "filters_config": filters_config,
            "layout_mode": layout_mode,
            "theme_config": theme_config,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "create_dashboard",
            {
                "name": name,
                "chart_count": len(charts or []),
                "filter_count": len(filters_config or []),
                "layout_mode": layout_mode,
            },
        )
    return await _request("POST", "/dashboards/", json_body=body)


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


@tool("report")
async def add_chart_to_dashboard(
    dashboard_id: int,
    chart_id: int,
    layout: dict[str, Any],
    parameters: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Place an existing chart on a dashboard.

    `layout` keys: {i?, x, y, w, h} (react-grid-layout). Width is 1-12
    columns. Use {x: 0, y: 0, w: 6, h: 4} for a half-width chart in the
    top-left corner.

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
    return await _request(
        "POST", f"/dashboards/{int(dashboard_id)}/charts", json_body=body
    )


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
    (text: {markdown}, image: {url, alt}, countdown: {target_date}, etc.).
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
    """
    if not user_confirmed:
        return _requires_confirmation(
            "update_dashboard_layout",
            {
                "dashboard_id": int(dashboard_id),
                "placement_count": len(chart_layouts),
            },
        )
    return await _request(
        "PUT",
        f"/dashboards/{int(dashboard_id)}/layout",
        json_body={"chart_layouts": chart_layouts},
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
    """Append a filter to the dashboard's `filters_config`.

    Implementation: GET the dashboard, append `filter_def` to `filters_config`,
    PUT it back. This avoids accidentally overwriting other filters when
    someone edits the dashboard concurrently.

    `filter_def` shape (typical):
      {
        "id": "filter_country",          # unique within dashboard
        "name": "Country",
        "type": "dropdown",              # text|number|date|dropdown
        "field": "orders.country",       # qualified semantic field
        "default_value": null,
        "scope": "global"                # or "page:<page_id>"
      }
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
    """Delete a public link (revokes the URL permanently).

    Backend rejects deletion of workboard-managed links with HTTP 403
    ("This link is managed by a workboard..."). Those links are tied to a
    workboard dashboard screen's lifecycle — remove the screen or the
    workboard itself to garbage-collect them. This tool surfaces the
    backend message verbatim when that happens so the caller knows where
    to act.
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
