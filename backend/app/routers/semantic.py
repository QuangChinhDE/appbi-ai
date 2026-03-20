"""
Semantic Layer API Routes
Endpoints for managing semantic views, models, explores, and executing semantic queries
"""
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.models.semantic import SemanticView, SemanticModel, SemanticExplore
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
from app.services.semantic_query_engine_v2 import SemanticQueryEngineV2
from app.services.datasource_service import DataSourceConnectionService
import time

router = APIRouter(prefix="/semantic", tags=["semantic"])


# ============ Semantic Views ============

@router.post("/views", response_model=SemanticViewSchema, status_code=status.HTTP_201_CREATED)
def create_view(view: SemanticViewCreate, db: Session = Depends(get_db)):
    """Create a new semantic view"""
    # Check if name already exists
    existing = db.query(SemanticView).filter(SemanticView.name == view.name).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"View with name '{view.name}' already exists"
        )
    
    # Validate that sql_table_name is provided
    if not view.sql_table_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="sql_table_name must be provided"
        )
    
    # Convert Pydantic models to dicts for JSON storage
    dimensions_data = [dim.model_dump() for dim in view.dimensions]
    measures_data = [measure.model_dump() for measure in view.measures]
    
    db_view = SemanticView(
        name=view.name,
        sql_table_name=view.sql_table_name,
        dimensions=dimensions_data,
        measures=measures_data,
        description=view.description,
    )
    
    db.add(db_view)
    db.commit()
    db.refresh(db_view)
    
    return db_view


@router.get("/views", response_model=List[SemanticViewSchema])
def list_views(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    """List all semantic views"""
    views = db.query(SemanticView).offset(skip).limit(limit).all()
    return views


@router.get("/views/{view_id}", response_model=SemanticViewSchema)
def get_view(view_id: int, db: Session = Depends(get_db)):
    """Get a semantic view by ID"""
    view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")
    return view


@router.put("/views/{view_id}", response_model=SemanticViewSchema)
def update_view(view_id: int, view_update: SemanticViewUpdate, db: Session = Depends(get_db)):
    """Update a semantic view"""
    db_view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not db_view:
        raise HTTPException(status_code=404, detail="View not found")
    
    update_data = view_update.model_dump(exclude_unset=True)
    
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
def delete_view(view_id: int, db: Session = Depends(get_db)):
    """Delete a semantic view"""
    db_view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not db_view:
        raise HTTPException(status_code=404, detail="View not found")
    
    db.delete(db_view)
    db.commit()
    
    return None


# ============ Semantic Models ============

@router.post("/models", response_model=SemanticModelSchema, status_code=status.HTTP_201_CREATED)
def create_model(model: SemanticModelCreate, db: Session = Depends(get_db)):
    """Create a new semantic model"""
    existing = db.query(SemanticModel).filter(SemanticModel.name == model.name).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Model with name '{model.name}' already exists"
        )
    
    db_model = SemanticModel(
        name=model.name,
        description=model.description,
    )
    
    db.add(db_model)
    db.commit()
    db.refresh(db_model)
    
    return db_model


@router.get("/models", response_model=List[SemanticModelSchema])
def list_models(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    """List all semantic models"""
    models = db.query(SemanticModel).offset(skip).limit(limit).all()
    return models


@router.get("/models/{model_id}", response_model=SemanticModelSchema)
def get_model(model_id: int, db: Session = Depends(get_db)):
    """Get a semantic model by ID"""
    model = db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    return model


@router.put("/models/{model_id}", response_model=SemanticModelSchema)
def update_model(model_id: int, model_update: SemanticModelUpdate, db: Session = Depends(get_db)):
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
def delete_model(model_id: int, db: Session = Depends(get_db)):
    """Delete a semantic model"""
    db_model = db.query(SemanticModel).filter(SemanticModel.id == model_id).first()
    if not db_model:
        raise HTTPException(status_code=404, detail="Model not found")
    
    db.delete(db_model)
    db.commit()
    
    return None


# ============ Semantic Explores ============

@router.post("/explores", response_model=SemanticExploreSchema, status_code=status.HTTP_201_CREATED)
def create_explore(explore: SemanticExploreCreate, db: Session = Depends(get_db)):
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
def list_explores(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    """List all semantic explores"""
    explores = db.query(SemanticExplore).offset(skip).limit(limit).all()
    return explores


@router.get("/explores/{explore_id}", response_model=SemanticExploreSchema)
def get_explore(explore_id: int, db: Session = Depends(get_db)):
    """Get a semantic explore by ID"""
    explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    return explore


@router.get("/explores/by-name/{explore_name}", response_model=SemanticExploreSchema)
def get_explore_by_name(explore_name: str, db: Session = Depends(get_db)):
    """Get a semantic explore by name"""
    explore = db.query(SemanticExplore).filter(SemanticExplore.name == explore_name).first()
    if not explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    return explore


@router.put("/explores/{explore_id}", response_model=SemanticExploreSchema)
def update_explore(explore_id: int, explore_update: SemanticExploreUpdate, db: Session = Depends(get_db)):
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
def delete_explore(explore_id: int, db: Session = Depends(get_db)):
    """Delete a semantic explore"""
    db_explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not db_explore:
        raise HTTPException(status_code=404, detail="Explore not found")
    
    db.delete(db_explore)
    db.commit()
    
    return None


# ============ Semantic Query Execution ============

@router.post("/query", response_model=SemanticQueryResponse)
def execute_semantic_query(query_request: SemanticQueryRequest, db: Session = Depends(get_db)):
    """
    Execute a semantic query
    Generates SQL from semantic definitions and executes it
    """
    start_time = time.time()
    
    try:
        # Get data source type for engine initialization
        explore = db.query(SemanticExplore).filter(
            SemanticExplore.name == query_request.explore
        ).first()
        
        if not explore:
            raise HTTPException(status_code=404, detail="Explore not found")
        
        base_view = db.query(SemanticView).filter(
            SemanticView.id == explore.base_view_id
        ).first()
        
        if base_view and base_view.sql_table_name:
            db_type = "postgresql"
        else:
            db_type = "postgresql"
        
        # Initialize query engine v2
        engine = SemanticQueryEngineV2(db, database_type=db_type)
        
        # Generate SQL with v2 features
        sql, columns, pivot_metadata = engine.generate_sql(
            explore_name=query_request.explore,
            dimensions=query_request.dimensions,
            measures=query_request.measures,
            filters={k: v.model_dump() for k, v in query_request.filters.items()},
            pivots=query_request.pivots,
            sorts=[s.model_dump() for s in query_request.sorts],
            limit=query_request.limit,
            window_functions=[wf.model_dump() for wf in query_request.window_functions],
            calculated_fields=[cf.model_dump() for cf in query_request.calculated_fields],
            time_grains=query_request.time_grains,
            top_n=query_request.top_n.model_dump() if query_request.top_n else None
        )
        
        # Determine data source (use first available)
        from app.models.models import DataSource
        data_source = db.query(DataSource).first()
        if not data_source:
            raise HTTPException(status_code=404, detail="No data source available")
        data_source_id = data_source.id
        
        # Get data source details
        from app.models.models import DataSource
        data_source = db.query(DataSource).filter(DataSource.id == data_source_id).first()
        if not data_source:
            raise HTTPException(status_code=404, detail="Data source not found")
        
        # Execute SQL using DataSourceConnectionService
        # Note: SemanticQueryEngine already adds LIMIT, so don't pass limit again
        columns, data, exec_time = DataSourceConnectionService.execute_query(
            ds_type=data_source.type,
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
    
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Query execution failed: {str(e)}")
