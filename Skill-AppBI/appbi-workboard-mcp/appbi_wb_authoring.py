"""Stage 3 helpers — richer Workboard authoring + sharing.

Sits beside the bundle apply path: validate JS computed columns before saving,
audit access/coverage, export a portable bundle, and mint per-screen public
share links (the form/view URL a tester actually opens, distinct from a
workspace which is the full app behind app-user login).
"""
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


# ---------------------------------------------------------------------------
# Read / preview helpers
# ---------------------------------------------------------------------------


@tool({"build", "deliver"})
async def test_screen_js(
    workboard_id: int,
    screen_id: str,
    code: str,
    rows: list[dict[str, Any]] | None = None,
    index_offset: int = 0,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Sandbox-evaluate a table computed-column JS formula before saving it.

    `code` is the column body (e.g. "return Number(row.qty) * Number(row.price)").
    `rows` are sample row objects to run it against. Returns per-row results +
    any compile error. Read-only — the sandbox can't reach DB or network.
    """
    return await _request(
        "POST",
        f"/workboards/{int(workboard_id)}/screens/{screen_id}/test-js",
        json_body={"code": str(code), "rows": rows or [], "index_offset": int(index_offset)},
    )


@tool({"discover", "build", "deliver"})
async def get_workboard_access_audit(
    workboard_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Classify which dataset tables the mini-app exposes and how (read/write,
    per role). Use to confirm RLS + visibility before sharing."""
    return await _request("GET", f"/workboards/{int(workboard_id)}/access-audit")


@tool({"discover", "build", "deliver"})
async def export_workboard(
    workboard_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Export a portable Workboard bundle (layout + referenced table snapshots).
    Read-only; useful for backups, demos, or cross-instance migration."""
    return await _request("GET", f"/workboards/{int(workboard_id)}/export")


# ---------------------------------------------------------------------------
# Public links (per-screen share URLs)
# ---------------------------------------------------------------------------


@tool({"discover", "deliver"})
async def list_workboard_public_links(
    workboard_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List public share links for a Workboard (token, mode, screen, active)."""
    return {"items": await _request("GET", f"/workboards/{int(workboard_id)}/public-links")}


@tool("deliver")
async def create_workboard_public_link(
    workboard_id: int,
    name: str,
    mode: str = "form",
    view_id: str | None = None,
    password: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Mint a public share link for one screen. Creating it PUBLISHES the app.

    mode='form' exposes a public data-entry form; mode='view' exposes a
    read-only screen. `view_id` is the screen id to expose. Optional `password`
    gates access. Requires the owner PIN to have been rotated off the default
    first (else the backend returns 400).
    """
    if not user_confirmed:
        return _requires_confirmation(
            "create_workboard_public_link",
            {
                "workboard_id": int(workboard_id),
                "name": name,
                "mode": mode,
                "view_id": view_id,
                "password_protected": bool(password),
                "effect": "Publishes the workboard and creates a publicly reachable URL.",
            },
        )
    body = _drop_none(
        {"name": name, "mode": mode, "view_id": view_id, "password": password}
    )
    return await _request(
        "POST", f"/workboards/{int(workboard_id)}/public-links", json_body=body
    )


@tool("deliver")
async def update_workboard_public_link(
    workboard_id: int,
    link_id: str,
    name: str | None = None,
    mode: str | None = None,
    view_id: str | None = None,
    is_active: bool | None = None,
    password: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update a public link (rename, switch mode/screen, toggle active, set or
    clear password). password='' clears it; omit to leave unchanged."""
    body: dict[str, Any] = _drop_none(
        {"name": name, "mode": mode, "view_id": view_id, "is_active": is_active}
    )
    if password is not None:
        body["password"] = password
    if not user_confirmed:
        return _requires_confirmation(
            "update_workboard_public_link",
            {"workboard_id": int(workboard_id), "link_id": link_id, "changes": sorted(body.keys())},
        )
    return await _request(
        "PATCH",
        f"/workboards/{int(workboard_id)}/public-links/{link_id}",
        json_body=body,
    )


@tool("deliver")
async def delete_workboard_public_link(
    workboard_id: int,
    link_id: str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete a public share link. The URL stops working immediately."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_workboard_public_link",
            {"workboard_id": int(workboard_id), "link_id": link_id},
        )
    await _request(
        "DELETE",
        f"/workboards/{int(workboard_id)}/public-links/{link_id}",
        expect_json=False,
    )
    return {"status": "deleted", "workboard_id": int(workboard_id), "link_id": link_id}


__all__: list[str] = []
