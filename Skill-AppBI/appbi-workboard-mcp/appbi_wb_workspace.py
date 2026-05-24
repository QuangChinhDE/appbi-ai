"""Workspace delivery tools for Workboard mini-apps."""
from __future__ import annotations

from typing import Any

import httpx

from appbi_wb_core import (
    APPBI_API_BASE_URL,
    APPBI_TIMEOUT_SECONDS,
    APPBI_VERIFY_TLS,
    Context,
    _drop_none,
    _request,
    _requires_confirmation,
    tool,
)


def _workspace_patch(raw: dict[str, Any]) -> dict[str, Any]:
    return _drop_none(
        {
            "name": raw.get("name"),
            "description": raw.get("description"),
            "icon": raw.get("icon"),
            "is_active": raw.get("is_active"),
            "access_mode": raw.get("access_mode"),
            "branding": raw.get("branding"),
            "session_ttl_seconds": raw.get("session_ttl_seconds"),
        }
    )


def _menu_item(
    workboard: dict[str, Any],
    raw: dict[str, Any],
) -> dict[str, Any]:
    slug = str(workboard.get("slug") or "").strip()
    if not slug:
        raise ValueError("Workspace delivery requires the Workboard to have a slug.")
    item = dict(raw.get("menu_item") or {})
    return _drop_none(
        {
            "workboard_slug": slug,
            "label": item.get("label") or workboard.get("name") or slug,
            "description": item.get("description") or workboard.get("description"),
            "icon": item.get("icon") or workboard.get("icon"),
            "roles": item.get("roles") or [],
            "view_id": item.get("view_id"),
        }
    )


def _merge_menu(menu: list[Any], item: dict[str, Any]) -> list[dict[str, Any]]:
    rows = [dict(row) for row in menu if isinstance(row, dict)]
    slug = item["workboard_slug"]
    replaced = False
    for index, row in enumerate(rows):
        if str(row.get("workboard_slug") or "") == slug:
            rows[index] = item
            replaced = True
            break
    if not replaced:
        rows.append(item)
    return rows


async def _deliver_workspace(
    workboard: dict[str, Any],
    workspace: dict[str, Any],
) -> dict[str, Any]:
    """Create/update a workspace and upsert this Workboard into its menu."""
    workspace_id = workspace.get("id") or workspace.get("workspace_id")
    item = _menu_item(workboard, workspace)

    if workspace_id is None:
        name = str(workspace.get("name") or "").strip()
        if not name:
            raise ValueError("A new workspace needs `name`.")
        body = _drop_none(
            {
                "name": name,
                "slug": workspace.get("slug"),
                "description": workspace.get("description"),
                "icon": workspace.get("icon"),
                "access_mode": workspace.get("access_mode") or "public_app_users",
                "branding": workspace.get("branding"),
                "session_ttl_seconds": workspace.get("session_ttl_seconds"),
                "menu_config": [item],
            }
        )
        created = await _request("POST", "/workspaces", json_body=body)
        return {"action": "created", "workspace": created, "menu_item": item}

    current = await _request("GET", f"/workspaces/{int(workspace_id)}")
    patch = _workspace_patch(workspace)
    patch["menu_config"] = _merge_menu(current.get("menu_config") or [], item)
    updated = await _request(
        "PATCH",
        f"/workspaces/{int(workspace_id)}",
        json_body=patch,
    )
    return {"action": "updated", "workspace": updated, "menu_item": item}


