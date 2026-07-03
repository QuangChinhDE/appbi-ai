"""Stage 2 — Data Model (relationships).

A Workboard needs a relationship model, not a full BI semantic layer: joins
power cross-table lookups in forms/tables, scope RLS, and feed any embedded
dashboard screen. Start with the heuristic generator, then refine the joins.
suggest_workboard_relationships returns the lookup-shaped join hints the
mini-app builder consumes directly.

Measures/explores (the chart-facing semantic layer) live in the dashboard MCP;
this module deliberately stops at tables + relationships.
"""
from __future__ import annotations

from typing import Any

from appbi_wb_core import (
    Context,
    _confirmation_required_for_destructive,
    _drop_none,
    _query_path,
    _request,
    _requires_confirmation,
    tool,
)


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@tool({"discover", "model", "build"})
async def get_dataset_model(
    dataset_id: int, summary: bool = False, ctx: Context | None = None
) -> dict[str, Any]:
    """Get the dataset model: {model_id, views, explores, generated}.

    generated=False means no model yet (run generate_dataset_model).
    summary=True drops SQL/descriptions, keeping ids + names + join targets.
    """
    payload = await _request("GET", f"/datasets/{int(dataset_id)}/model")
    if summary and isinstance(payload, dict):
        return _summarize_model(payload)
    return payload


def _summarize_model(payload: dict[str, Any]) -> dict[str, Any]:
    views = []
    for view in payload.get("views") or []:
        if not isinstance(view, dict):
            continue
        views.append(
            {
                "id": view.get("id"),
                "name": view.get("name"),
                "dataset_table_id": view.get("dataset_table_id"),
                "dimensions": [
                    d.get("name")
                    for d in (view.get("dimensions") or [])
                    if isinstance(d, dict) and d.get("name")
                ],
            }
        )
    explores = []
    for explore in payload.get("explores") or []:
        if not isinstance(explore, dict):
            continue
        explores.append(
            {
                "id": explore.get("id"),
                "name": explore.get("name"),
                "base_view_name": explore.get("base_view_name"),
                "joined_views": [
                    j.get("view")
                    for j in (explore.get("joins") or [])
                    if isinstance(j, dict) and j.get("view")
                ],
            }
        )
    return {
        "model_id": payload.get("model_id"),
        "dataset_id": payload.get("dataset_id"),
        "generated": payload.get("generated"),
        "views": views,
        "explores": explores,
        "_summary": True,
    }


