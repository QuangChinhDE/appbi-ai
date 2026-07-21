"""
Semantic Layer API Routes
Endpoints for managing semantic views, models, explores, and executing semantic queries
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.dependencies import require_permission
from app.core.logging import get_logger

logger = get_logger(__name__)
from app.models.semantic import SemanticView, SemanticModel, SemanticExplore
from app.models.user import User
from app.schemas.semantic import (
    SemanticView as SemanticViewSchema,
    SemanticViewCreate,
    SemanticViewUpdate,
    SemanticModel as SemanticModelSchema,
    SemanticModelCreate,
    SemanticModelUpdate,
    SemanticExplore as SemanticExploreSchema,
    SemanticExploreCreate,
    SemanticExploreUpdate,
    SemanticQueryRequest,
    SemanticQueryResponse,
)
from app.services.semantic_query_engine import SemanticQueryEngine
from app.services.datasource_service import DataSourceConnectionService
import time

router = APIRouter(prefix="/semantic", tags=["semantic"])

require_semantic_view = require_permission("datasets", "view")
require_semantic_edit = require_permission("datasets", "edit")
require_semantic_full = require_permission("datasets", "full")


# ============ Semantic Views ============

@router.post("/views", response_model=SemanticViewSchema, status_code=status.HTTP_201_CREATED)
def create_view(
    view: SemanticViewCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_edit),
):
    """Create a new semantic view"""
    from app.models.dataset import Dataset, DatasetTable
    from app.models.models import DataSource
    from app.services.dataset_model_service import (
        _resolve_dataset_dialect,
        _sql_table_for_table,
    )

    # Check if name already exists
    existing = db.query(SemanticView).filter(SemanticView.name == view.name).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"View with name '{view.name}' already exists"
        )

    # Phase-4 originally blocked any dual binding; Phase-5 narrows that:
    # physical_table views on remote datasources (BigQuery, schema-qualified
    # Postgres) NEED `sql_table_name` to hold the fully-qualified target
    # (e.g. `project.dataset.table`). The engine emits `sql_table_name` in
    # FROM and uses `dataset_table_id` for metadata. Both required.
    #
    # We only reject the truly ambiguous case: user explicitly typed a
    # sql_table_name that contradicts the dataset table's own source path.
    # That's a real foot-gun (the engine and the metadata would disagree),
    # so we surface it as a 400 with a clear message.

    resolved_sql_table_name = view.sql_table_name
    dataset_table_id = view.dataset_table_id
    dataset_table = None

    if dataset_table_id is not None:
        dataset_table = (
            db.query(DatasetTable)
            .filter(DatasetTable.id == dataset_table_id)
            .first()
        )
        if not dataset_table:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Dataset table with ID {dataset_table_id} not found",
            )
        existing_for_table = (
            db.query(SemanticView)
            .filter(SemanticView.dataset_table_id == dataset_table_id)
            .first()
        )
        if existing_for_table:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Semantic view for dataset_table_id={dataset_table_id} already exists",
            )

        if not resolved_sql_table_name:
            dataset_obj = (
                db.query(Dataset)
                .filter(Dataset.id == dataset_table.dataset_id)
                .first()
            )
            if not dataset_obj:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Dataset {dataset_table.dataset_id} not found",
                )
            datasource = None
            if getattr(dataset_table, "datasource_id", None) is not None:
                datasource = (
                    db.query(DataSource)
                    .filter(DataSource.id == dataset_table.datasource_id)
                    .first()
                )
            calendar_dialect = _resolve_dataset_dialect(
                [datasource] if datasource is not None else []
            )
            resolved_sql_table_name = _sql_table_for_table(
                dataset_obj,
                dataset_table,
                calendar_dialect=calendar_dialect,
                datasource=datasource,
                # Phase 6 (#41): pass db so derived tables resolve through the ONE
                # preview-parity renderer (dependency CTEs + aliases) instead of
                # the legacy raw-wrap fallback that diverges from chart runtime.
                db=db,
            )

    # Validate that sql_table_name is provided directly or can be resolved from dataset_table_id
    if not resolved_sql_table_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Either sql_table_name or dataset_table_id must be provided",
        )

    # Phase-12: run cross-reference measure validation (parity with the
    # dataset-scoped endpoint). dataset_table is resolved a few blocks up
    # when dataset_table_id is supplied; if it was a sql_table_name-only
    # view we cannot run dataset-scoped checks, but the per-measure
    # Pydantic model_validator already caught shape mismatches.
    if view.measures and dataset_table is not None:
        from app.api.datasets import _validate_measure_dependencies
        _validate_measure_dependencies(
            db,
            int(dataset_table.dataset_id),
            view.name,
            view.measures,
        )

    # Convert Pydantic models to dicts for JSON storage
    dimensions_data = [dim.model_dump() for dim in view.dimensions]
    measures_data = [measure.model_dump() for measure in view.measures]

    db_view = SemanticView(
        name=view.name,
        sql_table_name=resolved_sql_table_name,
        dataset_table_id=dataset_table_id,
        dimensions=dimensions_data,
        measures=measures_data,
        description=view.description,
    )

    db.add(db_view)
    db.commit()
    db.refresh(db_view)

    return db_view


@router.get("/views", response_model=List[SemanticViewSchema])
def list_views(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_view),
):
    """List all semantic views"""
    views = db.query(SemanticView).offset(skip).limit(limit).all()
    return views


@router.get("/views/{view_id}", response_model=SemanticViewSchema)
def get_view(
    view_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_view),
):
    """Get a semantic view by ID"""
    view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    return view


@router.put("/views/{view_id}", response_model=SemanticViewSchema)
def update_view(
    view_id: int,
    view_update: SemanticViewUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_edit),
):
    """Update a semantic view.

    Phase-12: also runs `_validate_measure_dependencies` so MCP callers
    (`update_semantic_view`) get the same cross-reference checks (depends_on
    cycles, scope/source_columns validation) as the dataset-scoped endpoint
    `PUT /datasets/{id}/model/views/{view_id}`. Without this, MCP paths
    bypass the cross-ref validator and DA only sees the error at chart
    preview time, far from the offending save.
    """
    db_view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not db_view:
        raise HTTPException(status_code=404, detail="View not found")

    update_data = view_update.model_dump(exclude_unset=True)

    # Phase-12: resolve dataset_id (view → table → dataset) so the validator
    # can cross-check source_columns against the model's other views.
    dataset_id_for_check: Optional[int] = None
    try:
        from app.models.dataset import DatasetTable as _DatasetTable  # local import to avoid cycles
        if db_view.dataset_table_id:
            table_row = (
                db.query(_DatasetTable)
                .filter(_DatasetTable.id == db_view.dataset_table_id)
                .first()
            )
            if table_row:
                dataset_id_for_check = int(table_row.dataset_id)
    except Exception:
        dataset_id_for_check = None

    if (
        "measures" in update_data
        and update_data["measures"] is not None
        and dataset_id_for_check is not None
    ):
        from app.api.datasets import _validate_measure_dependencies
        _validate_measure_dependencies(
            db,
            dataset_id_for_check,
            db_view.name,
            view_update.measures or [],
        )

    # Convert Pydantic models to dicts if present
    if "dimensions" in update_data and update_data["dimensions"] is not None:
        update_data["dimensions"] = [dim.model_dump() for dim in view_update.dimensions]
    if "measures" in update_data and update_data["measures"] is not None:
        update_data["measures"] = [measure.model_dump() for measure in view_update.measures]

    for key, value in update_data.items():
        setattr(db_view, key, value)

    db.commit()
    db.refresh(db_view)

    return db_view


@router.delete("/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_view(
    view_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_full),
):
    """Delete a semantic view"""
    db_view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not db_view:
        raise HTTPException(status_code=404, detail="View not found")
    
    db.delete(db_view)
    db.commit()
    
    return None


# ============ Semantic Models ============

@router.post("/models", response_model=SemanticModelSchema, status_code=status.HTTP_201_CREATED)
def create_model(
    model: SemanticModelCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_edit),
):
    """Create a new semantic model"""
    from app.models.dataset import Dataset

    existing = db.query(SemanticModel).filter(SemanticModel.name == model.name).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Model with name '{model.name}' already exists"
        )

    if model.dataset_id is not None:
        dataset_obj = db.query(Dataset).filter(Dataset.id == model.dataset_id).first()
        if not dataset_obj:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Dataset with ID {model.dataset_id} not found",
            )
        existing_for_dataset = (
            db.query(SemanticModel)
            .filter(SemanticModel.dataset_id == model.dataset_id)
            .first()
        )
        if existing_for_dataset:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Semantic model for dataset_id={model.dataset_id} already exists",
            )

    db_model = SemanticModel(
        name=model.name,
        dataset_id=model.dataset_id,
        description=model.description,
    )

    db.add(db_model)
    db.commit()
    db.refresh(db_model)

    return db_model


@router.get("/models", response_model=List[SemanticModelSchema])
def list_models(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_view),
):
    """List all semantic models"""
    models = db.query(SemanticModel).offset(skip).limit(limit).all()
    return models


@router.get("/models/{model_id}", response_model=SemanticModelSchema)
def get_model(
    model_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_view),
):
    """Get a semantic model by ID"""
    model = db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    return model


@router.put("/models/{model_id}", response_model=SemanticModelSchema)
def update_model(
    model_id: int,
    model_update: SemanticModelUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_edit),
):
    """Update a semantic model"""
    db_model = db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
    if not db_model:
        raise HTTPException(status_code=404, detail="Model not found")
    
    update_data = model_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_model, key, value)
    
    db.commit()
    db.refresh(db_model)
    
    return db_model


@router.delete("/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(
    model_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_full),
):
    """Delete a semantic model"""
    db_model = db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
    if not db_model:
        raise HTTPException(status_code=404, detail="Model not found")
    
    db.delete(db_model)
    db.commit()
    
    return None


# ============ Semantic Explores ============

@router.post("/explores", response_model=SemanticExploreSchema, status_code=status.HTTP_201_CREATED)
def create_explore(
    explore: SemanticExploreCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_edit),
):
    """Create a new semantic explore"""
    # Verify model exists
    model = db.query(SemanticModel).filter(SemanticModel.id == explore.model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    
    # Verify base view exists
    view = db.query(SemanticView).filter(SemanticView.id == explore.base_view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Base view not found")
    
    # Convert joins to dicts
    joins_data = [join.model_dump() for join in explore.joins]
    
    db_explore = SemanticExplore(
        name=explore.name,
        model_id=explore.model_id,
        base_view_id=explore.base_view_id,
        base_view_name=explore.base_view_name,
        joins=joins_data,
        default_filters=explore.default_filters,
        description=explore.description,
    )
    
    db.add(db_explore)
    db.commit()
    db.refresh(db_explore)
    
    return db_explore


@router.get("/explores", response_model=List[SemanticExploreSchema])
def list_explores(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_view),
):
    """List all semantic explores"""
    explores = db.query(SemanticExplore).offset(skip).limit(limit).all()
    return explores


@router.get("/explores/{explore_id}", response_model=SemanticExploreSchema)
def get_explore(
    explore_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_view),
):
    """Get a semantic explore by ID"""
    explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    return explore


@router.get("/explores/by-name/{explore_name}", response_model=SemanticExploreSchema)
def get_explore_by_name(
    explore_name: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_view),
):
    """Get a semantic explore by name"""
    explore = db.query(SemanticExplore).filter(SemanticExplore.name == explore_name).first()
    if not explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    return explore


@router.put("/explores/{explore_id}", response_model=SemanticExploreSchema)
def update_explore(
    explore_id: int,
    explore_update: SemanticExploreUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_edit),
):
    """Update a semantic explore"""
    db_explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not db_explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    
    update_data = explore_update.model_dump(exclude_unset=True)
    
    # Convert joins to dicts if present
    if "joins" in update_data and update_data["joins"] is not None:
        update_data["joins"] = [join.model_dump() for join in explore_update.joins]
    
    for key, value in update_data.items():
        setattr(db_explore, key, value)
    
    db.commit()
    db.refresh(db_explore)
    
    return db_explore


@router.delete("/explores/{explore_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_explore(
    explore_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_full),
):
    """Delete a semantic explore"""
    db_explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not db_explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    
    db.delete(db_explore)
    db.commit()
    
    return None


# ============ Semantic Query Execution ============

@router.post("/query", response_model=SemanticQueryResponse)
def execute_semantic_query(
    query_request: SemanticQueryRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_semantic_view),
):
    """
    Execute a semantic query
    Generates SQL from semantic definitions and executes it
    """
    start_time = time.time()
    
    try:
        # Resolve the explore — bound to a SPECIFIC model when model_id is given
        # (PowerBI binds a query to one model). Name-only is allowed for
        # convenience, but if the name is AMBIGUOUS across models we FAIL LOUD
        # rather than silently picking one (wrong model → wrong source/numbers).
        _explore_q = db.query(SemanticExplore).filter(
            SemanticExplore.name == query_request.explore
        )
        if query_request.model_id is not None:
            _explore_q = _explore_q.filter(SemanticExplore.model_id == query_request.model_id)
        _explores = _explore_q.all()
        if not _explores:
            raise HTTPException(status_code=404, detail="Explore not found")
        if len(_explores) > 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Explore name '{query_request.explore}' tồn tại ở "
                    f"{len(_explores)} model — không xác định được model. Truyền "
                    f"`model_id` để chỉ định (PowerBI gắn query vào 1 model cụ thể)."
                ),
            )
        explore = _explores[0]

        base_view = db.query(SemanticView).filter(
            SemanticView.id == explore.base_view_id
        ).first()

        # Phase-12.6: resolve real datasource dialect via the base view's
        # owning table → datasource chain. Previously this hardcoded
        # "postgresql" in BOTH branches (DA flagged 2026-05-16), defeating
        # Phase-5 multi-dialect support: BigQuery / MySQL / DuckDB queries
        # got PostgreSQL-flavoured SQL and crashed at execution.
        from app.models.dataset import DatasetTable as _DatasetTable
        from app.models.models import DataSource as _DataSource
        from app.services.live_query_service import _dialect_for_ds_type

        resolved_datasource = None
        if base_view and base_view.dataset_table_id:
            table_row = (
                db.query(_DatasetTable)
                .filter(_DatasetTable.id == base_view.dataset_table_id)
                .first()
            )
            if table_row and table_row.datasource_id:
                resolved_datasource = (
                    db.query(_DataSource)
                    .filter(_DataSource.id == table_row.datasource_id)
                    .first()
                )
        if resolved_datasource is None:
            # STRICT (PowerBI parity): NO `DataSource.first()` guess. An explore
            # whose base view doesn't anchor to a dataset_table + datasource has
            # no DEFINED source — guessing "any datasource" risks running the SQL
            # against the wrong source (wrong dialect / wrong data) and silently
            # returning wrong numbers. Fail loud so the modeller anchors the
            # explore's base table to a datasource in the Data Model.
            raise HTTPException(
                status_code=400,
                detail=(
                    "Explore không gắn datasource (base view chưa liên kết "
                    "dataset_table có datasource). Gắn bảng nguồn cho explore "
                    "trong Data Model rồi chạy lại."
                ),
            )

        ds_type_val = (
            resolved_datasource.type if isinstance(resolved_datasource.type, str)
            else resolved_datasource.type.value
        )
        db_type = _dialect_for_ds_type(ds_type_val)

        # Unified engine entry — compile the request to a SemanticQuerySpec (the
        # SAME contract chart + preview use) and run it. The direct API sends
        # pre-qualified refs (no role reclassification — that is its contract).
        from app.services.semantic_query_compiler import compile_from_semantic_request
        engine = SemanticQueryEngine(db, database_type=db_type)
        sql, columns, pivot_metadata = engine.run(compile_from_semantic_request(query_request))
        
        # Phase-12.6: reuse the datasource already resolved above so SQL
        # generation dialect matches execution datasource. Previously this
        # block re-queried `DataSource.first()` independently, which could
        # pick a DIFFERENT datasource than the one used for the dialect
        # decision — silent inconsistency.
        data_source = resolved_datasource
        if not data_source:
            raise HTTPException(status_code=404, detail="No data source available")
        
        # Execute SQL using DataSourceConnectionService.
        # Phase-12.7: unwrap enum → str so DataSourceConnectionService gets
        # the type as a string (it does `ds_type == DataSourceType.X.value`
        # equality checks which would silently miss for enum input).
        exec_ds_type = (
            data_source.type if isinstance(data_source.type, str)
            else data_source.type.value
        )
        # Note: SemanticQueryEngine already adds LIMIT, so don't pass limit again
        columns, data, exec_time = DataSourceConnectionService.execute_query(
            ds_type=exec_ds_type,
            config=data_source.config,
            sql_query=sql,
            limit=None  # Already included in SQL
        )

        return SemanticQueryResponse(
            sql=sql,
            columns=columns,
            data=data,
            row_count=len(data),
            execution_time_ms=exec_time,
            pivoted_columns=pivot_metadata,
            warnings=engine.warnings
        )

    except HTTPException:
        # Inner HTTPException (eg explore-not-found 404) bubbles unchanged
        # so FastAPI uses the original status code instead of being
        # re-wrapped as 500 by the generic handler below.
        raise
    except ValueError as e:
        # Phase-11 friendly VN message for unreachable views / missing
        # fields. Keep the engine's text; surface dialect for debug ease.
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Log full stack — DA was hitting "Query execution failed: ..."
        # generic 500s with no debugging info. Include explore name +
        # resolved dialect (if we got that far) so the cause is locatable
        # from logs alone.
        logger.exception(
            "execute_semantic_query failed: explore=%s dialect=%s",
            getattr(query_request, "explore", None),
            locals().get("db_type") or "<not_resolved>",
        )
        raise HTTPException(
            status_code=500,
            detail=f"Lỗi chạy semantic query: {e}. Báo dev kèm log nếu lặp lại.",
        )
