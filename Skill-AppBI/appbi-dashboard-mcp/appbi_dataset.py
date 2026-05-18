"""Stage 2 — Dataset.

Tools for creating datasets, importing tables from sources, and writing
descriptions/dictionary metadata that Claude generates locally.

Critical: this module DOES NOT call any AppBI LLM endpoints. The legacy
MCP exposed `regenerate_table_description` and `preview_table_description`
which delegated to the backend's OpenRouter client; both are absent here.
Claude writes the prose; `update_table_description` saves it verbatim.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import quote

from appbi_core import (
    Context,
    _clamp_int,
    _drop_none,
    _query_path,
    _request,
    _requires_confirmation,
    _confirmation_required_for_destructive,
    tool,
)


# ---------------------------------------------------------------------------
# Read — discovery & inspection
# ---------------------------------------------------------------------------


@tool({"report", "dataset", "explore"})
async def list_datasets(ctx: Context | None = None) -> dict[str, Any]:
    """List every dataset the authenticated user can view.

    Always call this BEFORE creating a new dataset. Reuse an existing
    dataset whenever its purpose matches the user's intent — present the
    options to the user and let them pick.
    """
    items = await _request("GET", "/datasets/")
    return {"items": items}


@tool({"report", "dataset", "explore"})
async def get_dataset(
    dataset_id: int,
    summary: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Fetch a dataset with its tables.

    Default returns full payload (100KB-1MB+). Pass summary=True to shrink
    10-100x — only id/name + per-table id/display_name/source_kind/column count.
    """
    payload = await _request("GET", f"/datasets/{int(dataset_id)}")
    if summary:
        return _summarize_dataset(payload)
    return payload


def _summarize_dataset(payload: Any) -> dict[str, Any]:
    """Trim a dataset payload to the dashboard-author essentials."""
    if not isinstance(payload, dict):
        return {"raw_type": type(payload).__name__}
    tables_summary: list[dict[str, Any]] = []
    for table in payload.get("tables") or []:
        if not isinstance(table, dict):
            continue
        cols = table.get("columns") or table.get("columns_cache") or []
        tables_summary.append(
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
        "tables": tables_summary,
        "_summary": True,
    }


