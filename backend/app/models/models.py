"""
SQLAlchemy models for the BI application.
"""
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, ForeignKey, JSON, Boolean, Enum
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from datetime import datetime
import enum

from app.core.database import Base


class DataSourceType(str, enum.Enum):
    """Supported data source types."""
    POSTGRESQL = "postgresql"
    MYSQL = "mysql"
    BIGQUERY = "bigquery"
    GOOGLE_SHEETS = "google_sheets"
    MANUAL = "manual"


class ChartType(str, enum.Enum):
    """Supported chart types."""
    BAR = "BAR"
    LINE = "LINE"
    PIE = "PIE"
    TIME_SERIES = "TIME_SERIES"
    TABLE = "TABLE"
    AREA = "AREA"
    STACKED_BAR = "STACKED_BAR"
    GROUPED_BAR = "GROUPED_BAR"
    SCATTER = "SCATTER"
    KPI = "KPI"


class DataSource(Base):
    """
    Data source connection configuration.
    Stores connection details for external SQL databases.
    """
    __tablename__ = "data_sources"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    type = Column(Enum(DataSourceType, values_callable=lambda obj: [e.value for e in obj]), nullable=False)
    description = Column(Text, nullable=True)
    
    # Connection configuration stored as JSON
    # Format depends on type:
    # PostgreSQL/MySQL: {host, port, database, username, password}
    # BigQuery: {project_id, credentials_json, dataset}
    config = Column(JSON, nullable=False)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    
    # Relationships
    datasets = relationship("Dataset", back_populates="data_source", cascade="all, delete-orphan")


class Dataset(Base):
    """
    Saved query definition with metadata.
    Represents a reusable data view from a data source.
    """
    __tablename__ = "datasets"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    description = Column(Text, nullable=True)
    
    # Foreign key to data source
    data_source_id = Column(Integer, ForeignKey("data_sources.id"), nullable=False)
    
    # SQL query
    sql_query = Column(Text, nullable=False)
    
    # Column metadata stored as JSON
    # Format: [{"name": "col1", "type": "integer"}, {"name": "col2", "type": "string"}, ...]
    columns = Column(JSON, nullable=True)
    
    # Transformations pipeline (Power Query-style)
    # Format: [{"id": "uuid", "type": "filter_rows", "enabled": true, "params": {...}}, ...]
    transformations = Column(JSON, nullable=True, default=list)
    transformation_version = Column(Integer, nullable=True, default=2)
    
    # Materialization configuration (v2)
    # Format: {"mode": "none|view|table", "name": "...", "schema": "...", "refresh": {...}, "last_refreshed_at": "...", "status": "...", "error": "..."}
    materialization = Column(JSON, nullable=True)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    
    # Relationships
    data_source = relationship("DataSource", back_populates="datasets")
    charts = relationship("Chart", back_populates="dataset", cascade="all, delete-orphan")
    semantic_views = relationship("SemanticView", back_populates="dataset")


class Chart(Base):
    """
    Chart definition based on a dataset.
    Defines visualization configuration.
    """
    __tablename__ = "charts"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    description = Column(Text, nullable=True)
    
    # Foreign key to dataset (nullable — chart can use dataset OR workspace table)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), nullable=True)
    
    # Foreign key to workspace table (alternative source to dataset)
    workspace_table_id = Column(Integer, ForeignKey("dataset_workspace_tables.id", ondelete="SET NULL"), nullable=True)
    
    # Chart type
    chart_type = Column(Enum(ChartType), nullable=False)
    
    # Chart configuration stored as JSON
    # Format depends on chart_type:
    # Bar/Line: {x_axis: "column_name", y_axis: "column_name", ...}
    # Pie: {label: "column_name", value: "column_name"}
    # Time Series: {time_column: "column_name", value_column: "column_name", ...}
    config = Column(JSON, nullable=False)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    
    # Relationships
    dataset = relationship("Dataset", back_populates="charts")
    workspace_table = relationship("DatasetWorkspaceTable", foreign_keys=[workspace_table_id])
    dashboard_charts = relationship("DashboardChart", back_populates="chart", cascade="all, delete-orphan")


class Dashboard(Base):
    """
    Dashboard containing multiple charts with layout information.
    """
    __tablename__ = "dashboards"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    description = Column(Text, nullable=True)
    
    # Store dashboard-level filters as JSON (hybrid approach v1)
    # Structure: [{"id": "uuid", "datasetId": 1, "field": "country", "type": "dropdown", "operator": "in", "value": ["US"]}]
    filters_config = Column(JSON, nullable=True, default=list)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    
    # Relationships
    dashboard_charts = relationship("DashboardChart", back_populates="dashboard", cascade="all, delete-orphan")


class DashboardChart(Base):
    """
    Association table between dashboards and charts with layout information.
    """
    __tablename__ = "dashboard_charts"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # Foreign keys
    dashboard_id = Column(Integer, ForeignKey("dashboards.id"), nullable=False)
    chart_id = Column(Integer, ForeignKey("charts.id"), nullable=False)
    
    # Layout information for react-grid-layout
    # Format: {x: 0, y: 0, w: 6, h: 4}
    layout = Column(JSON, nullable=False)
    
    # Relationships
    dashboard = relationship("Dashboard", back_populates="dashboard_charts")
    chart = relationship("Chart", back_populates="dashboard_charts")
