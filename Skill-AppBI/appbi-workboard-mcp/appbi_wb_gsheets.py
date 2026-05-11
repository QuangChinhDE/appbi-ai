"""Stage 1b - Google Sheets management tools."""
from __future__ import annotations

from typing import Any, Dict, List

from appbi_wb_core import _request, _requires_confirmation, mcp


SHEETS_WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets"


def _normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def _clean_headers(headers: List[str]) -> List[str]:
    cleaned: List[str] = []
    seen: set[str] = set()
    for raw in headers:
        header = str(raw or "").strip()
        if not header or header in seen:
            continue
        cleaned.append(header)
        seen.add(header)
    return cleaned


def _normalized_workboard_headers(
    headers: List[str],
    *,
    ensure_workboard_columns: bool,
) -> List[str]:
    cleaned = _clean_headers(headers)
    if ensure_workboard_columns:
        if "id" in cleaned:
            cleaned = ["id"] + [header for header in cleaned if header != "id"]
        else:
            cleaned = ["id", *cleaned]
        if "updated_at" not in cleaned:
            cleaned.append("updated_at")
    return cleaned


async def _check_google_sheets_write_scope(datasource_id: int) -> dict:
    """Return a diagnostic for whether the MCP can safely perform GSheets writes.

    The backend writes through the OAuth credential stored on the datasource.
    ``/auth/google/data-access/status`` describes the current PAT user, so we
    only use it as a hard blocker when it appears to be the same Google account
    as the datasource owner.
    """
    datasource = await _request("GET", f"/datasources/{datasource_id}")
    config = datasource.get("config") or {}
    if str(datasource.get("type") or "") != "google_sheets":
        return {
            "ok": False,
            "blocking": True,
            "message": f"Datasource {datasource_id} is not google_sheets.",
            "datasource_type": datasource.get("type"),
        }
    if config.get("auth_mode") != "google_oauth":
        return {
            "ok": True,
            "blocking": False,
            "message": "Datasource does not use user Google OAuth; write scope preflight is not required.",
            "auth_mode": config.get("auth_mode"),
        }

    status = await _request("GET", "/auth/google/data-access/status")
    scopes = status.get("scopes") if isinstance(status.get("scopes"), list) else []
    scope_set = {str(scope).strip() for scope in scopes}
    datasource_email = _normalize_email(config.get("google_oauth_email"))
    status_email = _normalize_email(status.get("email"))

    if datasource_email and status_email and datasource_email != status_email:
        return {
            "ok": None,
            "blocking": False,
            "message": (
                "Skipped hard write-scope blocking because this PAT user's Google status "
                "does not match the datasource OAuth owner. The backend write endpoint "
                "will be the source of truth."
            ),
            "datasource_id": datasource_id,
            "datasource_google_oauth_email": config.get("google_oauth_email"),
            "pat_google_oauth_email": status.get("email"),
            "pat_current_scopes": scopes,
            "required_scope": SHEETS_WRITE_SCOPE,
        }

    if SHEETS_WRITE_SCOPE in scope_set:
        return {
            "ok": True,
            "blocking": False,
            "message": "Google Sheets write scope is present for this OAuth user.",
            "datasource_id": datasource_id,
            "google_oauth_email": status.get("email") or config.get("google_oauth_email"),
            "current_scopes": scopes,
            "required_scope": SHEETS_WRITE_SCOPE,
        }

    return {
        "ok": False,
        "blocking": True,
        "message": (
            "Google Sheets write scope is missing for the AppBI user behind this PAT. "
            "Reconnect Google data access from AppBI so the stored OAuth grant includes "
            f"{SHEETS_WRITE_SCOPE}."
        ),
        "datasource_id": datasource_id,
        "datasource_google_oauth_email": config.get("google_oauth_email"),
        "google_oauth_email": status.get("email"),
        "current_scopes": scopes,
        "required_scope": SHEETS_WRITE_SCOPE,
        "reconnect_url": "/api/v1/auth/google/data-access/start?return_to=/datasources&popup=false",
        "notes": [
            "Owning or creating the spreadsheet file is not enough for API writes.",
            "The backend must hold an OAuth refresh token that includes the write scope.",
        ],
    }


@mcp.tool()
async def get_google_data_access_status() -> Any:
    """Return Google OAuth data-access status for the AppBI user represented by APPBI_PAT."""
    return await _request("GET", "/auth/google/data-access/status")


