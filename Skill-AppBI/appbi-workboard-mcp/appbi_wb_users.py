"""App-user maintenance tools for Workboard mini-app delivery."""
from __future__ import annotations

from typing import Any

from appbi_wb_core import (
    Context,
    _confirmation_required_for_destructive,
    _drop_none,
    _request,
    _requires_confirmation,
    tool,
)


def _user_patch_payload(user: dict[str, Any], *, creating: bool) -> dict[str, Any]:
    payload = _drop_none(
        {
            "username": user.get("username"),
            "pin": user.get("pin"),
            "full_name": user.get("full_name"),
            "role": user.get("role"),
            "active": user.get("active"),
            "context": user.get("context"),
        }
    )
    username = str(payload.get("username") or "").strip()
    if not username:
        raise ValueError("Every app user needs a non-empty username.")
    payload["username"] = username
    if creating and not str(payload.get("pin") or "").strip():
        raise ValueError(f"New app user '{username}' needs a PIN.")
    return payload


async def _upsert_app_users(
    workboard_id: int,
    users: list[dict[str, Any]],
) -> dict[str, Any]:
    """Create or patch app users by username without deleting other users."""
    existing_rows = await _request("GET", f"/workboards/{int(workboard_id)}/app-users")
    by_username = {
        str(row.get("username") or ""): row
        for row in existing_rows if isinstance(row, dict)
    }
    created: list[dict[str, Any]] = []
    updated: list[dict[str, Any]] = []

    for raw in users:
        if not isinstance(raw, dict):
            raise ValueError("app_users must be a list of objects.")
        username = str(raw.get("username") or "").strip()
        existing = by_username.get(username)
        body = _user_patch_payload(raw, creating=existing is None)
        if existing is None:
            result = await _request(
                "POST",
                f"/workboards/{int(workboard_id)}/app-users",
                json_body=body,
            )
            created.append(result)
            if isinstance(result, dict):
                by_username[str(result.get("username") or username)] = result
            continue

        result = await _request(
            "PATCH",
            f"/workboards/{int(workboard_id)}/app-users/{int(existing['id'])}",
            json_body=body,
        )
        updated.append(result)

    return {
        "workboard_id": int(workboard_id),
        "created": created,
        "updated": updated,
        "created_count": len(created),
        "updated_count": len(updated),
    }


@tool({"design", "delivery"})
async def list_workboard_app_users(
    workboard_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List app users for one Workboard. PIN hashes never leave the backend."""
    return {
        "items": await _request("GET", f"/workboards/{int(workboard_id)}/app-users")
    }


@tool("delivery")
async def upsert_workboard_app_users(
    workboard_id: int,
    users: list[dict[str, Any]],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create or patch multiple Workboard app users by username.

    This tool never deletes users. New users need `username` and `pin`.
    Existing users can omit `pin` to keep their credential unchanged.
    Common demo roles are `owner`, `admin`, `user`; inactive users are
    represented by `active=false`.
    """
    preview = [
        {
            "username": user.get("username"),
            "role": user.get("role"),
            "active": user.get("active", True),
            "pin_will_change": bool(user.get("pin")),
        }
        for user in users if isinstance(user, dict)
    ]
    if not user_confirmed:
        return _requires_confirmation(
            "upsert_workboard_app_users",
            {"workboard_id": int(workboard_id), "users": preview},
        )
    return await _upsert_app_users(int(workboard_id), users)


@tool("all")
async def delete_workboard_app_user(
    workboard_id: int,
    app_user_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete one Workboard app user by app_user_id."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_workboard_app_user",
            {"workboard_id": int(workboard_id), "app_user_id": int(app_user_id)},
        )
    await _request(
        "DELETE",
        f"/workboards/{int(workboard_id)}/app-users/{int(app_user_id)}",
        expect_json=False,
    )
    return {
        "status": "deleted",
        "workboard_id": int(workboard_id),
        "app_user_id": int(app_user_id),
    }


__all__: list[str] = ["_upsert_app_users"]
