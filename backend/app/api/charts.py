"""
API router for chart endpoints.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

from app.core import get_db
from app.core.dependencies import (
    get_current_user,
    require_permission,
    require_view_access,
    require_edit_access,
    require_full_access,
    get_effective_permission,
)
from app.core.permissions import _owned_or_shared
from app.models.models import Chart, DashboardChart, Dashboard
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    ChartCreate,
    ChartUpdate,
    ChartResponse,
    ChartDataResponse,
    ChartMetadataUpsert,
    ChartMetadataResponse,
    ChartParameterCreate,
    ChartParameterUpdate,
    ChartParameterResponse,
)
from app.services import ChartService, EmbeddingService, AutoTaggingService
from app.core.logging import get_logger


class AIChartPreviewRequest(BaseModel):
    """Request body for AI chart preview/create."""
    workspace_table_id: int
    chart_type: str
    config: Dict[str, Any] = {}
    name: str = "AI Chart"
    description: Optional[str] = None
    save: bool = False

logger = get_logger(__name__)
router = APIRouter(prefix="/charts", tags=["charts"])


def _get_workspace_for_chart_table(db: Session, workspace_table_id: int):
    """Resolve the parent workspace for a chart source table."""
    from app.models.dataset_workspace import DatasetWorkspace
    from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService

    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, workspace_table_id)
    if not db_table:
        raise HTTPException(status_code=404, detail="Workspace table not found")

    workspace = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == db_table.workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    return workspace, db_table


@router.get("/", response_model=List[ChartResponse])
def list_charts(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List charts visible to the current user."""
    items = (
        _owned_or_shared(db, Chart, ResourceType.CHART, current_user)
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(db, current_user, item, "explore_charts")
    return items


@router.get("/search", response_model=List[dict])
def search_charts_vector(
    q: str,
    limit: int = 10,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Vector similarity search for charts. Falls back to empty list if embeddings unavailable."""
    from app.services.embedding_service import EmbeddingService
    limit = min(limit, 20)
    hits = EmbeddingService.search_similar(db, q, resource_type="chart", limit=limit, user_id=current_user.id)
    if not hits:
        return []
    # Enrich with chart details
    chart_ids = [h["resource_id"] for h in hits]
    charts = db.query(Chart).filter(Chart.id.in_(chart_ids)).all()
    chart_map = {c.id: c for c in charts}
    results = []
    for h in hits:
        c = chart_map.get(h["resource_id"])
        if c:
            results.append({
                "id": c.id,
                "name": c.name,
                "chart_type": c.chart_type,
                "similarity": round(h["similarity"], 4),
            })
    return results


@router.post("/ai-preview")
def ai_chart_preview(
    payload: AIChartPreviewRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("ai_chat", "view")),
):
    """
    Execute a chart from AI config and optionally save it permanently.
    Used by the AI agent's create_chart tool.
    Requires ai_chat >= view permission.
    """
    from app.models.models import DataSource
    from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
    from app.services.duckdb_engine import DuckDBEngine

    workspace, db_table = _get_workspace_for_chart_table(db, payload.workspace_table_id)
    require_view_access(db, current_user, workspace, "workspaces")
    if payload.save:
        perms = current_user.permissions or {}
        if perms.get("explore_charts", "none") not in ("edit", "full"):
            raise HTTPException(
                status_code=403,
                detail="Requires 'edit' permission on module 'explore_charts'",
            )

    datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    # Resolve DuckDB base table
    if db_table.source_kind == "sql_query":
        rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query or "")
        if rewritten is None:
            raise HTTPException(status_code=422, detail={"code": "NOT_SYNCED", "message": "Table not synced to DuckDB"})
        base_table = f"({rewritten}) AS base_table"
    else:
        view_name = get_synced_view(datasource.id, db_table.source_table_name or "")
        if view_name is None:
            raise HTTPException(status_code=422, detail={"code": "NOT_SYNCED", "message": "Table not synced to DuckDB"})
        base_table = view_name

    # Build and execute aggregation query
    config = payload.config or {}
    dimensions = config.get("dimensions") or []
    metrics = config.get("metrics") or []
    limit = min(int(config.get("limit", 500)), 2000)

    select_parts = [f'"{d}"' for d in dimensions]
    for m in metrics:
        col = m.get("column", "")
        agg = m.get("aggregation", "sum").upper()
        alias = f"{col}_{agg.lower()}"
        select_parts.append(f'{agg}("{col}") AS "{alias}"')

    if not select_parts:
        sql = f"SELECT * FROM {base_table} LIMIT {limit}"
    elif dimensions:
        group_by = ", ".join(f'"{d}"' for d in dimensions)
        sql = f"SELECT {', '.join(select_parts)} FROM {base_table} GROUP BY {group_by} LIMIT {limit}"
    else:
        sql = f"SELECT {', '.join(select_parts)} FROM {base_table} LIMIT {limit}"

    try:
        data = DuckDBEngine.query(sql)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Query failed: {str(exc)}")

    response: Dict[str, Any] = {
        "chart_type": payload.chart_type,
        "config": config,
        "data": data,
        "row_count": len(data),
        "saved": False,
        "chart_id": None,
    }

    if payload.save:
        from app.schemas import ChartCreate
        from app.schemas.schemas import ChartTypeSchema
        chart_type_val = payload.chart_type.upper()
        try:
            ct = ChartTypeSchema(chart_type_val)
        except ValueError:
            ct = ChartTypeSchema.BAR
        chart_create = ChartCreate(
            name=payload.name,
            description=payload.description,
            workspace_table_id=payload.workspace_table_id,
            chart_type=ct,
            config=config,
        )
        new_chart = ChartService.create(db, chart_create, owner_id=current_user.id)
        background_tasks.add_task(EmbeddingService.embed_chart, db, new_chart.id)
        response["saved"] = True
        response["chart_id"] = new_chart.id
        response["chart_name"] = new_chart.name

    return response


@router.get("/{chart_id}", response_model=ChartResponse)
def get_chart(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a chart by ID."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chart with ID {chart_id} not found"
        )
    chart.user_permission = require_view_access(db, current_user, chart, "explore_charts")
    return chart


@router.post("/", response_model=ChartResponse, status_code=status.HTTP_201_CREATED)
def create_chart(
    chart: ChartCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("explore_charts", "edit")),
):
    """Create a new chart."""
    try:
        workspace, _ = _get_workspace_for_chart_table(db, chart.workspace_table_id)
        require_view_access(db, current_user, workspace, "workspaces")
        new_chart = ChartService.create(db, chart, owner_id=current_user.id)
        background_tasks.add_task(AutoTaggingService.tag_chart, db, new_chart.id)
        background_tasks.add_task(EmbeddingService.embed_chart, db, new_chart.id)
        return new_chart
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{chart_id}", response_model=ChartResponse)
def update_chart(
    chart_id: int,
    chart_update: ChartUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a chart."""
    chart_obj = db.query(Chart).filter(Chart.id == chart_id).first()
    if not chart_obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart with ID {chart_id} not found")
    require_edit_access(db, current_user, chart_obj, "explore_charts")
    if chart_update.workspace_table_id is not None:
        workspace, _ = _get_workspace_for_chart_table(db, chart_update.workspace_table_id)
        require_view_access(db, current_user, workspace, "workspaces")
    try:
        chart = ChartService.update(db, chart_id, chart_update)
        background_tasks.add_task(AutoTaggingService.tag_chart, db, chart_id)
        background_tasks.add_task(EmbeddingService.embed_chart, db, chart_id)
        return chart
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{chart_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chart(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a chart, blocked if it is used in any dashboard."""
    chart = db.query(Chart).filter(Chart.id == chart_id).first()
    if not chart:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chart with ID {chart_id} not found"
        )
    require_full_access(db, current_user, chart, "explore_charts")

    blocking_links = (
        db.query(DashboardChart)
        .filter(DashboardChart.chart_id == chart_id)
        .all()
    )
    if blocking_links:
        dashboard_ids = {lnk.dashboard_id for lnk in blocking_links}
        dashboards = db.query(Dashboard).filter(Dashboard.id.in_(dashboard_ids)).all()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": f"Chart \"{chart.name}\" đang được sử dụng trong {len(dashboards)} dashboard và không thể xóa.",
                "constraints": [
                    {"type": "dashboard", "id": d.id, "name": d.name}
                    for d in dashboards
                ],
            },
        )

    EmbeddingService.delete_embedding(db, "chart", chart_id)
    success = ChartService.delete(db, chart_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chart with ID {chart_id} not found"
        )


@router.get("/{chart_id}/data", response_model=ChartDataResponse)
def get_chart_data(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get chart configuration with data."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chart not found")
    perm = get_effective_permission(db, current_user, chart, "explore_charts")
    if perm == "none":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    try:
        result = ChartService.get_chart_data(db, chart_id)
        return ChartDataResponse(**result)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Failed to get chart data: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get chart data: {str(e)}"
        )


# ---------------------------------------------------------------------------
# Metadata endpoints
# ---------------------------------------------------------------------------

@router.put("/{chart_id}/metadata", response_model=ChartMetadataResponse)
def upsert_chart_metadata(
    chart_id: int,
    data: ChartMetadataUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create or replace semantic metadata for a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    return ChartService.upsert_metadata(db, chart_id, data)


@router.get("/{chart_id}/metadata", response_model=ChartMetadataResponse)
def get_chart_metadata(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get semantic metadata for a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    perm = get_effective_permission(db, current_user, chart, "explore_charts")
    if perm == "none":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    meta = ChartService.get_metadata(db, chart_id)
    if not meta:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No metadata found for this chart")
    return meta


@router.delete("/{chart_id}/metadata", status_code=status.HTTP_204_NO_CONTENT)
def delete_chart_metadata(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete semantic metadata for a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    if not ChartService.delete_metadata(db, chart_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No metadata found for this chart")


# ---------------------------------------------------------------------------
# Description endpoints (knowledge system)
# ---------------------------------------------------------------------------

@router.get("/{chart_id}/description")
def get_chart_description(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get AI-generated description and knowledge fields for a chart."""
    from app.models.models import ChartMetadata
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    perm = get_effective_permission(db, current_user, chart, "explore_charts")
    if perm == "none":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    meta = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
    if not meta:
        return {
            "auto_description": None,
            "insight_keywords": None,
            "common_questions": None,
            "query_aliases": None,
            "description_source": None,
            "description_updated_at": None,
        }
    return {
        "auto_description": meta.auto_description,
        "insight_keywords": meta.insight_keywords,
        "common_questions": meta.common_questions,
        "query_aliases": meta.query_aliases,
        "description_source": meta.description_source,
        "description_updated_at": meta.description_updated_at.isoformat() if meta.description_updated_at else None,
    }


@router.put("/{chart_id}/description")
def update_chart_description(
    chart_id: int,
    body: dict,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update chart description fields manually. Sets description_source='user' and re-embeds."""
    from datetime import datetime
    from app.models.models import ChartMetadata
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")

    meta = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
    if not meta:
        meta = ChartMetadata(chart_id=chart_id)
        db.add(meta)

    if "auto_description" in body:
        meta.auto_description = body["auto_description"]
    if "insight_keywords" in body:
        meta.insight_keywords = body["insight_keywords"]
    if "common_questions" in body:
        meta.common_questions = body["common_questions"]
    if "query_aliases" in body:
        meta.query_aliases = body["query_aliases"]

    meta.description_source = "user"
    meta.description_updated_at = datetime.utcnow()
    db.commit()

    background_tasks.add_task(EmbeddingService.embed_chart, db, chart_id)

    return {
        "auto_description": meta.auto_description,
        "insight_keywords": meta.insight_keywords,
        "common_questions": meta.common_questions,
        "query_aliases": meta.query_aliases,
        "description_source": meta.description_source,
        "description_updated_at": meta.description_updated_at.isoformat() if meta.description_updated_at else None,
    }


@router.post("/{chart_id}/description/regenerate")
def regenerate_chart_description(
    chart_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Force-regenerate AI description for a chart, then re-embed."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")

    background_tasks.add_task(AutoTaggingService.tag_chart, db, chart_id, True)
    background_tasks.add_task(EmbeddingService.embed_chart, db, chart_id)

    return {"status": "regenerating"}


# ---------------------------------------------------------------------------
# Parameter definition endpoints
# ---------------------------------------------------------------------------

@router.get("/{chart_id}/parameters", response_model=List[ChartParameterResponse])
def list_chart_parameters(
    chart_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all parameter definitions for a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_view_access(db, current_user, chart, "explore_charts")
    return ChartService.get_parameters(db, chart_id)


@router.put("/{chart_id}/parameters", response_model=List[ChartParameterResponse])
def replace_chart_parameters(
    chart_id: int,
    params: List[ChartParameterCreate],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Replace all parameter definitions for a chart (bulk replace)."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    return ChartService.replace_parameters(db, chart_id, params)


@router.post("/{chart_id}/parameters", response_model=ChartParameterResponse, status_code=status.HTTP_201_CREATED)
def add_chart_parameter(
    chart_id: int,
    data: ChartParameterCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a single parameter definition to a chart."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    return ChartService.add_parameter(db, chart_id, data)


@router.put("/{chart_id}/parameters/{param_id}", response_model=ChartParameterResponse)
def update_chart_parameter(
    chart_id: int,
    param_id: int,
    data: ChartParameterUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a parameter definition."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    param = ChartService.update_parameter(db, chart_id, param_id, data)
    if not param:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Parameter {param_id} not found")
    return param


@router.delete("/{chart_id}/parameters/{param_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chart_parameter(
    chart_id: int,
    param_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a parameter definition."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Chart {chart_id} not found")
    require_edit_access(db, current_user, chart, "explore_charts")
    if not ChartService.delete_parameter(db, chart_id, param_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Parameter {param_id} not found")
