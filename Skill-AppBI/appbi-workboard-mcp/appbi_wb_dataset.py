"""Stage 2 - Dataset setup tools.

Only needed when no suitable dataset exists yet. Creates a dataset and
attaches physical tables so they are available as screen sources.
"""
from __future__ import annotations

from typing import Any, Optional

from appbi_wb_core import _request, _requires_confirmation, mcp


def _default_display_name(name: str) -> str:
    raw = str(name or "").strip().split(".")[-1]
    words = [part for part in raw.replace("-", " ").replace("_", " ").split() if part]
    if not words:
        return raw or "Untitled Table"
    return " ".join(word[:1].upper() + word[1:] for word in words)


async def _resolve_dataset_datasource_id(dataset_id: int) -> tuple[Optional[int], list[int]]:
    dataset = await _request("GET", f"/datasets/{dataset_id}")
    raw_tables = dataset.get("tables") or []
    datasource_ids = {
        int(table["datasource_id"])
        for table in raw_tables
        if isinstance(table, dict) and table.get("datasource_id") is not None
    }
    if not datasource_ids:
        raw_tables = await _request("GET", f"/datasets/{dataset_id}/tables")
        datasource_ids = {
            int(table["datasource_id"])
            for table in raw_tables
            if isinstance(table, dict) and table.get("datasource_id") is not None
        }
    ordered = sorted(datasource_ids)
    if len(ordered) == 1:
        return ordered[0], ordered
    return None, ordered


async def _attach_physical_table(
    *,
    dataset_id: int,
    datasource_id: Optional[int],
    schema_name: str,
    table_name: str,
    display_name: Optional[str],
    description: Optional[str],
    user_confirmed: bool,
) -> Any:
    resolved_datasource_id = datasource_id
    candidate_datasource_ids: list[int] = []
    if resolved_datasource_id is None:
        resolved_datasource_id, candidate_datasource_ids = await _resolve_dataset_datasource_id(dataset_id)

    source_table_name = f"{schema_name}.{table_name}" if schema_name else table_name
    resolved_display_name = (display_name or "").strip() or _default_display_name(table_name)

    plan = {
        "action": "add_physical_table",
        "dataset_id": dataset_id,
        "datasource_id": resolved_datasource_id,
        "source_table_name": source_table_name,
        "display_name": resolved_display_name,
        "source_kind": "physical_table",
        "description": description,
        "next_steps": [
            "Call get_dataset_table_profile after attach to inspect columns and sample rows.",
        ],
    }
    if candidate_datasource_ids:
        plan["candidate_datasource_ids_from_dataset"] = candidate_datasource_ids

    if resolved_datasource_id is None:
        return {
            "ok": False,
            "message": (
                "datasource_id is required because this dataset does not yet imply "
                "a single datasource. Re-run with datasource_id, or attach a first "
                "table from the intended datasource."
            ),
            "plan": plan,
        }

    if not user_confirmed:
        return _requires_confirmation(plan)

    body: dict[str, Any] = {
        "datasource_id": int(resolved_datasource_id),
        "display_name": resolved_display_name,
        "source_kind": "physical_table",
        "source_table_name": source_table_name,
    }
    if description:
        body["description"] = description

    return await _request("POST", f"/datasets/{dataset_id}/tables", json_body=body)


@mcp.tool()
async def create_dataset(
    name: str,
    description: Optional[str] = None,
    datasource_id: Optional[int] = None,
    user_confirmed: bool = False,
) -> Any:
    """Create a new dataset.

    Datasets are datasource-agnostic in the backend. Keep ``datasource_id``
    only for compatibility with older prompts - it is ignored on write.
    """
    plan = {
        "action": "create_dataset",
        "name": name,
        "description": description,
        "datasource_id_ignored": datasource_id,
        "notes": [
            "Datasets do not bind to a datasource at creation time.",
            "Attach physical tables afterward with add_physical_table or attach_gsheet_tab_to_dataset.",
        ],
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    body: dict[str, Any] = {"name": name}
    if description:
        body["description"] = description

    return await _request("POST", "/datasets/", json_body=body)


@mcp.tool()
async def add_physical_table(
    dataset_id: int,
    table_name: str,
    datasource_id: Optional[int] = None,
    schema_name: str = "",
    display_name: Optional[str] = None,
    description: Optional[str] = None,
    user_confirmed: bool = False,
) -> Any:
    """Attach a physical SQL table or GSheets tab to a dataset.

    For SQL tables pass ``schema_name`` when needed. For Google Sheets tabs,
    leave ``schema_name`` empty and pass the tab name as ``table_name``.
    """
    return await _attach_physical_table(
        dataset_id=dataset_id,
        datasource_id=datasource_id,
        schema_name=schema_name,
        table_name=table_name,
        display_name=display_name,
        description=description,
        user_confirmed=user_confirmed,
    )


@mcp.tool()
async def attach_gsheet_tab_to_dataset(
    dataset_id: int,
    datasource_id: int,
    sheet_name: str,
    display_name: Optional[str] = None,
    description: Optional[str] = None,
    user_confirmed: bool = False,
) -> Any:
    """Attach an existing Google Sheets tab to a dataset.

    This helper removes the need to remember the lower-level
    ``schema_name=''`` convention used by the generic add_physical_table tool.
    """
    return await _attach_physical_table(
        dataset_id=dataset_id,
        datasource_id=datasource_id,
        schema_name="",
        table_name=sheet_name,
        display_name=display_name,
        description=description,
        user_confirmed=user_confirmed,
    )


@mcp.tool()
async def detach_table_from_dataset(
    dataset_id: int,
    table_id: int,
    user_confirmed: bool = False,
) -> Any:
    """Remove a table attachment from a dataset.

    Use this when the wrong tab was attached, or when a source table no
    longer exists and you want to clean up the dataset.  The table record
    is deleted from the dataset but the underlying data source is not
    affected.

    Obtain ``table_id`` from list_dataset_tables or get_dataset.
    """
    plan = {
        "action": "detach_table_from_dataset",
        "dataset_id": dataset_id,
        "table_id": table_id,
        "warning": "This removes the table from the dataset. Existing workboard screens that reference this table will break.",
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    return await _request("DELETE", f"/datasets/{dataset_id}/tables/{table_id}")


@mcp.tool()
async def check_dataset_source_status(dataset_id: int) -> Any:
    """Check whether all tables attached to a dataset still exist in their source.

    Returns a list of tables with a ``status`` field indicating ``ok``,
    ``missing``, or ``error``.  Use this to diagnose stale or broken
    dataset attachments after a Google Sheet tab is renamed or deleted.
    """
    return await _request("GET", f"/datasets/{dataset_id}/tables/source-status")