@mcp.tool()
async def prepare_gsheet_tab_schema(
    business_columns: List[str],
    ensure_workboard_columns: bool = True,
) -> Any:
    """Normalize intended GSheets headers and return recommended workboard settings."""
    headers = _normalized_workboard_headers(
        business_columns,
        ensure_workboard_columns=ensure_workboard_columns,
    )
    recommendations = {
        "headers": headers,
        "workboard": {
            "primary_key_columns": ["id"] if "id" in headers else [],
            "optimistic_lock_column": "updated_at" if "updated_at" in headers else None,
            "system_columns": {
                "id": "Internal primary key. Keep it in the sheet, but do not expose it in user forms; runtime auto-generates it.",
                "updated_at": "Audit/optimistic-lock column. Keep it in the sheet, but let runtime set it on writes.",
            },
        },
        "layout_json": {
            "audit": {
                "updated_at_column": "updated_at" if "updated_at" in headers else None,
            }
        },
        "notes": [
            "Use simple snake_case headers for Google Sheets-backed workboards.",
            "Treat 'id' and 'updated_at' as system columns, not fields users type manually.",
            "Seed/admin row tools in this MCP bypass workboard RLS/validation; use them only for setup or repair.",
        ],
    }
    if headers and headers[0] == "id":
        recommendations["notes"].append(
            "The first column is 'id', which lets workboard updates and deletes target a stable row key."
        )
    return recommendations


@mcp.tool()
async def list_gsheet_tabs(datasource_id: int) -> Any:
    """List all sheet tabs in the connected Google Spreadsheet."""
    return await _request("GET", f"/datasources/{datasource_id}/gsheets/sheets")


@mcp.tool()
async def read_gsheet_rows(
    datasource_id: int,
    sheet_name: str,
    limit: int = 50,
) -> Any:
    """Read rows from a sheet tab for profiling or verification."""
    return await _request(
        "GET",
        f"/datasources/{datasource_id}/gsheets/{sheet_name}/rows",
        params={"limit": limit},
    )


@mcp.tool()
async def create_gsheet_tab(
    datasource_id: int,
    sheet_name: str,
    headers: List[str],
    ensure_workboard_columns: bool = True,
    user_confirmed: bool = False,
) -> Any:
    """Create a sheet tab with normalized headers suitable for workboard use."""
    normalized_headers = _normalized_workboard_headers(
        headers,
        ensure_workboard_columns=ensure_workboard_columns,
    )
    if not normalized_headers:
        return {"ok": False, "error": "headers must contain at least one non-empty column name"}

    plan = {
        "action": "create_gsheet_tab",
        "datasource_id": datasource_id,
        "sheet_name": sheet_name,
        "requested_headers": headers,
        "normalized_headers": normalized_headers,
        "ensure_workboard_columns": ensure_workboard_columns,
        "next_steps": [
            f"Call attach_gsheet_tab_to_dataset(dataset_id=..., datasource_id={datasource_id}, sheet_name='{sheet_name}')",
            "Call get_dataset_table_profile after attach to confirm columns loaded.",
        ],
        "recommended_workboard": {
            "primary_key_columns": ["id"] if "id" in normalized_headers else [],
            "optimistic_lock_column": "updated_at" if "updated_at" in normalized_headers else None,
            "system_columns_hidden_from_forms": [
                header for header in ("id", "updated_at") if header in normalized_headers
            ],
            "layout_audit": {
                "updated_at_column": "updated_at" if "updated_at" in normalized_headers else None,
            },
        },
    }
    scope_check = await _check_google_sheets_write_scope(datasource_id)
    plan["google_oauth_write_scope"] = scope_check
    if not user_confirmed:
        return _requires_confirmation(plan)
    if scope_check.get("blocking"):
        return scope_check

    return await _request(
        "POST",
        f"/datasources/{datasource_id}/gsheets/sheets",
        json_body={"sheet_name": sheet_name, "headers": normalized_headers},
    )


@mcp.tool()
async def append_gsheet_row(
    datasource_id: int,
    sheet_name: str,
    values: Dict[str, Any],
    user_confirmed: bool = False,
) -> Any:
    """Append a row directly to a Google Sheet tab.

    This is for setup, seeding, or repair. It does not go through workboard
    RLS, audit, or validation rules.
    """
    plan = {
        "action": "append_row",
        "datasource_id": datasource_id,
        "sheet_name": sheet_name,
        "values": values,
        "warning": "This bypasses workboard runtime validation and RLS.",
    }
    scope_check = await _check_google_sheets_write_scope(datasource_id)
    plan["google_oauth_write_scope"] = scope_check
    if not user_confirmed:
        return _requires_confirmation(plan)
    if scope_check.get("blocking"):
        return scope_check

    return await _request(
        "POST",
        f"/datasources/{datasource_id}/gsheets/{sheet_name}/rows",
        json_body={"values": values},
    )


