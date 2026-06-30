"""Stage 1 — Dataset.

Create a dataset and attach the tables a Workboard mini-app reads/writes.
Tables come from an attached data source (physical_table / sql_query) or are
derived from other dataset tables (derived_table). Date tables are enabled via
update_dataset settings, never the tables endpoint. Profiling a new table is
what populates its columns_cache — downstream model/screen tools depend on it.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from appbi_wb_core import (
    Context,
    _clamp_int,
    _confirmation_required_for_destructive,
    _drop_none,
    _request,
    _requires_confirmation,
    tool,
)


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@tool({"discover", "source", "dataset", "model", "build"})
async def list_datasets(ctx: Context | None = None) -> dict[str, Any]:
    """List datasets visible to the PAT. Reuse one before creating a new one."""
    return {"items": await _request("GET", "/datasets/")}


@tool({"discover", "dataset", "model", "build"})
async def get_dataset(
    dataset_id: int, summary: bool = False, ctx: Context | None = None
) -> dict[str, Any]:
    """Fetch a dataset with its tables. summary=True keeps only id/name +
    per-table id/display_name/source_kind/column count."""
    payload = await _request("GET", f"/datasets/{int(dataset_id)}")
    if summary and isinstance(payload, dict):
        return _summarize_dataset(payload)
    return payload


def _summarize_dataset(payload: dict[str, Any]) -> dict[str, Any]:
    tables: list[dict[str, Any]] = []
    for table in payload.get("tables") or []:
        if not isinstance(table, dict):
            continue
        cache = table.get("columns_cache")
        cols = cache.get("columns") if isinstance(cache, dict) else (cache or table.get("columns"))
        tables.append(
            {
                "id": table.get("id"),
                "display_name": table.get("display_name"),
                "source_kind": table.get("source_kind"),
                "source_table_name": table.get("source_table_name"),
                "datasource_id": table.get("datasource_id"),
                "column_count": len(cols) if isinstance(cols, list) else None,
                "enabled": table.get("enabled"),
            }
        )
    return {
        "id": payload.get("id"),
        "name": payload.get("name"),
        "description": payload.get("description"),
        "tables": tables,
        "_summary": True,
    }


@tool({"discover", "dataset", "model", "build"})
async def list_dataset_tables(
    dataset_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List a dataset's tables (id, display_name, source_kind, columns_cache)."""
    return {"items": await _request("GET", f"/datasets/{int(dataset_id)}/tables")}


