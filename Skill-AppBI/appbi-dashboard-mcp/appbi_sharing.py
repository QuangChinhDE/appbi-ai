"""Cross-resource sharing.

Backed by `/api/v1/shares/{resource_type}/{resource_id}`. Supported resource
types: dataset, datasource, chart, dashboard, dataset_model, workboard,
chat_session.

For dashboards, sharing cascades to the underlying charts and datasets so
the recipient can actually render the dashboard.
"""
from __future__ import annotations

from typing import Any

from appbi_core import (
    Context,
    _confirmation_required_for_destructive,
    _drop_none,
    _request,
    _requires_confirmation,
    tool,
)


_VALID_RESOURCE_TYPES = {
    "dataset",
    "datasource",
    "chart",
    "dashboard",
    "dataset_model",
    "workboard",
    "chat_session",
}


def _normalize_resource_type(resource_type: str) -> str:
    norm = str(resource_type).strip().lower()
    if norm not in _VALID_RESOURCE_TYPES:
        raise ValueError(
            f"resource_type must be one of {sorted(_VALID_RESOURCE_TYPES)}, "
            f"got '{resource_type}'."
        )
    return norm


@tool({"all", "admin"})
async def list_resource_shares(
    resource_type: str,
    resource_id: str,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List who has access to a resource.

    `resource_type` ∈ {dataset, datasource, chart, dashboard,
    dataset_model, workboard, chat_session}. Only the owner / admin can
    see the list.
    """
    rt = _normalize_resource_type(resource_type)
    items = await _request("GET", f"/shares/{rt}/{resource_id}")
    return {"items": items}


@tool({"all", "admin"})
async def share_resource(
    resource_type: str,
    resource_id: str,
    permission: str,
    user_id: str | None = None,
    email: str | None = None,
    team_id: str | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Grant access to a user or team.

    Provide ONE target: `user_id`, `email`, or `team_id`. `permission` ∈
    {view, edit, full}. Sharing a dashboard cascades to its charts and
    underlying datasets so the recipient sees real data.
    """
    rt = _normalize_resource_type(resource_type)
    if not (user_id or email or team_id):
        raise ValueError("Provide user_id, email, or team_id.")
    if not user_confirmed:
        return _requires_confirmation(
            "share_resource",
            {
                "resource_type": rt,
                "resource_id": resource_id,
                "permission": permission,
                "target": _drop_none(
                    {"user_id": user_id, "email": email, "team_id": team_id}
                ),
                "cascade_warning": (
                    "Sharing a dashboard cascades to its charts + datasets."
                    if rt == "dashboard"
                    else None
                ),
            },
        )
    body = _drop_none(
        {
            "user_id": user_id,
            "email": email,
            "team_id": team_id,
            "permission": permission,
        }
    )
    return await _request(
        "POST", f"/shares/{rt}/{resource_id}", json_body=body
    )


@tool({"all", "admin"})
async def update_share_entry(
    resource_type: str,
    resource_id: str,
    share_id: int,
    permission: str,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Update permission level on an existing share entry."""
    rt = _normalize_resource_type(resource_type)
    if not user_confirmed:
        return _requires_confirmation(
            "update_share_entry",
            {
                "resource_type": rt,
                "resource_id": resource_id,
                "share_id": int(share_id),
                "new_permission": permission,
            },
        )
    return await _request(
        "PUT",
        f"/shares/{rt}/{resource_id}/entries/{int(share_id)}",
        json_body={"permission": permission},
    )


@tool({"all", "admin"})
async def revoke_share_entry(
    resource_type: str,
    resource_id: str,
    share_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Revoke an existing share by its entry id."""
    rt = _normalize_resource_type(resource_type)
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "revoke_share_entry",
            {
                "resource_type": rt,
                "resource_id": resource_id,
                "share_id": int(share_id),
            },
            reversible=False,
        )
    await _request(
        "DELETE",
        f"/shares/{rt}/{resource_id}/entries/{int(share_id)}",
        expect_json=False,
    )
    return {"status": "revoked", "share_id": int(share_id)}


__all__: list[str] = []
