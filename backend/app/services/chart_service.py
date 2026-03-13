"""
CRUD service for charts.
"""
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models import Chart, ChartType
from app.schemas import ChartCreate, ChartUpdate
from app.services.dataset_service import DatasetService
from app.core.logging import get_logger

logger = get_logger(__name__)


class ChartService:
    """Service for chart operations."""
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Chart]:
        """Get all charts with pagination."""
        return db.query(Chart).offset(skip).limit(limit).all()
    
    @staticmethod
    def get_by_id(db: Session, chart_id: int) -> Optional[Chart]:
        """Get a chart by ID."""
        return db.query(Chart).filter(Chart.id == chart_id).first()
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[Chart]:
        """Get a chart by name."""
        return db.query(Chart).filter(Chart.name == name).first()
    
    @staticmethod
    def create(db: Session, chart: ChartCreate) -> Chart:
        """Create a new chart."""
        # Verify dataset exists
        dataset = DatasetService.get_by_id(db, chart.dataset_id)
        if not dataset:
            raise ValueError(f"Dataset with ID {chart.dataset_id} not found")
        
        try:
            db_chart = Chart(
                name=chart.name,
                description=chart.description,
                dataset_id=chart.dataset_id,
                chart_type=ChartType(chart.chart_type.value),
                config=chart.config
            )
            db.add(db_chart)
            db.commit()
            db.refresh(db_chart)
            logger.info(f"Created chart: {chart.name}")
            return db_chart
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Chart with name '{chart.name}' already exists")
    
    @staticmethod
    def update(
        db: Session,
        chart_id: int,
        chart_update: ChartUpdate
    ) -> Optional[Chart]:
        """Update a chart."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            return None
        
        try:
            update_data = chart_update.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                if field == "chart_type" and value:
                    setattr(db_chart, field, ChartType(value.value))
                else:
                    setattr(db_chart, field, value)
            
            db.commit()
            db.refresh(db_chart)
            logger.info(f"Updated chart: {db_chart.name}")
            return db_chart
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Chart with name '{chart_update.name}' already exists")
    
    @staticmethod
    def delete(db: Session, chart_id: int) -> bool:
        """Delete a chart."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            return False
        
        db.delete(db_chart)
        db.commit()
        logger.info(f"Deleted chart: {db_chart.name}")
        return True
    
    @staticmethod
    def get_chart_data(db: Session, chart_id: int):
        """Get chart configuration with data."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            raise ValueError(f"Chart with ID {chart_id} not found")
        
        # Check if chart config has workspace table source (from Explore)
        config = db_chart.config or {}
        if isinstance(config, dict) and config.get('source', {}).get('kind') == 'workspace_table':
            # Fetch data from workspace table
            from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService
            from app.services.datasource_service import DataSourceConnectionService
            from app.models.models import DataSource
            
            workspace_id = config['source'].get('workspaceId')
            table_id = config['source'].get('tableId')
            
            if not workspace_id or not table_id:
                raise ValueError("Invalid workspace table source in chart config")
            
            # Get table
            db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
            if not db_table or db_table.workspace_id != workspace_id:
                raise ValueError("Table not found in workspace")
            
            # Get datasource
            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise ValueError("Datasource not found")
            
            # Execute query based on source_kind
            if db_table.source_kind == "sql_query":
                if not db_table.source_query:
                    raise ValueError("Table has no SQL query")
                result = DataSourceConnectionService.execute_query(
                    db,
                    db_table.datasource_id,
                    db_table.source_query,
                    limit=1000
                )
            elif db_table.source_kind == "physical_table":
                if not db_table.source_table:
                    raise ValueError("Table has no physical table")
                query = f"SELECT * FROM {db_table.source_table}"
                result = DataSourceConnectionService.execute_query(
                    db,
                    db_table.datasource_id,
                    query,
                    limit=1000
                )
            else:
                raise ValueError(f"Unsupported source_kind: {db_table.source_kind}")
            
            return {
                "chart": db_chart,
                "data": result["rows"]
            }
        else:
            # Execute the underlying dataset query (standard charts)
            dataset_result = DatasetService.execute(db, db_chart.dataset_id)
            
            return {
                "chart": db_chart,
                "data": dataset_result["data"]
            }
