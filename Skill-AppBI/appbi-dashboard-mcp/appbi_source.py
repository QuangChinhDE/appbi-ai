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
    _query_path,
    _request,
    tool,
)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


@tool({"report", "dataset"})
async def list_data_sources(ctx: Context | None = None) -> dict[str, Any]:
    """List every data source the authenticated user can view.

    Always start a new orchestration here. The returned list shows id, name,
    type (postgresql/mysql/bigquery/...), and connection status. Pick the
    one matching the user's intent — never guess by name.
    """
    items = await _request("GET", "/datasources/")
    return {"items": items}


@tool({"report", "dataset"})
async def get_data_source(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Fetch one data source's full details (config, type, status)."""
    return await _request("GET", f"/datasources/{int(data_source_id)}")


@tool("dataset")
async def test_data_source_connection(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Test if a data source connection is still live. Use after connection
    errors to isolate source vs query."""
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


@tool({"report", "dataset"})
async def inspect_source_schema(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Return the source's schema tree: schemas → tables/views.

    Use to scout what's available before pulling tables into a dataset.
    Output: {schemas: [{name, tables: [{name, row_count_estimate, ...}],
    views: [...]}]}.
    """
    return await _request("GET", f"/datasources/{int(data_source_id)}/schema")


@tool({"report", "dataset"})
async def inspect_source_table(
    data_source_id: int,
    schema_name: str,
    table_name: str,
    preview_rows: int = 5,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Quick look at ONE source table — columns + types + PK/FK flags
    + N preview rows. For serious profiling use get_table_profile."""
    rows = _clamp_int(preview_rows, default=5, minimum=0, maximum=50)
    path = (
        f"/datasources/{int(data_source_id)}"
        f"/tables/{schema_name}/{table_name}"
        f"?preview_rows={rows}"
    )
    return await _request("GET", path)


@tool("dataset")
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


@tool("dataset")
async def run_source_query(
    data_source_id: int,
    sql_query: str,
    limit: int = 100,
    timeout_seconds: int = 30,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Run an ad-hoc SELECT to verify data hypotheses (cardinality,
    FK overlap, distribution). Rate-limit 20/min/user. SELECT-only;
    limit defaults 100, max 5000."""
    capped_limit = _clamp_int(limit, default=100, minimum=1, maximum=5000)
    capped_timeout = _clamp_int(timeout_seconds, default=30, minimum=1, maximum=120)
    body = {
        "data_source_id": int(data_source_id),
        "sql_query": str(sql_query),
        "limit": capped_limit,
        "timeout_seconds": capped_timeout,
    }
    return await _request("POST", "/datasources/query", json_body=body)


@tool("dataset")
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


# ---------------------------------------------------------------------------
# Google Sheets source — special-case read endpoints
# ---------------------------------------------------------------------------
# `inspect_source_schema` / `inspect_source_table` are the right tools for
# SQL-flavoured sources (BigQuery, Postgres, MySQL, Snowflake, …). For a
# Google Sheets datasource the spreadsheet has TABS rather than tables and
# the BE exposes a dedicated path under `/datasources/{id}/gsheets/...` —
# the two tools below are the gsheets equivalent of "list tables" and
# "inspect table" so Claude can discover what's available before creating
# a dataset.


@tool({"report", "dataset"})
async def list_gsheet_tabs(
    data_source_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List the tabs (sheets) in a Google Sheets datasource's spreadsheet.

    Use this INSTEAD of `inspect_source_schema` when
    `get_data_source(id).type` is `google_sheets`. Each tab name is the
    `source_table_name` you pass to `add_table_to_dataset` or
    `commit_dataset_workspace.plan.tables[].source_table_name`.

    Returns: `{spreadsheet_id, sheets: [<tab_name>, …]}`.
    """
    return await _request(
        "GET", f"/datasources/{int(data_source_id)}/gsheets/sheets"
    )


@tool({"report", "dataset"})
async def read_gsheet_rows(
    data_source_id: int,
    sheet_name: str,
    limit: int = 20,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Read the first `limit` rows of a Google Sheets tab.

    Use after `list_gsheet_tabs` to learn the columns + sample values of
    a tab before adding it to a dataset. The first row of the sheet must
    be a header row — column names come from there.

    Returns: `{spreadsheet_id, sheet_name, columns: [...], rows: [...],
    row_count}`.
    """
    path = _query_path(
        f"/datasources/{int(data_source_id)}/gsheets/{sheet_name}/rows",
        {"limit": int(limit)},
    )
    return await _request("GET", path)


__all__: list[str] = []
