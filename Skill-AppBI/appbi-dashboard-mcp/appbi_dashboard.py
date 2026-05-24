"""Stage 5 — Dashboard.

Tools for assembling charts into dashboards: layout, filters, public links.
Prefer the blueprint flow (`propose_dashboard_blueprint` →
`commit_dashboard_blueprint`) for multi-chart builds — these granular tools
are for incremental edits to an existing dashboard.

Filters (Phase-15.81 v12):
  AppBI dashboards expose TWO authoring scopes for slicer filters:
    * `filters_config`          — all-pages slot list (applies to every chart)
    * `pages_config[i].filters` — per-page slot list (applies to active page)
  Plus per-public-link hidden constraints stored on each
  `DashboardPublicLink.filters_config` (silent WHERE, viewer never sees).

  All slot edits land in the dashboard's `draft_snapshot` first so the
  human can review before public viewers see them. Publishing flushes
  layout + filter drafts in one shot. MCP-driven filter edits should
  therefore use the *_draft_filters helpers; calling the live
  `update_dashboard(filters_config=...)` bypasses the draft safety net
  and is discouraged for AI-driven flows.

  BaseFilter wire shape (each slot):
    {
      id: str,                         # stable unique id
      field: str,                      # bare column name
      fieldKey?: 'view.col',           # qualified key
      semanticField?: 'view.col',      # semantic ref (preferred)
      datasetId?: int,                 # dataset scope
      linkedFields?: ['view.col', ...],# cross-view fan-out (Date filter etc.)
      type: 'text'|'number'|'date'|'dropdown',
      operator: 'eq'|'in'|'not_in'|'between'|'gte'|'lte'|...,
      value: any,                      # scalar | array | [from,to]
      label?: str,                     # display name override
      datePreset?: 'this_month'|'last_7_days'|'custom'|...
    }
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
    `filters_config` (Phase-15.81): all-pages slicer slots. Each item
      follows the BaseFilter shape — see module docstring. Common
      fields: `{id, field, semanticField:'view.col', datasetId, type,
      operator, value, label, linkedFields?}`.
    `public_filters_config`: legacy DA-baked slot list for the public
      share link. NEW dashboards prefer the per-link filters via
      `create_public_link(filters_config=...)` which scopes hidden
      constraints to each share token.
    `pages_config`: [{id, name, filters?, order?}] for tab pages.
      Charts pin to a page via `layout.pageId`. `filters` is a
      per-page slot list (same BaseFilter shape) — applies only when
      that page is active.
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
    """Patch a dashboard.

    ⚠️  Phase-15.81 v12 — this endpoint writes LIVE config directly.
    For filter slot edits you almost always want
    `update_dashboard_draft_filters` / `add_dashboard_filter` /
    `remove_dashboard_filter` instead, which stage into draft_snapshot
    so the public link only sees changes after Publish. Calling this
    tool with `filters_config` or `pages_config[i].filters` bypasses
    that safety net.

    Safe live-write cases: name, description, theme, layout_mode,
    canvas_config. Filter fields are accepted for backwards-compat but
    will skip the draft pipeline.
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
    # Phase-15.67 — guardrails: layout must have x/y/w/h; auto-fill `i`
    # so BE schema (DashboardChartLayout) sees the full shape react-grid-
    # layout expects. Catching shape drift here gives Claude a precise
    # error message instead of a generic 422 from FastAPI. Run BEFORE
    # confirmation so the preview itself shows the validated payload.
    if not isinstance(layout, dict):
        raise ValueError("layout phải là dict {x, y, w, h, ...}.")
    required_keys = {"x", "y", "w", "h"}
    missing = required_keys - set(layout.keys())
    if missing:
        raise ValueError(
            f"layout thiếu key bắt buộc: {sorted(missing)}. "
            "Tối thiểu cần {x, y, w, h} (BE schema DashboardChartLayout)."
        )
    try:
        w_val = int(layout.get("w", 0))
    except (TypeError, ValueError):
        w_val = 0
    if not (1 <= w_val <= 12):
        raise ValueError(
            f"layout.w = {layout.get('w')} ngoài range hợp lệ (1-12)."
        )
    layout_with_i = dict(layout)
    layout_with_i.setdefault("i", str(int(chart_id)))
    if not user_confirmed:
        return _requires_confirmation(
            "add_chart_to_dashboard",
            {
                "dashboard_id": int(dashboard_id),
                "chart_id": int(chart_id),
                "layout": layout_with_i,
                "parameters": parameters,
            },
        )
    body = _drop_none(
        {
            "chart_id": int(chart_id),
            "layout": layout_with_i,
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
    # Phase-15.67 — same guardrails as add_chart_to_dashboard.
    if not isinstance(layout, dict):
        raise ValueError("layout phải là dict {x, y, w, h, ...}.")
    required_keys = {"x", "y", "w", "h"}
    missing = required_keys - set(layout.keys())
    if missing:
        raise ValueError(
            f"layout thiếu key bắt buộc: {sorted(missing)}. "
            "Tối thiểu cần {x, y, w, h} (BE schema DashboardChartLayout)."
        )
    try:
        w_val = int(layout.get("w", 0))
    except (TypeError, ValueError):
        w_val = 0
    if not (1 <= w_val <= 12):
        raise ValueError(
            f"layout.w = {layout.get('w')} ngoài range hợp lệ (1-12)."
        )
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
    """Publish the dashboard's draft snapshot — copy draft layout AND
    draft filters onto live rows so public share viewers see the new state.

    Phase-15.56 introduced layout drafts; Phase-15.81 v12 extended the
    snapshot to also hold filter slot drafts (`filters_config` +
    `pages_config[i].filters`). One Publish call flushes both. MCP
    edits land as a draft; the draft only becomes the public version
    when this tool is called (or when a human clicks "Lưu & xuất bản"
    in the editor toolbar). DO NOT auto-call this after every MCP edit
    — that would defeat the safety net the draft workflow exists for.
    Only invoke when the user EXPLICITLY asks to publish ("xuất bản",
    "publish", "đẩy bản mới ra share link").
    """
    if not user_confirmed:
        return _requires_confirmation(
            "publish_dashboard_draft",
            {
                "dashboard_id": int(dashboard_id),
                "effect": (
                    "Draft layout + filter sẽ ghi đè live + public viewer thấy bản mới."
                ),
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
    """Throw away the dashboard's pending draft (layout + filters).

    Live + public viewer are untouched. Use when the user says "huỷ
    bản nháp", "bỏ thay đổi", or asks to revert to the published
    version. Phase-15.81 v12: this also discards any pending filter
    slot edits, not just layout.
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
# Write — filter slots (Phase-15.81 v12 draft pipeline)
#
# Filter slot edits route through draft_snapshot so the human can review
# before public viewers see them. Publish (`publish_dashboard_draft`)
# flushes layout + filter drafts together. The granular helpers below
# read the CURRENT slot list (which is the draft overlay on top of live
# when a draft exists, else live), mutate, and stage back as a draft.
# ---------------------------------------------------------------------------


def _normalize_scope(scope: str | None, page_id: str | None) -> tuple[str, str | None]:
    """Resolve filter scope. Returns ('all'|'page', page_id_or_None).

    `scope` accepts: 'all', 'all_pages', 'global'  → all-pages slot
                     'page', 'page:<id>'            → per-page slot
    If `scope` is 'page:<id>', `page_id` is overridden by the suffix.
    """
    raw = (scope or "all").strip().lower()
    if raw.startswith("page:"):
        return "page", raw.split(":", 1)[1] or page_id
    if raw in {"page", "this_page"}:
        if not page_id:
            raise ValueError(
                "scope='page' yêu cầu `page_id` (id của trang trong pages_config)."
            )
        return "page", page_id
    if raw in {"all", "all_pages", "global"}:
        return "all", None
    raise ValueError(
        f"scope='{scope}' không hợp lệ. Chấp nhận: 'all' | 'page' (kèm page_id) | 'page:<id>'."
    )


def _patch_pages_config(
    pages: list[dict[str, Any]],
    page_id: str,
    mutator,
) -> list[dict[str, Any]]:
    """Apply `mutator(page_dict) → page_dict` to the page whose id matches."""
    out: list[dict[str, Any]] = []
    matched = False
    for page in pages or []:
        if isinstance(page, dict) and str(page.get("id") or "") == str(page_id):
            out.append(mutator(dict(page)))
            matched = True
        else:
            out.append(page)
    if not matched:
        raise ValueError(
            f"page_id='{page_id}' không tồn tại trong pages_config — list trước bằng "
            "`get_dashboard(dashboard_id).pages_config`."
        )
    return out


@tool("report")
async def update_dashboard_draft_filters(
    dashboard_id: int,
    filters_config: list[dict[str, Any]] | None = None,
    pages_config: list[dict[str, Any]] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Stage filter-slot edits (all-pages + per-page) into draft_snapshot.

    Phase-15.81 v12 — body fields are independent: omit one to leave that
    scope untouched in the draft. Public viewer keeps seeing the last-
    published filter config until `publish_dashboard_draft` flushes it.

    Use this when you want to set BOTH scopes in one call, or to push a
    fully composed pages_config (each page item is `{id, name, filters?}`).
    For single-filter add/remove, prefer the granular helpers.
    """
    body = _drop_none(
        {
            "filters_config": filters_config,
            "pages_config": pages_config,
        }
    )
    if not body:
        raise ValueError(
            "Phải truyền ít nhất một trong `filters_config` hoặc `pages_config`."
        )
    if not user_confirmed:
        return _requires_confirmation(
            "update_dashboard_draft_filters",
            {
                "dashboard_id": int(dashboard_id),
                "scopes": sorted(body.keys()),
                "all_filter_count": (
                    len(filters_config) if filters_config is not None else None
                ),
                "page_count": (
                    len(pages_config) if pages_config is not None else None
                ),
                "target": "draft_snapshot (Phase-15.81 v12)",
                "publish_step": (
                    "Call `publish_dashboard_draft(dashboard_id)` after human review "
                    "to make filters visible to the public link."
                ),
            },
        )
    return await _request(
        "PUT",
        f"/dashboards/{int(dashboard_id)}/draft-filters",
        json_body=body,
    )


@tool("report")
async def add_dashboard_filter(
    dashboard_id: int,
    filter_def: dict[str, Any],
    scope: str = "all",
    page_id: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Append a filter slot to the dashboard. Stages into draft_snapshot.

    `filter_def`: BaseFilter shape — see module docstring. At minimum
       `{id, field, type, operator, value, datasetId, semanticField}`.
       `id` must be unique within the target scope.

    `scope`:
       * 'all' (default)   — append to dashboard.filters_config (all-pages
                              slicer that every chart on every page sees).
       * 'page'            — append to pages_config[page_id].filters
                              (only charts on that page see it).

    `page_id`: required when `scope='page'`. Find page ids via
       `get_dashboard(dashboard_id).pages_config[*].id`.

    Phase-15.81 v12: stages a DRAFT — call `publish_dashboard_draft` to
    push to the public link, or `discard_dashboard_draft` to revert.
    """
    target_scope, resolved_page = _normalize_scope(scope, page_id)
    if not user_confirmed:
        return _requires_confirmation(
            "add_dashboard_filter",
            {
                "dashboard_id": int(dashboard_id),
                "scope": target_scope,
                "page_id": resolved_page,
                "filter_summary": {
                    "id": filter_def.get("id"),
                    "label": filter_def.get("label"),
                    "type": filter_def.get("type"),
                    "operator": filter_def.get("operator"),
                    "semanticField": filter_def.get("semanticField"),
                    "datasetId": filter_def.get("datasetId"),
                },
                "target": "draft_snapshot",
            },
        )
    dash = await _request("GET", f"/dashboards/{int(dashboard_id)}")
    body: dict[str, Any] = {}
    if target_scope == "all":
        existing = list(dash.get("filters_config") or [])
        if any((f.get("id") == filter_def.get("id")) for f in existing if isinstance(f, dict)):
            raise ValueError(
                f"filter_def.id='{filter_def.get('id')}' đã tồn tại trong "
                "filters_config — dùng `update_dashboard_draft_filters` để replace."
            )
        existing.append(filter_def)
        body["filters_config"] = existing
    else:
        assert resolved_page is not None  # _normalize_scope guarantees
        pages = list(dash.get("pages_config") or [])

        def _add(page: dict[str, Any]) -> dict[str, Any]:
            current = list(page.get("filters") or [])
            if any(
                (f.get("id") == filter_def.get("id"))
                for f in current
                if isinstance(f, dict)
            ):
                raise ValueError(
                    f"filter_def.id='{filter_def.get('id')}' đã tồn tại trong "
                    f"pages_config[{resolved_page}].filters."
                )
            current.append(filter_def)
            page["filters"] = current
            return page

        body["pages_config"] = _patch_pages_config(pages, resolved_page, _add)
    return await _request(
        "PUT",
        f"/dashboards/{int(dashboard_id)}/draft-filters",
        json_body=body,
    )


@tool("all")
async def remove_dashboard_filter(
    dashboard_id: int,
    filter_id: str,
    scope: str = "all",
    page_id: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Remove a filter slot (by its `id`) from the dashboard's draft.

    `scope` / `page_id` semantics mirror `add_dashboard_filter`.

    Phase-15.81 v12: stages the removal into draft_snapshot — the public
    link viewer keeps seeing the old slot until you publish or discard.
    """
    target_scope, resolved_page = _normalize_scope(scope, page_id)
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "remove_dashboard_filter",
            {
                "dashboard_id": int(dashboard_id),
                "filter_id": filter_id,
                "scope": target_scope,
                "page_id": resolved_page,
                "target": "draft_snapshot",
            },
            reversible=True,
        )
    dash = await _request("GET", f"/dashboards/{int(dashboard_id)}")
    body: dict[str, Any] = {}
    if target_scope == "all":
        existing = [
            f for f in (dash.get("filters_config") or [])
            if isinstance(f, dict) and f.get("id") != filter_id
        ]
        body["filters_config"] = existing
    else:
        assert resolved_page is not None
        pages = list(dash.get("pages_config") or [])

        def _strip(page: dict[str, Any]) -> dict[str, Any]:
            current = [
                f for f in (page.get("filters") or [])
                if isinstance(f, dict) and f.get("id") != filter_id
            ]
            if current:
                page["filters"] = current
            else:
                page.pop("filters", None)
            return page

        body["pages_config"] = _patch_pages_config(pages, resolved_page, _strip)
    return await _request(
        "PUT",
        f"/dashboards/{int(dashboard_id)}/draft-filters",
        json_body=body,
    )


@tool("report")
async def list_dashboard_filters(
    dashboard_id: int,
    scope: str = "all",
    page_id: str | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Read the current filter slot list for a scope (draft overlay applied).

    `scope`: 'all' for dashboard.filters_config, 'page' (+ page_id) for
    pages_config[page_id].filters. Returns {scope, page_id, filters,
    has_draft} so the caller can tell whether the slots they see are
    pending publish.
    """
    target_scope, resolved_page = _normalize_scope(scope, page_id)
    dash = await _request("GET", f"/dashboards/{int(dashboard_id)}")
    if target_scope == "all":
        filters = list(dash.get("filters_config") or [])
    else:
        assert resolved_page is not None
        page = next(
            (
                p for p in (dash.get("pages_config") or [])
                if isinstance(p, dict) and str(p.get("id") or "") == str(resolved_page)
            ),
            None,
        )
        if page is None:
            raise ValueError(
                f"page_id='{resolved_page}' không tồn tại trong pages_config."
            )
        filters = list(page.get("filters") or [])
    return {
        "scope": target_scope,
        "page_id": resolved_page,
        "filters": filters,
        "has_draft": bool(dash.get("has_draft")),
    }


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
    `<APPBI_BASE_URL>/public/dashboard/<token>`.

    `filters_config` (Phase-15.81 — Loại 2 hidden link filters):
       Bake in HIDDEN constraints scoped to THIS share link. Viewer
       never sees these filters in the UI, but BE silently AND-merges
       them into every chart-data request from this token. Different
       links to the same dashboard can carry different hidden filters
       (e.g. one link constrained by region=North, another by
       region=South). Uses the same BaseFilter shape — see module
       docstring.
       Note: the SLICER filters the viewer can interact with come from
       the dashboard's own `filters_config` / `pages_config[i].filters`
       (Loại 1) — NOT this field.

    `password` (optional) gates the link with a shared secret.
    Communicate that password through a separate channel.
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

    `filters_config` here is the LINK's hidden constraint set (Loại 2,
    silent WHERE), NOT the dashboard's slicer config. See
    `create_public_link` docstring for the distinction.

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
