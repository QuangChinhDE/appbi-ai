"""Data quality rules.

Claude authors rules locally based on its understanding of the data
(via `get_table_profile` and friends). The legacy `ai_suggest_quality_rule`
endpoint that delegated suggestions to backend LLMs is intentionally NOT
exposed here.
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


@tool("all")
async def list_quality_rules(
    dataset_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """List all quality rules attached to a dataset."""
    items = await _request(
        "GET", f"/datasets/{int(dataset_id)}/quality/rules"
    )
    return {"items": items}


@tool("all")
async def get_quality_summary(
    dataset_id: int, ctx: Context | None = None
) -> dict[str, Any]:
    """Get the latest quality summary (overall score + per-dimension stats)."""
    return await _request(
        "GET", f"/datasets/{int(dataset_id)}/quality/summary"
    )


@tool("all")
async def create_quality_rule(
    dataset_id: int,
    table_id: int,
    rule_type: str,
    dimension: str,
    name: str,
    column_name: str | None = None,
    config: dict[str, Any] | None = None,
    severity: str = "warning",
    enabled: bool = True,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create a quality rule that Claude designed locally.

    `dimension` ∈ {completeness, validity, uniqueness, consistency,
    timeliness, accuracy}. `rule_type` is a string code within the
    dimension (e.g. 'not_null', 'accepted_values', 'unique'). `config`
    is rule-type-specific (for 'accepted_values': {"values": [...]} ).

    `severity` ∈ {info, warning, error}. Use `error` only when the
    business has flagged the check as a hard requirement.
    """
    body = {
        "table_id": int(table_id),
        "column_name": column_name,
        "dimension": dimension,
        "rule_type": rule_type,
        "name": name,
        "config": config or {},
        "severity": severity,
        "enabled": bool(enabled),
    }
    if not user_confirmed:
        return _requires_confirmation(
            "create_quality_rule",
            {
                "dataset_id": int(dataset_id),
                "table_id": int(table_id),
                "rule": {
                    "name": name,
                    "dimension": dimension,
                    "rule_type": rule_type,
                    "column": column_name or "(table-level)",
                    "severity": severity,
                },
            },
        )
    return await _request(
        "POST",
        f"/datasets/{int(dataset_id)}/quality/rules",
        json_body=body,
    )


@tool("all")
async def create_quality_rules_bulk(
    dataset_id: int,
    rules: list[dict[str, Any]],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Create many quality rules atomically (rolls back on any failure).

    Each item: {table_id, rule_type, dimension, name, column_name?,
    config?, severity?, enabled?}.
    """
    if not user_confirmed:
        by_table: dict[int, int] = {}
        for r in rules:
            by_table[int(r.get("table_id", 0))] = (
                by_table.get(int(r.get("table_id", 0)), 0) + 1
            )
        return _requires_confirmation(
            "create_quality_rules_bulk",
            {
                "dataset_id": int(dataset_id),
                "total_rules": len(rules),
                "rules_per_table": by_table,
                "preview": [
                    {
                        "name": r.get("name"),
                        "dimension": r.get("dimension"),
                        "rule_type": r.get("rule_type"),
                    }
                    for r in rules[:10]
                ],
            },
        )
    return await _request(
        "POST",
        f"/datasets/{int(dataset_id)}/quality/rules/bulk",
        json_body={"rules": rules},
    )


@tool("all")
async def update_quality_rule(
    dataset_id: int,
    rule_id: int,
    patch: dict[str, Any],
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Patch a quality rule. Send only the fields you want to change."""
    if not user_confirmed:
        return _requires_confirmation(
            "update_quality_rule",
            {
                "dataset_id": int(dataset_id),
                "rule_id": int(rule_id),
                "fields": sorted(patch.keys()),
            },
        )
    return await _request(
        "PUT",
        f"/datasets/{int(dataset_id)}/quality/rules/{int(rule_id)}",
        json_body=patch,
    )


@tool("all")
async def delete_quality_rule(
    dataset_id: int,
    rule_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Delete a quality rule."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "delete_quality_rule",
            {"dataset_id": int(dataset_id), "rule_id": int(rule_id)},
            reversible=False,
        )
    await _request(
        "DELETE",
        f"/datasets/{int(dataset_id)}/quality/rules/{int(rule_id)}",
        expect_json=False,
    )
    return {"status": "deleted", "rule_id": int(rule_id)}


@tool("all")
async def trigger_quality_run(
    dataset_id: int,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Run all enabled quality rules in the background; returns run_id."""
    if not user_confirmed:
        return _requires_confirmation(
            "trigger_quality_run",
            {
                "dataset_id": int(dataset_id),
                "note": "Runs every enabled rule. May take seconds to minutes.",
            },
        )
    return await _request(
        "POST", f"/datasets/{int(dataset_id)}/quality/runs"
    )


@tool("all")
async def list_quality_runs(
    dataset_id: int, limit: int = 20, ctx: Context | None = None
) -> dict[str, Any]:
    """List recent quality run history."""
    items = await _request(
        "GET",
        f"/datasets/{int(dataset_id)}/quality/runs?limit={int(limit)}",
    )
    return {"items": items}


@tool("all")
async def get_quality_run(
    dataset_id: int,
    run_id: int,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Poll a single quality run for results."""
    return await _request(
        "GET",
        f"/datasets/{int(dataset_id)}/quality/runs/{int(run_id)}",
    )


__all__: list[str] = []
