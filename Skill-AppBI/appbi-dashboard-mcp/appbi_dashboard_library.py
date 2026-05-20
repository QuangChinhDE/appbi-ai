"""Stage 4 — pattern-driven dashboard config builders.

6 wrappers, each generates ONE kind of dashboard-level config block
(theme, filter, layout, public-link appearance, widget, pages) with
the shape baked in correctly. Claude picks the tool by intent
("dark mode" → apply_theme_preset, "filter ngày" → add_date_filter_recipe)
and never has to author raw {mode, cardStyle, density…} fields.

Tools (Phase 15.48 dashboard config library):
  Tier 1 — typed-param presets:
    list_dashboard_presets            inventory of every preset this module knows
    apply_theme_preset                writes theme_config from a named preset
    add_date_filter_recipe            DATE filter with one of 13 preset ranges
    add_dropdown_filter_recipe        TEXT/DROPDOWN filter, multi-select default
    set_public_link_appearance        briefing/editorial/minimal × accent_preset
    set_dashboard_pages               tab pages_config from a list of names

  Tier 2 — each tool accepts `extra={...}` to passthrough advanced
  fields the typed surface skipped (font, background, ai_bot_*, etc).

  Tier 3 — `update_dashboard` (already in appbi_dashboard.py) for any
  shape outside these patterns.

Every tool follows preview-then-confirm via `user_confirmed`. On
commit the tool PATCHes /dashboards/{id} with the resolved config —
no read-modify-write needed because BE merges JSON dict fields.

Presets here mirror what the FE bakes into DashboardThemeModal /
PublicLinkAppearance / DashboardFilterBar — keeping MCP and FE in
sync so a dashboard built by Claude looks identical to one a human
builds in the UI.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any, Literal

from appbi_core import (
    Context,
    _append_session_log,
    _drop_none,
    _request,
    _requires_confirmation,
    tool,
)


# ---------------------------------------------------------------------------
# Preset catalogs — single source of truth for FE/MCP parity
# ---------------------------------------------------------------------------

# Mirrors frontend/src/components/dashboards/DashboardThemeModal.tsx PRESETS.
# Keep in sync — Claude can apply any of these and the result looks
# identical to a human picking the same preset in the UI.
THEME_PRESETS: dict[str, dict[str, Any]] = {
    "default":         {"mode": "light", "cardStyle": "soft", "density": "normal"},
    "dark_amber":      {"mode": "dark", "accent": "#facc15", "cardStyle": "soft"},
    "dark_emerald":    {"mode": "dark", "accent": "#10b981", "cardStyle": "soft"},
    "light_sapphire":  {"mode": "light", "accent": "#2563eb", "cardStyle": "soft"},
    "elevated":        {"mode": "light", "cardStyle": "elevated", "density": "normal"},
    "compact":         {"mode": "light", "cardStyle": "flat", "density": "compact"},
    "sharp":           {"mode": "light", "cardStyle": "sharp"},
    "flat":            {"mode": "light", "cardStyle": "flat"},
}

# Date filter presets accepted by the FE DateInput component. Each
# resolves to a {start, end} range at query time — Claude only needs
# to pick the semantic preset name.
DATE_PRESETS = {
    "today",
    "yesterday",
    "this_week",
    "last_week",
    "this_month",
    "last_month",
    "this_quarter",
    "last_quarter",
    "this_year",
    "last_year",
    "last_7_days",
    "last_30_days",
    "last_90_days",
    "custom",
}

# Public-link appearance presets, from FE PublicLinkAppearanceConfig.
PUBLIC_LINK_PRESETS: dict[str, dict[str, Any]] = {
    "briefing": {
        "preset": "briefing",
        "embed_header_mode": "full",
        "show_summary": True,
        "show_stats": True,
        "show_page_tabs": True,
        "show_footer": True,
        "density": "comfortable",
        "canvas_style": "soft",
    },
    "editorial": {
        "preset": "editorial",
        "embed_header_mode": "compact",
        "show_summary": True,
        "show_stats": False,
        "show_page_tabs": True,
        "show_footer": True,
        "density": "comfortable",
        "canvas_style": "grid",
    },
    "minimal": {
        "preset": "minimal",
        "embed_header_mode": "hidden",
        "show_summary": False,
        "show_stats": False,
        "show_page_tabs": False,
        "show_footer": False,
        "density": "compact",
        "canvas_style": "plain",
    },
}

ACCENT_PRESETS = {"sky", "teal", "amber", "rose", "slate"}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# Theme `extra` whitelist — keep open enough for power users but
# reject random keys so we catch typos before BE silently drops them.
_THEME_EXTRA_KEYS = {
    "accent", "fontFamily", "font", "background", "backgroundColor",
    "cardRadius", "radius", "cardShadow", "hoverAnimation", "hoverEffect",
}

# Public-link appearance `extra` whitelist — covers branding + AI bot
# admin config. ai_bot_key NEVER stored here (admin-only endpoint).
_APPEARANCE_EXTRA_KEYS = {
    "accent_preset", "accent_color", "hero_label", "headline", "summary",
    "footer_note", "allow_viewer_filters", "show_chart_type_label",
    "ai_bot_enabled", "ai_bot_provider", "ai_bot_model",
    "ai_bot_normal_cost_cap_usd", "ai_bot_thinking_cost_cap_usd",
    "ai_bot_report_context_note",
}


def _apply_whitelist(
    target: dict[str, Any], extra: dict[str, Any] | None, allowed: set[str], scope: str
) -> dict[str, Any]:
    if not extra:
        return target
    if not isinstance(extra, dict):
        raise ValueError(f"{scope}.extra must be a dict or None.")
    unknown = set(extra.keys()) - allowed
    if unknown:
        raise ValueError(
            f"{scope}.extra contains unknown keys: {sorted(unknown)}. "
            f"Allowed: {sorted(allowed)}. For anything outside the "
            f"whitelist call `update_dashboard` directly with the raw "
            f"config dict."
        )
    merged = dict(target)
    for k, v in extra.items():
        if v is None:
            continue
        merged[k] = v
    return merged


async def _patch_dashboard(
    dashboard_id: int,
    patch: dict[str, Any],
    user_confirmed: bool,
    action_name: str,
    summary: dict[str, Any],
) -> dict[str, Any]:
    """Shared PATCH-with-confirm: shows preview, then PATCHes /dashboards/{id}.

    BE merges JSON dict fields at the column level, so we can send
    only the field we want to change (theme_config, public_filters_config,
    etc.) without read-modify-write.
    """
    if not user_confirmed:
        return _requires_confirmation(
            action_name,
            {"dashboard_id": int(dashboard_id), **summary, "patch": patch},
        )
    result = await _request(
        "PATCH", f"/dashboards/{int(dashboard_id)}", json_body=_drop_none(patch)
    )
    log_path = _append_session_log(
        "report",
        action_name,
        {"dashboard_id": int(dashboard_id), **summary},
        dashboard_id=int(dashboard_id),
    )
    return {
        "status": "committed",
        "dashboard_id": int(dashboard_id),
        "action": action_name,
        **summary,
        "auto_logged_to": log_path,
        "dashboard_result": result,
    }


# ---------------------------------------------------------------------------
# Tier 0 — inventory tool (read-only)
# ---------------------------------------------------------------------------


@tool("report")
async def list_dashboard_presets(
    category: Literal["all", "theme", "date_filter", "public_link", "accent"] = "all",
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Inventory of every preset this library knows about. Call it
    once at the start of a dashboard build so Claude can pick by name
    instead of guessing the shape.

    `category` filters the response: "theme" / "date_filter" /
    "public_link" / "accent" / "all".
    """
    out: dict[str, Any] = {}
    if category in ("all", "theme"):
        out["theme_presets"] = {
            name: {"name": name, "config": cfg}
            for name, cfg in THEME_PRESETS.items()
        }
    if category in ("all", "date_filter"):
        out["date_presets"] = sorted(DATE_PRESETS)
    if category in ("all", "public_link"):
        out["public_link_presets"] = {
            name: {"name": name, "config": cfg}
            for name, cfg in PUBLIC_LINK_PRESETS.items()
        }
    if category in ("all", "accent"):
        out["accent_presets"] = sorted(ACCENT_PRESETS)
    out["note"] = (
        "These names mirror frontend/src/components/dashboards/* presets. "
        "A dashboard built via Claude using these tools should be visually "
        "identical to one a human builds in the UI."
    )
    return out


