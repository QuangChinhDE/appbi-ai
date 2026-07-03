"""Stage 0 — Source.

Discover the data sources already connected to AppBI, and (for the two
mini-app-friendly kinds) create new ones: Google Sheets and manual
file/paste. SQL-database sources (Postgres/MySQL/BigQuery) carry secret
credentials and stay in the AppBI UI — discover them here, create them there.

Discovery tools are read-only. Create tools preview a plan until
user_confirmed=true.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from appbi_wb_core import (
    BackendError,
    Context,
    _clamp_int,
    _drop_none,
    _multipart_request,
    _query_path,
    _request,
    _requires_confirmation,
    tool,
)


# ---------------------------------------------------------------------------
# Discovery (read-only)
# ---------------------------------------------------------------------------


@tool({"discover", "source", "dataset"})
async def list_data_sources(ctx: Context | None = None) -> dict[str, Any]:
    """List data sources visible to the PAT (id, name, type, status).

    Start here. Reuse a connected source when one matches before creating one.
    """
    return {"items": await _request("GET", "/datasources/")}


@tool({"discover", "source", "dataset"})
async def get_data_source(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Fetch one data source's details (type, status, non-secret config)."""
    return await _request("GET", f"/datasources/{int(data_source_id)}")


@tool({"source", "dataset"})
async def test_data_source_connection(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Test whether a data source connection is still live."""
    ds = await _request("GET", f"/datasources/{int(data_source_id)}")
    body = {
        "data_source_id": int(data_source_id),
        "type": ds.get("type") if isinstance(ds, dict) else None,
        "config": (ds.get("config") or {}) if isinstance(ds, dict) else {},
    }
    return await _request("POST", "/datasources/test", json_body=body)


@tool({"discover", "source", "dataset"})
async def inspect_source_schema(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Return a SQL source's schema tree: schemas -> tables/views.

    For a Google Sheets source use list_gsheet_tabs instead.
    """
    return await _request("GET", f"/datasources/{int(data_source_id)}/schema")


@tool({"source", "dataset"})
async def inspect_source_table(
    data_source_id: int,
    schema_name: str,
    table_name: str,
    preview_rows: int = 5,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """One source table: columns + types + PK/FK flags + N preview rows."""
    rows = _clamp_int(preview_rows, default=5, minimum=0, maximum=50)
    return await _request(
        "GET",
        f"/datasources/{int(data_source_id)}/tables/{schema_name}/{table_name}"
        f"?preview_rows={rows}",
    )


@tool({"discover", "source", "dataset"})
async def list_gsheet_tabs(
    data_source_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List the tabs (sheets) of a Google Sheets source.

    Each tab name is the `source_table_name` you pass to add_table_to_dataset
    (the tab name ONLY, never "<spreadsheet_id>.<tab>").
    """
    return await _request(
        "GET", f"/datasources/{int(data_source_id)}/gsheets/sheets"
    )


@tool({"discover", "source", "dataset"})
async def read_gsheet_rows(
    data_source_id: int,
    sheet_name: str,
    limit: int = 20,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Read the first `limit` rows of a Google Sheets tab (row 1 = header)."""
    return await _request(
        "GET",
        _query_path(
            f"/datasources/{int(data_source_id)}/gsheets/{sheet_name}/rows",
            {"limit": int(limit)},
        ),
    )


@tool({"source", "dataset"})
async def run_source_query(
    data_source_id: int,
    sql_query: str,
    limit: int = 100,
    timeout_seconds: int = 30,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Run an ad-hoc SELECT against a SQL source to verify data. SELECT-only;
    limit default 100, max 5000."""
    body = {
        "data_source_id": int(data_source_id),
        "sql_query": str(sql_query),
        "limit": _clamp_int(limit, default=100, minimum=1, maximum=5000),
        "timeout_seconds": _clamp_int(timeout_seconds, default=30, minimum=1, maximum=120),
    }
    return await _request("POST", "/datasources/query", json_body=body)


@tool({"source", "dataset"})
async def validate_source_sql(
    data_source_id: int, sql_query: str, ctx: Context | None = None
) -> dict[str, Any]:
    """Dry-run validate SQL against a source dialect. Returns {valid, error?}."""
    return await _request(
        "POST",
        "/datasources/validate-sql",
        json_body={"data_source_id": int(data_source_id), "sql_query": str(sql_query)},
    )


# ---------------------------------------------------------------------------
# Create — Google Sheets + manual only
# ---------------------------------------------------------------------------


_SPREADSHEET_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")


def _extract_spreadsheet_id(value: str) -> str:
    raw = str(value or "").strip()
    match = _SPREADSHEET_ID_RE.search(raw)
    return match.group(1) if match else raw


@tool("source")
async def get_source_setup_guide(ctx: Context | None = None) -> dict[str, Any]:
    """Explain how to create the two mini-app-friendly source kinds."""
    return {
        "creatable_kinds": ["google_sheets", "manual"],
        "google_sheets": {
            "tool": "create_google_sheets_source",
            "auth_mode": {
                "service_account": (
                    "Recommended. Run check_google_data_access() for the platform "
                    "service-account email, SHARE the spreadsheet with that email "
                    "(Viewer is enough for read, Editor if the mini-app writes back), "
                    "then create with auth_mode='service_account'."
                ),
                "google_oauth": (
                    "Use when no platform service account is configured. The PAT "
                    "owner must first connect their Google account in AppBI "
                    "(Settings -> Google data access). check_google_data_access() "
                    "reports whether that connection exists."
                ),
            },
            "needs": "spreadsheet id or full URL; optional sheet_name (defaults to first tab)",
        },
        "manual": {
            "from_file": "create_manual_source_from_file(local_path) for an .xlsx/.xls/.csv on disk",
            "from_data": "create_manual_source(name, columns, rows) for pasted/small data",
            "note": "Manual sources are editable inside AppBI and behave like a sheet.",
        },
        "not_creatable_here": {
            "kinds": ["postgresql", "mysql", "bigquery"],
            "why": "DB credentials are secret; connect these in the AppBI UI, then discover them with list_data_sources.",
        },
    }


@tool("source")
async def check_google_data_access(ctx: Context | None = None) -> dict[str, Any]:
    """Report Google access readiness before creating a Google Sheets source.

    Returns the platform service-account email (share the sheet with it) and
    whether the PAT owner has connected a personal Google account.
    """
    platform: Any = None
    oauth: Any = None
    try:
        platform = await _request("GET", "/datasources/platform-gcp-info")
    except BackendError as exc:
        platform = {"error": exc.detail, "status_code": exc.status_code}
    try:
        oauth = await _request("GET", "/auth/google/data-access/status")
    except BackendError as exc:
        oauth = {"error": exc.detail, "status_code": exc.status_code}

    sa_email = platform.get("service_account_email") if isinstance(platform, dict) else None
    oauth_connected = bool(oauth.get("connected")) if isinstance(oauth, dict) else False
    return {
        "platform_service_account": platform,
        "personal_google_oauth": oauth,
        "ready_service_account": bool(sa_email),
        "ready_google_oauth": oauth_connected,
        "claude_should": (
            f"Share the spreadsheet with {sa_email} then use auth_mode='service_account'."
            if sa_email
            else (
                "No platform service account. Use auth_mode='google_oauth' after the "
                "PAT owner connects Google in AppBI Settings -> Google data access."
                if not oauth_connected
                else "Use auth_mode='google_oauth' (personal Google account is connected)."
            )
        ),
    }


@tool("source")
async def create_google_sheets_source(
    name: str,
    spreadsheet: str,
    sheet_name: str | None = None,
    auth_mode: str = "service_account",
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a Google Sheets data source.

    `spreadsheet` accepts a full URL or a bare spreadsheet id.
    `auth_mode` ∈ service_account | google_oauth (see check_google_data_access).
    Backend validates the connection on create; fix sharing/OAuth if it 400s.
    """
    spreadsheet_id = _extract_spreadsheet_id(spreadsheet)
    config = _drop_none(
        {
            "auth_mode": auth_mode,
            "spreadsheet_id": spreadsheet_id,
            "sheet_name": sheet_name,
        }
    )
    if not user_confirmed:
        return _requires_confirmation(
            "create_google_sheets_source",
            {
                "name": name,
                "type": "google_sheets",
                "spreadsheet_id": spreadsheet_id,
                "sheet_name": sheet_name,
                "auth_mode": auth_mode,
                "reminder": (
                    "For service_account, the spreadsheet must already be shared "
                    "with the platform service-account email."
                ),
            },
        )
    body = _drop_none(
        {"name": name, "type": "google_sheets", "description": description, "config": config}
    )
    return await _request("POST", "/datasources/", json_body=body)


@tool("source")
async def create_manual_source(
    name: str,
    columns: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    table_name: str = "Sheet1",
    description: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a manual data source from in-memory columns + rows.

    `columns[i]`: {name, type?}; type ∈ string|number|date (default string).
    `rows[i]`: {column_name: value}. `table_name` becomes the source table name
    you pass to add_table_to_dataset. Use create_manual_source_from_file for a
    spreadsheet/CSV already on disk.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "create_manual_source",
            {
                "name": name,
                "type": "manual",
                "table_name": table_name,
                "column_count": len(columns or []),
                "row_count": len(rows or []),
                "columns": [c.get("name") for c in columns or [] if isinstance(c, dict)],
            },
        )
    # The sheets-shaped config is what the manual connector + schema introspect
    # expect; it lets columns_cache populate at add_table_to_dataset time.
    body = _drop_none(
        {
            "name": name,
            "type": "manual",
            "description": description,
            "config": {"sheets": {table_name: {"columns": columns or [], "rows": rows or []}}},
        }
    )
    return await _request("POST", "/datasources/", json_body=body)


@tool("source")
async def create_manual_source_from_file(
    local_path: str,
    name: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a manual data source by parsing a local .xlsx/.xls/.csv file.

    The file is parsed server-side; every sheet/tab becomes a table in the
    source. `name` defaults to the file name. The MCP reads `local_path` from
    the machine it runs on.
    """
    path = Path(os.path.expanduser(str(local_path))).resolve()
    if not path.is_file():
        return {
            "status": "invalid_input",
            "detail": f"File not found: {path}",
            "claude_should": "Ask the user for a valid local path to an .xlsx/.xls/.csv file.",
        }
    ext = path.suffix.lower()
    if ext not in {".xlsx", ".xls", ".csv"}:
        return {
            "status": "invalid_input",
            "detail": f"Unsupported file type '{ext}'. Allowed: .xlsx, .xls, .csv",
        }
    source_name = name or path.stem

    if not user_confirmed:
        size_kb = round(path.stat().st_size / 1024, 1)
        return _requires_confirmation(
            "create_manual_source_from_file",
            {
                "name": source_name,
                "type": "manual",
                "file": str(path),
                "file_size_kb": size_kb,
                "effect": "Parses the file server-side and stores its rows as a manual source.",
            },
        )

    content_type = "text/csv" if ext == ".csv" else (
        "application/vnd.ms-excel"
        if ext == ".xls"
        else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    with path.open("rb") as handle:
        parsed = await _multipart_request(
            "POST",
            "/datasources/manual/parse-file",
            files={"file": (path.name, handle.read(), content_type)},
        )
    sheets = parsed.get("sheets") if isinstance(parsed, dict) else None
    if not isinstance(sheets, dict) or not sheets:
        return {
            "status": "parse_empty",
            "detail": "The file parsed to zero sheets/rows.",
            "parsed": parsed,
        }
    body = {
        "name": source_name,
        "type": "manual",
        "description": f"Imported from {path.name}",
        "config": {"sheets": sheets},
    }
    created = await _request("POST", "/datasources/", json_body=body)
    return {
        "status": "created",
        "data_source": created,
        "parsed_sheets": {
            sheet: {
                "columns": [c.get("name") for c in (data.get("columns") or []) if isinstance(c, dict)],
                "row_count": len(data.get("rows") or []),
            }
            for sheet, data in sheets.items()
            if isinstance(data, dict)
        },
    }


__all__: list[str] = []