@mcp.tool()
async def append_gsheet_rows_batch(
    datasource_id: int,
    sheet_name: str,
    rows: List[Dict[str, Any]],
    user_confirmed: bool = False,
) -> Any:
    """Append multiple rows to a Google Sheet tab in a single API call.

    Use this instead of calling append_gsheet_row repeatedly when seeding
    reference data (e.g. 30+ lookup rows). Reduces N round-trips to 1.

    ``rows`` is a list of dicts: [{col: value, ...}, ...].
    This bypasses workboard RLS, audit, and validation rules.
    """
    plan = {
        "action": "append_rows_batch",
        "datasource_id": datasource_id,
        "sheet_name": sheet_name,
        "row_count": len(rows),
        "preview_first_row": rows[0] if rows else None,
        "warning": "This bypasses workboard runtime validation and RLS.",
    }
    scope_check = await _check_google_sheets_write_scope(datasource_id)
    plan["google_oauth_write_scope"] = scope_check
    if not user_confirmed:
        return _requires_confirmation(plan)
    if scope_check.get("blocking"):
        return scope_check

    return await _request(
        "POST",
        f"/datasources/{datasource_id}/gsheets/{sheet_name}/rows/batch",
        json_body={"rows": rows},
    )


@mcp.tool()
async def import_csv_to_gsheet(
    datasource_id: int,
    sheet_name: str,
    csv_data: str,
    user_confirmed: bool = False,
) -> Any:
    """Replace an entire Google Sheet tab with CSV data in one API call.

    Use when you have a clean CSV (first row = headers) and want to overwrite
    the tab completely. Avoids row-by-row seeding entirely.

    ``csv_data`` is raw CSV text, e.g. "name,code\\nDept A,D01\\nDept B,D02"
    This bypasses workboard RLS, audit, and validation rules.
    """
    # Quick parse to show preview in confirmation plan
    lines = [line for line in csv_data.strip().splitlines() if line.strip()]
    plan = {
        "action": "import_csv_to_gsheet",
        "datasource_id": datasource_id,
        "sheet_name": sheet_name,
        "header_row": lines[0] if lines else None,
        "data_rows_count": max(0, len(lines) - 1),
        "warning": "This OVERWRITES the entire sheet tab. Existing data will be replaced.",
    }
    scope_check = await _check_google_sheets_write_scope(datasource_id)
    plan["google_oauth_write_scope"] = scope_check
    if not user_confirmed:
        return _requires_confirmation(plan)
    if scope_check.get("blocking"):
        return scope_check

    return await _request(
        "POST",
        f"/datasources/{datasource_id}/gsheets/{sheet_name}/import-csv",
        json_body={"csv_data": csv_data},
    )


@mcp.tool()
async def update_gsheet_row(
    datasource_id: int,
    sheet_name: str,
    pk: Dict[str, Any],
    values: Dict[str, Any],
    user_confirmed: bool = False,
) -> Any:
    """Update a row directly in a Google Sheet tab.

    This is for setup or repair and bypasses workboard runtime safeguards.
    """
    plan = {
        "action": "update_row",
        "datasource_id": datasource_id,
        "sheet_name": sheet_name,
        "pk": pk,
        "values": values,
        "warning": "This bypasses workboard runtime validation and RLS.",
    }
    scope_check = await _check_google_sheets_write_scope(datasource_id)
    plan["google_oauth_write_scope"] = scope_check
    if not user_confirmed:
        return _requires_confirmation(plan)
    if scope_check.get("blocking"):
        return scope_check

    return await _request(
        "PATCH",
        f"/datasources/{datasource_id}/gsheets/{sheet_name}/rows",
        json_body={"pk": pk, "values": values},
    )


@mcp.tool()
async def delete_gsheet_row(
    datasource_id: int,
    sheet_name: str,
    pk: Dict[str, Any],
    user_confirmed: bool = False,
) -> Any:
    """Delete a row directly from a Google Sheet tab.

    This is for setup or repair and bypasses workboard runtime safeguards.
    """
    plan = {
        "action": "delete_row",
        "datasource_id": datasource_id,
        "sheet_name": sheet_name,
        "pk": pk,
        "warning": "This bypasses workboard runtime validation and RLS.",
    }
    scope_check = await _check_google_sheets_write_scope(datasource_id)
    plan["google_oauth_write_scope"] = scope_check
    if not user_confirmed:
        return _requires_confirmation(plan)
    if scope_check.get("blocking"):
        return scope_check

    return await _request(
        "DELETE",
        f"/datasources/{datasource_id}/gsheets/{sheet_name}/rows",
        json_body={"pk": pk},
    )