# ---------------------------------------------------------------------------
# Theme preset
# ---------------------------------------------------------------------------


@tool("report")
async def apply_theme_preset(
    dashboard_id: int,
    preset: Literal[
        "default", "dark_amber", "dark_emerald", "light_sapphire",
        "elevated", "compact", "sharp", "flat",
    ],
    extra: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Set `theme_config` on a dashboard from a named preset.

    Presets mirror DashboardThemeModal: `default`, `dark_amber`,
    `dark_emerald`, `light_sapphire`, `elevated`, `compact`, `sharp`,
    `flat`. Use `list_dashboard_presets('theme')` to see the full
    config each one produces.

    `extra` (Tier 2 escape hatch) whitelisted keys: `accent`,
    `fontFamily`/`font`, `background`/`backgroundColor`, `cardRadius`,
    `cardShadow`, `hoverAnimation` ('none'|'lift'|'scale'|'glow').
    For anything outside this set call `update_dashboard` directly.
    """
    if preset not in THEME_PRESETS:
        raise ValueError(
            f"Unknown theme preset {preset!r}. Available: "
            f"{sorted(THEME_PRESETS)}. Use `list_dashboard_presets('theme')` "
            "to inspect each preset's config."
        )
    base = dict(THEME_PRESETS[preset])
    theme_config = _apply_whitelist(base, extra, _THEME_EXTRA_KEYS, "theme")
    return await _patch_dashboard(
        dashboard_id,
        {"theme_config": theme_config},
        user_confirmed,
        "apply_theme_preset",
        {"preset": preset, "theme_config_preview": theme_config},
    )


# ---------------------------------------------------------------------------
# Filter recipes — date + dropdown
# ---------------------------------------------------------------------------


@tool("report")
async def add_date_filter_recipe(
    dashboard_id: int,
    name: str,
    field: str,
    date_preset: Literal[
        "today", "yesterday", "this_week", "last_week", "this_month",
        "last_month", "this_quarter", "last_quarter", "this_year",
        "last_year", "last_7_days", "last_30_days", "last_90_days",
    ] = "this_month",
    target: Literal["filters", "public_filters"] = "filters",
    linked_fields: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Append a DATE filter to the dashboard with a named relative
    preset (FE resolves the actual {start,end} at render time).

    `field` is the semantic-qualified `view.column` (e.g.
    `orders.created_at`) or a bare column name for non-semantic
    dashboards.

    `target='public_filters'` writes to `public_filters_config` instead
    — those are LOCKED on the public share link (viewer cannot change
    them). Use this to force a "last 30 days" lens on a public link.

    `linked_fields` (optional): names of additional date columns the
    same filter should propagate to. Useful for dashboards mixing
    multiple date dimensions (e.g. order_date + ship_date).
    """
    if date_preset not in DATE_PRESETS or date_preset == "custom":
        raise ValueError(
            f"date_preset must be one of {sorted(DATE_PRESETS - {'custom'})}. "
            "`custom` would require explicit start/end — use the generic "
            "`add_dashboard_filter` tool for that."
        )
    new_filter = _drop_none({
        "id": f"df-{date_preset}-{field.replace('.', '_')}",
        "name": name,
        "field": field,
        "type": "date",
        "operator": "between",
        "datePreset": date_preset,
        "linkedFields": linked_fields,
        "label": name,
    })
    # Read current filter list so we can append (PATCH replaces the
    # whole JSON column otherwise).
    dash = await _request("GET", f"/dashboards/{int(dashboard_id)}")
    key = "filters_config" if target == "filters" else "public_filters_config"
    existing = list((dash.get(key) or []))
    if any((f or {}).get("id") == new_filter["id"] for f in existing):
        raise ValueError(
            f"A filter with id {new_filter['id']!r} already exists in "
            f"{key}. Remove it first (via `remove_dashboard_filter`) or "
            "use a different field/preset combo."
        )
    return await _patch_dashboard(
        dashboard_id,
        {key: existing + [new_filter]},
        user_confirmed,
        "add_date_filter_recipe",
        {
            "target": target,
            "filter_id": new_filter["id"],
            "field": field,
            "date_preset": date_preset,
            "existing_filter_count": len(existing),
        },
    )


@tool("report")
async def add_dropdown_filter_recipe(
    dashboard_id: int,
    name: str,
    field: str,
    default_values: list[str] | None = None,
    multi_select: bool = True,
    target: Literal["filters", "public_filters"] = "filters",
    linked_fields: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Append a dropdown/multi-select filter (operator='in') to the
    dashboard. The FE auto-fetches distinct values for `field`.

    `default_values`: optional pre-selected list. Pass empty/None for
    "show all rows".

    `multi_select=False` switches the operator to 'eq' so the chip
    only accepts ONE value (rare — used for radio-style filters).

    `target='public_filters'` LOCKS the filter on the public share —
    viewers see the chip but cannot change values.
    """
    operator = "in" if multi_select else "eq"
    value: Any = list(default_values or []) if multi_select else (
        default_values[0] if default_values else ""
    )
    new_filter = _drop_none({
        "id": f"df-dd-{field.replace('.', '_')}",
        "name": name,
        "field": field,
        "type": "dropdown",
        "operator": operator,
        "value": value,
        "linkedFields": linked_fields,
        "label": name,
    })
    dash = await _request("GET", f"/dashboards/{int(dashboard_id)}")
    key = "filters_config" if target == "filters" else "public_filters_config"
    existing = list((dash.get(key) or []))
    if any((f or {}).get("id") == new_filter["id"] for f in existing):
        raise ValueError(
            f"A filter with id {new_filter['id']!r} already exists in "
            f"{key}. Pick a different field or remove the existing one."
        )
    return await _patch_dashboard(
        dashboard_id,
        {key: existing + [new_filter]},
        user_confirmed,
        "add_dropdown_filter_recipe",
        {
            "target": target,
            "filter_id": new_filter["id"],
            "field": field,
            "multi_select": multi_select,
            "default_value_count": len(default_values or []),
            "existing_filter_count": len(existing),
        },
    )


# ---------------------------------------------------------------------------
# Public link appearance preset
# ---------------------------------------------------------------------------


@tool("report")
async def set_public_link_appearance(
    dashboard_id: int,
    preset: Literal["briefing", "editorial", "minimal"] = "briefing",
    accent_preset: Literal["sky", "teal", "amber", "rose", "slate"] | None = None,
    headline: str | None = None,
    summary: str | None = None,
    extra: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Set the `appearance_config` on the dashboard's public-share link
    from a named preset.

    Presets:
      `briefing`  — full header, summary card, stats, page tabs, footer
                    (executive briefing layout). Use for stakeholder reports.
      `editorial` — compact header, summary card, no stats, page tabs
                    (long-form narrative). Use for content-heavy reports.
      `minimal`   — header hidden, no chrome, compact density
                    (chartless embed). Use when embedding inside another app.

    `accent_preset` overrides the color palette (sky/teal/amber/rose/slate).

    `extra` whitelist (Tier 2): hero_label, headline, summary, footer_note,
    allow_viewer_filters, show_chart_type_label, ai_bot_* admin config.

    Note: this writes to the dashboard's *shared* appearance_config.
    For per-share-token customisation use the granular sharing tools.
    """
    if preset not in PUBLIC_LINK_PRESETS:
        raise ValueError(
            f"Unknown public link preset {preset!r}. Available: "
            f"{sorted(PUBLIC_LINK_PRESETS)}."
        )
    if accent_preset is not None and accent_preset not in ACCENT_PRESETS:
        raise ValueError(
            f"accent_preset must be one of {sorted(ACCENT_PRESETS)}."
        )
    base = dict(PUBLIC_LINK_PRESETS[preset])
    if accent_preset:
        base["accent_preset"] = accent_preset
    if headline:
        base["headline"] = headline
    if summary:
        base["summary"] = summary
    appearance = _apply_whitelist(base, extra, _APPEARANCE_EXTRA_KEYS, "appearance")
    return await _patch_dashboard(
        dashboard_id,
        {"appearance_config": appearance},
        user_confirmed,
        "set_public_link_appearance",
        {
            "preset": preset,
            "accent_preset": accent_preset,
            "appearance_preview": appearance,
        },
    )


# ---------------------------------------------------------------------------
# Pages config helper
# ---------------------------------------------------------------------------


@tool("report")
async def set_dashboard_pages(
    dashboard_id: int,
    page_names: list[str],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Set `pages_config` from a list of human-readable page names —
    builds the `[{id, name, order}]` array for you.

    Example: `page_names=['Tổng quan', 'Doanh thu', 'Khách hàng']`
    creates 3 tab pages. Charts pin to a page via their layout's
    `pageId` field (set by `move_chart_to_page` or
    `build_dashboard_from_design`).

    Pass `page_names=[]` to remove all pages (single-page mode).
    """
    if not isinstance(page_names, list):
        raise ValueError("page_names must be a list of strings.")
    seen: set[str] = set()
    pages: list[dict[str, Any]] = []
    for idx, raw in enumerate(page_names):
        name = (str(raw) or "").strip()
        if not name:
            raise ValueError(f"page_names[{idx}] is empty after trim.")
        if name in seen:
            raise ValueError(f"page_names[{idx}] duplicates an earlier name {name!r}.")
        seen.add(name)
        # Slug the id from the name. ASCII-only so the id is portable
        # across BE storage, FE chart `pageId` lookups, and URL fragments.
        # Vietnamese "Tổng quan" -> "tong_quan", not "tổng_quan".
        ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
        slug = re.sub(r"[^a-zA-Z0-9]+", "_", ascii_name).strip("_").lower() or f"page_{idx + 1}"
        pages.append({"id": f"p_{slug}", "name": name, "order": idx})
    return await _patch_dashboard(
        dashboard_id,
        {"pages_config": pages},
        user_confirmed,
        "set_dashboard_pages",
        {
            "page_count": len(pages),
            "page_ids": [p["id"] for p in pages],
            "pages_preview": pages,
        },
    )
