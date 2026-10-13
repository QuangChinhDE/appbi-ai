"""Read-only discovery tools (scope appbi.read). No AppBI writes."""

from typing import Annotated, Any
from urllib.parse import quote

from pydantic import Field

from ..appbi_client import AppbiError
from ..oauth import scopes as sc
from ..security import clamp_rows
from .runtime import Env, tool

PREVIEW_MAX = 20


def _source_summary(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": s.get("id"),
        "name": s.get("name"),
        "type": s.get("type"),
        "description": s.get("description"),
        "health": s.get("last_test_status"),
        "last_error_code": s.get("last_error_code"),
    }


@tool(scope=sc.READ, title="Who am I", read_only=True)
async def whoami(env: Env) -> dict[str, Any]:
    """Show which AppBI user this connection acts as and what the connection is allowed to do.

    The connection never exceeds the user's own AppBI permissions; AppBI checks
    every action again with the user's live rights.
    """
    me = await env.appbi.get("/auth/me")
    grant = env.app.provider.active_grant(env.principal.grant_id) or {}
    return {
        "status": "ok",
        "user": {"id": me.get("id"), "email": me.get("email"), "name": me.get("full_name")},
        "connection_scopes": env.principal.scopes,
        "connection_expires_at": grant.get("expires_at"),
        "appbi_url": env.app.settings.appbi_public_url,
    }


@tool(scope=sc.READ, title="List data sources", read_only=True)
async def list_data_sources(
    env: Env,
    limit: Annotated[int, Field(ge=1, le=200, description="Maximum number of sources")] = 100,
) -> dict[str, Any]:
    """List the data sources this user can see (databases, BigQuery, Google Sheets, files)."""
    rows = await env.appbi.get("/datasources/", skip=0, limit=limit)
    return {"status": "ok", "data_sources": [_source_summary(s) for s in rows or []]}


@tool(scope=sc.READ, title="Inspect a data source", read_only=True)
async def inspect_data_source(
    env: Env,
    data_source_id: Annotated[int, Field(description="Data source id from list_data_sources")],
    search: Annotated[str | None, Field(description="Only tables whose name contains this text")] = None,
    max_tables: Annotated[int, Field(ge=1, le=500)] = 200,
) -> dict[str, Any]:
    """List the tables of one data source.

    `source_table` is the exact name to use in plan_dataset. Row counts are
    estimates from the source's statistics.
    """
    source = await env.appbi.get(f"/datasources/{data_source_id}")
    listed = await env.appbi.get(f"/datasets/datasources/{data_source_id}/tables", search=search or None)
    counts: dict[tuple[str, str], Any] = {}
    try:
        schema = await env.appbi.get(f"/datasources/{data_source_id}/schema")
        for sch in (schema or {}).get("schemas", []):
            for t in sch.get("tables", []):
                counts[(str(sch.get("schema")), str(t.get("name")))] = t.get("row_count")
    except AppbiError:
        pass  # counts are a convenience; the table list above is authoritative
    out = []
    for t in listed or []:
        name = str(t.get("name"))
        bare = name.split(".", 1)[1] if t.get("schema") and name.startswith(f"{t.get('schema')}.") else name
        out.append({
            "source_table": name,
            "schema": t.get("schema"),
            "table": bare,
            "type": t.get("table_type"),
            "row_count_estimate": counts.get((str(t.get("schema")), bare)),
        })
    tables, truncated = clamp_rows(out, max_tables)
    return {
        "status": "ok",
        "data_source": _source_summary(source),
        "tables": tables,
        "truncated": truncated,
        "hint": "Use inspect_source_table for columns and a short preview." if tables else "No tables matched.",
    }