@tool({"dataset", "model", "build"})
async def get_table_profile(
    dataset_id: int,
    table_id: int,
    sample_limit: int = 5,
    include_stats: bool = True,
    stats_top_limit: int = 3,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Profile a table — schema + sample + per-column stats. Also populates
    columns_cache, so call this once on every newly added table before
    authoring model joins or screens against it."""
    rows = _clamp_int(sample_limit, default=5, minimum=1, maximum=200)
    top = _clamp_int(stats_top_limit, default=3, minimum=1, maximum=20)
    return await _request(
        "POST",
        f"/datasets/{int(dataset_id)}/tables/{int(table_id)}/profile"
        f"?sample_limit={rows}&include_stats={'true' if include_stats else 'false'}"
        f"&stats_top_limit={top}",
    )


@tool({"dataset", "model"})
async def get_column_summary(
    dataset_id: int,
    table_id: int,
    column_name: str,
    top_limit: int = 10,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Detailed stats for ONE column (use after get_table_profile flags one)."""
    top = _clamp_int(top_limit, default=10, minimum=1, maximum=50)
    return await _request(
        "GET",
        f"/datasets/{int(dataset_id)}/tables/{int(table_id)}"
        f"/columns/{quote(column_name)}/summary?top_limit={top}",
    )


# ---------------------------------------------------------------------------
# Write — datasets
# ---------------------------------------------------------------------------


@tool("dataset")
async def create_dataset(
    name: str,
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create an empty dataset. Add tables with add_table_to_dataset."""
    if not user_confirmed:
        return _requires_confirmation(
            "create_dataset", {"name": name, "description": description}
        )
    body = _drop_none({"name": name, "description": description})
    return await _request("POST", "/datasets/", json_body=body)


@tool("dataset")
async def update_dataset(
    dataset_id: int,
    name: str | None = None,
    description: str | None = None,
    settings: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update a dataset's name / description / settings.

    Enable a date table via settings:
      {"calendar_dimension": {"enabled": true, "start_date": "2020-01-01",
       "end_date": "2030-12-31", "table_name": "calendar_dim"}}
    The backend materialises a generated_calendar table automatically — do not
    add a calendar via add_table_to_dataset.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "update_dataset",
            {
                "dataset_id": int(dataset_id),
                "changes": _drop_none(
                    {
                        "name": name,
                        "description": description,
                        "settings_keys": sorted((settings or {}).keys()) or None,
                    }
                ),
            },
        )
    body = _drop_none({"name": name, "description": description, "settings": settings})
    return await _request("PUT", f"/datasets/{int(dataset_id)}", json_body=body)


# ---------------------------------------------------------------------------
# Write — tables
# ---------------------------------------------------------------------------


@tool("dataset")
async def add_table_to_dataset(
    dataset_id: int,
    display_name: str,
    source_kind: str = "physical_table",
    datasource_id: int | None = None,
    source_table_name: str | None = None,
    source_query: str | None = None,
    enabled: bool = True,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add a table to a dataset.

    source_kind:
      physical_table -> datasource_id + source_table_name. For Google Sheets
        source_table_name is the TAB name only ("DM_SanPham"); for SQL it is
        "schema.table" ("public.orders").
      sql_query      -> datasource_id + source_query (SELECT ...).
      derived_table  -> source_query referencing dataset tables; NO datasource_id.
    Calendar tables go through update_dataset settings, not here.
    After adding, call get_table_profile to populate columns_cache.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "add_table_to_dataset",
            {
                "dataset_id": int(dataset_id),
                "display_name": display_name,
                "source_kind": source_kind,
                "datasource_id": datasource_id,
                "source_table_name": source_table_name,
                "source_query_preview": (source_query or "")[:200] or None,
            },
        )
    body = _drop_none(
        {
            "display_name": display_name,
            "source_kind": source_kind,
            "datasource_id": datasource_id,
            "source_table_name": source_table_name,
            "source_query": source_query,
            "enabled": enabled,
        }
    )
    result = await _request("POST", f"/datasets/{int(dataset_id)}/tables", json_body=body)
    if isinstance(result, dict):
        cache = result.get("columns_cache")
        cols = cache.get("columns") if isinstance(cache, dict) else None
        count = len(cols) if isinstance(cols, list) else 0
        state: dict[str, Any] = {"columns_cached": count, "columns_ready": count > 0}
        if count == 0:
            state["columns_warning"] = (
                "columns_cache is empty. Call get_table_profile(dataset_id, table_id) "
                "now — it live-runs the table and fills the cache that model joins and "
                "screen columns read from."
            )
        result["_columns_state"] = state
    return result


@tool("dataset")
async def update_dataset_table(
    dataset_id: int,
    table_id: int,
    display_name: str | None = None,
    source_query: str | None = None,
    enabled: bool | None = None,
    type_overrides: dict[str, Any] | None = None,
    column_formats: dict[str, Any] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update a dataset table.

    type_overrides: {col: 'date'|'number'|'string'|...} override inferred types.
    column_formats: per-column display formats. enabled=False disables it.
    """
    changes = _drop_none(
        {
            "display_name": display_name,
            "source_query": source_query,
            "enabled": enabled,
            "type_overrides": type_overrides,
            "column_formats": column_formats,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "update_dataset_table",
            {"dataset_id": int(dataset_id), "table_id": int(table_id), "changes": changes},
        )
    return await _request(
        "PUT", f"/datasets/{int(dataset_id)}/tables/{int(table_id)}", json_body=changes
    )


@tool("dataset")
async def remove_table_from_dataset(
    dataset_id: int,
    table_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Remove a table from a dataset. Cascades to model views/screens using it."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "remove_table_from_dataset",
            {"dataset_id": int(dataset_id), "table_id": int(table_id)},
        )
    await _request(
        "DELETE",
        f"/datasets/{int(dataset_id)}/tables/{int(table_id)}",
        expect_json=False,
    )
    return {"status": "removed", "dataset_id": int(dataset_id), "table_id": int(table_id)}


# ---------------------------------------------------------------------------
# Write — descriptions (Claude-authored, no LLM)
# ---------------------------------------------------------------------------


@tool("dataset")
async def update_table_description(
    dataset_id: int,
    table_id: int,
    auto_description: str | None = None,
    column_descriptions: dict[str, str] | None = None,
    common_questions: list[str] | None = None,
    query_aliases: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Save table description fields (pure write). query_aliases are alternate
    names ('GMV', 'doanh thu')."""
    body = _drop_none(
        {
            "auto_description": auto_description,
            "column_descriptions": column_descriptions,
            "common_questions": common_questions,
            "query_aliases": query_aliases,
        }
    )
    if not body:
        raise ValueError("Provide at least one description field to update.")
    if not user_confirmed:
        return _requires_confirmation(
            "update_table_description",
            {
                "dataset_id": int(dataset_id),
                "table_id": int(table_id),
                "fields_to_update": sorted(body.keys()),
            },
        )
    return await _request(
        "PUT",
        f"/datasets/{int(dataset_id)}/tables/{int(table_id)}/description",
        json_body=body,
    )


@tool("dataset")
async def update_dataset_dictionary(
    dataset_id: int,
    overview: str | None = None,
    business_purpose: str | None = None,
    usage_guidelines: str | None = None,
    ai_context: str | None = None,
    default_filters: list[str] | None = None,
    warnings: list[str] | None = None,
    table_notes: list[dict[str, Any]] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Replace the dataset-level dictionary (business glossary). REPLACES the
    whole dictionary JSON — pass complete state."""
    body = _drop_none(
        {
            "overview": overview,
            "business_purpose": business_purpose,
            "usage_guidelines": usage_guidelines,
            "ai_context": ai_context,
            "default_filters": default_filters,
            "warnings": warnings,
            "table_notes": table_notes,
        }
    )
    if not body:
        raise ValueError("Provide at least one dictionary field to update.")
    if not user_confirmed:
        return _requires_confirmation(
            "update_dataset_dictionary",
            {
                "dataset_id": int(dataset_id),
                "fields_to_update": sorted(body.keys()),
                "table_note_count": len(table_notes or []),
            },
        )
    return await _request(
        "PUT", f"/datasets/{int(dataset_id)}/dictionary", json_body=body
    )


__all__: list[str] = []
