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
    mcp,
)


# ---------------------------------------------------------------------------
# Read — discovery & inspection
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_datasets(ctx: Context | None = None) -> dict[str, Any]:
    """List every dataset the authenticated user can view.

    Always call this BEFORE creating a new dataset. Reuse an existing
    dataset whenever its purpose matches the user's intent — present the
    options to the user and let them pick.
    """
    items = await _request("GET", "/datasets/")
    return {"items": items}


@mcp.tool()
async def get_dataset(
    dataset_id: int,
    summary: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Fetch a dataset with its tables.

    Default returns the full backend payload (columns, samples, descriptions —
    can be 100KB-1MB+ on wide datasets). Pass `summary=True` to get only the
    fields needed for dashboard authoring: dataset id/name plus each table's
    id, display_name, source_kind, and column count. This typically shrinks
    the payload by 10-100x and is what propose_dashboard_blueprint reads.
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


@mcp.tool()
async def list_dataset_tables(
    dataset_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List tables in a dataset (without the heavy column metadata)."""
    items = await _request("GET", f"/datasets/{int(dataset_id)}/tables")
    return {"items": items}


@mcp.tool()
async def get_table_profile(
    dataset_id: int,
    table_id: int,
    sample_limit: int = 5,
    include_stats: bool = True,
    stats_top_limit: int = 3,
    histogram_bins: int = 8,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """**Primary tool for understanding a table.**

    Returns schema + sample rows + per-column stats (top values / histogram /
    null %) in a single call. Use this BEFORE designing the semantic model
    or proposing charts — Claude needs concrete evidence about cardinality,
    types, and value distribution to make good decisions.

    Token-cost defaults are tuned for *design work*, not data exploration:
      - sample_limit=5 — enough rows to see value patterns; bump to 20+
        only when debugging specific data quirks.
      - stats_top_limit=3 — top categorical values per column.
      - histogram_bins=8 — re-bin numeric histograms client-side from
        the backend's 20 down to 8. Distribution shape stays readable.

    Profile each table at most ONCE per session; reuse the result from
    conversation context rather than re-calling. Use `get_column_summary`
    for follow-up depth on a single column you flagged interesting.

    Backend: POST /datasets/{id}/tables/{tid}/profile.
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


@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
async def get_dataset_dictionary(
    dataset_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Read the dataset glossary (terms, aliases, definitions)."""
    return await _request("GET", f"/datasets/{int(dataset_id)}/dictionary")


@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
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
    """Import one source table into a dataset.

    `source_kind` ∈ {'physical_table', 'sql_query', 'derived_table'}:
      - physical_table: requires datasource_id + source_table_name
                        (e.g. 'public.orders').
      - sql_query    : requires datasource_id + source_query (SELECT ...).
      - derived_table: requires source_query referencing other already-
                        imported dataset tables. datasource_id MUST be
                        omitted.

    Validation runs server-side; on the first call this tool returns a
    plan including the resolved source path so the user can sanity-check
    before the write.
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


@mcp.tool()
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
    """Update a dataset table's metadata.

    Common uses:
      - Override a column's inferred type via `type_overrides`
        (e.g. {"order_date": "date"}).
      - Set display formats via `column_formats`.
      - Disable a table without removing it via `enabled=False`.
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


@mcp.tool()
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


@mcp.tool()
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
    """Save table description fields that Claude authored.

    This is a PURE WRITE — the backend does not call any LLM. It just
    persists the strings, marks `description_source='user'`, and triggers
    a background re-embedding of the search index.

    Workflow:
      1. Call `get_table_profile` to ground yourself in the data.
      2. Author the description, column_descriptions dict, and 3-5
         common_questions.
      3. Show the draft to the user and ask for any tweaks.
      4. Call this with `user_confirmed=True` to save.

    `query_aliases` are alternative names users might use ('GMV', 'doanh
    thu' for a revenue column) — populate when known.
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


@mcp.tool()
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
    """Update the dataset-level dictionary (business glossary).

    The backend persists every field below as part of the dataset's
    `dictionary` JSON. Send only the fields you want to set; omitted
    fields keep their existing values only if you also include them
    explicitly — the backend REPLACES the whole dictionary on each call,
    so always pass the complete intended state.

    Fields:
      - overview          : short prose describing what's in the dataset.
      - business_purpose  : why this dataset exists / what decisions it supports.
      - usage_guidelines  : do/don't notes for analysts and AI.
      - ai_context        : extra context the AI assistants should know.
      - default_filters   : list of human-readable default filter strings.
      - warnings          : list of caveats / data-quality notes.
      - table_notes       : per-table annotations. Each item is a dict:
          {
            "table_id": <int>,
            "business_role": "fact|dimension|bridge|...",
            "grain": "one row per ...",
            "freshness_expectation": "daily|hourly|...",
            "join_hint": "...",
            "owner_note": "...",
            "row_count_expectation": "...",
            "important_columns": ["col_a", "col_b"],
            "column_notes": [
              {"column_name": "...", "description": "...",
               "business_name": "...", "examples": ["..."],
               "quality": {...}}
            ]
          }
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