@tool(scope=sc.READ, title="Inspect a source table", read_only=True)
async def inspect_source_table(
    env: Env,
    data_source_id: int,
    source_table: Annotated[str, Field(description="Table name exactly as inspect_data_source lists it in source_table")],
    preview_rows: Annotated[int, Field(ge=0, le=PREVIEW_MAX, description=f"Sample rows (max {PREVIEW_MAX})")] = 5,
) -> dict[str, Any]:
    """Columns (name, type) and a few sample rows of one source table."""
    cols = await env.appbi.get(f"/datasets/datasources/{data_source_id}/tables/columns", table=source_table)
    result: dict[str, Any] = {
        "status": "ok",
        "data_source_id": data_source_id,
        "source_table": source_table,
        "columns": (cols or {}).get("columns", []),
    }
    rows = min(max(preview_rows, 0), PREVIEW_MAX)  # AppBI does not cap preview_rows on its route
    if rows and "." in source_table:
        schema, table = source_table.split(".", 1)
        try:
            detail = await env.appbi.get(
                f"/datasources/{data_source_id}/tables/{quote(schema, safe='')}/{quote(table, safe='')}", preview_rows=rows
            )
            result["preview"], _ = clamp_rows((detail or {}).get("preview") or [], rows)
        except AppbiError as exc:
            result["preview"] = None
            result["preview_unavailable"] = f"AppBI could not produce a preview ({exc.status}: {exc.message})"
    return result


def _dataset_summary(d: dict[str, Any], env: Env) -> dict[str, Any]:
    return {
        "id": d.get("id"),
        "name": d.get("name"),
        "description": d.get("description"),
        "purpose": d.get("purpose"),
        "owner_id": d.get("owner_id"),
        "updated_at": d.get("updated_at"),
        "url": env.link(f"/datasets/{d.get('id')}"),
    }


@tool(scope=sc.READ, title="List datasets", read_only=True)
async def list_datasets(env: Env, limit: Annotated[int, Field(ge=1, le=200)] = 100) -> dict[str, Any]:
    """List the datasets this user can see."""
    rows = await env.appbi.get("/datasets/", skip=0, limit=limit)
    items = rows.get("items", rows) if isinstance(rows, dict) else rows
    return {"status": "ok", "datasets": [_dataset_summary(d, env) for d in items or []]}


def model_digest(model: dict[str, Any]) -> dict[str, Any]:
    """The part of a semantic model a planner needs: views, fields, measures, joins."""
    views = []
    for v in model.get("views", []) or []:
        views.append({
            "view_id": v.get("id"),
            "view": v.get("name"),
            "dataset_table_id": v.get("dataset_table_id"),
            "dimensions": [
                {"name": d.get("name"), "type": d.get("type"), "label": d.get("label")}
                for d in v.get("dimensions", []) or [] if not d.get("hidden")
            ],
            "measures": [
                {"name": m.get("name"), "type": m.get("type"), "sql": m.get("sql"), "label": m.get("label"),
                 "field_ref": f"{v.get('name')}.{m.get('name')}"}
                for m in v.get("measures", []) or [] if not m.get("hidden")
            ],
        })
    explores = []
    for e in model.get("explores", []) or []:
        explores.append({
            "explore_id": e.get("id"),
            "base_view": e.get("base_view_name") or e.get("base_view"),
            "joins_version": e.get("joins_version"),
            "joins": [
                {
                    "view": j.get("view_name") or j.get("name"),
                    "relationship": j.get("relationship") or j.get("cardinality"),
                    "on": j.get("sql_on") or j.get("on"),
                }
                for j in e.get("joins", []) or []
            ],
        })
    return {"model_id": model.get("id"), "views": views, "explores": explores}


@tool(scope=sc.READ, title="Get a dataset", read_only=True)
async def get_dataset(env: Env, dataset_id: int) -> dict[str, Any]:
    """A dataset's tables, semantic model (dimensions, measures, joins) and publish state."""
    ds = await env.appbi.get(f"/datasets/{dataset_id}")
    model = await env.appbi.get(f"/datasets/{dataset_id}/model")
    status = await env.appbi.get(f"/datasets/{dataset_id}/publish-status")
    tables = [
        {
            "dataset_table_id": t.get("id"),
            "display_name": t.get("display_name"),
            "source_kind": t.get("source_kind"),
            "datasource_id": t.get("datasource_id"),
            "source_table_name": t.get("source_table_name"),
            "columns": [c.get("name") for c in (t.get("columns_cache") or {}).get("columns", [])][:200]
            if isinstance(t.get("columns_cache"), dict) else None,
        }
        for t in (ds or {}).get("tables", []) or []
    ]
    return {
        "status": "ok",
        "dataset": _dataset_summary(ds, env),
        "tables": tables,
        "model": model_digest(model or {}),
        "publish": {
            "state": (status or {}).get("publish_state"),
            "published_at": (status or {}).get("published_at"),
            "syncing": (status or {}).get("syncing"),
            "last_sync_error": (status or {}).get("last_sync_error"),
            "has_published_data": (status or {}).get("has_published_data"),
        },
    }


