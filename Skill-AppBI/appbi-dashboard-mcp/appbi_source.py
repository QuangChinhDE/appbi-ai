"""Stage 1 — Source.

Tools for inspecting a raw data source BEFORE any dataset is created.
Claude uses these to understand what tables exist, what columns they have,
and what real data looks like — so the dataset/model design that follows
is grounded in evidence, not guesses.

All tools here are read-only. None of them trigger writes to AppBI.
"""
from __future__ import annotations

from typing import Any

from appbi_core import (
    Context,
    _clamp_int,
    _request,
    mcp,
)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


@mcp.tool()
async def list_data_sources(ctx: Context | None = None) -> dict[str, Any]:
    """List every data source the authenticated user can view.

    Always start a new orchestration here. The returned list shows id, name,
    type (postgresql/mysql/bigquery/...), and connection status. Pick the
    one matching the user's intent — never guess by name.
    """
    items = await _request("GET", "/datasources/")
    return {"items": items}


@mcp.tool()
async def get_data_source(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Fetch one data source's full details (config, type, status)."""
    return await _request("GET", f"/datasources/{int(data_source_id)}")


@mcp.tool()
async def test_data_source_connection(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Test the data source connection is still live.

    Use this when a later tool fails with a connection error to confirm
    whether the issue is the source itself or the query.

    Implementation note: AppBI's `/datasources/test` expects a `type` +
    `config` body. We fetch the existing data source first and forward
    its stored config so the backend re-authenticates with the real
    credentials (sensitive fields are restored server-side).
    """
    ds = await _request("GET", f"/datasources/{int(data_source_id)}")
    body = {
        "data_source_id": int(data_source_id),
        "type": ds.get("type"),
        "config": ds.get("config") or {},
    }
    return await _request("POST", "/datasources/test", json_body=body)


# ---------------------------------------------------------------------------
# Schema introspection
# ---------------------------------------------------------------------------


@mcp.tool()
async def inspect_source_schema(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Return the schema tree for a data source: schemas → tables/views.

    Output shape (per backend):
      { "schemas": [
          { "name": "public",
            "tables": [{"name": "orders", "row_count_estimate": 12345, ...}, ...],
            "views":  [...] }, ... ]}

    Use this to map out what's available before deciding which tables to
    pull into a dataset.
    """
    return await _request("GET", f"/datasources/{int(data_source_id)}/schema")


@mcp.tool()
async def inspect_source_table(
    data_source_id: int,
    schema_name: str,
    table_name: str,
    preview_rows: int = 5,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Return column metadata + a tiny preview for ONE source table.

    The response includes column names, types, primary-key/foreign-key/index
    flags (when the source supports them), and the first `preview_rows`
    rows. Use this for a quick look — for serious profiling pull the table
    into a dataset first and call `get_table_profile`.
    """
    rows = _clamp_int(preview_rows, default=5, minimum=0, maximum=50)
    path = (
        f"/datasources/{int(data_source_id)}"
        f"/tables/{schema_name}/{table_name}"
        f"?preview_rows={rows}"
    )
    return await _request("GET", path)


@mcp.tool()
async def get_watermark_candidates(
    data_source_id: int,
    schema_name: str,
    table_name: str,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List columns usable as a watermark (timestamp/date/integer-PK) for
    incremental sync planning. Mostly useful when the user wants scheduled
    refresh of a high-volume table."""
    path = (
        f"/datasources/{int(data_source_id)}"
        f"/tables/{schema_name}/{table_name}/watermarks"
    )
    return await _request("GET", path)


# ---------------------------------------------------------------------------
# Ad-hoc query
# ---------------------------------------------------------------------------


@mcp.tool()
async def run_source_query(
    data_source_id: int,
    sql_query: str,
    limit: int = 100,
    timeout_seconds: int = 30,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Run an ad-hoc SELECT against the data source.

    Use this to verify hypotheses about the data: cardinality of a column,
    overlap between two tables (for FK detection), distribution of a value,
    etc. The backend rate-limits this to 20 calls/minute per user.

    Safety:
      - Prefer SELECT-only. Backend validators block destructive statements
        but be polite.
      - Bound the result size — `limit` defaults to 100, max 5000.
    """
    capped_limit = _clamp_int(limit, default=100, minimum=1, maximum=5000)
    capped_timeout = _clamp_int(timeout_seconds, default=30, minimum=1, maximum=120)
    body = {
        "data_source_id": int(data_source_id),
        "sql_query": str(sql_query),
        "limit": capped_limit,
        "timeout_seconds": capped_timeout,
    }
    return await _request("POST", "/datasources/query", json_body=body)


@mcp.tool()
async def validate_source_sql(
    data_source_id: int,
    sql_query: str,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Dry-run validate a SQL query against the source dialect.

    Returns `{valid: bool, error?: str, dialect: str}`. Use before
    `run_source_query` when the SQL is non-trivial — saves a round-trip
    when the syntax is wrong.
    """
    body = {
        "data_source_id": int(data_source_id),
        "sql_query": str(sql_query),
    }
    return await _request("POST", "/datasources/validate-sql", json_body=body)


__all__: list[str] = []
