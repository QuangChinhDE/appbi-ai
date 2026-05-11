"""Stage 1 - Discovery tools (read-only).

All tools here are safe: they only call read endpoints and never mutate
anything. Claude should call these first before proposing or committing.
"""
from __future__ import annotations

from typing import Any, Optional

from appbi_wb_core import _request, mcp


def _columns_from_cache(table: dict) -> list[dict]:
    cache = table.get("columns_cache") or {}
    raw_columns = cache.get("columns") if isinstance(cache, dict) else []
    columns: list[dict] = []
    if isinstance(raw_columns, list):
        for entry in raw_columns:
            if isinstance(entry, dict) and entry.get("name"):
                columns.append(
                    {
                        "name": str(entry.get("name")),
                        "type": str(entry.get("type") or "string"),
                        "nullable": bool(entry.get("nullable", True)),
                        "description": "",
                    }
                )
            elif isinstance(entry, str):
                columns.append(
                    {
                        "name": entry,
                        "type": "string",
                        "nullable": True,
                        "description": "",
                    }
                )
    return columns


async def _fallback_gsheet_table_profile(
    dataset_id: int,
    table_id: int,
    sample_rows: int,
    original_error: Exception,
) -> Any:
    tables = await _request("GET", f"/datasets/{dataset_id}/tables")
    table = next(
        (item for item in tables if isinstance(item, dict) and int(item.get("id") or 0) == int(table_id)),
        None,
    )
    if not table or not table.get("datasource_id"):
        raise original_error

    datasource = await _request("GET", f"/datasources/{int(table['datasource_id'])}")
    if str(datasource.get("type") or "").strip().lower() != "google_sheets":
        raise original_error

    rows_payload = await _request(
        "GET",
        f"/datasources/{int(table['datasource_id'])}/gsheets/{table.get('source_table_name')}/rows",
        params={"limit": sample_rows},
    )
    columns = rows_payload.get("columns") or _columns_from_cache(table)
    if columns and isinstance(columns[0], str):
        columns = [
            {"name": str(name), "type": "string", "nullable": True, "description": ""}
            for name in columns
        ]
    return {
        "ok": True,
        "fallback": True,
        "fallback_reason": (
            "Backend dataset table profile failed for this Google Sheets table; "
            "MCP fell back to datasource rows plus dataset columns_cache."
        ),
        "original_error": str(original_error),
        "table": {
            "id": table.get("id"),
            "name": table.get("source_table_name"),
            "display_name": table.get("display_name"),
            "description": table.get("auto_description"),
            "estimated_row_count": rows_payload.get("row_count") or table.get("estimated_row_count"),
        },
        "columns": columns,
        "sample_rows": rows_payload.get("rows") or [],
        "sample_size": len(rows_payload.get("rows") or []),
        "stats": {} if columns else None,
    }


@mcp.tool()
async def list_datasets(skip: int = 0, limit: int = 50) -> Any:
    """List datasets visible to the current AppBI PAT.

    Returns a structured list: {datasets: [{id, name, description, table_count}, ...], total}
    so the caller can quickly find a dataset by id or name without parsing raw JSON blobs.
    """
    raw = await _request("GET", "/datasets/", params={"skip": skip, "limit": limit})
    # Normalize to a clean list regardless of whether backend returns list or {items:...}
    items = raw if isinstance(raw, list) else (raw.get("items") or raw.get("datasets") or [])
    datasets = [
        {
            "id": ds.get("id"),
            "name": ds.get("name"),
            "description": ds.get("description") or "",
            "table_count": len(ds.get("tables") or []),
            "created_at": ds.get("created_at"),
        }
        for ds in items
        if isinstance(ds, dict)
    ]
    return {
        "datasets": datasets,
        "total": len(datasets),
        "skip": skip,
        "limit": limit,
    }


@mcp.tool()
async def get_dataset(dataset_id: int) -> Any:
    """Get a dataset with attached table details."""
    return await _request("GET", f"/datasets/{dataset_id}")