@tool({"report", "dataset", "explore"})
async def list_dataset_tables(
    dataset_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List tables in a dataset (without the heavy column metadata)."""
    items = await _request("GET", f"/datasets/{int(dataset_id)}/tables")
    return {"items": items}


@tool({"report", "dataset", "explore"})
async def get_table_profile(
    dataset_id: int,
    table_id: int,
    sample_limit: int = 5,
    include_stats: bool = True,
    stats_top_limit: int = 3,
    histogram_bins: int = 8,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Primary tool to understand a table — schema + sample + per-column stats.

    Use BEFORE designing semantic model or proposing charts. Call ONCE per
    table per session; reuse from conversation context. Use get_column_summary
    for follow-up depth on a flagged column. Defaults are design-tuned:
    sample_limit=5, stats_top_limit=3, histogram_bins=8.
    """
    rows = _clamp_int(sample_limit, default=5, minimum=1, maximum=200)
    top = _clamp_int(stats_top_limit, default=3, minimum=1, maximum=20)
    bins = _clamp_int(histogram_bins, default=8, minimum=2, maximum=20)
    path = (
        f"/datasets/{int(dataset_id)}/tables/{int(table_id)}/profile"
        f"?sample_limit={rows}"
        f"&include_stats={'true' if include_stats else 'false'}"
        f"&stats_top_limit={top}"
    )
    payload = await _request("POST", path)
    return _trim_profile_payload(payload, histogram_bins=bins)


def _trim_profile_payload(
    payload: Any, *, histogram_bins: int
) -> dict[str, Any]:
    """Drop server-side bloat from get_table_profile responses.

    The backend's column histogram is fixed at 20 bins; for semantic-design
    work 8 bins are plenty and the difference is ~1.6KB→0.6KB per numeric
    column. On a 50-column table that's ~50KB→~30KB shaved.
    """
    if not isinstance(payload, dict):
        return payload
    stats = payload.get("stats")
    if not isinstance(stats, dict):
        return payload
    target_bins = max(2, min(int(histogram_bins or 8), 20))
    for col_stats in stats.values():
        if not isinstance(col_stats, dict):
            continue
        histogram = col_stats.get("histogram")
        if not isinstance(histogram, list) or len(histogram) <= target_bins:
            continue
        col_stats["histogram"] = _rebin_histogram(histogram, target_bins)
        col_stats["histogram_rebinned_from"] = len(histogram)
    return payload


def _rebin_histogram(
    bins: list[dict[str, Any]], target: int
) -> list[dict[str, Any]]:
    """Merge adjacent bins so we end up with `target` bins total.

    Keeps the first bin's bin_start, the last bin's bin_end, sums counts.
    Distribution shape (where mass concentrates) is preserved.
    """
    if not bins:
        return bins
    n = len(bins)
    group_size = max(1, (n + target - 1) // target)
    merged: list[dict[str, Any]] = []
    for i in range(0, n, group_size):
        chunk = bins[i : i + group_size]
        merged.append(
            {
                "bin_start": chunk[0].get("bin_start"),
                "bin_end": chunk[-1].get("bin_end"),
                "count": sum(int(b.get("count") or 0) for b in chunk),
            }
        )
    return merged


@tool({"dataset", "explore"})
async def get_table_description(
    dataset_id: int,
    table_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Read the current AI/manual description for a table.

    Returns auto_description, column_descriptions, common_questions,
    query_aliases, and description_source ('auto'|'user'|'feedback').
    """
    return await _request(
        "GET", f"/datasets/{int(dataset_id)}/tables/{int(table_id)}/description"
    )


@tool({"report", "dataset", "explore"})
async def get_column_summary(
    dataset_id: int,
    table_id: int,
    column_name: str,
    top_limit: int = 10,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Detailed stats for ONE column.

    Use when `get_table_profile` flagged something interesting and you need
    deeper detail on a specific column without re-profiling the whole table.
    """
    top = _clamp_int(top_limit, default=10, minimum=1, maximum=50)
    path = (
        f"/datasets/{int(dataset_id)}/tables/{int(table_id)}"
        f"/columns/{quote(column_name)}/summary?top_limit={top}"
    )
    return await _request("GET", path)


@tool({"dataset", "explore"})
async def get_dataset_dictionary(
    dataset_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Read the dataset glossary (terms, aliases, definitions)."""
    return await _request("GET", f"/datasets/{int(dataset_id)}/dictionary")


@tool({"dataset", "explore"})
async def search_dataset_tables(
    query: str,
    dataset_id: int | None = None,
    limit: int = 10,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Vector-similarity search for tables matching a natural-language intent.

    Useful when the user describes what they want ('sales by region last
    quarter') and you need to find which tables in which datasets are
    relevant. Searches across descriptions + column hints.
    """
    return await _request(
        "GET",
        _query_path(
            "/datasets/tables/search",
            {"q": query, "dataset_id": dataset_id, "limit": int(limit)},
        ),
    )


@tool("dataset")
async def list_source_tables_for_dataset(
    datasource_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List source tables that can be imported into a dataset.

    Backend endpoint is mounted under /datasets/datasources/{id}/tables and
    is the canonical way to discover what's importable from one source.
    """
    return await _request(
        "GET", f"/datasets/datasources/{int(datasource_id)}/tables"
    )


# ---------------------------------------------------------------------------
# Write — datasets
# ---------------------------------------------------------------------------


@tool({"report", "dataset"})
async def create_dataset(
    name: str,
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create an empty dataset. Tables are added separately via
    `add_table_to_dataset`.

    Preview-then-confirm: returns a plan on the first call. Only writes
    after the user explicitly approves and you call again with
    `user_confirmed=True`.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "create_dataset",
            {"name": name, "description": description},
        )
    body = _drop_none({"name": name, "description": description})
    return await _request("POST", "/datasets/", json_body=body)


@tool("dataset")
async def update_dataset(
    dataset_id: int,
    name: str | None = None,
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update a dataset's name and/or description."""
    if not user_confirmed:
        return _requires_confirmation(
            "update_dataset",
            {
                "dataset_id": int(dataset_id),
                "changes": _drop_none({"name": name, "description": description}),
            },
        )
    body = _drop_none({"name": name, "description": description})
    return await _request(
        "PUT", f"/datasets/{int(dataset_id)}", json_body=body
    )


@tool("dataset")
async def delete_dataset(
    dataset_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete a dataset and all its tables (CASCADE).

    This will cascade to charts, dashboards-chart links, and quality rules
    that reference the dataset. Not reversible.
    """
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_dataset",
            {"dataset_id": int(dataset_id)},
            reversible=False,
        )
    await _request(
        "DELETE", f"/datasets/{int(dataset_id)}", expect_json=False
    )
    return {"status": "deleted", "dataset_id": int(dataset_id)}


# ---------------------------------------------------------------------------
# Write — tables
# ---------------------------------------------------------------------------


@tool({"report", "dataset"})
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

    `source_kind`:
      physical_table → datasource_id + source_table_name ('public.orders')
      sql_query      → datasource_id + source_query (SELECT ...)
      derived_table  → source_query referencing dataset tables; NO datasource_id.
    Calendar tables: use update_dataset settings.calendar_dimension.
    Measures: live on SemanticView, not a table.
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
                "source_query_preview": (source_query or "")[:200],
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
    return await _request(
        "POST", f"/datasets/{int(dataset_id)}/tables", json_body=body
    )


@tool("dataset")
async def update_dataset_table(
    dataset_id: int,
    table_id: int,
    display_name: str | None = None,
    source_query: str | None = None,
    enabled: bool | None = None,
    type_overrides: dict[str, Any] | None = None,
    column_formats: dict[str, Any] | None = None,
    transformations: list[dict[str, Any]] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update a dataset table's metadata.

    `type_overrides`: {col: 'date'|...} override inferred types.
    `column_formats`: display formats per column.
    `transformations`: REPLACES pipeline (calc columns, lookups).
    `enabled=False`: disable without remove.
    """
    changes = _drop_none(
        {
            "display_name": display_name,
            "source_query": source_query,
            "enabled": enabled,
            "type_overrides": type_overrides,
            "column_formats": column_formats,
            "transformations": transformations,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "update_dataset_table",
            {
                "dataset_id": int(dataset_id),
                "table_id": int(table_id),
                "changes": changes,
            },
        )
    return await _request(
        "PUT",
        f"/datasets/{int(dataset_id)}/tables/{int(table_id)}",
        json_body=changes,
    )


@tool("dataset")
async def remove_table_from_dataset(
    dataset_id: int,
    table_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Remove a table from a dataset.

    Cascades to any semantic view/explore referencing the table. Charts
    that referenced the table will break — list them first via
    `list_charts` filtered by dataset_table_id.
    """
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "remove_table_from_dataset",
            {"dataset_id": int(dataset_id), "table_id": int(table_id)},
            reversible=False,
        )
    await _request(
        "DELETE",
        f"/datasets/{int(dataset_id)}/tables/{int(table_id)}",
        expect_json=False,
    )
    return {
        "status": "removed",
        "dataset_id": int(dataset_id),
        "table_id": int(table_id),
    }


# ---------------------------------------------------------------------------
# Write — descriptions (Claude-authored, NOT LLM-delegated)
# ---------------------------------------------------------------------------


@tool({"report", "dataset"})
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
    """Save table description fields (pure write, no LLM).

    Workflow: get_table_profile → author description + 3-5 common_questions
    → show draft to user → user_confirmed=True. `query_aliases` are
    alternative names ('GMV', 'doanh thu' for revenue).
    """
    body = _drop_none(
        {
            "auto_description": auto_description,
            "column_descriptions": column_descriptions,
            "common_questions": common_questions,
            "query_aliases": query_aliases,
        }
    )
    if not body:
        raise ValueError(
            "At least one of auto_description, column_descriptions, "
            "common_questions, query_aliases must be provided."
        )
    if not user_confirmed:
        preview = {
            "dataset_id": int(dataset_id),
            "table_id": int(table_id),
            "fields_to_update": sorted(body.keys()),
            "auto_description_preview": (
                (auto_description or "")[:300] if auto_description else None
            ),
            "column_count": (
                len(column_descriptions) if column_descriptions else 0
            ),
            "questions_count": (
                len(common_questions) if common_questions else 0
            ),
        }
        return _requires_confirmation("update_table_description", preview)
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
    """Replace the dataset-level dictionary (business glossary).

    REPLACES the whole `dictionary` JSON — pass complete state.
    `table_notes[i]`: {table_id, business_role, grain,
    freshness_expectation, join_hint, owner_note, row_count_expectation,
    important_columns, column_notes}.
    """
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
        raise ValueError(
            "Provide at least one of overview, business_purpose, "
            "usage_guidelines, ai_context, default_filters, warnings, "
            "table_notes."
        )
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
