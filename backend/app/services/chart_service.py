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
        
        # Execute the underlying dataset query
        dataset_result = DatasetService.execute(db, db_chart.dataset_id)
        
        return {
            "chart": db_chart,
            "data": dataset_result["data"]
        }
