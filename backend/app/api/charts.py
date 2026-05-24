"""
API router for chart endpoints.
"""
import json
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import String, case, cast, func, or_
from sqlalchemy.orm import Session, joinedload, selectinload
from typing import Any, Dict, List, Literal, Optional

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
from app.models.models import Chart, ChartMetadata, ChartType, DashboardChart, Dashboard
from app.models.dataset import Dataset, DatasetTable
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
    source_sample_limit: int = Field(default=100, ge=1, le=5000)


class ChartNormalizeConfigRequest(BaseModel):
    """Request body for the canonical normalize endpoint.

    Phase-12 single-source-of-truth contract: MCP / SDK / FE callers POST
    their proposed (chart_type, config) here and trust the response —
    never re-implement role-config / metric / agg normalization locally.
    """
    chart_type: str
    config: Dict[str, Any] = Field(default_factory=dict)


class ChartConfigChange(BaseModel):
    """One field the normalize endpoint mutated, surfaced to the caller."""
    path: str
    before: Any
    after: Any
    reason: str


class ChartNormalizeConfigResponse(BaseModel):
    """Response shape — the normalized config the BE will actually save."""
    normalized_config: Dict[str, Any]
    changes: List[ChartConfigChange] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class ChartDryRunCreateRequest(BaseModel):
    """Run the full ChartCreate validation pipeline WITHOUT saving."""
    name: str
    chart_type: str
    dataset_table_id: int
    config: Dict[str, Any]
    description: Optional[str] = None


class ChartDryRunCreateResponse(BaseModel):
    """Single endpoint MCP / SDK call before creating a chart.

    On ``ok=True`` the caller can confidently call ``POST /charts/`` with
    ``normalized_config`` and the chart will land cleanly. On ``ok=False``
    the caller MUST not write — show ``validation_errors`` /
    ``runtime_errors`` to the user (or AI) and ask for a corrected
    payload.
    """
    ok: bool
    normalized_config: Dict[str, Any]
    changes: List[ChartConfigChange] = Field(default_factory=list)
    validation_errors: List[str] = Field(default_factory=list)
    semantic_warnings: List[str] = Field(default_factory=list)
    runtime_errors: List[str] = Field(default_factory=list)
    runtime_root_cause: Optional[str] = None
    runtime_preview_sample: Optional[List[Dict[str, Any]]] = None
    # Phase-12.6: config keys the BE would accept + save but the FE
    # Explore renderer does NOT consume — typically misspellings or
    # legacy fields the AI emitted. These don't block the create (BE is
    # tolerant) but are surfaced so the caller can warn the user
    # "the chart will save but the field X won't visibly affect rendering".
    fe_unrecognised_keys: List[str] = Field(default_factory=list)


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


def _stamp_chart_catalog_fields(current_user: User, items: list[Chart]) -> None:
    for item in items:
        dataset_table = getattr(item, "dataset_table", None)
        dataset_obj = getattr(dataset_table, "dataset", None) if dataset_table else None
        is_owned = bool(current_user and item.owner_id == current_user.id)
        item.dataset_id = getattr(dataset_obj, "id", None)
        item.dataset_name = getattr(dataset_obj, "name", None)
        item.dataset_table_name = getattr(dataset_table, "display_name", None)
        item.datasource_id = getattr(dataset_table, "datasource_id", None)
        item.is_owned_by_current_user = is_owned
        item.is_shared = not is_owned


