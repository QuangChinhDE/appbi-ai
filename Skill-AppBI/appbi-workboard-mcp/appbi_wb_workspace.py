"""Stage 6 - Workspace management."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import httpx

from appbi_wb_core import APPBI_API_BASE_URL, APPBI_TIMEOUT, _request, _requires_confirmation, mcp


def _workspace_permission_error(exc: RuntimeError) -> dict | None:
    message = str(exc)
    if (
        "Requires 'full' permission on module 'settings'" not in message
        and "Requires 'full' permission on module 'workboards'" not in message
    ):
        return None
    required_scope = (
        {"settings": "full"}
        if "module 'settings'" in message
        else {"workboards": "full"}
    )
    return {
        "ok": False,
        "error": "Workspace admin action was blocked by AppBI permissions.",
        "backend_error": message,
        "required_pat_scope": required_scope,
        "notes": [
            "The AppBI user may have enough permissions, but a Personal Access Token can still be capped by its own scopes.",
            f"Create or update the PAT used by this MCP so its scopes include {required_scope}, then retry the workspace step.",
        ],
    }


@mcp.tool()
async def create_workspace(
    name: str,
    slug: str,
    description: Optional[str] = None,
    icon: Optional[str] = None,
    access_mode: str = "public_app_users",
    session_ttl_seconds: int = 28800,
    branding: Optional[Dict[str, Any]] = None,
    user_confirmed: bool = False,
) -> Any:
    """Create a workspace that hosts one or more workboards."""
    plan = {
        "action": "create_workspace",
        "name": name,
        "slug": slug,
        "access_mode": access_mode,
        "session_ttl_seconds": session_ttl_seconds,
        "branding": branding,
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    body: Dict[str, Any] = {
        "name": name,
        "slug": slug,
        "access_mode": access_mode,
        "session_ttl_seconds": session_ttl_seconds,
        "menu_config": [],
    }
    if description:
        body["description"] = description
    if icon:
        body["icon"] = icon
    if branding:
        body["branding"] = branding

    # Backend registers POST on /workspaces (no trailing slash). GET supports
    # both variants, but POST /workspaces/ returns 405.
    try:
        return await _request("POST", "/workspaces", json_body=body)
    except RuntimeError as exc:
        permission_error = _workspace_permission_error(exc)
        if permission_error:
            return permission_error
        raise


@mcp.tool()
async def link_workboard_to_workspace(
    workspace_id: int,
    workboard_slug: str,
    menu_label: str,
    menu_icon: Optional[str] = None,
    menu_description: Optional[str] = None,
    visible_for_roles: Optional[List[str]] = None,
    view_id: Optional[str] = None,
    user_confirmed: bool = False,
) -> Any:
    """Upsert a workboard entry inside a workspace menu_config."""
    workspace = await _request("GET", f"/workspaces/{workspace_id}")
    current_menu: list = workspace.get("menu_config") or []
    new_menu = [item for item in current_menu if item.get("workboard_slug") != workboard_slug]

    new_item: Dict[str, Any] = {
        "workboard_slug": workboard_slug,
        "label": menu_label,
        "icon": menu_icon or "LayoutDashboard",
        "roles": visible_for_roles or [],
    }
    if menu_description:
        new_item["description"] = menu_description
    if view_id:
        new_item["view_id"] = view_id
    new_menu.append(new_item)

    plan = {
        "action": "link_workboard_to_workspace",
        "workspace_id": workspace_id,
        "workspace_name": workspace.get("name"),
        "workboard_slug": workboard_slug,
        "new_menu_item": new_item,
        "full_menu_after": new_menu,
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    try:
        return await _request(
            "PATCH",
            f"/workspaces/{workspace_id}",
            json_body={"menu_config": new_menu},
        )
    except RuntimeError as exc:
        permission_error = _workspace_permission_error(exc)
        if permission_error:
            return permission_error
        raise


@mcp.tool()
async def preview_workboard(
    workspace_id: int,
    workboard_id: int,
    username: Optional[str] = None,
    role: Optional[str] = None,
) -> Any:
    """Start a preview session for a workboard in a workspace."""
    body: Dict[str, Any] = {"workboard_id": workboard_id}
    if username:
        body["username"] = username
    if role:
        body["role"] = role

    return await _request(
        "POST",
        f"/workspaces/{workspace_id}/preview-session",
        json_body=body,
    )


@mcp.tool()
async def run_workboard_runtime_smoke_test(
    workspace_token: str,
    workboard_id: int,
    username: str,
    pin: str,
    list_screen_id: str,
    form_screen_id: Optional[str] = None,
    insert_values: Optional[Dict[str, Any]] = None,
    pk_columns: Optional[List[str]] = None,
    user_confirmed: bool = False,
) -> Any:
    """Test the public mini-app runtime as a real app user.

    This logs in through the public workspace flow, checks menu/app/list
    rendering, optionally submits one form row, and reads the list again.
    Passing ``insert_values`` writes to the backing table, so it requires
    ``user_confirmed=True``.
    """
    plan = {
        "action": "run_workboard_runtime_smoke_test",
        "workspace_token": workspace_token,
        "workboard_id": workboard_id,
        "username": username,
        "list_screen_id": list_screen_id,
        "form_screen_id": form_screen_id,
        "will_insert_test_row": bool(insert_values),
        "insert_values_preview": insert_values,
        "checks": [
            "GET public workspace metadata",
            "POST public workspace login with app-user credentials",
            "GET authenticated workspace menu",
            "GET mini-app screen catalogue",
            "POST list screen rows",
            "Optional: POST form screen row and list again",
        ],
    }
    if insert_values and not user_confirmed:
        return _requires_confirmation(plan)

    steps: List[Dict[str, Any]] = []

    def add_step(name: str, ok: bool, status_code: Optional[int] = None, data: Any = None) -> None:
        steps.append(
            {
                "step": name,
                "ok": ok,
                "status_code": status_code,
                "data": data,
            }
        )

    async with httpx.AsyncClient(timeout=APPBI_TIMEOUT, verify=False) as client:
        async def call(method: str, path: str, **kwargs: Any) -> tuple[bool, int, Any]:
            response = await client.request(method, f"{APPBI_API_BASE_URL}{path}", **kwargs)
            try:
                data = response.json()
            except Exception:
                data = response.text
            return response.status_code < 400, response.status_code, data

        ok, status, data = await call("GET", f"/public/workspaces/{workspace_token}")
        add_step("workspace_meta", ok, status, data)
        if not ok:
            return {"ok": False, "steps": steps}

        ok, status, data = await call(
            "POST",
            f"/public/workspaces/{workspace_token}/login",
            json={"username": username, "pin": pin},
        )
        add_step(
            "workspace_login",
            ok,
            status,
            {
                "expires_in": data.get("expires_in") if isinstance(data, dict) else None,
                "app_user": data.get("app_user") if isinstance(data, dict) else None,
            },
        )
        if not ok:
            return {"ok": False, "steps": steps}

        ok, status, data = await call("GET", f"/public/workspaces/{workspace_token}/menu")
        add_step("workspace_menu", ok, status, data)
        if not ok:
            return {"ok": False, "steps": steps}

        ok, status, data = await call(
            "GET",
            f"/public/workspaces/{workspace_token}/workboards/{workboard_id}/app",
        )
        add_step("workboard_app", ok, status, data)
        if not ok:
            return {"ok": False, "steps": steps}

        ok, status, before_list = await call(
            "POST",
            f"/public/workspaces/{workspace_token}/workboards/{workboard_id}/screens/{list_screen_id}/list",
            json={"page": 1, "page_size": 20},
        )
        before_rows = before_list.get("rows") if isinstance(before_list, dict) else []
        add_step(
            "list_before",
            ok,
            status,
            {
                "columns": before_list.get("columns") if isinstance(before_list, dict) else None,
                "row_count": len(before_rows or []),
                "sample_rows": (before_rows or [])[:3],
            },
        )
        if not ok:
            return {"ok": False, "steps": steps}

        insert_result = None
        inserted_visible = None
        after_rows = before_rows or []
        if insert_values:
            if not form_screen_id:
                return {
                    "ok": False,
                    "steps": steps,
                    "error": "form_screen_id is required when insert_values is provided.",
                }
            ok, status, insert_result = await call(
                "POST",
                f"/public/workspaces/{workspace_token}/workboards/{workboard_id}/screens/{form_screen_id}/rows",
                json={"values": insert_values},
            )
            add_step("form_insert", ok, status, insert_result)
            if not ok:
                return {"ok": False, "steps": steps}

            ok, status, after_list = await call(
                "POST",
                f"/public/workspaces/{workspace_token}/workboards/{workboard_id}/screens/{list_screen_id}/list",
                json={"page": 1, "page_size": 50},
            )
            after_rows = after_list.get("rows") if isinstance(after_list, dict) else []
            insert_pk = (
                insert_result.get("pk")
                if isinstance(insert_result, dict) and isinstance(insert_result.get("pk"), dict)
                else {}
            )
            effective_pk_columns = pk_columns or list(insert_pk.keys()) or (["id"] if "id" in insert_values else [])
            if effective_pk_columns:
                inserted_visible = any(
                    all(
                        str(row.get(col)) == str(insert_pk.get(col, insert_values.get(col)))
                        for col in effective_pk_columns
                    )
                    for row in (after_rows or [])
                    if isinstance(row, dict)
                )
            add_step(
                "list_after_insert",
                ok and (inserted_visible is not False),
                status,
                {
                    "row_count": len(after_rows or []),
                    "inserted_visible": inserted_visible,
                    "sample_rows": (after_rows or [])[:5],
                },
            )
            if not ok or inserted_visible is False:
                return {"ok": False, "steps": steps}

    return {
        "ok": True,
        "readable": True,
        "writable": bool(insert_values),
        "row_count_before": len(before_rows or []),
        "row_count_after": len(after_rows or []),
        "inserted_visible": inserted_visible,
        "insert_result": insert_result,
        "steps": steps,
    }
