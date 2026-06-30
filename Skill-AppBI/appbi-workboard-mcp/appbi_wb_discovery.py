"""Read-only discovery tools for Workboard design."""
from __future__ import annotations

from typing import Any

from appbi_wb_core import (
    BackendError,
    Context,
    _clamp_int,
    _request,
    tool,
)


def _as_items(payload: Any, *keys: str) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def _column_rows(table: dict[str, Any]) -> list[dict[str, Any]]:
    cache = table.get("columns_cache")
    raw_columns: Any = cache
    if isinstance(cache, dict):
        raw_columns = cache.get("columns") or cache.get("items") or []
    columns: list[dict[str, Any]] = []
    for raw in raw_columns if isinstance(raw_columns, list) else []:
        if isinstance(raw, dict) and raw.get("name"):
            columns.append(
                {
                    "name": str(raw["name"]),
                    "type": str(raw.get("type") or "string"),
                    "nullable": bool(raw.get("nullable", True)),
                }
            )
        elif isinstance(raw, str):
            columns.append({"name": raw, "type": "string", "nullable": True})
    return columns


def _profile_summary(
    table: dict[str, Any],
    payload: dict[str, Any],
    *,
    profile_fallback: str | None = None,
) -> dict[str, Any]:
    columns = payload.get("columns") or _column_rows(table)
    if columns and isinstance(columns[0], str):
        columns = [{"name": value, "type": "string"} for value in columns]
    sample = payload.get("sample_rows") or payload.get("rows") or []
    table_meta = payload.get("table") if isinstance(payload.get("table"), dict) else {}
    return {
        "id": table.get("id"),
        "display_name": table.get("display_name"),
        "source_kind": table.get("source_kind"),
        "source_table_name": table.get("source_table_name"),
        "datasource_id": table.get("datasource_id"),
        "query_mode": table.get("query_mode"),
        "estimated_row_count": (
            table_meta.get("estimated_row_count") or table.get("estimated_row_count")
        ),
        "columns": columns,
        "sample_rows": sample,
        "stats": payload.get("stats") or {},
        "profile_fallback": profile_fallback,
    }


async def _profile_table(
    dataset_id: int,
    table: dict[str, Any],
    *,
    sample_rows: int,
    include_stats: bool,
) -> dict[str, Any]:
    table_id = int(table["id"])
    try:
        profile = await _request(
            "POST",
            f"/datasets/{int(dataset_id)}/tables/{table_id}/profile",
            params={
                "sample_limit": sample_rows,
                "include_stats": "true" if include_stats else "false",
                "stats_top_limit": 3,
            },
        )
        return _profile_summary(table, profile if isinstance(profile, dict) else {})
    except BackendError as exc:
        datasource_id = table.get("datasource_id")
        if not datasource_id:
            raise
        datasource = await _request("GET", f"/datasources/{int(datasource_id)}")
        if str((datasource or {}).get("type") or "").lower() != "google_sheets":
            raise
        sheet_name = str(table.get("source_table_name") or "")
        rows = await _request(
            "GET",
            f"/datasources/{int(datasource_id)}/gsheets/{sheet_name}/rows",
            params={"limit": sample_rows},
        )
        return _profile_summary(
            table,
            rows if isinstance(rows, dict) else {},
            profile_fallback=f"Google Sheets rows fallback after profile error {exc.status_code}",
        )


@tool({"discover", "build"})
async def inspect_dataset_for_workboard(
    dataset_id: int,
    table_ids: list[int] | None = None,
    sample_rows: int = 5,
    include_stats: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Return Workboard design context for a dataset in one call.

    Includes attached dataset table ids, columns and small live samples.
    Restrict table_ids on large datasets. The result is the source of truth
    for screen.table_id and lookup table ids in a Workboard bundle.
    """
    sample_limit = _clamp_int(sample_rows, default=5, minimum=1, maximum=50)
    dataset = await _request("GET", f"/datasets/{int(dataset_id)}")
    tables_payload = await _request("GET", f"/datasets/{int(dataset_id)}/tables")
    tables = _as_items(tables_payload, "items", "tables")
    wanted = {int(item) for item in table_ids or []}
    selected = [
        table
        for table in tables
        if not wanted or int(table.get("id") or 0) in wanted
    ]
    profiles = [
        await _profile_table(
            int(dataset_id),
            table,
            sample_rows=sample_limit,
            include_stats=include_stats,
        )
        for table in selected
    ]
    return {
        "dataset": {
            "id": dataset.get("id") if isinstance(dataset, dict) else dataset_id,
            "name": dataset.get("name") if isinstance(dataset, dict) else None,
            "description": dataset.get("description") if isinstance(dataset, dict) else None,
        },
        "tables": profiles,
        "table_count": len(profiles),
        "design_notes": [
            "Use tables[].id for screen.table_id and lookup.table_id.",
            "Use table columns that exist in this response before inventing form fields.",
            "Primary Workboard rows should have stable primary_key_columns for update/delete.",
        ],
    }


@tool("discover")
async def list_workboards(ctx: Context | None = None) -> dict[str, Any]:
    """List Workboards visible to the PAT so a builder can reuse or update."""
    return {"items": await _request("GET", "/workboards/")}


@tool("discover")
async def get_workboard(
    workboard_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Fetch full Workboard layout, settings, dataset binding and publish state."""
    return await _request("GET", f"/workboards/{int(workboard_id)}")


@tool("discover")
async def audit_workboard(
    workboard_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Run the backend broken-reference audit for a Workboard layout."""
    return await _request("GET", f"/workboards/{int(workboard_id)}/audit")


@tool("discover")
async def list_workspaces(ctx: Context | None = None) -> dict[str, Any]:
    """List public Workboard workspaces available to this PAT."""
    return {"items": await _request("GET", "/workspaces/")}


@tool("discover")
async def get_workspace(
    workspace_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Fetch one workspace including its menu_config and public token."""
    return await _request("GET", f"/workspaces/{int(workspace_id)}")


__all__: list[str] = []
