"""
API router for dataset endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from typing import Any, Dict, List, Optional
import os

from app.core import get_db
from app.models.models import Chart, Dataset, SyncJobRun
from app.schemas import (
    DatasetCreate,
    DatasetUpdate,
    DatasetResponse,
    DatasetExecuteRequest,
    DatasetExecuteResponse,
    DatasetPreviewRequest,
    DatasetPreviewResponse,
    DatasetMaterializeRequest,
    DatasetMaterializeResponse,
    ColumnMetadata
)
from app.services import DatasetService
from app.core.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/datasets", tags=["datasets"])


@router.get("/", response_model=List[DatasetResponse])
def list_datasets(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    """List all datasets with pagination."""
    return DatasetService.get_all(db, skip=skip, limit=limit)


@router.get("/{dataset_id}", response_model=DatasetResponse)
def get_dataset(dataset_id: int, db: Session = Depends(get_db)):
    """Get a dataset by ID."""
    dataset = DatasetService.get_by_id(db, dataset_id)
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset with ID {dataset_id} not found"
        )
    return dataset


@router.post("/", response_model=DatasetResponse, status_code=status.HTTP_201_CREATED)
def create_dataset(dataset: DatasetCreate, db: Session = Depends(get_db)):
    """Create a new dataset."""
    try:
        return DatasetService.create(db, dataset)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{dataset_id}", response_model=DatasetResponse)
def update_dataset(
    dataset_id: int,
    dataset_update: DatasetUpdate,
    db: Session = Depends(get_db)
):
    """Update a dataset."""
    try:
        dataset = DatasetService.update(db, dataset_id, dataset_update)
        if not dataset:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Dataset with ID {dataset_id} not found"
            )
        return dataset
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, db: Session = Depends(get_db)):
    """Delete a dataset, blocked if any charts still reference it."""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset with ID {dataset_id} not found"
        )

    blocking_charts = db.query(Chart).filter(Chart.dataset_id == dataset_id).all()
    if blocking_charts:
        names = ", ".join(f'"{c.name}"' for c in blocking_charts)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": f"Dataset \"{dataset.name}\" đang được sử dụng bởi {len(blocking_charts)} chart và không thể xóa.",
                "constraints": [
                    {"type": "chart", "id": c.id, "name": c.name}
                    for c in blocking_charts
                ],
            },
        )

    success = DatasetService.delete(db, dataset_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Dataset with ID {dataset_id} not found"
        )


@router.post("/{dataset_id}/execute", response_model=DatasetExecuteResponse)
def execute_dataset(
    dataset_id: int,
    request: DatasetExecuteRequest,
    db: Session = Depends(get_db)
):
    """Execute a dataset query and return the results with optional transformations."""
    try:
        result = DatasetService.execute(
            db, 
            dataset_id, 
            request.limit,
            apply_transformations=request.apply_transformations
        )
        return DatasetExecuteResponse(**result)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Dataset execution failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Dataset execution failed: {str(e)}"
        )


@router.post("/preview", response_model=DatasetPreviewResponse)
def preview_adhoc_dataset(
    request: DatasetPreviewRequest,
    db: Session = Depends(get_db)
):
    """
    Preview an ad-hoc dataset query (without saving).
    Used for dataset designer/creation flow.
    """
    from app.models import DataSource
    
    try:
        # Validate required fields for ad-hoc preview
        if not request.data_source_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="data_source_id is required for ad-hoc preview"
            )
        if not request.sql_query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="sql_query is required for ad-hoc preview"
            )
        
        # Get data source
        data_source = db.query(DataSource).filter(DataSource.id == request.data_source_id).first()
        if not data_source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"DataSource with ID {request.data_source_id} not found"
            )
        
        # Execute preview using the service with ad-hoc parameters
        result = DatasetService.preview_adhoc(
            db=db,
            data_source_id=request.data_source_id,
            sql_query=request.sql_query,
            transformations=request.transformations or [],
            stop_at_step_id=request.stop_at_step_id,
            limit=request.limit
        )
        
        return DatasetPreviewResponse(**result)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ad-hoc preview failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Preview failed: {str(e)}"
        )


@router.post("/{dataset_id}/preview", response_model=DatasetPreviewResponse)
def preview_dataset(
    dataset_id: int,
    request: DatasetPreviewRequest,
    db: Session = Depends(get_db)
):
    """
    Preview dataset with transformations applied up to a specific step.
    Returns column schema and sample data.
    """
    try:
        # Get dataset
        dataset = DatasetService.get_by_id(db, dataset_id)
        if not dataset:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Dataset with ID {dataset_id} not found"
            )
        
        data_source = dataset.data_source
        
        # Compile SQL with transformations up to stop_at_step_id
        if request.apply_transformations and dataset.transformations:
            from app.services.dataset_service import compile_transformed_sql
            compiled_sql = compile_transformed_sql(
                db,
                dataset,
                stop_at_step_id=request.stop_at_step_id
            )
        else:
            compiled_sql = dataset.sql_query
        
        # Execute query with limit
        from app.services.datasource_service import DataSourceConnectionService
        columns, data, _ = DataSourceConnectionService.execute_query(
            data_source.type.value,
            data_source.config,
            compiled_sql,
            request.limit,
            30  # timeout
        )
        
        # Infer column schema
        from app.services.schema_inference import infer_schema_from_sql
        column_metadata = infer_schema_from_sql(
            db,
            data_source,
            compiled_sql,
            timeout=30
        )
        
        # Include compiled SQL if debug flag is set
        include_sql = os.environ.get('INCLUDE_COMPILED_SQL', 'false').lower() == 'true'
        
        return DatasetPreviewResponse(
            columns=column_metadata,
            data=data,
            row_count=len(data),
            step_id=request.stop_at_step_id,
            compiled_sql=compiled_sql if include_sql else None
        )
    
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Dataset preview failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Dataset preview failed: {str(e)}"
        )


@router.post("/{dataset_id}/materialize", response_model=DatasetMaterializeResponse)
def materialize_dataset(
    dataset_id: int,
    request: DatasetMaterializeRequest,
    db: Session = Depends(get_db)
):
    """
    Materialize dataset as VIEW or TABLE.
    """
    try:
        dataset = DatasetService.get_by_id(db, dataset_id)
        if not dataset:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Dataset with ID {dataset_id} not found"
            )
        
        if request.mode not in ('none', 'view', 'table'):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Mode must be 'none', 'view', or 'table'"
            )
        
        # If mode is 'none', dematerialize
        if request.mode == 'none':
            from app.services.materialization_service import dematerialize_dataset
            result = dematerialize_dataset(db, dataset)
            return DatasetMaterializeResponse(
                success=result['success'],
                message=result['message'],
                materialization=result.get('materialization', {})
            )
        
        # Materialize as view or table
        from app.services.materialization_service import materialize_dataset as do_materialize
        result = do_materialize(
            db,
            dataset,
            mode=request.mode,
            custom_name=request.name,
            custom_schema=request.schema
        )
        
        return DatasetMaterializeResponse(
            success=result['success'],
            message=result['message'],
            materialization=result.get('materialization', {})
        )
    
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Materialization failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Materialization failed: {str(e)}"
        )


@router.post("/{dataset_id}/refresh", response_model=DatasetMaterializeResponse)
def refresh_dataset(
    dataset_id: int,
    db: Session = Depends(get_db)
):
    """
    Refresh materialized VIEW or TABLE.
    """
    try:
        dataset = DatasetService.get_by_id(db, dataset_id)
        if not dataset:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Dataset with ID {dataset_id} not found"
            )
        
        if not dataset.materialization or dataset.materialization.get('mode') == 'none':
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Dataset is not materialized"
            )
        
        from app.services.materialization_service import refresh_materialized_dataset
        result = refresh_materialized_dataset(db, dataset)
        
        return DatasetMaterializeResponse(
            success=result['success'],
            message=result['message'],
            materialization=result.get('materialization', {})
        )
    
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Refresh failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Refresh failed: {str(e)}"
        )


@router.post("/{dataset_id}/dematerialize", response_model=DatasetMaterializeResponse)
def dematerialize_dataset_endpoint(
    dataset_id: int,
    db: Session = Depends(get_db)
):
    """
    Dematerialize dataset (drop VIEW/TABLE).
    """
    try:
        dataset = DatasetService.get_by_id(db, dataset_id)
        if not dataset:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Dataset with ID {dataset_id} not found"
            )
        
        from app.services.materialization_service import dematerialize_dataset
        result = dematerialize_dataset(db, dataset)
        
        return DatasetMaterializeResponse(
            success=result['success'],
            message=result['message'],
            materialization=result.get('materialization', {})
        )
    
    except Exception as e:
        logger.error(f"Dematerialization failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Dematerialization failed: {str(e)}"
        )


# ── Dataset Sync endpoints ──────────────────────────────────────────────────


@router.post("/{dataset_id}/sync/trigger")
def trigger_sync(
    dataset_id: int,
    mode: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """
    Manually trigger a dataset sync.
    Optional query param ?mode=full_refresh|incremental|append_only
    to override the configured mode.
    """
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    from app.services.dataset_sync_engine import trigger_dataset_sync
    try:
        job_run_id = trigger_dataset_sync(
            dataset_id, db, triggered_by="api", mode_override=mode
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return {"job_run_id": job_run_id, "status": "running"}


@router.get("/{dataset_id}/sync/status")
def sync_status(dataset_id: int, db: Session = Depends(get_db)):
    """Return the latest sync job run for the dataset."""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    latest = (
        db.query(SyncJobRun)
        .filter(SyncJobRun.dataset_id == dataset_id)
        .order_by(SyncJobRun.started_at.desc())
        .first()
    )
    if not latest:
        return {"sync": None}

    return {
        "sync": {
            "id": latest.id,
            "mode": latest.mode,
            "status": latest.status,
            "rows_pulled": latest.rows_pulled,
            "duration_seconds": latest.duration_seconds,
            "error": latest.error,
            "started_at": latest.started_at.isoformat() if latest.started_at else None,
            "finished_at": latest.finished_at.isoformat() if latest.finished_at else None,
        }
    }


@router.get("/{dataset_id}/sync/history")
def sync_history(
    dataset_id: int,
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Return paginated sync job run history for the dataset."""
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    total = db.query(SyncJobRun).filter(SyncJobRun.dataset_id == dataset_id).count()
    runs = (
        db.query(SyncJobRun)
        .filter(SyncJobRun.dataset_id == dataset_id)
        .order_by(SyncJobRun.started_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "mode": r.mode,
                "status": r.status,
                "rows_pulled": r.rows_pulled,
                "duration_seconds": r.duration_seconds,
                "error": r.error,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            }
            for r in runs
        ],
    }


@router.put("/{dataset_id}/sync-config")
def update_sync_config(
    dataset_id: int,
    body: Dict[str, Any],
    db: Session = Depends(get_db),
):
    """
    Save sync_config on a dataset and update the scheduler.

    Expected body example:
    {
      "mode": "full_refresh",
      "schedule": {"enabled": true, "type": "interval", "interval_hours": 6},
      "watermark_column": null
    }
    """
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    dataset.sync_config = body
    db.commit()
    db.refresh(dataset)

    # Update scheduler
    from app.services.dataset_sync_scheduler import register_dataset
    register_dataset(dataset_id, body)

    return {"sync_config": dataset.sync_config}
