"""Stage 3 — pattern-driven measure builders.

7 thin wrappers that each create ONE kind of measure on an existing
SemanticView, with the config baked in correctly. Claude picks the tool
by intent ("tổng" → add_sum_measure, "tỷ lệ" → add_ratio_measure …) and
never has to author raw {type, sql, expression, depends_on} fields.

Every tool follows preview-then-confirm via `user_confirmed`. On commit
the tool GETs the current view, appends the new measure, PUTs the full
view back — the BE has no append-measure endpoint, so read-modify-write
is the only safe path.
"""
from __future__ import annotations

import re
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
# Internal builders
# ---------------------------------------------------------------------------

_IDENT_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def _validate_measure_name(name: str) -> str:
    """Reject measure names that aren't valid SQL/identifier-safe tokens.

    BE doesn't enforce this, but the FE rejects on save — so a measure
    Claude creates with a space (e.g. 'AVG Goal') goes into the DB fine
    and then BLOCKS every subsequent edit of the host view from the
    AppBI UI. Catch it here so Claude never plants that landmine.

    Returns the trimmed name on success; raises ValueError with an
    auto-suggested fix on failure.
    """
    trimmed = (name or "").strip()
    if not trimmed:
        raise ValueError("measure name is required.")
    if _IDENT_RE.match(trimmed):
        return trimmed
    # Auto-suggest a snake_case fix so Claude can re-call with it
    suggestion = re.sub(r"[^a-zA-Z0-9_]+", "_", trimmed).strip("_").lower() or "measure"
    if not _IDENT_RE.match(suggestion):
        suggestion = "_" + suggestion
    raise ValueError(
        f"measure name {trimmed!r} is invalid — must start with a letter "
        f"or underscore and contain only letters, digits, underscores "
        f"(no spaces, no accents, no special chars). The AppBI FE blocks "
        f"every save on a view that holds a bad-named measure, so we "
        f"reject it here too. Suggested fix: {suggestion!r}. "
        f"Use `label` for the human-readable display name."
    )


async def _fetch_view(view_id: int) -> dict[str, Any]:
    return await _request("GET", f"/semantic/views/{int(view_id)}")


async def _append_measure(
    view_id: int,
    new_measure: dict[str, Any],
    user_confirmed: bool,
    action_name: str,
) -> dict[str, Any]:
    """Shared read-modify-write: append `new_measure` to the view and PUT."""
    view = await _fetch_view(view_id)
    existing = list(view.get("measures") or [])
    new_name = (new_measure.get("name") or "").strip()
    if not new_name:
        raise ValueError("measure.name is required.")
    if any((m or {}).get("name") == new_name for m in existing):
        raise ValueError(
            f"View '{view.get('name')}' already has a measure named "
            f"'{new_name}'. Pick a different name or update the existing "
            "measure via the generic update_semantic_view tool."
        )
    if not user_confirmed:
        return _requires_confirmation(
            action_name,
            {
                "view_id": int(view_id),
                "view_name": view.get("name"),
                "measure": new_measure,
                "existing_measure_count": len(existing),
            },
        )
    body = {
        "name": view.get("name"),
        "sql_table_name": view.get("sql_table_name"),
        "dataset_table_id": view.get("dataset_table_id"),
        "description": view.get("description"),
        "dimensions": view.get("dimensions") or [],
        "measures": existing + [new_measure],
    }
    result = await _request(
        "PUT", f"/semantic/views/{int(view_id)}", json_body=_drop_none(body)
    )
    log_path = _append_session_log(
        "dataset",
        action_name,
        {
            "view_id": int(view_id),
            "view_name": view.get("name"),
            "measure_name": new_name,
            "measure_type": new_measure.get("type"),
        },
    )
    return {
        "status": "committed",
        "view_id": int(view_id),
        "measure_added": new_name,
        "total_measure_count": len(existing) + 1,
        "auto_logged_to": log_path,
        "view_result": result,
    }


def _format_block(
    kind: str | None,
    decimals: int | None,
    currency: str | None,
    suffix: str | None,
    prefix: str | None,
) -> dict[str, Any] | None:
    block = _drop_none({
        "kind": kind,
        "decimals": decimals,
        "currency": currency,
        "suffix": suffix,
        "prefix": prefix,
    })
    return block or None


# ---------------------------------------------------------------------------
# Pattern tools
# ---------------------------------------------------------------------------


