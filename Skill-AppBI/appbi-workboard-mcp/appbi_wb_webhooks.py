"""Webhook maintenance tools for doc screen sync triggers."""
from __future__ import annotations

from typing import Any

from appbi_wb_core import (
    Context,
    _clamp_int,
    _drop_none,
    _request,
    _requires_confirmation,
    tool,
)


def _require_webhook_shape(webhooks: list[dict[str, Any]]) -> None:
    ids: set[str] = set()
    for raw in webhooks:
        if not isinstance(raw, dict):
            raise ValueError("webhooks must be a list of objects.")
        missing = [
            field for field in ("id", "name", "url", "screen_id")
            if not str(raw.get(field) or "").strip()
        ]
        if missing:
            raise ValueError(f"Webhook is missing required fields {missing}: {raw}")
        webhook_id = str(raw["id"])
        if webhook_id in ids:
            raise ValueError(f"Duplicate webhook id '{webhook_id}'.")
        ids.add(webhook_id)


async def _replace_webhook_settings(
    workboard_id: int,
    webhooks: list[dict[str, Any]],
) -> dict[str, Any]:
    _require_webhook_shape(webhooks)
    workboard = await _request("GET", f"/workboards/{int(workboard_id)}")
    settings = dict(workboard.get("settings") or {}) if isinstance(workboard, dict) else {}
    settings["webhooks"] = webhooks
    result = await _request(
        "PATCH",
        f"/workboards/{int(workboard_id)}",
        json_body={"settings": settings},
    )
    return {
        "workboard": result,
        "webhooks": (result.get("settings") or {}).get("webhooks", [])
        if isinstance(result, dict) else webhooks,
    }


@tool({"design", "delivery"})
async def list_workboard_webhooks(
    workboard_id: int,
    screen_id: str | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """List webhook configs stored on a Workboard, optionally for one doc screen."""
    return {
        "items": await _request(
            "GET",
            f"/workboards/{int(workboard_id)}/webhooks",
            params={"screen_id": screen_id},
        )
    }


@tool("delivery")
async def replace_workboard_webhooks(
    workboard_id: int,
    webhooks: list[dict[str, Any]],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Replace all doc webhook configs while preserving explicit webhook ids.

    Use the bundle tool when a layout sync trigger changes too. This
    maintenance path writes `settings.webhooks` as one coherent set so
    doc `sync_triggers[].webhook_ids` can keep stable ids.
    """
    if not user_confirmed:
        return _requires_confirmation(
            "replace_workboard_webhooks",
            {
                "workboard_id": int(workboard_id),
                "webhook_count": len(webhooks),
                "webhooks": [
                    {
                        "id": row.get("id"),
                        "name": row.get("name"),
                        "screen_id": row.get("screen_id"),
                        "is_active": row.get("is_active", True),
                    }
                    for row in webhooks if isinstance(row, dict)
                ],
            },
        )
    return await _replace_webhook_settings(int(workboard_id), webhooks)


@tool("delivery")
async def test_workboard_webhook(
    workboard_id: int,
    webhook_id: str,
    sample_rows: int = 3,
    sample_columns: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """POST a small synthetic payload to one configured webhook."""
    if not user_confirmed:
        return _requires_confirmation(
            "test_workboard_webhook",
            {
                "workboard_id": int(workboard_id),
                "webhook_id": webhook_id,
                "sample_rows": _clamp_int(sample_rows, default=3, minimum=1, maximum=20),
                "sample_columns": sample_columns or ["col_a", "col_b"],
                "effect": "Sends one synthetic POST to the configured webhook URL.",
            },
        )
    return await _request(
        "POST",
        f"/workboards/{int(workboard_id)}/webhooks/{webhook_id}/test",
        json_body=_drop_none(
            {
                "sample_rows": _clamp_int(sample_rows, default=3, minimum=1, maximum=20),
                "sample_columns": sample_columns,
            }
        ),
    )


@tool({"design", "delivery"})
async def list_workboard_sync_runs(
    workboard_id: int,
    webhook_id: str | None = None,
    screen_id: str | None = None,
    status: str | None = None,
    limit: int = 20,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Read recent webhook sync run history for demo verification or debugging."""
    return {
        "items": await _request(
            "GET",
            f"/workboards/{int(workboard_id)}/sync-runs",
            params={
                "webhook_id": webhook_id,
                "screen_id": screen_id,
                "status": status,
                "limit": _clamp_int(limit, default=20, minimum=1, maximum=200),
            },
        )
    }


__all__: list[str] = ["_replace_webhook_settings"]