@router.get("/", response_model=List[ChartResponse])
def list_charts(
    skip: int = 0,
    limit: int = Query(100, ge=1, le=500),
    q: Optional[str] = Query(None, description="Search by chart name, type, dataset, description, or tags"),
    chart_type: Optional[str] = Query(None, description="Filter by chart type enum, e.g. BAR or LINE"),
    scope: Literal["all", "mine", "shared"] = Query("all", description="Ownership scope"),
    sort: Literal["updated_desc", "created_desc", "name_asc", "name_desc", "relevance"] = Query("updated_desc"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List charts visible to the current user."""
    query = (
        _owned_or_shared(db, Chart, ResourceType.CHART, current_user)
        .options(
            joinedload(Chart.chart_meta),
            selectinload(Chart.parameters),
            joinedload(Chart.dataset_table).joinedload(DatasetTable.dataset),
        )
        .outerjoin(ChartMetadata, Chart.chart_meta)
        .outerjoin(DatasetTable, Chart.dataset_table)
        .outerjoin(Dataset, DatasetTable.dataset)
    )

    normalized_query = (q or "").strip()
    normalized_query_lower = normalized_query.lower()

    if chart_type:
        chart_type_upper = chart_type.strip().upper()
        valid_chart_types = {member.value for member in ChartType}
        if chart_type_upper not in valid_chart_types:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported chart_type '{chart_type}'",
            )
        query = query.filter(Chart.chart_type == ChartType(chart_type_upper))

    if scope == "mine":
        query = query.filter(Chart.owner_id == current_user.id)
    elif scope == "shared":
        query = query.filter(or_(Chart.owner_id.is_(None), Chart.owner_id != current_user.id))

    if normalized_query:
        like_term = f"%{normalized_query}%"
        query = query.filter(
            or_(
                Chart.name.ilike(like_term),
                Chart.description.ilike(like_term),
                cast(Chart.chart_type, String).ilike(like_term),
                Dataset.name.ilike(like_term),
                DatasetTable.display_name.ilike(like_term),
                ChartMetadata.domain.ilike(like_term),
                ChartMetadata.intent.ilike(like_term),
                ChartMetadata.auto_description.ilike(like_term),
                cast(ChartMetadata.metrics, String).ilike(like_term),
                cast(ChartMetadata.dimensions, String).ilike(like_term),
                cast(ChartMetadata.tags, String).ilike(like_term),
                cast(ChartMetadata.query_aliases, String).ilike(like_term),
                cast(ChartMetadata.insight_keywords, String).ilike(like_term),
                cast(ChartMetadata.common_questions, String).ilike(like_term),
            )
        )

    if sort == "relevance" and normalized_query:
        startswith_term = f"{normalized_query_lower}%"
        contains_term = f"%{normalized_query_lower}%"
        relevance_rank = case(
            (func.lower(Chart.name) == normalized_query_lower, 0),
            (func.lower(Chart.name).like(startswith_term), 1),
            (func.lower(DatasetTable.display_name) == normalized_query_lower, 2),
            (func.lower(Dataset.name) == normalized_query_lower, 3),
            (func.lower(cast(Chart.chart_type, String)) == normalized_query_lower, 4),
            (func.lower(Chart.name).like(contains_term), 5),
            (func.lower(DatasetTable.display_name).like(contains_term), 6),
            (func.lower(Dataset.name).like(contains_term), 7),
            (func.lower(func.coalesce(Chart.description, "")).like(contains_term), 8),
            (func.lower(func.coalesce(ChartMetadata.auto_description, "")).like(contains_term), 9),
            else_=10,
        )
        query = query.order_by(relevance_rank.asc(), Chart.updated_at.desc(), Chart.id.desc())
    elif sort == "created_desc":
        query = query.order_by(Chart.created_at.desc(), Chart.id.desc())
    elif sort == "name_asc":
        query = query.order_by(func.lower(Chart.name).asc(), Chart.id.asc())
    elif sort == "name_desc":
        query = query.order_by(func.lower(Chart.name).desc(), Chart.id.desc())
    else:
        query = query.order_by(Chart.updated_at.desc(), Chart.id.desc())

    items = query.offset(skip).limit(limit).all()
    # Batch hydrate: use auto_generate=False to avoid heavy model generation
    # on the list endpoint (semantic models are generated on save/preview instead).
    for item in items:
        ChartService.hydrate_runtime_config(db, item, auto_generate=False)
    # Batch permission check — single DB query instead of N queries
    perm_map = batch_effective_permissions(db, current_user, items, "explore_charts")
    for item in items:
        item.user_permission = perm_map.get(item.id, "none")
    stamp_owner_emails(db, items)
    _stamp_chart_catalog_fields(current_user, items)
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
    current_user: User = Depends(require_permission("explore_charts", "view")),
):
    """
    Execute a chart from AI config and optionally save it permanently.
    Used by the AI agent's create_chart tool.
    Requires explore_charts >= view permission.
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
            from app.services.dataset_relation_service import resolve_dataset_table_relation
            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise HTTPException(status_code=404, detail="Datasource not found")
            ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
            dialect = _dialect_for_ds_type(ds_type)
            plan = resolve_dataset_table_relation(datasource, db_table)
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
        logger.exception("Failed to preview chart data")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to preview chart data: {exc}",
        )


# ---------------------------------------------------------------------------
# Phase-12: BE-as-single-source-of-truth contract.
#
# `/normalize-config` is a pure function — caller (MCP / FE / SDK) sends a
# raw config, gets back the canonical form the BE will actually save +
# the list of fields that were rewritten so the caller can surface the diff.
#
# `/dry-run-create` runs the full ChartCreate validation + semantic
# preflight + runtime preview pipeline WITHOUT touching the DB. Callers
# use this as their single pre-flight check before POST /charts/.
#
# Why these exist: every previous attempt to embed normalization logic in
# MCP (or any external SDK) eventually drifted from the canonical BE
# rules — Phase-3 `agg='auto'`, Phase-9 validator, Phase-10 binding
# hydration. With these endpoints the BE is the single gatekeeper; MCP
# tools call here instead of re-implementing the contract.


# Phase-12.6 FE-key registry. These are the keys the Explore renderer
# actually consumes. Maintained by hand here so the BE can warn callers
# (MCP, AI agents) when they emit configs with keys the FE will silently
# drop — the recurring "chart saves but doesn't look like I asked" defect.
#
# Source of truth: keep these sets in sync with the TS interfaces in
# `frontend/src/components/explore/ExploreChartConfig.tsx`:
#   - ChartRoleConfig         → _FE_ROLE_CONFIG_KEYS
#   - ChartStyleConfig        → _FE_STYLE_CONFIG_KEYS
#   - MetricConfig            → _FE_METRIC_KEYS
#   - Top-level config keys   → _FE_TOP_LEVEL_KEYS
#
# Don't pretend to enumerate every legacy / per-chart-type key — just the
# ones likely to be emitted by Claude. A missing entry only produces a
# false-positive "won't render" warning, never an error.

_FE_TOP_LEVEL_KEYS: set[str] = {
    "chartType", "queryMode", "roleConfig", "generatedRoleConfig",
    "customRoleConfig", "customSql", "styleConfig", "filters", "baseFilters",
    "semanticBinding", "limit", "sort", "calculatedFields", "windowFunctions",
    "rename_map",
}

_FE_ROLE_CONFIG_KEYS: set[str] = {
    "dimension", "metrics", "breakdown", "lineMetric", "benchmarkMetric",
    "timeField", "scatterX", "scatterY", "tableMode", "tableRowDimension",
    "tableColumnDimension", "tablePivotMetric", "selectedColumns",
    # Phase-15.12: time_grains forwarded to SemanticQueryEngine from role_config.
    # Without this entry the dry-run reports false-positive "fe_unrecognised_keys".
    "timeGrains",
}

_FE_METRIC_KEYS: set[str] = {
    "field", "agg", "label", "format", "function",
}

_FE_STYLE_CONFIG_KEYS: set[str] = {
    # Data labels
    "showDataLabels", "dataLabelPosition",
    # Number formatting
    "numberFormat", "currencySymbol", "decimalPlaces",
    # Axis
    "xAxisLabel", "yAxisLabel", "yAxisMin", "yAxisMax", "yAxisRightLabel",
    # Legend / grid
    "legendPosition", "showGrid",
    # Palette
    "palette", "seriesColors",
    # Font
    "fontSize", "chartTitleFontSize",
    # Bar
    "barRadius",
    # Line
    "showDots", "lineStyle",
    # Benchmark line
    "showBenchmarkLine", "benchmarkValue", "benchmarkLabel",
    "benchmarkColor", "benchmarkLineStyle",
    # KPI
    "kpiLabel", "kpiContextTemplate", "kpiBenchmarkValue",
    "kpiBenchmarkLabel", "kpiShowBenchmarkValue", "kpiShowDelta",
    "kpiGoalDirection", "kpiAccentColor", "kpiEnableColorRules",
    "kpiColorRules", "kpiIconName", "kpiIconColor", "kpiAccentBorder",
    "kpiGradientBg", "kpiValueFontSize",
    # PODIUM
    "podiumTop", "podiumNameField", "podiumValueField",
    "podiumGoldColor", "podiumSilverColor", "podiumBronzeColor",
    # Table
    "tableEnableConditionalFormatting", "tableEnableHeatmap",
    "tableConditionalFormatting", "tableHeatmapRules",
    "tableShowSummaryRow", "tableSummaryLabel", "tableSummaryLabelColumn",
    "tableSummaryRows", "tableColumnWidths", "tableColumnAlignments",
    "tableHyperlinkRules",
    # Chart title
    "chartTitle",
    # PIE / donut
    "pieInnerRadius",
    # Stacked bar
    "stackMode",
    # Time series
    "timeGranularity",
    # Data shaping
    "chartSortRules", "dataLimit", "dataLimitDirection",
    # BAR_LINE
    "dualYAxis",
    # AREA
    "areaOpacity",
    # LINE / AREA / TIME_SERIES — stroke + sizing
    "lineWidth", "barSize",
    # SCATTER label field
    "scatterLabelField",
    # Phase-15.82 — render-pipeline extensions. All read by ExploreChart
    # / chartDataAdapter; declared here so /charts/dry-run-create doesn't
    # report them as `fe_unrecognised_keys` to MCP and AI agents.
    "showAllPoints",
    "seriesFormats", "seriesDecimalPlaces",
    "tooltipExtraFields",
    "dataLabelTemplate",
    "dateDrillLevel",
    "seriesConditionalRules",
    "annotations",
    "seriesRenderAs",
    "calculatedFields",
}


def _collect_fe_unrecognised_keys(config: Dict[str, Any]) -> List[str]:
    """Walk a chart config and list any keys the Explore renderer doesn't
    know about. Used by ``/charts/dry-run-create`` so MCP / AI agents
    learn which fields they emitted will silently no-op at view time.

    The walk only checks the well-known buckets — role containers, style
    config, metric entries. It does NOT recurse into arbitrary user
    payloads (e.g. ``conditional_formatting[].rule.value`` literals);
    those are caller-controlled values, not renderer-recognised keys.
    """
    if not isinstance(config, dict):
        return []
    out: List[str] = []
    for key in config.keys():
        if key not in _FE_TOP_LEVEL_KEYS:
            out.append(f"config.{key}")

    style = config.get("styleConfig")
    if isinstance(style, dict):
        for key in style.keys():
            if key not in _FE_STYLE_CONFIG_KEYS:
                out.append(f"config.styleConfig.{key}")

    for container_key in ("roleConfig", "generatedRoleConfig", "customRoleConfig"):
        container = config.get(container_key)
        if not isinstance(container, dict):
            continue
        for key in container.keys():
            if key not in _FE_ROLE_CONFIG_KEYS:
                out.append(f"config.{container_key}.{key}")
        metrics = container.get("metrics") or []
        for idx, metric in enumerate(metrics):
            if not isinstance(metric, dict):
                continue
            for key in metric.keys():
                if key not in _FE_METRIC_KEYS:
                    out.append(f"config.{container_key}.metrics[{idx}].{key}")
        for solo_key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
            metric = container.get(solo_key)
            if not isinstance(metric, dict):
                continue
            for key in metric.keys():
                if key not in _FE_METRIC_KEYS:
                    out.append(f"config.{container_key}.{solo_key}.{key}")
    return out


def _normalize_chart_config_with_diff(
    chart_type: str,
    raw_config: Dict[str, Any],
) -> tuple[Dict[str, Any], List[ChartConfigChange]]:
    """Run the canonical role-config normalizer on every container in the
    config and return (normalized, list_of_changes).

    The change list is intentionally simple — one entry per
    rewritten role container, with a structural diff the caller can
    print in plain language. We do NOT walk every leaf because the
    normalizer is idempotent and most callers only need a yes/no signal
    + the final value.
    """
    from app.services.chart_contracts import normalize_chart_role_config

    if not isinstance(raw_config, dict):
        return raw_config, []
    out = dict(raw_config)
    changes: List[ChartConfigChange] = []
    for container_key in ("roleConfig", "generatedRoleConfig", "customRoleConfig"):
        before = raw_config.get(container_key)
        if not isinstance(before, dict):
            continue
        after = normalize_chart_role_config(chart_type, before)
        if after != before:
            changes.append(
                ChartConfigChange(
                    path=container_key,
                    before=before,
                    after=after,
                    reason="Coerced metric.agg / role keys to canonical values.",
                )
            )
        out[container_key] = after
    return out, changes


@router.post("/normalize-config", response_model=ChartNormalizeConfigResponse)
def normalize_chart_config(
    payload: ChartNormalizeConfigRequest,
    current_user: User = Depends(get_current_user),
):
    """Canonicalise a chart config without saving.

    Used by external SDKs (MCP, scripts) so they never have to mirror the
    normalization rules locally. Pass any role-config shape the AI emitted
    and you get back the exact form the BE would persist.
    """
    normalized, changes = _normalize_chart_config_with_diff(
        payload.chart_type, payload.config or {}
    )
    return ChartNormalizeConfigResponse(
        normalized_config=normalized,
        changes=changes,
        warnings=[],
    )


@router.post("/dry-run-create", response_model=ChartDryRunCreateResponse)
def dry_run_create_chart(
    payload: ChartDryRunCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("explore_charts", "view")),
):
    """Validate a proposed chart through the full create pipeline — WITHOUT
    writing to the DB.

    Runs (in order):
      1. ``normalize_chart_role_config`` to canonicalise the payload.
      2. The Pydantic ``ChartCreate`` model validator (Phase-9 shape +
         Phase-12 metric.agg checks).
      3. ``ChartService.preview_chart_data`` so we know the chart's query
         would actually execute against the bound table.

    Returns ``ok=True`` only when all three pass. Callers (MCP) treat that
    as permission to POST ``/charts/`` with ``normalized_config``.
    """
    from pydantic import ValidationError
    from app.schemas import ChartCreate as ChartCreateSchema
    from app.schemas.schemas import ChartTypeSchema

    normalized, changes = _normalize_chart_config_with_diff(
        payload.chart_type, payload.config or {}
    )

    validation_errors: List[str] = []
    try:
        chart_type_enum = ChartTypeSchema(payload.chart_type.upper())
    except ValueError:
        validation_errors.append(
            f"chart_type={payload.chart_type!r} is not a recognised ChartType."
        )
        chart_type_enum = None

    if chart_type_enum is not None:
        try:
            ChartCreateSchema.model_validate(
                {
                    "name": payload.name,
                    "description": payload.description,
                    "dataset_table_id": payload.dataset_table_id,
                    "chart_type": chart_type_enum,
                    "config": normalized,
                }
            )
        except ValidationError as exc:
            validation_errors.extend(
                f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}"
                for err in exc.errors()
            )

    fe_unrecognised = _collect_fe_unrecognised_keys(normalized)

    if validation_errors:
        return ChartDryRunCreateResponse(
            ok=False,
            normalized_config=normalized,
            changes=changes,
            validation_errors=validation_errors,
            fe_unrecognised_keys=fe_unrecognised,
        )

    # Verify the dataset_table exists + user can view it BEFORE simulating
    # the runtime preview — otherwise we'd 500 with a confusing dataset
    # lookup error.
    try:
        dataset_obj, _ = _get_dataset_for_chart_table(db, payload.dataset_table_id)
    except HTTPException as exc:
        return ChartDryRunCreateResponse(
            ok=False,
            normalized_config=normalized,
            changes=changes,
            validation_errors=[f"dataset_table_id: {exc.detail}"],
        )
    require_view_access(db, current_user, dataset_obj, "datasets")

    runtime_errors: List[str] = []
    runtime_root_cause: Optional[str] = None
    runtime_sample: Optional[List[Dict[str, Any]]] = None
    try:
        preview = ChartService.preview_chart_data(
            db,
            payload.dataset_table_id,
            payload.chart_type,
            normalized,
        )
        runtime_sample = (preview.get("data") or [])[:5]
    except ValueError as exc:
        runtime_errors.append(str(exc))
    except Exception as exc:
        logger.exception("dry-run-create runtime preview failed")
        runtime_errors.append(f"runtime preview failed: {type(exc).__name__}: {exc}")
        runtime_root_cause = type(exc).__name__

    return ChartDryRunCreateResponse(
        ok=not runtime_errors,
        normalized_config=normalized,
        changes=changes,
        validation_errors=[],
        semantic_warnings=[],
        runtime_errors=runtime_errors,
        runtime_root_cause=runtime_root_cause,
        runtime_preview_sample=runtime_sample,
        fe_unrecognised_keys=fe_unrecognised,
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
    stamp_owner_emails(db, [chart])
    _stamp_chart_catalog_fields(current_user, [chart])
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
        new_chart = ChartService.get_by_id(db, new_chart.id)
        if new_chart:
            new_chart.user_permission = get_effective_permission(db, current_user, new_chart, "explore_charts")
            stamp_owner_emails(db, [new_chart])
            _stamp_chart_catalog_fields(current_user, [new_chart])
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
        if chart:
            chart.user_permission = get_effective_permission(db, current_user, chart, "explore_charts")
            stamp_owner_emails(db, [chart])
            _stamp_chart_catalog_fields(current_user, [chart])
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
        # Phase-12.7: ValueError from the semantic engine / chart runtime
        # means the chart's CONFIG is invalid given the current dataset
        # state (missing relationship, removed column, BigQuery cost guard,
        # etc.). The chart row still exists — 400 (bad request) is the
        # correct semantic; the previous 404 made DAs think the chart had
        # been deleted. Phase-11 ensures the message is Vietnamese-
        # friendly when the cause is engine-side (unreachable view).
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception(
            "Failed to get chart data for chart_id=%s context=%s",
            chart_id,
            context,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve chart data: {e}",
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