@tool("report")
async def add_sum_measure(
    view_id: int,
    name: str,
    column: str,
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    format_kind: Literal["number", "currency", "percent", "duration", "custom"] | None = None,
    format_currency: str | None = None,
    format_decimals: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a SUM measure aggregating `column` on the view.

    `column` is the bare column name in the view's source table (no
    `${TABLE}.` prefix — this tool wraps it correctly).
    """
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "sum",
        "sql": "${TABLE}." + column.strip(),
        "label": label,
        "folder": folder,
        "filters": filters or None,
        "format": _format_block(format_kind, format_decimals, format_currency, None, None),
    })
    return await _append_measure(view_id, measure, user_confirmed, "add_sum_measure")


@tool("report")
async def add_avg_measure(
    view_id: int,
    name: str,
    column: str,
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    format_kind: Literal["number", "currency", "percent"] | None = None,
    format_decimals: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add an AVG measure aggregating `column`."""
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "avg",
        "sql": "${TABLE}." + column.strip(),
        "label": label,
        "folder": folder,
        "filters": filters or None,
        "format": _format_block(format_kind, format_decimals, None, None, None),
    })
    return await _append_measure(view_id, measure, user_confirmed, "add_avg_measure")


@tool("report")
async def add_count_measure(
    view_id: int,
    name: str,
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a COUNT-of-rows measure (counts qualifying rows; no column).

    Use `filters` to count only rows matching a condition (filtered
    count, e.g. won_deal_count = COUNT rows where status='won').
    """
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "count",
        "label": label,
        "folder": folder,
        "filters": filters or None,
    })
    return await _append_measure(view_id, measure, user_confirmed, "add_count_measure")


@tool("report")
async def add_count_distinct_measure(
    view_id: int,
    name: str,
    column: str,
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a COUNT DISTINCT measure (unique non-null values of `column`)."""
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "count_distinct",
        "sql": "${TABLE}." + column.strip(),
        "label": label,
        "folder": folder,
        "filters": filters or None,
    })
    return await _append_measure(
        view_id, measure, user_confirmed, "add_count_distinct_measure"
    )


@tool("report")
async def add_min_max_measure(
    view_id: int,
    name: str,
    column: str,
    kind: Literal["min", "max"],
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a MIN or MAX measure on `column`. `kind` = 'min' | 'max'.

    Works on numeric, date, AND string columns (MIN/MAX of a string
    returns the alphabetically first/last value).
    """
    if kind not in ("min", "max"):
        raise ValueError("kind must be 'min' or 'max'.")
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": kind,
        "sql": "${TABLE}." + column.strip(),
        "label": label,
        "folder": folder,
        "filters": filters or None,
    })
    return await _append_measure(view_id, measure, user_confirmed, f"add_{kind}_measure")


@tool("report")
async def add_ratio_measure(
    view_id: int,
    name: str,
    numerator_measure: str,
    denominator_measure: str,
    label: str | None = None,
    folder: str | None = None,
    format_kind: Literal["number", "percent", "currency"] | None = None,
    format_decimals: int | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a RATIO measure = numerator_measure / denominator_measure.

    Both measures must ALREADY exist on the same view. The tool
    builds the Mode-2 ratio (expression + depends_on) so the engine
    inlines each measure's aggregate SQL — no double-aggregation.

    Example ARPD = revenue / deal_won:
      add_ratio_measure(view_id=7, name="arpd",
                        numerator_measure="revenue",
                        denominator_measure="deal_won",
                        label="ARPD", format_kind="currency")
    """
    num = numerator_measure.strip()
    den = denominator_measure.strip()
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "avg",  # cosmetic — formula path bypasses outer agg
        "expression": "${" + num + "} / NULLIF(${" + den + "}, 0)",
        "depends_on": [num, den],
        "label": label,
        "folder": folder,
        "format": _format_block(format_kind, format_decimals, None, None, None),
    })
    return await _append_measure(view_id, measure, user_confirmed, "add_ratio_measure")


@tool("report")
async def add_percent_of_total_measure(
    view_id: int,
    name: str,
    column: str,
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a % OF GRAND TOTAL measure on `column`.

    Engine renders this as `SUM(col) / SUM(SUM(col)) OVER () * 100` so
    every row's value shows its share of the overall total in the
    chart's result set.
    """
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "percent_of_total",
        "sql": "${TABLE}." + column.strip(),
        "label": label,
        "folder": folder,
        "filters": filters or None,
    })
    return await _append_measure(
        view_id, measure, user_confirmed, "add_percent_of_total_measure"
    )


__all__ = [
    "add_sum_measure",
    "add_avg_measure",
    "add_count_measure",
    "add_count_distinct_measure",
    "add_min_max_measure",
    "add_ratio_measure",
    "add_percent_of_total_measure",
]
