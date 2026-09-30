"""
Semantic Layer API Routes
Endpoints for managing semantic views, models, explores, and executing semantic queries
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.core.dependencies import (
    get_effective_permission,
    require_edit_access,
    require_full_access,
    require_permission,
    require_view_access,
)
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


# ============ Object-level access ============
#
# Every semantic object belongs to ONE dataset: a model by `dataset_id`, a view
# by `dataset_table -> dataset`, an explore by `model -> dataset`. The module
# gate above only says the user may use the Datasets module at all; the object
# is readable/editable only when the user may read/edit THAT dataset — the same
# `require_*_access` rule the dataset-scoped endpoints (`api/datasets.py`) use.
# Without it any module user could read every model and rewrite any dataset's
# joins and measures through this router.
#
# An object with no dataset (legacy, pre-dataset rows) has no owner to ask, so
# only a module administrator (`datasets: full`) may touch it.

_LEVELS = {"none": 0, "view": 1, "edit": 2, "full": 3}


def _dataset_of_view(db: Session, view: SemanticView):
    from app.models.dataset import Dataset, DatasetTable

    if not getattr(view, "dataset_table_id", None):
        return None
    table = db.query(DatasetTable).filter(DatasetTable.id == view.dataset_table_id).first()
    if table is None:
        return None
    return db.query(Dataset).filter(Dataset.id == table.dataset_id).first()


def _dataset_of_model(db: Session, model: SemanticModel):
    from app.models.dataset import Dataset

    if getattr(model, "dataset_id", None) is None:
        return None
    return db.query(Dataset).filter(Dataset.id == model.dataset_id).first()


def _dataset_of_explore(db: Session, explore: SemanticExplore):
    model = db.query(SemanticModel).filter(SemanticModel.id == explore.model_id).first()
    return _dataset_of_model(db, model) if model is not None else None


def _module_level(user: User) -> str:
    from app.core.dependencies import _normalize_permissions

    return str(_normalize_permissions(user).get("datasets", "none") or "none")


def _require_dataset_level(db: Session, user: User, dataset, level: str) -> None:
    if dataset is None:
        if _module_level(user) != "full":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Permission denied: object has no dataset; datasets full access required",
            )
        return
    if level == "view":
        require_view_access(db, user, dataset, "datasets")
    elif level == "edit":
        require_edit_access(db, user, dataset, "datasets")
    else:
        require_full_access(db, user, dataset, "datasets")


def _can_view_dataset(db: Session, user: User, dataset, cache: dict) -> bool:
    key = getattr(dataset, "id", None)
    if key not in cache:
        if dataset is None:
            cache[key] = _module_level(user) == "full"
        else:
            cache[key] = get_effective_permission(db, user, dataset, "datasets") != "none"
    return cache[key]


# ============ Semantic Views ============

@router.post("/views", response_model=SemanticViewSchema, status_code=status.HTTP_201_CREATED)
def create_view(
    view: SemanticViewCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_edit),
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
        _require_dataset_level(
            db, current_user,
            db.query(Dataset).filter(Dataset.id == dataset_table.dataset_id).first(),
            "edit",
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

    if dataset_table is None:
        # A raw `sql_table_name` view belongs to no dataset: administrators only.
        _require_dataset_level(db, current_user, None, "edit")

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
    current_user: User = Depends(require_semantic_view),
):
    """List the semantic views of datasets the caller may read."""
    cache: dict = {}
    views = [
        v for v in db.query(SemanticView).order_by(SemanticView.id).all()
        if _can_view_dataset(db, current_user, _dataset_of_view(db, v), cache)
    ]
    return views[max(skip, 0): max(skip, 0) + max(limit, 0)]


@router.get("/views/{view_id}", response_model=SemanticViewSchema)
def get_view(
    view_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_view),
):
    """Get a semantic view by ID"""
    view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    _require_dataset_level(db, current_user, _dataset_of_view(db, view), "view")
    return view


@router.put("/views/{view_id}", response_model=SemanticViewSchema)
def update_view(
    view_id: int,
    view_update: SemanticViewUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_edit),
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
    _require_dataset_level(db, current_user, _dataset_of_view(db, db_view), "edit")

    update_data = view_update.model_dump(exclude_unset=True)
    if (
        "dataset_table_id" in update_data
        and update_data["dataset_table_id"] != db_view.dataset_table_id
    ):
        # Re-pointing a view at another table moves it between datasets and
        # changes what every chart on it reads; that is not an edit of a view.
        raise HTTPException(
            status_code=400,
            detail="Không đổi dataset_table_id của view qua API này — tạo view mới cho bảng khác.",
        )

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
    current_user: User = Depends(require_semantic_full),
):
    """Delete a semantic view"""
    db_view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not db_view:
        raise HTTPException(status_code=404, detail="View not found")
    _require_dataset_level(db, current_user, _dataset_of_view(db, db_view), "full")

    db.delete(db_view)
    db.commit()
    
    return None


# ============ Semantic Models ============

@router.post("/models", response_model=SemanticModelSchema, status_code=status.HTTP_201_CREATED)
def create_model(
    model: SemanticModelCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_edit),
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
        _require_dataset_level(db, current_user, dataset_obj, "edit")
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

    if model.dataset_id is None:
        _require_dataset_level(db, current_user, None, "edit")

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
    current_user: User = Depends(require_semantic_view),
):
    """List the semantic models of datasets the caller may read."""
    cache: dict = {}
    models = [
        m for m in db.query(SemanticModel).order_by(SemanticModel.id).all()
        if _can_view_dataset(db, current_user, _dataset_of_model(db, m), cache)
    ]
    return models[max(skip, 0): max(skip, 0) + max(limit, 0)]


@router.get("/models/{model_id}", response_model=SemanticModelSchema)
def get_model(
    model_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_view),
):
    """Get a semantic model by ID"""
    model = db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    _require_dataset_level(db, current_user, _dataset_of_model(db, model), "view")
    return model


@router.put("/models/{model_id}", response_model=SemanticModelSchema)
def update_model(
    model_id: int,
    model_update: SemanticModelUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_edit),
):
    """Update a semantic model"""
    db_model = db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
    if not db_model:
        raise HTTPException(status_code=404, detail="Model not found")
    _require_dataset_level(db, current_user, _dataset_of_model(db, db_model), "edit")

    update_data = model_update.model_dump(exclude_unset=True)
    if "dataset_id" in update_data and update_data["dataset_id"] != db_model.dataset_id:
        # Moving a model to another dataset would hand its explores (and every
        # chart bound to them) to that dataset's viewers.
        raise HTTPException(
            status_code=400,
            detail="Không đổi dataset_id của model qua API này.",
        )
    for key, value in update_data.items():
        setattr(db_model, key, value)
    
    db.commit()
    db.refresh(db_model)
    
    return db_model


@router.delete("/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(
    model_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_full),
):
    """Delete a semantic model"""
    db_model = db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
    if not db_model:
        raise HTTPException(status_code=404, detail="Model not found")
    _require_dataset_level(db, current_user, _dataset_of_model(db, db_model), "full")

    db.delete(db_model)
    db.commit()
    
    return None


# ============ Semantic Explores ============

def _check_view_belongs(db: Session, view: SemanticView, dataset, base_view_name: str) -> None:
    """The explore's base view must be a view of the explore's own dataset."""
    view_dataset = _dataset_of_view(db, view)
    if getattr(view_dataset, "id", None) != getattr(dataset, "id", None):
        raise HTTPException(status_code=400, detail="Base view không thuộc dataset của model.")
    if base_view_name and base_view_name != view.name:
        raise HTTPException(
            status_code=400,
            detail=f"base_view_name '{base_view_name}' không khớp view id={view.id} ('{view.name}').",
        )


def _validated_joins(db: Session, dataset, base_view_name: str, joins: list) -> list:
    from app.services.dataset_model_service import validate_direct_explore_joins

    try:
        return validate_direct_explore_joins(
            db, getattr(dataset, "id", None), base_view_name, joins,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/explores", response_model=SemanticExploreSchema, status_code=status.HTTP_201_CREATED)
def create_explore(
    explore: SemanticExploreCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_edit),
):
    """Create a new semantic explore"""
    # Verify model exists
    model = db.query(SemanticModel).filter(SemanticModel.id == explore.model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    model_dataset = _dataset_of_model(db, model)
    _require_dataset_level(db, current_user, model_dataset, "edit")

    # Verify base view exists
    view = db.query(SemanticView).filter(SemanticView.id == explore.base_view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="Base view not found")
    _check_view_belongs(db, view, model_dataset, explore.base_view_name)

    joins_data = _validated_joins(
        db, model_dataset, explore.base_view_name, [join.model_dump() for join in explore.joins],
    )

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
    current_user: User = Depends(require_semantic_view),
):
    """List the semantic explores of datasets the caller may read."""
    cache: dict = {}
    explores = [
        e for e in db.query(SemanticExplore).order_by(SemanticExplore.id).all()
        if _can_view_dataset(db, current_user, _dataset_of_explore(db, e), cache)
    ]
    return explores[max(skip, 0): max(skip, 0) + max(limit, 0)]


@router.get("/explores/{explore_id}", response_model=SemanticExploreSchema)
def get_explore(
    explore_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_view),
):
    """Get a semantic explore by ID"""
    explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    _require_dataset_level(db, current_user, _dataset_of_explore(db, explore), "view")
    return explore


@router.get("/explores/by-name/{explore_name}", response_model=SemanticExploreSchema)
def get_explore_by_name(
    explore_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_view),
):
    """Get a semantic explore by name (among the explores the caller may read).

    A name is not unique across models; one readable match is returned, and
    several readable matches are refused rather than picking one."""
    cache: dict = {}
    matches = [
        e for e in db.query(SemanticExplore).filter(SemanticExplore.name == explore_name).all()
        if _can_view_dataset(db, current_user, _dataset_of_explore(db, e), cache)
    ]
    if not matches:
        raise HTTPException(status_code=404, detail="Explore not found")
    if len(matches) > 1:
        raise HTTPException(
            status_code=400,
            detail=f"Explore name '{explore_name}' tồn tại ở {len(matches)} model — dùng /explores/{{id}}.",
        )
    return matches[0]


@router.put("/explores/{explore_id}", response_model=SemanticExploreSchema)
def update_explore(
    explore_id: int,
    explore_update: SemanticExploreUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_edit),
):
    """Update a semantic explore"""
    db_explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not db_explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    model_dataset = _dataset_of_explore(db, db_explore)
    _require_dataset_level(db, current_user, model_dataset, "edit")

    update_data = explore_update.model_dump(exclude_unset=True)
    base_view_name = update_data.get("base_view_name") or db_explore.base_view_name
    if update_data.get("base_view_id") is not None:
        new_base = db.query(SemanticView).filter(SemanticView.id == update_data["base_view_id"]).first()
        if not new_base:
            raise HTTPException(status_code=404, detail="Base view not found")
        _check_view_belongs(db, new_base, model_dataset, base_view_name)

    # Joins go through the same structural checks as the dataset endpoint.
    if "joins" in update_data and update_data["joins"] is not None:
        update_data["joins"] = _validated_joins(
            db, model_dataset, base_view_name,
            [join.model_dump() for join in explore_update.joins],
        )

    for key, value in update_data.items():
        setattr(db_explore, key, value)
    
    db.commit()
    db.refresh(db_explore)
    
    return db_explore


@router.delete("/explores/{explore_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_explore(
    explore_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_full),
):
    """Delete a semantic explore"""
    db_explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not db_explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    _require_dataset_level(db, current_user, _dataset_of_explore(db, db_explore), "full")

    db.delete(db_explore)
    db.commit()
    
    return None


# ============ Semantic Query Execution ============

@router.post("/query", response_model=SemanticQueryResponse)
def execute_semantic_query(
    query_request: SemanticQueryRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_semantic_view),
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
        # Only explores of datasets the caller may read exist for this request —
        # the query returns warehouse rows, so this is a data-exposure gate.
        _cache: dict = {}
        _explores = [
            e for e in _explore_q.all()
            if _can_view_dataset(db, current_user, _dataset_of_explore(db, e), _cache)
        ]
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
        # Pin the engine to THIS explore's model: it resolves the explore by
        # name again, and a same-named explore in a model the caller cannot
        # read must not be the one it finds.
        query_request = query_request.model_copy(update={"model_id": explore.model_id})

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
