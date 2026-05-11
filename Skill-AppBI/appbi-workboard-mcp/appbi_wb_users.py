"""Stage 5 - App user management."""
from __future__ import annotations

from typing import Any, Dict, List

from appbi_wb_core import _request, _requires_confirmation, mcp


@mcp.tool()
async def create_app_users_batch(
    workboard_id: int,
    users: List[Dict[str, Any]],
    user_confirmed: bool = False,
) -> Any:
    """Create multiple app users for a workboard in one call."""
    if not users:
        return {"ok": False, "message": "users list is empty"}

    errors: List[str] = []
    usernames_seen: set[str] = set()
    for index, user in enumerate(users):
        username = str(user.get("username") or "").strip()
        pin = str(user.get("pin") or "").strip()
        full_name = str(user.get("full_name") or "").strip()
        role = str(user.get("role") or "").strip()

        if not username:
            errors.append(f"users[{index}] missing username")
        elif username in usernames_seen:
            errors.append(f"users[{index}] duplicate username '{username}' in the same batch")
        else:
            usernames_seen.add(username)
        if not pin:
            errors.append(f"users[{index}] missing pin")
        elif len(pin) < 4:
            errors.append(f"users[{index}] pin must be at least 4 characters")
        if not full_name:
            errors.append(f"users[{index}] missing full_name")
        if not role:
            errors.append(f"users[{index}] missing role")

    if errors:
        return {"ok": False, "validation_errors": errors}

    plan = {
        "action": "create_app_users_batch",
        "workboard_id": workboard_id,
        "user_count": len(users),
        "users_preview": [
            {
                "username": str(user["username"]).strip(),
                "full_name": str(user["full_name"]).strip(),
                "role": str(user["role"]).strip(),
                "pin": "****",
            }
            for user in users
        ],
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    created: List[Dict[str, Any]] = []
    errors_out: List[Dict[str, Any]] = []
    for user in users:
        body = {
            "username": str(user["username"]).strip(),
            "pin": str(user["pin"]).strip(),
            "full_name": str(user["full_name"]).strip(),
            "role": str(user["role"]).strip(),
            "active": bool(user.get("active", True)),
            "context": user.get("context") or {},
        }
        try:
            result = await _request("POST", f"/workboards/{workboard_id}/app-users", json_body=body)
            created.append({"ok": True, "username": body["username"], "id": result.get("id")})
        except RuntimeError as exc:
            errors_out.append({"ok": False, "username": body["username"], "error": str(exc)})

    return {
        "ok": len(errors_out) == 0,
        "created": created,
        "errors": errors_out,
        "total_created": len(created),
        "total_errors": len(errors_out),
    }


@mcp.tool()
async def update_app_user(
    workboard_id: int,
    app_user_id: int,
    updates: Dict[str, Any],
    user_confirmed: bool = False,
) -> Any:
    """Update an existing app user.

    Supported fields: username, pin, full_name, role, active, context.
    """
    plan = {
        "action": "update_app_user",
        "workboard_id": workboard_id,
        "app_user_id": app_user_id,
        "fields_to_update": {
            key: "****" if key == "pin" else value for key, value in updates.items()
        },
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    return await _request(
        "PATCH",
        f"/workboards/{workboard_id}/app-users/{app_user_id}",
        json_body=updates,
    )


@mcp.tool()
async def delete_app_user(
    workboard_id: int,
    app_user_id: int,
    user_confirmed: bool = False,
) -> Any:
    """Delete an app user from a workboard."""
    plan = {
        "action": "delete_app_user",
        "workboard_id": workboard_id,
        "app_user_id": app_user_id,
    }
    if not user_confirmed:
        return _requires_confirmation(plan)

    return await _request("DELETE", f"/workboards/{workboard_id}/app-users/{app_user_id}")
