"""Core infrastructure for the AppBI Workboard MCP.

Shared HTTP client, environment loading, confirmation helper, and the
FastMCP instance that all stage modules register tools onto.

Design rules:
- Claude is the only LLM. Never call any AppBI endpoint that triggers
  backend AI inference.
- Every write tool exposes user_confirmed: bool = False. When False,
  return a plain-language plan and write nothing.
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP


def _runtime_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


ROOT = _runtime_root()
load_dotenv(Path(os.getenv("APPBI_ENV_FILE") or (ROOT / ".env")))


def _normalize_api_base_url(raw: str) -> str:
    base = str(raw or "").strip().rstrip("/")
    if not base:
        raise RuntimeError("APPBI_BASE_URL is required (for example http://localhost:8000)")
    if base.endswith("/api/v1"):
        return base
    return f"{base}/api/v1"


def _read_required_pat() -> str:
    token = str(os.getenv("APPBI_PAT") or "").strip()
    if not token:
        raise RuntimeError("APPBI_PAT is required")
    if "replace_me" in token.lower() or token.lower() == "your_token_here":
        raise RuntimeError("APPBI_PAT still contains a placeholder value")
    return token


APPBI_API_BASE_URL = _normalize_api_base_url(os.getenv("APPBI_BASE_URL", ""))
APPBI_PAT = _read_required_pat()
APPBI_TIMEOUT = float(os.getenv("APPBI_TIMEOUT_SECONDS", "60"))


logging.basicConfig(
    level=os.getenv("APPBI_MCP_LOG_LEVEL", "INFO").upper(),
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("appbi_workboard_mcp")


_MCP_INSTRUCTIONS = """
You are the AppBI Workboard Builder. Help the user go from raw tables to a
working mini-app with forms, list views, app users, and workspace links.

## Canonical workflow - SQL source

  Stage 1 - Discovery (read only)
    list_datasets
    list_workboards
    get_dataset
    list_dataset_tables
    get_dataset_table_profile
    list_data_sources
    list_datasource_tables
    inspect_source_schema
    inspect_source_table

  Stage 2 - Dataset setup
    create_dataset
    add_physical_table(dataset_id, table_name, datasource_id, schema_name?)

  Stage 3 - Blueprint design
    propose_workboard_blueprint(dataset_id, business_intent, table_profiles)

  Stage 4 - Create or update
    commit_workboard_blueprint(blueprint_json, user_confirmed=true)
    update_workboard_blueprint(workboard_id, blueprint_json, user_confirmed=true)

  Stage 5 - App users
    create_app_users_batch(workboard_id, users, user_confirmed=true)

  Stage 6 - Workspace
    create_workspace
    link_workboard_to_workspace
    preview_workboard
    run_workboard_runtime_smoke_test
    Requires the MCP PAT scope workboards=full for create/link.

## Canonical workflow - Google Sheets source

  Stage 1 - Discovery
    list_data_sources
    get_google_data_access_status
    list_gsheet_tabs
    read_gsheet_rows

  Stage 1b - Sheet design
    prepare_gsheet_tab_schema(business_columns)
    create_gsheet_tab(datasource_id, sheet_name, headers, user_confirmed=true)

  Stage 2 - Attach to dataset
    create_dataset
    attach_gsheet_tab_to_dataset(dataset_id, datasource_id, sheet_name, user_confirmed=true)
    get_dataset_table_profile

  Stage 3 - Blueprint design
    propose_workboard_blueprint
    For Google Sheets, keep a stable id column and use updated_at for optimistic locking.

  Stage 4 - Create or update
    commit_workboard_blueprint
    update_workboard_blueprint

## Important schema rules

1. Profile tables before proposing a blueprint.
2. row_actions must be ScreenAction objects, never strings.
3. mini_app_nav must not contain a "default" key.
4. Screen/table ids must refer to dataset_tables.id values already attached to the dataset.
5. visible_for_roles and screen RLS role strings must match the app user roles you plan to create.
6. For Google Sheets, id and optimistic_lock_column are system columns. Keep them in the sheet, but do not expose them as user-editable form fields.
7. Google Sheets writes require OAuth scope https://www.googleapis.com/auth/spreadsheets; spreadsheet ownership does not replace OAuth write scope.
8. Raw GSheets row tools are for setup/repair only; they bypass workboard runtime validation and RLS.

## Confirmation model

Every write tool supports preview-then-confirm:
  - user_confirmed=false -> return a plan only
  - user_confirmed=true  -> execute the write
"""

mcp = FastMCP(
    name="AppBI Workboard Builder",
    instructions=_MCP_INSTRUCTIONS,
)


async def _request(
    method: str,
    path: str,
    json_body: dict | None = None,
    params: dict | None = None,
) -> Any:
    url = f"{APPBI_API_BASE_URL}{path}"
    headers = {
        "Authorization": f"Bearer {APPBI_PAT}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    async with httpx.AsyncClient(timeout=APPBI_TIMEOUT, verify=False) as client:
        response = await client.request(
            method=method.upper(),
            url=url,
            headers=headers,
            json=json_body,
            params=params,
        )
    if response.status_code >= 400:
        try:
            detail = response.json()
        except Exception:
            detail = response.text
        raise RuntimeError(f"AppBI API {method} {path} -> {response.status_code}: {detail}")
    if response.status_code == 204 or not response.content:
        return {"ok": True}
    return response.json()


def _requires_confirmation(plan: dict) -> dict:
    return {
        "requires_confirmation": True,
        "message": "Review the plan above. Call again with user_confirmed=True to execute.",
        "plan": plan,
    }


def _clamp_int(val: int, default: int, minimum: int, maximum: int) -> int:
    if val is None:
        return default
    return max(minimum, min(maximum, int(val)))
