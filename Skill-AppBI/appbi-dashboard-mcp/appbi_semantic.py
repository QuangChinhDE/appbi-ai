"""Stage 3 — Semantic Model.

Semantic views/models/explores are AppBI's LookML-style abstraction. Charts
query through the semantic engine instead of writing raw SQL, which gives
consistent measures, dimensions, and joins across the whole dataset.

Two paths to a working model:

  A. **Claude-designed** (preferred). Claude profiles the tables, chooses
     dimensions/measures, designs joins manually, then calls
     `create_semantic_view` / `create_semantic_explore`. More work, but
     the result reflects the user's actual analysis intent.

  B. **Heuristic auto-generation**. `generate_dataset_model` scans columns
     and produces a starter model. Useful as a draft Claude can then
     refine via the update_* tools. Does NOT call any LLM.

This module exposes both. Claude picks based on the user's preference and
how much hand-tuning the data requires.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from appbi_core import (
    Context,
    _confirmation_required_for_destructive,
    _drop_none,
    _query_path,
    _request,
    _requires_confirmation,
    tool,
)


# ---------------------------------------------------------------------------
# Read — global semantic catalog
# ---------------------------------------------------------------------------


@tool("explore")
async def list_semantic_views(ctx: Context | None = None) -> dict[str, Any]:
    """List every semantic view across the workspace."""
    items = await _request("GET", "/semantic/views")
    return {"items": items}


@tool("explore")
async def get_semantic_view(
    view_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Fetch one view (dimensions, measures, sql_table_name, dataset_table_id)."""
    return await _request("GET", f"/semantic/views/{int(view_id)}")


@tool("explore")
async def list_semantic_models(ctx: Context | None = None) -> dict[str, Any]:
    """List every semantic model. A model groups views + explores for a dataset."""
    items = await _request("GET", "/semantic/models")
    return {"items": items}