@tool(scope=sc.READ, title="Profile a dataset table", read_only=True)
async def profile_dataset_table(
    env: Env,
    dataset_id: int,
    dataset_table_id: int,
    sample_rows: Annotated[int, Field(ge=1, le=PREVIEW_MAX)] = 10,
) -> dict[str, Any]:
    """Schema, column statistics and a few sample rows of a dataset table (read-only)."""
    prof = await env.appbi.post(f"/datasets/{dataset_id}/tables/{dataset_table_id}/profile", None, sample_limit=sample_rows)
    if isinstance(prof, dict):
        for key in ("sample_rows", "rows", "sample"):
            if isinstance(prof.get(key), list):
                prof[key], _ = clamp_rows(prof[key], sample_rows)
    return {"status": "ok", "profile": prof}


@tool(scope=sc.READ, title="List dashboards", read_only=True)
async def list_dashboards(env: Env, limit: Annotated[int, Field(ge=1, le=200)] = 100) -> dict[str, Any]:
    """List the dashboards this user can see."""
    rows = await env.appbi.get("/dashboards/", skip=0, limit=limit)
    return {
        "status": "ok",
        "dashboards": [
            {"id": d.get("id"), "name": d.get("name"), "updated_at": d.get("updated_at"), "url": env.link(f"/dashboards/{d.get('id')}")}
            for d in rows or []
        ],
    }


def dashboard_digest(d: dict[str, Any], user_id: str) -> dict[str, Any]:
    tiles = []
    for c in d.get("dashboard_charts", []) or d.get("charts", []) or []:
        layout = c.get("layout") or {}
        tiles.append({
            "tile_id": c.get("id"),
            "chart_id": c.get("chart_id"),
            "chart_name": (c.get("chart") or {}).get("name"),
            "chart_type": (c.get("chart") or {}).get("chart_type"),
            "draft_only": bool(layout.get("draftOnly")),
            "mine": str(layout.get("draftOwner") or "") == str(user_id) if layout.get("draftOnly") else None,
            "v": layout.get("_v", 0),
        })
    shared = d.get("shared_draft") or {}
    return {
        "id": d.get("id"),
        "name": d.get("name"),
        "has_draft": d.get("has_draft"),
        "shared_draft": {"rev": shared.get("rev"), "has_changes": shared.get("has_changes"), "other_authors": shared.get("other_authors")},
        "filters": [
            {"id": f.get("id"), "label": f.get("label"), "field": f.get("semanticField") or f.get("field"), "type": f.get("type")}
            for f in d.get("filters_config", []) or []
        ],
        "tiles": tiles,
    }


@tool(scope=sc.READ, title="Get a dashboard", read_only=True)
async def get_dashboard(env: Env, dashboard_id: int) -> dict[str, Any]:
    """A dashboard's tiles (with your draft overlay), filters and co-editing draft state."""
    d = await env.appbi.get(f"/dashboards/{dashboard_id}")
    digest = dashboard_digest(d or {}, env.principal.user_id)
    digest["url"] = env.link(f"/dashboards/{dashboard_id}")
    return {"status": "ok", "dashboard": digest}


@tool(scope=sc.READ, title="Get chart data", read_only=True)
async def get_chart_data(
    env: Env,
    chart_id: int,
    filters: Annotated[
        list[dict[str, Any]] | None,
        Field(description="Runtime filters [{field, operator, value, semanticField?, datasetId?}] as a dashboard sends them"),
    ] = None,
    max_rows: Annotated[int, Field(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    """The rows a chart renders (as AppBI computes them), optionally under dashboard filters.

    Use it to check numbers. `dropped_filters` lists filters AppBI could not apply.
    """
    import json

    params: dict[str, Any] = {"context": "dashboard"}
    if filters:
        params["filters"] = json.dumps(filters)
    res = await env.appbi.get(f"/charts/{chart_id}/data", **params)
    data, truncated = clamp_rows((res or {}).get("data") or [], max_rows)
    debug = (res or {}).get("debug") or {}
    return {
        "status": "ok",
        "chart_id": chart_id,
        "rows": data,
        "truncated": truncated,
        "row_count": len((res or {}).get("data") or []),
        "dropped_filters": debug.get("dropped_filters"),
    }