@tool({"model", "build"})
async def suggest_workboard_relationships(
    from_table_id: int,
    dataset_id: int | None = None,
    deep_scan: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Suggest tables joinable from `from_table_id`, shaped for mini-app lookups.

    Returns join targets + the columns a form/table lookup `relationship_path`
    needs. deep_scan also probes data-value overlap (key for Google Sheets,
    which has no FKs and off-convention key names) — heavier, opt in.
    """
    return {
        "items": await _request(
            "GET",
            _query_path(
                "/workboard-relationships",
                {
                    "from_table_id": int(from_table_id),
                    "dataset_id": dataset_id,
                    "deep_scan": "true" if deep_scan else "false",
                },
            ),
        )
    }


@tool({"model", "build"})
async def suggest_dataset_model_join(
    dataset_id: int,
    from_view_id: int,
    to_view_id: int,
    from_column: str | None = None,
    to_column: str | None = None,
    from_columns: list[str] | None = None,
    to_columns: list[str] | None = None,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Inspect two views + join columns and recommend {join_type, relationship}.

    Read-only — does NOT create the join. Use single from_column/to_column, or
    from_columns/to_columns lists for composite keys. Call before
    add_dataset_model_join so the relationship type is evidence-based, not a
    guess (a wrong many_to_one can fan out or drop rows).
    """
    body = _drop_none(
        {
            "from_view_id": int(from_view_id),
            "to_view_id": int(to_view_id),
            "from_column": from_column,
            "to_column": to_column,
            "from_columns": from_columns,
            "to_columns": to_columns,
        }
    )
    return await _request(
        "POST", f"/datasets/{int(dataset_id)}/model/joins/suggestion", json_body=body
    )


# ---------------------------------------------------------------------------
# Write
# ---------------------------------------------------------------------------


@tool("model")
async def generate_dataset_model(
    dataset_id: int,
    force: bool = False,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Heuristically generate a starter model (no LLM): one view per table +
    FK-based joins. Refine joins afterwards. force=True overwrites an existing
    model and may lose manual customizations."""
    if not user_confirmed:
        return _requires_confirmation(
            "generate_dataset_model",
            {
                "dataset_id": int(dataset_id),
                "force_overwrite": bool(force),
                "note": "Rebuilds views/explores. Heuristic FK match can pick the wrong key — review joins after.",
            },
        )
    return await _request(
        "POST",
        _query_path(
            f"/datasets/{int(dataset_id)}/generate-model",
            {"force": "true" if force else "false"},
        ),
    )


@tool("model")
async def add_dataset_model_join(
    dataset_id: int,
    from_view_id: int,
    to_view_id: int,
    from_column: str | None = None,
    to_column: str | None = None,
    from_columns: list[str] | None = None,
    to_columns: list[str] | None = None,
    join_type: str = "left",
    relationship: str = "many_to_one",
    alias: str | None = None,
    is_active: bool = True,
    cross_filter: str = "single",
    force: bool = False,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Add/update a relationship between two views in a dataset model.

    join_type ∈ left|inner|right|full. relationship ∈ many_to_one|one_to_many|
    one_to_one|many_to_many. cross_filter ∈ single|both. force bypasses cycle
    warnings. Prefer suggest_dataset_model_join first.
    """
    join_from = from_columns or ([from_column] if from_column else [])
    join_to = to_columns or ([to_column] if to_column else [])
    if not user_confirmed:
        return _requires_confirmation(
            "add_dataset_model_join",
            {
                "dataset_id": int(dataset_id),
                "from_view_id": int(from_view_id),
                "to_view_id": int(to_view_id),
                "on": list(zip(join_from, join_to)) if join_from and join_to else None,
                "join_type": join_type,
                "relationship": relationship,
                "cross_filter": cross_filter,
                "alias": alias,
            },
        )
    body = _drop_none(
        {
            "from_view_id": int(from_view_id),
            "to_view_id": int(to_view_id),
            "from_column": from_column,
            "to_column": to_column,
            "from_columns": from_columns,
            "to_columns": to_columns,
            "join_type": join_type,
            "relationship": relationship,
            "alias": alias,
            "is_active": is_active,
            "cross_filter": cross_filter,
            "force": force if force else None,
        }
    )
    return await _request(
        "POST", f"/datasets/{int(dataset_id)}/model/joins", json_body=body
    )


@tool("model")
async def remove_dataset_model_join(
    dataset_id: int,
    from_view_id: int,
    to_view_name: str,
    from_column: str | None = None,
    to_column: str | None = None,
    from_columns: list[str] | None = None,
    to_columns: list[str] | None = None,
    user_confirmed: bool = False,
    ctx: Context | None = None,
) -> dict[str, Any]:
    """Remove a relationship between two views in a dataset model."""
    if not user_confirmed:
        return _confirmation_required_for_destructive(
            "remove_dataset_model_join",
            {
                "dataset_id": int(dataset_id),
                "from_view_id": int(from_view_id),
                "to_view_name": to_view_name,
            },
        )
    return await _request(
        "DELETE",
        _query_path(
            f"/datasets/{int(dataset_id)}/model/joins",
            {
                "from_view_id": int(from_view_id),
                "to_view_name": to_view_name,
                "from_column": from_column,
                "to_column": to_column,
                "from_columns": ",".join(from_columns) if from_columns else None,
                "to_columns": ",".join(to_columns) if to_columns else None,
            },
        ),
        expect_json=False,
    )


__all__: list[str] = []