@tool("explore")
async def get_semantic_model(
    model_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Fetch one semantic model."""
    return await _request("GET", f"/semantic/models/{int(model_id)}")


@tool({"report", "dataset", "explore"})
async def list_semantic_explores(ctx: Context | None = None) -> dict[str, Any]:
    """List every explore. Charts target an explore by name."""
    items = await _request("GET", "/semantic/explores")
    return {"items": items}


@tool({"report", "dataset", "explore"})
async def get_semantic_explore(
    explore_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Fetch one explore (base view + joins + default filters)."""
    return await _request("GET", f"/semantic/explores/{int(explore_id)}")


@tool({"report", "explore"})
async def get_semantic_explore_by_name(
    explore_name: str, ctx: Context | None = None
) -> dict[str, Any]:
    """Look up an explore by its unique name (faster than list+filter)."""
    return await _request(
        "GET", f"/semantic/explores/by-name/{quote(explore_name)}"
    )


# ---------------------------------------------------------------------------
# Read — dataset-scoped model (the visual model editor view)
# ---------------------------------------------------------------------------


@tool({"report", "dataset", "explore"})
async def get_dataset_model(
    dataset_id: int,
    summary: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Get the semantic model attached to a dataset.

    Returns `{model_id, dataset_id, dataset_name, views, explores, generated}`.
    `generated=False` means no model has been built yet — call
    `generate_dataset_model` for a heuristic starter, or design from scratch
    via `create_semantic_view` + `create_semantic_explore`.

    Pass `summary=True` to trim views/explores down to id+name+field-name
    catalogue (drops full measure SQL, descriptions, hidden flags). Use the
    summary when you only need the field index — propose_dashboard_blueprint
    already exposes the same information in a richer agent-tuned shape.
    """
    payload = await _request("GET", f"/datasets/{int(dataset_id)}/model")
    if summary:
        return _summarize_dataset_model(payload)
    return payload


def _summarize_dataset_model(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"raw_type": type(payload).__name__}
    views_summary: list[dict[str, Any]] = []
    for view in payload.get("views") or []:
        if not isinstance(view, dict):
            continue
        views_summary.append(
            {
                "id": view.get("id"),
                "name": view.get("name"),
                "dataset_table_id": view.get("dataset_table_id"),
                "dimensions": [
                    d.get("name")
                    for d in (view.get("dimensions") or [])
                    if isinstance(d, dict) and d.get("name")
                ],
                "measures": [
                    {"name": m.get("name"), "type": m.get("type")}
                    for m in (view.get("measures") or [])
                    if isinstance(m, dict) and m.get("name")
                ],
            }
        )
    explores_summary: list[dict[str, Any]] = []
    for explore in payload.get("explores") or []:
        if not isinstance(explore, dict):
            continue
        explores_summary.append(
            {
                "id": explore.get("id"),
                "name": explore.get("name"),
                "base_view_name": explore.get("base_view_name"),
                "joined_views": [
                    j.get("view")
                    for j in (explore.get("joins") or [])
                    if isinstance(j, dict) and j.get("view")
                ],
            }
        )
    return {
        "model_id": payload.get("model_id"),
        "dataset_id": payload.get("dataset_id"),
        "dataset_name": payload.get("dataset_name"),
        "generated": payload.get("generated"),
        "views": views_summary,
        "explores": explores_summary,
        "_summary": True,
    }


@tool("explore")
async def get_distinct_field_values(
    dataset_id: int,
    field: str,
    limit: int = 200,
    filters_json: str | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Get distinct values for a qualified semantic field (e.g. 'orders.country').

    Used to populate dropdown filter values. `filters_json` is a JSON-encoded
    list of dashboard filter objects to cascade — pass when you want
    distinct values restricted by other active filters.
    """
    return await _request(
        "GET",
        _query_path(
            f"/datasets/{int(dataset_id)}/model/distinct-values",
            {"field": field, "limit": int(limit), "filters": filters_json},
        ),
    )


# ---------------------------------------------------------------------------
# Write — view CRUD
# ---------------------------------------------------------------------------


@tool("explore")
async def create_semantic_view(
    name: str,
    sql_table_name: str | None = None,
    dataset_table_id: int | None = None,
    dimensions: list[dict[str, Any]] | None = None,
    measures: list[dict[str, Any]] | None = None,
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a semantic view backing one physical/derived table.

    Either `sql_table_name` (e.g. 'public.orders') or `dataset_table_id`
    must be set. When both are present, `dataset_table_id` wins.

    `dimensions` items: {name, type ('string'|'number'|'date'|'datetime'|'yesno'),
                         sql, label, description, hidden}.

    `measures` items (Phase-1 schema — fields after `hidden` are optional):
        {
          name, type ('count'|'sum'|'avg'|'min'|'max'|
                      'count_distinct'|'percent_of_total'),
          sql, label, description, hidden,

          # ── optional, omit if not used ──
          expression: str — SQL expression aggregated by `type`; takes
              precedence over `sql`. Use for arithmetic across columns,
              e.g. expression='${TABLE}.amount - ${TABLE}.cost'.
          filters: list[{field, operator, value}] — Looker-style filtered
              measure. Compiles to CASE WHEN so the aggregate only sees
              qualifying rows. Operators: eq, ne, gt, gte, lt, lte, in,
              not_in, between, contains, starts_with, ends_with, is_null,
              is_not_null. Prefer this over `where_sql` whenever possible.
          where_sql: str — raw SQL boolean fragment AND-combined with
              `filters`. Reserved for predicates the operator list cannot
              express (date math, regex, multi-column comparisons).
          depends_on: list[str] — names of other measures on the SAME view
              referenced inside `expression`. Required for cycle detection.
              Self-reference and circular chains are rejected at commit time.
          format: {kind ('number'|'currency'|'percent'|'duration'|'custom'),
                   decimals (0..10), currency, prefix, suffix, pattern} —
              display hint for charts/KPIs. Does not affect SQL.
          folder: str — UI grouping label (e.g. 'Revenue').
        }

    Use ${TABLE} placeholder in `sql`, `expression`, and `where_sql` to
    reference the underlying table alias.
    """
    body = _drop_none(
        {
            "name": name,
            "sql_table_name": sql_table_name,
            "dataset_table_id": dataset_table_id,
            "dimensions": dimensions or [],
            "measures": measures or [],
            "description": description,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "create_semantic_view",
            {
                "name": name,
                "table_ref": sql_table_name or f"dataset_table_id={dataset_table_id}",
                "dimension_count": len(dimensions or []),
                "measure_count": len(measures or []),
            },
        )
    return await _request("POST", "/semantic/views", json_body=body)


@tool("explore")
async def update_semantic_view(
    view_id: int,
    patch: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Patch a semantic view. `patch` may include any of:
    name, sql_table_name, dataset_table_id, dimensions, measures, description.

    When patching `measures`, the WHOLE measures array is replaced (not
    merged per-measure) — read the current view first, mutate, then write
    back. Each measure object follows the Phase-1 schema documented on
    `create_semantic_view` (expression, filters, where_sql, depends_on,
    format, folder are all optional)."""
    if not user_confirmed:
        return _requires_confirmation(
            "update_semantic_view",
            {"view_id": int(view_id), "fields": sorted(patch.keys())},
        )
    return await _request(
        "PUT", f"/semantic/views/{int(view_id)}", json_body=patch
    )


@tool("explore")
async def delete_semantic_view(
    view_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete a semantic view. Cascades to explores that reference it."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_semantic_view", {"view_id": int(view_id)}, reversible=False,
        )
    await _request(
        "DELETE", f"/semantic/views/{int(view_id)}", expect_json=False
    )
    return {"status": "deleted", "view_id": int(view_id)}


# ---------------------------------------------------------------------------
# Write — model CRUD
# ---------------------------------------------------------------------------


@tool("explore")
async def create_semantic_model(
    name: str,
    dataset_id: int | None = None,
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a semantic model. Usually one per dataset."""
    body = _drop_none(
        {"name": name, "dataset_id": dataset_id, "description": description}
    )
    if not user_confirmed:
        return _requires_confirmation("create_semantic_model", body)
    return await _request("POST", "/semantic/models", json_body=body)


@tool("explore")
async def update_semantic_model(
    model_id: int,
    patch: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Patch a semantic model (name, description, dataset_id)."""
    if not user_confirmed:
        return _requires_confirmation(
            "update_semantic_model",
            {"model_id": int(model_id), "fields": sorted(patch.keys())},
        )
    return await _request(
        "PUT", f"/semantic/models/{int(model_id)}", json_body=patch
    )


@tool("explore")
async def delete_semantic_model(
    model_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete a semantic model. Cascades to explores under it."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_semantic_model", {"model_id": int(model_id)}, reversible=False,
        )
    await _request(
        "DELETE", f"/semantic/models/{int(model_id)}", expect_json=False
    )
    return {"status": "deleted", "model_id": int(model_id)}


# ---------------------------------------------------------------------------
# Write — explore CRUD (joins live here)
# ---------------------------------------------------------------------------


@tool("explore")
async def create_semantic_explore(
    name: str,
    base_view_name: str,
    base_view_id: int,
    model_id: int,
    joins: list[dict[str, Any]] | None = None,
    default_filters: dict[str, Any] | None = None,
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create an explore: a starting view + a list of joins.

    `joins` items: {name, view, alias?, type ('left'|'inner'|'right'|'full'),
                    sql_on, relationship?}
    `sql_on` uses ${view.field} placeholders, e.g.
        '${orders.customer_id} = ${customers.id}'

    Charts target explores by `name`, so pick a name the user will recognize
    (e.g. 'orders_with_customers').
    """
    body = _drop_none(
        {
            "name": name,
            "base_view_name": base_view_name,
            "base_view_id": int(base_view_id),
            "model_id": int(model_id),
            "joins": joins or [],
            "default_filters": default_filters or {},
            "description": description,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "create_semantic_explore",
            {
                "name": name,
                "base_view": base_view_name,
                "join_count": len(joins or []),
            },
        )
    return await _request("POST", "/semantic/explores", json_body=body)


@tool("explore")
async def update_semantic_explore(
    explore_id: int,
    patch: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Patch an explore (name, base_view_*, joins, default_filters, description)."""
    if not user_confirmed:
        return _requires_confirmation(
            "update_semantic_explore",
            {"explore_id": int(explore_id), "fields": sorted(patch.keys())},
        )
    return await _request(
        "PUT", f"/semantic/explores/{int(explore_id)}", json_body=patch
    )


@tool("explore")
async def delete_semantic_explore(
    explore_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete an explore. Charts targeting this explore will break."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_semantic_explore",
            {"explore_id": int(explore_id)},
            reversible=False,
        )
    await _request(
        "DELETE", f"/semantic/explores/{int(explore_id)}", expect_json=False
    )
    return {"status": "deleted", "explore_id": int(explore_id)}


# ---------------------------------------------------------------------------
# Write — dataset-scoped model joins (managed via the dataset endpoints)
# ---------------------------------------------------------------------------


@tool("explore")
async def add_dataset_model_join(
    dataset_id: int,
    from_view_id: int,
    to_view_id: int,
    from_column: str | None = None,
    to_column: str | None = None,
    from_columns: list[str] | None = None,
    to_columns: list[str] | None = None,
    join_type: str = "left",
    relationship: str = "many_to_one",
    alias: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add or update a relationship between two views inside one dataset's model.

    Wraps `POST /datasets/{id}/model/joins`. Use this instead of editing
    explore joins directly when working with the dataset-scoped visual model.
    """
    if not user_confirmed:
        join_from = from_columns or ([from_column] if from_column else [])
        join_to = to_columns or ([to_column] if to_column else [])
        return _requires_confirmation(
            "add_dataset_model_join",
            {
                "dataset_id": int(dataset_id),
                "from_view_id": int(from_view_id),
                "to_view_id": int(to_view_id),
                "on": list(zip(join_from, join_to)) if join_from and join_to else None,
                "join_type": join_type,
                "relationship": relationship,
                "alias": alias,
            },
        )
    body = _drop_none(
        {
            "from_view_id": int(from_view_id),
            "to_view_id": int(to_view_id),
            "from_column": from_column,
            "to_column": to_column,
            "from_columns": from_columns,
            "to_columns": to_columns,
            "join_type": join_type,
            "relationship": relationship,
            "alias": alias,
        }
    )
    return await _request(
        "POST", f"/datasets/{int(dataset_id)}/model/joins", json_body=body
    )


@tool("explore")
async def remove_dataset_model_join(
    dataset_id: int,
    from_view_id: int,
    to_view_name: str,
    from_column: str | None = None,
    to_column: str | None = None,
    from_columns: list[str] | None = None,
    to_columns: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Remove a relationship between two views in a dataset model."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "remove_dataset_model_join",
            {
                "dataset_id": int(dataset_id),
                "from_view_id": int(from_view_id),
                "to_view_name": to_view_name,
            },
            reversible=False,
        )
    return await _request(
        "DELETE",
        _query_path(
            f"/datasets/{int(dataset_id)}/model/joins",
            {
                "from_view_id": int(from_view_id),
                "to_view_name": to_view_name,
                "from_column": from_column,
                "to_column": to_column,
                "from_columns": ",".join(from_columns) if from_columns else None,
                "to_columns": ",".join(to_columns) if to_columns else None,
            },
        ),
    )


# ---------------------------------------------------------------------------
# Heuristic generator (does NOT call any LLM)
# ---------------------------------------------------------------------------


@tool({"dataset", "explore"})
async def generate_dataset_model(
    dataset_id: int,
    force: bool = False,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Heuristically generate a starter semantic model for a dataset.

    Scans every table's columns_cache and produces:
      - one SemanticView per table (dimensions + measures inferred from types)
      - one SemanticModel for the dataset
      - SemanticExplores with auto-detected JOINs (FK heuristic)

    No LLM is involved — this is a pure scan + rule-based generator. Use it
    as a starting point Claude refines via `update_semantic_view` and
    `update_semantic_explore`. With `force=True` it overwrites any existing
    model.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "generate_dataset_model",
            {
                "dataset_id": int(dataset_id),
                "force_overwrite": bool(force),
                "note": "This rebuilds views/explores. Existing customizations may be lost.",
            },
        )
    return await _request(
        "POST",
        _query_path(
            f"/datasets/{int(dataset_id)}/generate-model",
            {"force": "true" if force else "false"},
        ),
    )


# ---------------------------------------------------------------------------
# Query (read) — execute through the semantic engine
# ---------------------------------------------------------------------------


@tool({"report", "explore"})
async def execute_semantic_query(
    explore: str,
    dimensions: list[str] | None = None,
    measures: list[str] | None = None,
    filters: dict[str, dict[str, Any]] | None = None,
    pivots: list[str] | None = None,
    sorts: list[dict[str, Any]] | None = None,
    limit: int = 500,
    time_grains: dict[str, str] | None = None,
    top_n: dict[str, Any] | None = None,
    calculated_fields: list[dict[str, Any]] | None = None,
    measure_agg_overrides: dict[str, str] | None = None,
    window_functions: list[dict[str, Any]] | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Execute a semantic query and return data + the SQL that was run.

    The engine generates SQL, joins through the explore, applies filters /
    pivots / time grains / window functions, and returns rows. Use this
    BEFORE creating a chart to verify the query produces the data shape
    you expect (correct cardinality, no fan-out, sane numbers).

    `dimensions` / `measures`: qualified names like 'orders.country',
    'orders.total_revenue'.
    `filters`: dict keyed by qualified field name; each value is a
    `FilterCondition` object — `{"operator": "<op>", "value": <any>}` —
    where `operator` is one of eq|ne|gt|gte|lt|lte|in|not_in|contains|
    starts_with|ends_with. Plain field-to-value dicts will be rejected
    with HTTP 422.
    Example:
        filters={"orders.country": {"operator": "eq", "value": "VN"}}
    `sorts`: list of `{field, direction}` where direction is 'asc'|'desc'.
    `time_grains`: {qualified_field: 'day'|'week'|'month'|'quarter'|'year'}.
    `window_functions`: list of `{name, base_measure, partition_by,
    order_by, type}` where type ∈ running_sum|running_avg|rank|
    dense_rank|row_number. The output column lives under `name`.
    """
    body = _drop_none(
        {
            "explore": explore,
            "dimensions": dimensions or [],
            "measures": measures or [],
            "filters": filters or {},
            "pivots": pivots or [],
            "sorts": sorts or [],
            "limit": int(limit),
            "time_grains": time_grains or {},
            "top_n": top_n,
            "calculated_fields": calculated_fields or [],
            "measure_agg_overrides": measure_agg_overrides or {},
            "window_functions": window_functions or [],
        }
    )
    return await _request("POST", "/semantic/query", json_body=body)


__all__: list[str] = []
