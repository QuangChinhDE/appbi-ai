"""
CRUD service for dashboards.
"""
from typing import List, Optional
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.exc import IntegrityError

from app.models import Dashboard, DashboardChart
from app.schemas import DashboardCreate, DashboardUpdate
from app.schemas.chart_config import DashboardChartItem, DashboardChartLayout, DashboardLayoutUpdate
from app.services.chart_service import ChartService
from app.core.logging import get_logger

logger = get_logger(__name__)


class DashboardService:
    """Service for dashboard operations."""
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Dashboard]:
        """Get all dashboards with pagination."""
        return db.query(Dashboard).offset(skip).limit(limit).all()
    
    @staticmethod
    def get_by_id(db: Session, dashboard_id: int) -> Optional[Dashboard]:
        """Get a dashboard by ID."""
        return db.query(Dashboard)\
            .options(joinedload(Dashboard.dashboard_charts).joinedload(DashboardChart.chart))\
            .filter(Dashboard.id == dashboard_id).first()
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[Dashboard]:
        """Get a dashboard by name."""
        return db.query(Dashboard).filter(Dashboard.name == name).first()
    
    @staticmethod
    def create(db: Session, dashboard: DashboardCreate, owner_id=None) -> Dashboard:
        """Create a new dashboard."""
        try:
            db_dashboard = Dashboard(
                name=dashboard.name,
                description=dashboard.description,
                owner_id=owner_id,
            )
            db.add(db_dashboard)
            db.flush()  # Get the ID without committing
            
            # Add charts if provided
            for chart_item in dashboard.charts:
                # Verify chart exists
                chart = ChartService.get_by_id(db, chart_item.chart_id)
                if not chart:
                    db.rollback()
                    raise ValueError(f"Chart with ID {chart_item.chart_id} not found")
                
                db_dashboard_chart = DashboardChart(
                    dashboard_id=db_dashboard.id,
                    chart_id=chart_item.chart_id,
                    layout=chart_item.layout.model_dump()
                )
                db.add(db_dashboard_chart)
            
            db.commit()
            db.refresh(db_dashboard)
            logger.info(f"Created dashboard: {dashboard.name}")
            return db_dashboard
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Dashboard with name '{dashboard.name}' already exists")
    
    @staticmethod
    def update(
        db: Session,
        dashboard_id: int,
        dashboard_update: DashboardUpdate
    ) -> Optional[Dashboard]:
        """Update a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        
        try:
            update_data = dashboard_update.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                setattr(db_dashboard, field, value)
            
            db.commit()
            db.refresh(db_dashboard)
            logger.info(f"Updated dashboard: {db_dashboard.name}")
            return db_dashboard
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Dashboard with name '{dashboard_update.name}' already exists")
    
    @staticmethod
    def delete(db: Session, dashboard_id: int) -> bool:
        """Delete a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return False
        
        db.delete(db_dashboard)
        db.commit()
        logger.info(f"Deleted dashboard: {db_dashboard.name}")
        return True
    
    @staticmethod
    def add_chart(
        db: Session,
        dashboard_id: int,
        chart_id: int,
        layout: DashboardChartLayout,
        parameters: Optional[dict] = None,
    ) -> Optional[Dashboard]:
        """Add a chart to a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        
        # Verify chart exists
        chart = ChartService.get_by_id(db, chart_id)
        if not chart:
            raise ValueError(f"Chart with ID {chart_id} not found")
        
        # Check if chart is already in dashboard
        existing = db.query(DashboardChart).filter(
            DashboardChart.dashboard_id == dashboard_id,
            DashboardChart.chart_id == chart_id
        ).first()
        
        if existing:
            raise ValueError(f"Chart with ID {chart_id} is already in the dashboard")
        
        db_dashboard_chart = DashboardChart(
            dashboard_id=dashboard_id,
            chart_id=chart_id,
            layout=layout.model_dump(),
            parameters=parameters or {},
        )
        db.add(db_dashboard_chart)
        db.commit()
        db.refresh(db_dashboard)
        logger.info(f"Added chart {chart_id} to dashboard {dashboard_id}")
        return db_dashboard
    
    @staticmethod
    def remove_chart(
        db: Session,
        dashboard_id: int,
        chart_id: int
    ) -> Optional[Dashboard]:
        """Remove a chart from a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        
        db_dashboard_chart = db.query(DashboardChart).filter(
            DashboardChart.dashboard_id == dashboard_id,
            DashboardChart.chart_id == chart_id
        ).first()
        
        if not db_dashboard_chart:
            raise ValueError(f"Chart with ID {chart_id} not found in dashboard")
        
        db.delete(db_dashboard_chart)
        db.commit()
        db.refresh(db_dashboard)
        logger.info(f"Removed chart {chart_id} from dashboard {dashboard_id}")
        return db_dashboard
    
    @staticmethod
    def update_layout(
        db: Session,
        dashboard_id: int,
        chart_layouts: List[DashboardLayoutUpdate]
    ) -> Optional[Dashboard]:
        """Update layout for all charts in a dashboard."""
        db_dashboard = DashboardService.get_by_id(db, dashboard_id)
        if not db_dashboard:
            return None
        
        for chart_layout_update in chart_layouts:
            dashboard_chart_id = chart_layout_update.id
            layout = chart_layout_update.layout
            
            db_dashboard_chart = db.query(DashboardChart).filter(
                DashboardChart.id == dashboard_chart_id,
                DashboardChart.dashboard_id == dashboard_id
            ).first()
            
            if db_dashboard_chart:
                # Convert Pydantic model to dict
                db_dashboard_chart.layout = layout.model_dump()
        
        db.commit()
        db.refresh(db_dashboard)
        logger.info(f"Updated layout for dashboard {dashboard_id}")
        return db_dashboard
