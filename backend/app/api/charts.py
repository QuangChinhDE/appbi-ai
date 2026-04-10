"""
API router for chart endpoints.
"""
import json
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.core import get_db
from app.core.dependencies import (
    get_current_user,
    require_permission,
    require_view_access,
    require_edit_access,
    require_full_access,
    get_effective_permission,
    batch_effective_permissions,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
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
from app.services import ChartService, EmbeddingService
from app.services.dataset_calendar_service import (
    build_calendar_live_sql,
    get_calendar_settings,
    is_generated_calendar_table,
)
from app.services.dataset_table_sql_service import (
    DatasetTableSqlError,
    build_live_proxy_table_for_dataset_table,
    is_derived_table,
)
from app.services.description_pipeline_service import (
    DescriptionPipelineService,
    resolve_session_factory,
)
from app.core.logging import get_logger


class AIChartPreviewRequest(BaseModel):
    """Request body for AI chart preview/create."""
    dataset_table_id: int
    chart_type: str
    config: Dict[str, Any] = {}
    name: str = "AI Chart"
    description: Optional[str] = None
    save: bool = False


class ChartPreviewDataRequest(BaseModel):
    """Request body for Explore chart preview."""
    dataset_table_id: int
    chart_type: str
    config: Dict[str, Any] = Field(default_factory=dict)
    context: Optional[str] = None
    include_source_sample: bool = False
    source_sample_limit: int = Field(default=100, ge=1, le=1000)


class ChartPreviewDataResponse(BaseModel):
    """Shared preview response for Explore."""
    data: List[Dict[str, Any]]
    pre_aggregated: bool = False
    execution_time_ms: Optional[float] = None
    source_columns: List[str] = Field(default_factory=list)
    source_rows: List[Dict[str, Any]] = Field(default_factory=list)

logger = get_logger(__name__)
router = APIRouter(prefix="/charts", tags=["charts"])


def _get_dataset_for_chart_table(db: Session, dataset_table_id: int):
    """Resolve the parent dataset for a chart source table."""
    from app.models.dataset import Dataset
    from app.services.dataset_crud import DatasetCRUDService

    db_table = DatasetCRUDService.get_table_by_id(db, dataset_table_id)
    if not db_table:
        raise HTTPException(status_code=404, detail="Dataset table not found")

    dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")

    return dataset_obj, db_table


def _serialize_chart_description(meta) -> dict:
    if not meta:
        return {
            "auto_description": None,
            "insight_keywords": None,
            "common_questions": None,
            "query_aliases": None,
            "description_source": None,
            "description_updated_at": None,
            "generation_status": "idle",
            "generation_error": None,
            "generation_requested_at": None,
            "generation_finished_at": None,
            "stale_reason": None,
        }

    return {
        "auto_description": getattr(meta, "auto_description", None),
        "insight_keywords": getattr(meta, "insight_keywords", None),
        "common_questions": getattr(meta, "common_questions", None),
        "query_aliases": getattr(meta, "query_aliases", None),
        "description_source": getattr(meta, "description_source", None),
        "description_updated_at": meta.description_updated_at.isoformat() if getattr(meta, "description_updated_at", None) else None,
        "generation_status": getattr(meta, "generation_status", "idle") or "idle",
        "generation_error": getattr(meta, "generation_error", None),
        "generation_requested_at": meta.generation_requested_at.isoformat() if getattr(meta, "generation_requested_at", None) else None,
        "generation_finished_at": meta.generation_finished_at.isoformat() if getattr(meta, "generation_finished_at", None) else None,
        "stale_reason": getattr(meta, "stale_reason", None),
    }


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
    # Batch hydrate: use auto_generate=False to avoid heavy model generation
    # on the list endpoint (semantic models are generated on save/preview instead).
    for item in items:
        ChartService.hydrate_runtime_config(db, item, auto_generate=False)
    # Batch permission check — single DB query instead of N queries
    perm_map = batch_effective_permissions(db, current_user, items, "explore_charts")
    for item in items:
        item.user_permission = perm_map.get(item.id, "none")
    stamp_owner_emails(db, items)
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
    from app.services.live_query_service import build_live_dataset_query, _dialect_for_ds_type
    from app.services.datasource_service import DataSourceConnectionService

    dataset_obj, db_table = _get_dataset_for_chart_table(db, payload.dataset_table_id)
    require_view_access(db, current_user, dataset_obj, "datasets")
    if payload.save:
        perms = current_user.permissions or {}
        if perms.get("explore_charts", "none") not in ("edit", "full"):
            raise HTTPException(
                status_code=403,
                detail="Requires 'edit' permission on module 'explore_charts'",
            )
    config = payload.config or {}

    # Resolve live datasource and base SQL for every table type
    try:
        if is_generated_calendar_table(db_table):
            # Calendar tables need an explicit datasource to determine dialect.
            # Pick the first physical datasource referenced by the dataset.
            from app.models.dataset import DatasetTable
            sibling_table = (
                db.query(DatasetTable)
                .filter(
                    DatasetTable.dataset_id == dataset_obj.id,
                    DatasetTable.datasource_id.isnot(None),
                )
                .first()
            )
            if sibling_table is None:
                raise HTTPException(
                    status_code=422,
                    detail="No datasource available for calendar table",
                )
            datasource = db.query(DataSource).filter(DataSource.id == sibling_table.datasource_id).first()
            if datasource is None:
                raise HTTPException(status_code=404, detail="Datasource not found")
            ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
            dialect = _dialect_for_ds_type(ds_type)
            base_sql = build_calendar_live_sql(
                get_calendar_settings(dataset_obj, enabled_default=False),
                dialect,
            )
        elif is_derived_table(db_table):
            datasource, proxy_table = build_live_proxy_table_for_dataset_table(
                db, dataset_obj, db_table,
            )
            ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
            dialect = _dialect_for_ds_type(ds_type)
            base_sql = proxy_table.source_query
        else:
            # Physical or sql_query table — build live SQL via query plan
            from app.services.live_query_service import build_live_base_query_plan
            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise HTTPException(status_code=404, detail="Datasource not found")
            ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
            dialect = _dialect_for_ds_type(ds_type)
            plan = build_live_base_query_plan(datasource, db_table)
            base_sql = plan.sql
    except DatasetTableSqlError as exc:
        code = getattr(exc, "code", "")
        if code == "NOT_SYNCED":
            raise HTTPException(
                status_code=422,
                detail={"code": exc.code, "message": str(exc)},
            )
        raise HTTPException(status_code=400, detail=str(exc))

    # Build and execute aggregation query via live datasource
    dimensions = config.get("dimensions") or []
    metrics = config.get("metrics") or []
    limit = min(int(config.get("limit", 500)), 2000)
    measures = [
        {
            "field": item.get("column", ""),
            "agg": str(item.get("aggregation", "sum")).lower(),
        }
        for item in metrics
        if item.get("column")
    ]

    sql = build_live_dataset_query(
        base_table=f"({base_sql}) AS base_table",
        dimensions=dimensions,
        measures=measures,
        filters=[],
        order_by=[],
        limit=limit,
        dialect=dialect,
    )

    try:
        _, data, _ = DataSourceConnectionService.execute_query(
            ds_type,
            datasource.config,
            sql,
            timeout_seconds=60 if ds_type == "bigquery" else 30,
            skip_bigquery_cost_check=True,
        )
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
            dataset_table_id=payload.dataset_table_id,
            chart_type=ct,
            config=config,
        )
        new_chart = ChartService.create(db, chart_create, owner_id=current_user.id)
        DescriptionPipelineService.enqueue_chart_pipeline(
            background_tasks,
            db,
            new_chart.id,
            trigger="chart_created",
        )
        response["saved"] = True
        response["chart_id"] = new_chart.id
        response["chart_name"] = new_chart.name

    return response


