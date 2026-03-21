"""
CRUD service for charts.
"""
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models import Chart, ChartType, ChartMetadata, ChartParameter
from app.schemas import ChartCreate, ChartUpdate
from app.schemas import ChartMetadataUpsert, ChartParameterCreate, ChartParameterUpdate
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
    def create(db: Session, chart: ChartCreate, owner_id=None) -> Chart:
        """Create a new chart."""
        if chart.workspace_table_id is not None:
            # Verify workspace table exists
            from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService
            table = DatasetWorkspaceCRUDService.get_table_by_id(db, chart.workspace_table_id)
            if not table:
                raise ValueError(f"Workspace table with ID {chart.workspace_table_id} not found")

        try:
            db_chart = Chart(
                name=chart.name,
                description=chart.description,
                workspace_table_id=chart.workspace_table_id,
                chart_type=ChartType(chart.chart_type.value),
                config=chart.config,
                owner_id=owner_id,
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

        # Prefer direct workspace_table_id FK over config-embedded source
        if db_chart.workspace_table_id is not None:
            from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService
            from app.services.datasource_service import DataSourceConnectionService
            from app.models.models import DataSource

            db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, db_chart.workspace_table_id)
            if not db_table:
                raise ValueError("Workspace table not found")

            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise ValueError("Data source not found")

            from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
            from app.services.duckdb_engine import DuckDBEngine

            if db_table.source_kind == "sql_query":
                if not db_table.source_query:
                    raise ValueError("Table has no SQL query")
                # Rewrite to DuckDB views if datasource has been synced
                rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query)
                if rewritten:
                    try:
                        rows = DuckDBEngine.query(
                            f"SELECT * FROM ({rewritten}) AS _q LIMIT 1000"
                        )
                        return {"chart": db_chart, "data": rows}
                    except Exception:
                        pass  # fall through to live query
                sql = db_table.source_query
            elif db_table.source_kind == "physical_table":
                if not db_table.source_table_name:
                    raise ValueError("Table has no physical table name")
                # Use DuckDB synced cache if available — avoids live source round-trip
                view_name = get_synced_view(datasource.id, db_table.source_table_name)
                if view_name:
                    rows = DuckDBEngine.query(f"SELECT * FROM {view_name} LIMIT 1000")
                    return {"chart": db_chart, "data": rows}
                sql = f'SELECT * FROM {db_table.source_table_name}'
            else:
                raise ValueError(f"Unsupported source_kind: {db_table.source_kind}")

            columns, rows, _ = DataSourceConnectionService.execute_query(
                datasource.type, datasource.config, sql, limit=1000
            )
            return {"chart": db_chart, "data": rows}

        # Fallback: check config for legacy workspace_table source
        config = db_chart.config or {}
        if isinstance(config, dict) and config.get('source', {}).get('kind') == 'workspace_table':
            from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService
            from app.services.datasource_service import DataSourceConnectionService
            from app.models.models import DataSource

            workspace_id = config['source'].get('workspaceId')
            table_id = config['source'].get('tableId')

            if not workspace_id or not table_id:
                raise ValueError("Invalid workspace table source in chart config")

            db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
            if not db_table or db_table.workspace_id != workspace_id:
                raise ValueError("Table not found in workspace")

            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise ValueError("Data source not found")

            from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
            from app.services.duckdb_engine import DuckDBEngine

            if db_table.source_kind == "sql_query":
                if not db_table.source_query:
                    raise ValueError("Table has no SQL query")
                # Rewrite to DuckDB views if datasource has been synced
                rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query)
                if rewritten:
                    try:
                        rows = DuckDBEngine.query(
                            f"SELECT * FROM ({rewritten}) AS _q LIMIT 1000"
                        )
                        return {"chart": db_chart, "data": rows}
                    except Exception:
                        pass  # fall through to live query
                sql = db_table.source_query
            elif db_table.source_kind == "physical_table":
                if not db_table.source_table_name:
                    raise ValueError("Table has no physical table")
                # Use DuckDB synced cache if available — avoids live source round-trip
                view_name = get_synced_view(datasource.id, db_table.source_table_name)
                if view_name:
                    rows = DuckDBEngine.query(f"SELECT * FROM {view_name} LIMIT 1000")
                    return {"chart": db_chart, "data": rows}
                sql = f'SELECT * FROM {db_table.source_table_name}'
            else:
                raise ValueError(f"Unsupported source_kind: {db_table.source_kind}")

            columns, rows, _ = DataSourceConnectionService.execute_query(
                datasource.type, datasource.config, sql, limit=1000
            )
            return {"chart": db_chart, "data": rows}

        raise ValueError("Chart has no data source configured")

    # -----------------------------------------------------------------------
    # Metadata CRUD
    # -----------------------------------------------------------------------

    @staticmethod
    def upsert_metadata(db: Session, chart_id: int, data: ChartMetadataUpsert) -> ChartMetadata:
        """Create or replace semantic metadata for a chart."""
        existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if existing:
            for field, value in data.model_dump(exclude_unset=False).items():
                setattr(existing, field, value)
            db.commit()
            db.refresh(existing)
            return existing
        new_meta = ChartMetadata(
            chart_id=chart_id,
            domain=data.domain,
            intent=data.intent,
            metrics=data.metrics or [],
            dimensions=data.dimensions or [],
            tags=data.tags or [],
        )
        db.add(new_meta)
        db.commit()
        db.refresh(new_meta)
        return new_meta

    @staticmethod
    def get_metadata(db: Session, chart_id: int) -> Optional[ChartMetadata]:
        """Get metadata for a chart."""
        return db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()

    @staticmethod
    def delete_metadata(db: Session, chart_id: int) -> bool:
        """Delete metadata for a chart."""
        existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if not existing:
            return False
        db.delete(existing)
        db.commit()
        return True

    # -----------------------------------------------------------------------
    # Parameter CRUD
    # -----------------------------------------------------------------------

    @staticmethod
    def get_parameters(db: Session, chart_id: int) -> List[ChartParameter]:
        """Get all parameter definitions for a chart."""
        return db.query(ChartParameter).filter(ChartParameter.chart_id == chart_id).all()

    @staticmethod
    def replace_parameters(db: Session, chart_id: int, params: List[ChartParameterCreate]) -> List[ChartParameter]:
        """Replace all parameter definitions for a chart (bulk upsert)."""
        db.query(ChartParameter).filter(ChartParameter.chart_id == chart_id).delete()
        new_params = [
            ChartParameter(
                chart_id=chart_id,
                parameter_name=p.parameter_name,
                parameter_type=p.parameter_type,
                column_mapping=p.column_mapping,
                default_value=p.default_value,
                description=p.description,
            )
            for p in params
        ]
        db.add_all(new_params)
        db.commit()
        for p in new_params:
            db.refresh(p)
        return new_params

    @staticmethod
    def add_parameter(db: Session, chart_id: int, data: ChartParameterCreate) -> ChartParameter:
        """Add a single parameter definition to a chart."""
        param = ChartParameter(
            chart_id=chart_id,
            parameter_name=data.parameter_name,
            parameter_type=data.parameter_type,
            column_mapping=data.column_mapping,
            default_value=data.default_value,
            description=data.description,
        )
        db.add(param)
        db.commit()
        db.refresh(param)
        return param

    @staticmethod
    def update_parameter(
        db: Session, chart_id: int, param_id: int, data: ChartParameterUpdate
    ) -> Optional[ChartParameter]:
        """Update a parameter definition."""
        param = db.query(ChartParameter).filter(
            ChartParameter.id == param_id,
            ChartParameter.chart_id == chart_id,
        ).first()
        if not param:
            return None
        for field, value in data.model_dump(exclude_unset=True).items():
            setattr(param, field, value)
        db.commit()
        db.refresh(param)
        return param

    @staticmethod
    def delete_parameter(db: Session, chart_id: int, param_id: int) -> bool:
        """Delete a parameter definition."""
        param = db.query(ChartParameter).filter(
            ChartParameter.id == param_id,
            ChartParameter.chart_id == chart_id,
        ).first()
        if not param:
            return False
        db.delete(param)
        db.commit()
        return True