@mcp.tool()
async def list_dataset_tables(dataset_id: int) -> Any:
    """List all tables attached to a dataset, with a sheet_exists flag for GSheets tabs.

    For Google Sheets datasources, sheet_exists indicates whether the tab is
    actually present in the live spreadsheet (validates against columns_cache state).
    For non-GSheets tables, sheet_exists is always null.
    """
    tables = await _request("GET", f"/datasets/{dataset_id}/tables")
    if not isinstance(tables, list):
        return tables

    # Try to get live sheet tabs for GSheets datasources
    # Group tables by datasource_id to batch the tab list calls
    from typing import Dict as _Dict
    dsid_to_tabs: _Dict[int, Any] = {}

    result = []
    for table in tables:
        if not isinstance(table, dict):
            result.append(table)
            continue

        dsid = table.get("datasource_id")
        source_kind = str(table.get("source_kind") or "")
        sheet_exists: Any = None

        if dsid is not None and source_kind == "physical_table":
            # Lazily fetch tab list per datasource (cached in dsid_to_tabs)
            if dsid not in dsid_to_tabs:
                try:
                    tabs_resp = await _request("GET", f"/datasources/{dsid}/gsheets/sheets")
                    if isinstance(tabs_resp, list):
                        dsid_to_tabs[dsid] = {str(t.get("title") or t.get("name") or ""): True for t in tabs_resp if isinstance(t, dict)}
                    elif isinstance(tabs_resp, dict) and "sheets" in tabs_resp:
                        dsid_to_tabs[dsid] = {str(s.get("title") or ""): True for s in tabs_resp["sheets"] if isinstance(s, dict)}
                    else:
                        dsid_to_tabs[dsid] = None  # not a GSheets datasource
                except Exception:
                    dsid_to_tabs[dsid] = None

            tab_map = dsid_to_tabs.get(dsid)
            if tab_map is not None:
                # source_table_name for GSheets is the tab name
                tab_name = str(table.get("source_table_name") or "")
                sheet_exists = tab_map.get(tab_name, False)

        result.append({**table, "sheet_exists": sheet_exists})

    return result


@mcp.tool()
async def get_dataset_table_profile(
    dataset_id: int,
    table_id: int,
    sample_rows: int = 20,
    include_stats: bool = True,
    stats_top_limit: int = 5,
) -> Any:
    """Profile a dataset table: schema, sample rows, and optional stats.

    The backend exposes this as POST even though it is read-only.
    """
    try:
        return await _request(
            "POST",
            f"/datasets/{dataset_id}/tables/{table_id}/profile",
            params={
                "sample_limit": sample_rows,
                "include_stats": include_stats,
                "stats_top_limit": stats_top_limit,
            },
        )
    except Exception as exc:
        return await _fallback_gsheet_table_profile(dataset_id, table_id, sample_rows, exc)


@mcp.tool()
async def list_workboards(skip: int = 0, limit: int = 50) -> Any:
    """List workboards visible to the current AppBI PAT."""
    return await _request("GET", "/workboards/", params={"skip": skip, "limit": limit})


@mcp.tool()
async def get_workboard(workboard_id: int) -> Any:
    """Get a full workboard including layout_json."""
    return await _request("GET", f"/workboards/{workboard_id}")


@mcp.tool()
async def list_app_users(workboard_id: int) -> Any:
    """List app users for a workboard."""
    return await _request("GET", f"/workboards/{workboard_id}/app-users")


@mcp.tool()
async def list_data_sources(skip: int = 0, limit: int = 50) -> Any:
    """List datasource connections registered on AppBI."""
    return await _request("GET", "/datasources/", params={"skip": skip, "limit": limit})


@mcp.tool()
async def get_data_source(datasource_id: int) -> Any:
    """Get one datasource with type and connection metadata."""
    return await _request("GET", f"/datasources/{datasource_id}")


@mcp.tool()
async def inspect_source_schema(datasource_id: int) -> Any:
    """List schemas available in a datasource."""
    return await _request("GET", f"/datasources/{datasource_id}/schema")


@mcp.tool()
async def list_datasource_tables(
    datasource_id: int,
    search: Optional[str] = None,
) -> Any:
    """List live source tables/tabs for a datasource."""
    params = {"search": search} if search else None
    return await _request("GET", f"/datasets/datasources/{datasource_id}/tables", params=params)


@mcp.tool()
async def inspect_source_table(
    datasource_id: int,
    schema_name: str,
    table_name: str,
    preview_rows: int = 5,
) -> Any:
    """Inspect a single physical source table before attaching it to a dataset."""
    return await _request(
        "GET",
        f"/datasources/{datasource_id}/tables/{schema_name}/{table_name}",
        params={"preview_rows": preview_rows},
    )


@mcp.tool()
async def list_workspaces() -> Any:
    """List public workspaces."""
    return await _request("GET", "/workspaces/")


@mcp.tool()
async def get_workspace(workspace_id: int) -> Any:
    """Get workspace details including menu_config."""
    return await _request("GET", f"/workspaces/{workspace_id}")
