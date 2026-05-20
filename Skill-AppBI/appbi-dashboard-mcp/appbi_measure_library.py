"""Stage 3 — pattern-driven measure builders.

8 wrappers, each creates ONE kind of measure on an existing SemanticView
with the config baked in correctly. Claude picks the tool by intent
("tổng" → add_sum_measure, "tỷ lệ" → add_ratio_measure …) and never
has to author raw {type, sql, expression, depends_on} fields.

Tools (Phase 15.42 3-tier hierarchy):
  Tier 1 — typed-param standard patterns:
    add_sum_measure              SUM(col)
    add_avg_measure              AVG(col)
    add_count_measure            COUNT(*) on the view (count rows). Use
                                 `filters` for conditional counting.
    add_count_distinct_measure   COUNT(DISTINCT col)
    add_min_max_measure          MIN/MAX(col), kind='min'|'max'
    add_ratio_measure            Mode-2 ratio: ${num}/NULLIF(${den}, 0)
    add_percent_of_total_measure SUM/SUM(SUM) OVER() * 100
  Tier 2 — same tools with `extra={...}` for advanced BE fields
    (where_sql, hidden, description, context_modifiers, scope='dataset' +
    source_columns).
  Tier 3 — add_advanced_measure(view_id, measure_spec) for shapes no
    Tier-1 tool fits (custom expression, multiple context_modifiers,
    custom format.pattern).

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
    # Look up dataset_id so the log lands in logs/dataset_<id>/dataset.md
    log_ds_id: int | None = None
    table_id = view.get("dataset_table_id")
    if isinstance(table_id, int):
        try:
            table_meta = await _request("GET", f"/dataset-tables/{int(table_id)}")
            if isinstance(table_meta, dict):
                cand = table_meta.get("dataset_id")
                if isinstance(cand, int):
                    log_ds_id = cand
        except Exception:  # noqa: BLE001 — best-effort
            log_ds_id = None
    log_path = _append_session_log(
        "dataset",
        action_name,
        {
            "dataset_id": log_ds_id,
            "view_id": int(view_id),
            "view_name": view.get("name"),
            "measure_name": new_name,
            "measure_type": new_measure.get("type"),
        },
        dataset_id=log_ds_id,
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


# Phase-15.42: allow library tools to passthrough advanced BE-recognized
# fields without exploding the typed-param surface. Whitelist keeps the
# escape hatch from becoming an arbitrary-dict footgun — only fields the
# BE MeasureDefinition schema knows about can slip through.
_ALLOWED_EXTRA_KEYS = {
    "where_sql",          # raw WHERE fragment (power user; structured filters preferred)
    "description",        # human prose, separate from `label`
    "hidden",             # bool — measure exists but hidden in pickers
    "context_modifiers",  # Phase-14: [{type, keep_fields?, join_alias?}]
    "scope",              # Phase-12: "view" (default) | "dataset"
    "source_columns",     # Phase-12: [{view, field}] — required with scope="dataset"
}


def _apply_extra(
    measure: dict[str, Any],
    extra: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge whitelisted `extra` fields into the measure dict.

    Rejects any key outside `_ALLOWED_EXTRA_KEYS` with a ValueError so
    callers can't sneak through ad-hoc fields the BE will silently drop
    (the recurring drift class). The BE Pydantic validator does a second
    pass on shape (e.g. context_modifiers entries must be dicts with the
    right `type`); we don't duplicate that here.
    """
    if not extra:
        return measure
    if not isinstance(extra, dict):
        raise ValueError("extra must be a dict or None.")
    unknown = set(extra.keys()) - _ALLOWED_EXTRA_KEYS
    if unknown:
        raise ValueError(
            f"extra contains unknown keys: {sorted(unknown)}. "
            f"Allowed: {sorted(_ALLOWED_EXTRA_KEYS)}. For fields not in "
            "this whitelist, use `add_advanced_measure` with the full "
            "MeasureDefinition shape."
        )
    # scope='dataset' requires source_columns and vice versa — cheap
    # cross-check so MCP catches it before the BE round-trip.
    if extra.get("scope") == "dataset" and not extra.get("source_columns"):
        raise ValueError(
            "scope='dataset' requires `source_columns` (list of "
            "{view, field}) so the engine knows which views to JOIN. "
            "Without source_columns the BE will reject the measure."
        )
    if extra.get("source_columns") and extra.get("scope") != "dataset":
        raise ValueError(
            "source_columns is only valid with scope='dataset' "
            "(Phase-12 cross-table measure). Remove source_columns or "
            "set scope='dataset' explicitly."
        )
    merged = dict(measure)
    for key, value in extra.items():
        if value is None:
            continue
        merged[key] = value
    return merged


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
    extra: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """SUM(`column`). `column` is the bare column name (this tool wraps
    `${TABLE}.` for you).

    `extra` (optional, Tier 2 escape hatch) whitelisted keys:
    `where_sql`, `description`, `hidden`, `context_modifiers`,
    `scope` ('view'|'dataset'), `source_columns` (req with dataset).
    For shapes outside this whitelist use `add_advanced_measure`.
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
    measure = _apply_extra(measure, extra)
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
    extra: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add an AVG measure aggregating `column`. See `add_sum_measure` for `extra` shape."""
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "avg",
        "sql": "${TABLE}." + column.strip(),
        "label": label,
        "folder": folder,
        "filters": filters or None,
        "format": _format_block(format_kind, format_decimals, None, None, None),
    })
    measure = _apply_extra(measure, extra)
    return await _append_measure(view_id, measure, user_confirmed, "add_avg_measure")