@router.post("/preview-data", response_model=ChartPreviewDataResponse)
def preview_chart_data(
    payload: ChartPreviewDataRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview chart runtime for Explore using the saved-chart execution path."""
    dataset_obj, _ = _get_dataset_for_chart_table(db, payload.dataset_table_id)
    require_view_access(db, current_user, dataset_obj, "datasets")

    try:
        result = ChartService.preview_chart_data(
            db,
            payload.dataset_table_id,
            payload.chart_type,
            payload.config,
            filter_context=payload.context,
            include_source_sample=payload.include_source_sample,
            source_sample_limit=payload.source_sample_limit,
        )
        return ChartPreviewDataResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except Exception as exc:
        logger.error(f"Failed to preview chart data: {exc}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to preview chart data.",
        )


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
        dataset_obj, _ = _get_dataset_for_chart_table(db, chart.dataset_table_id)
        require_view_access(db, current_user, dataset_obj, "datasets")
        new_chart = ChartService.create(db, chart, owner_id=current_user.id)
        DescriptionPipelineService.enqueue_chart_pipeline(
            background_tasks,
            db,
            new_chart.id,
            trigger="chart_created",
        )
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
    if chart_update.dataset_table_id is not None:
        dataset_obj, _ = _get_dataset_for_chart_table(db, chart_update.dataset_table_id)
        require_view_access(db, current_user, dataset_obj, "datasets")
    try:
        chart = ChartService.update(db, chart_id, chart_update)
        DescriptionPipelineService.enqueue_chart_pipeline(
            background_tasks,
            db,
            chart_id,
            trigger="chart_updated",
        )
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
    filters: Optional[str] = Query(None, description="JSON-encoded list of {field, operator, value} filter objects"),
    context: Optional[str] = Query(None, description="Runtime filter context, e.g. dashboard"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get chart configuration with data. Accepts optional dashboard filters."""
    chart = ChartService.get_by_id(db, chart_id)
    if not chart:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chart not found")
    perm = get_effective_permission(db, current_user, chart, "explore_charts")
    if perm == "none":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    extra_filters = None
    if filters:
        try:
            extra_filters = json.loads(filters)
            if not isinstance(extra_filters, list):
                raise ValueError("filters must be a JSON array")
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid filters parameter: {e}")

    try:
        result = ChartService.get_chart_data(
            db,
            chart_id,
            extra_filters=extra_filters,
            filter_context=context,
        )
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
            detail="Failed to retrieve chart data."
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
    return _serialize_chart_description(meta)


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
    meta.generation_status = "succeeded"
    meta.generation_error = None
    meta.generation_requested_at = None
    meta.generation_finished_at = datetime.utcnow()
    meta.stale_reason = None
    db.commit()

    background_tasks.add_task(
        DescriptionPipelineService.run_chart_embedding,
        chart_id,
        resolve_session_factory(db),
    )

    return _serialize_chart_description(meta)


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

    DescriptionPipelineService.enqueue_chart_pipeline(
        background_tasks,
        db,
        chart_id,
        trigger="manual_regenerate",
        force=True,
    )

    return {"status": "queued", "generation_status": "queued"}


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