@tool("delivery")
async def deliver_workboard_to_workspace(
    workboard_id: int,
    workspace: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create/update a workspace and link one Workboard into its menu."""
    workboard = await _request("GET", f"/workboards/{int(workboard_id)}")
    if not user_confirmed:
        return _requires_confirmation(
            "deliver_workboard_to_workspace",
            {
                "workboard_id": int(workboard_id),
                "workboard_slug": workboard.get("slug"),
                "workspace_id": workspace.get("id") or workspace.get("workspace_id"),
                "workspace_name": workspace.get("name"),
                "access_mode": workspace.get("access_mode") or "public_app_users",
            },
        )
    return await _deliver_workspace(workboard, workspace)


@tool("delivery")
async def create_workspace_preview_session(
    workspace_id: int,
    workboard_id: int,
    username: str | None = None,
    role: str | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Mint an admin preview session for one workspace Workboard."""
    return await _request(
        "POST",
        f"/workspaces/{int(workspace_id)}/preview-session",
        json_body=_drop_none(
            {
                "workboard_id": int(workboard_id),
                "username": username,
                "role": role,
            }
        ),
    )


@tool("delivery")
async def run_workboard_runtime_smoke_test(
    workspace_token: str,
    workboard_id: int,
    username: str,
    pin: str,
    screen_ids: list[str] | None = None,
    table_screen_id: str | None = None,
    form_screen_id: str | None = None,
    insert_values: dict[str, Any] | None = None,
    pk_columns: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Exercise public runtime through a real workspace app-user session.

    Read path: metadata, login, menu, app shell, optional screen renders,
    optional table rows. Passing `insert_values` also submits one form row
    and re-reads the table, so that branch requires confirmation.
    """
    if insert_values and not user_confirmed:
        return _requires_confirmation(
            "run_workboard_runtime_smoke_test",
            {
                "workspace_token": workspace_token,
                "workboard_id": int(workboard_id),
                "username": username,
                "screen_ids": screen_ids or [],
                "table_screen_id": table_screen_id,
                "form_screen_id": form_screen_id,
                "insert_values_preview": insert_values,
                "effect": "Submits one public form row before reading the table again.",
            },
        )
    if insert_values and (not form_screen_id or not table_screen_id):
        raise ValueError(
            "insert_values requires form_screen_id and table_screen_id for visibility check."
        )

    steps: list[dict[str, Any]] = []

    def add_step(
        name: str,
        ok: bool,
        status_code: int,
        data: Any,
    ) -> None:
        steps.append(
            {
                "step": name,
                "ok": ok,
                "status_code": status_code,
                "data": data,
            }
        )

    def response_summary(data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        rows = data.get("rows")
        blocks = data.get("blocks")
        return _drop_none(
            {
                "screen_id": data.get("screen_id"),
                "kind": data.get("kind"),
                "title": data.get("title"),
                "columns": data.get("columns"),
                "row_count": len(rows) if isinstance(rows, list) else None,
                "sample_rows": rows[:3] if isinstance(rows, list) else None,
                "block_count": len(blocks) if isinstance(blocks, list) else None,
                "keys": sorted(data.keys())[:20],
            }
        )

    async with httpx.AsyncClient(
        timeout=APPBI_TIMEOUT_SECONDS,
        verify=APPBI_VERIFY_TLS,
        follow_redirects=True,
    ) as client:
        async def call(method: str, path: str, **kwargs: Any) -> tuple[bool, int, Any]:
            response = await client.request(
                method,
                f"{APPBI_API_BASE_URL}{path}",
                **kwargs,
            )
            try:
                data = response.json()
            except ValueError:
                data = response.text[:500]
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
                "session_token_redacted": bool(data.get("session_token"))
                if isinstance(data, dict) else None,
            },
        )
        if not ok:
            return {"ok": False, "steps": steps}

        ok, status, data = await call("GET", f"/public/workspaces/{workspace_token}/menu")
        add_step("workspace_menu", ok, status, data)
        if not ok:
            return {"ok": False, "steps": steps}

        base_path = f"/public/workspaces/{workspace_token}/workboards/{int(workboard_id)}"
        ok, status, data = await call("GET", f"{base_path}/app")
        add_step("workboard_app", ok, status, response_summary(data))
        if not ok:
            return {"ok": False, "steps": steps}

        for screen_id in screen_ids or []:
            ok, status, data = await call("GET", f"{base_path}/screens/{screen_id}")
            add_step(f"screen:{screen_id}", ok, status, response_summary(data))
            if not ok:
                return {"ok": False, "steps": steps}

        before_rows: list[Any] = []
        if table_screen_id:
            ok, status, data = await call(
                "POST",
                f"{base_path}/screens/{table_screen_id}/table",
                json={"page": 1, "page_size": 20},
            )
            before_rows = data.get("rows") if isinstance(data, dict) else []
            add_step("table_before", ok, status, response_summary(data))
            if not ok:
                return {"ok": False, "steps": steps}

        insert_result = None
        inserted_visible = None
        after_rows = before_rows or []
        if insert_values:
            ok, status, insert_result = await call(
                "POST",
                f"{base_path}/screens/{form_screen_id}/rows",
                json={"values": insert_values},
            )
            add_step("form_insert", ok, status, insert_result)
            if not ok:
                return {"ok": False, "steps": steps}

            ok, status, after_table = await call(
                "POST",
                f"{base_path}/screens/{table_screen_id}/table",
                json={"page": 1, "page_size": 50},
            )
            after_rows = after_table.get("rows") if isinstance(after_table, dict) else []
            insert_pk = (
                insert_result.get("pk")
                if isinstance(insert_result, dict) and isinstance(insert_result.get("pk"), dict)
                else {}
            )
            effective_pk_columns = (
                pk_columns or list(insert_pk.keys()) or (["id"] if "id" in insert_values else [])
            )
            if effective_pk_columns:
                inserted_visible = any(
                    all(
                        str(row.get(column))
                        == str(insert_pk.get(column, insert_values.get(column)))
                        for column in effective_pk_columns
                    )
                    for row in after_rows or []
                    if isinstance(row, dict)
                )
            add_step(
                "table_after_insert",
                ok and inserted_visible is not False,
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


__all__: list[str] = ["_deliver_workspace"]