@tool("report")
async def add_count_measure(
    view_id: int,
    name: str,
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    extra: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """COUNT(*) on the view (count rows). Use `filters` to count
    conditionally (e.g. status='won'); for "rows where col IS NOT NULL"
    add a filter with operator='is_not_null'. For unique non-null
    counts use `add_count_distinct_measure`. See `add_sum_measure`
    for `extra`.
    """
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "count",
        "label": label,
        "folder": folder,
        "filters": filters or None,
    })
    measure = _apply_extra(measure, extra)
    return await _append_measure(view_id, measure, user_confirmed, "add_count_measure")


@tool("report")
async def add_count_distinct_measure(
    view_id: int,
    name: str,
    column: str,
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    extra: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a COUNT DISTINCT measure (unique non-null values of `column`). See `add_sum_measure` for `extra`."""
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "count_distinct",
        "sql": "${TABLE}." + column.strip(),
        "label": label,
        "folder": folder,
        "filters": filters or None,
    })
    measure = _apply_extra(measure, extra)
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
    extra: dict[str, Any] | None = None,
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
    measure = _apply_extra(measure, extra)
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
    extra: dict[str, Any] | None = None,
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
    See `add_sum_measure` for `extra` shape.
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
    measure = _apply_extra(measure, extra)
    return await _append_measure(view_id, measure, user_confirmed, "add_ratio_measure")


@tool("report")
async def add_percent_of_total_measure(
    view_id: int,
    name: str,
    column: str,
    label: str | None = None,
    filters: list[dict[str, Any]] | None = None,
    folder: str | None = None,
    extra: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a % OF GRAND TOTAL measure on `column`.

    Engine renders this as `SUM(col) / SUM(SUM(col)) OVER () * 100` so
    every row's value shows its share of the overall total in the
    chart's result set. See `add_sum_measure` for `extra` shape.
    """
    measure = _drop_none({
        "name": _validate_measure_name(name),
        "type": "percent_of_total",
        "sql": "${TABLE}." + column.strip(),
        "label": label,
        "folder": folder,
        "filters": filters or None,
    })
    measure = _apply_extra(measure, extra)
    return await _append_measure(
        view_id, measure, user_confirmed, "add_percent_of_total_measure"
    )


@tool("report")
async def add_advanced_measure(
    view_id: int,
    measure_spec: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Tier 3 — raw passthrough for measure shapes no typed tool fits
    (custom expression, multiple context_modifiers, custom format.pattern,
    BE fields outside Tier-2 `extra` whitelist). Prefer the typed tools
    when possible.

    `measure_spec` = full MeasureDefinition shape:
      name (snake_case, required), type, sql OR expression,
      filters[], where_sql, depends_on[], format, folder, label,
      description, hidden, scope, source_columns[], context_modifiers[].

    Validates: name regex, type present, non-count needs sql OR expression.
    """
    if not isinstance(measure_spec, dict):
        raise ValueError("measure_spec must be a dict.")
    spec = dict(measure_spec)
    spec["name"] = _validate_measure_name(spec.get("name") or "")
    m_type = (spec.get("type") or "").strip().lower()
    if not m_type:
        raise ValueError("measure_spec.type is required.")
    if m_type != "count":
        has_sql = bool(str(spec.get("sql") or "").strip())
        has_expr = bool(str(spec.get("expression") or "").strip())
        if not has_sql and not has_expr:
            raise ValueError(
                f"measure_spec.type={m_type!r} requires either `sql` "
                "(e.g. '${TABLE}.amount') or `expression`. Only "
                "type='count' may omit both."
            )
    return await _append_measure(
        view_id, spec, user_confirmed, "add_advanced_measure"
    )


__all__ = [
    "add_sum_measure",
    "add_avg_measure",
    "add_count_measure",
    "add_count_distinct_measure",
    "add_min_max_measure",
    "add_ratio_measure",
    "add_advanced_measure",
    "add_percent_of_total_measure",
]
