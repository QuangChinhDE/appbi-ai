"""
SQLAlchemy models for the BI application.
"""
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, ForeignKey, JSON, Boolean, Enum, Float
)
from sqlalchemy.dialects.postgresql import UUID
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

    # Sync configuration (schedule + per-table strategies + retry + notification)
    # Format: {schedule: {...}, tables: {...}, retry: {...}, notification: {...}}
    sync_config = Column(JSON, nullable=True)

    # Ownership
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    sync_jobs = relationship("SyncJob", back_populates="data_source", cascade="all, delete-orphan")


class Chart(Base):
    """
    Chart definition based on a dataset.
    Defines visualization configuration.
    """
    __tablename__ = "charts"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    description = Column(Text, nullable=True)
    
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
    
    # Ownership
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    
    # Relationships
    workspace_table = relationship("DatasetWorkspaceTable", foreign_keys=[workspace_table_id])
    dashboard_charts = relationship("DashboardChart", back_populates="chart", cascade="all, delete-orphan")
    chart_meta = relationship("ChartMetadata", back_populates="chart", uselist=False, cascade="all, delete-orphan")
    parameters = relationship("ChartParameter", back_populates="chart", cascade="all, delete-orphan")


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
    
    # Ownership
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Public link sharing — null means not shared
    share_token = Column(String(64), nullable=True, unique=True, index=True)
    public_filters_config = Column(JSON, nullable=True, default=list)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    dashboard_charts = relationship("DashboardChart", back_populates="dashboard", cascade="all, delete-orphan")
    public_links = relationship("DashboardPublicLink", back_populates="dashboard", cascade="all, delete-orphan")


class DashboardPublicLink(Base):
    """
    A named public share link for a dashboard, each with its own filter set and access tracking.
    One dashboard can have many public links with different filters.
    """
    __tablename__ = "dashboard_public_links"

    id = Column(Integer, primary_key=True, index=True)
    dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    token = Column(String(64), nullable=False, unique=True, index=True)
    filters_config = Column(JSON, nullable=True, default=list)
    is_active = Column(Boolean, nullable=False, default=True)

    # Tracking
    access_count = Column(Integer, nullable=False, default=0)
    last_accessed_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    dashboard = relationship("Dashboard", back_populates="public_links")


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
    
    # Runtime parameter values for this chart instance in this dashboard
    # Format: {"date_range": "last_30_days", "region": "VN"}
    parameters = Column(JSON, nullable=True, default=dict)
    
    # Relationships
    dashboard = relationship("Dashboard", back_populates="dashboard_charts")
    chart = relationship("Chart", back_populates="dashboard_charts")


class ChartMetadata(Base):
    """
    Semantic metadata for a chart (business meaning layer).
    Separate from chart config — does not affect rendering or execution.
    """
    __tablename__ = "chart_metadata"

    id = Column(Integer, primary_key=True, index=True)
    chart_id = Column(Integer, ForeignKey("charts.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)

    # Business domain: sales / marketing / finance / operations / hr
    domain = Column(String(100), nullable=True)

    # Analysis intent: trend / comparison / ranking / summary / distribution
    intent = Column(String(100), nullable=True)

    # Business metric names (semantic labels, NOT technical column names)
    # Example: ["revenue", "order_count"]
    metrics = Column(JSON, nullable=True, default=list)

    # Business dimension names (semantic labels)
    # Example: ["month", "region"]
    dimensions = Column(JSON, nullable=True, default=list)

    # Free-form tags for search and classification
    # Example: ["sales", "performance", "q1"]
    tags = Column(JSON, nullable=True, default=list)

    # Knowledge system fields — Feedback-Driven Knowledge System
    auto_description = Column(Text, nullable=True, default=None)          # AI-generated chart description
    insight_keywords = Column(JSON, nullable=True, default=None)          # ["revenue by region", "doanh thu vùng"]
    common_questions = Column(JSON, nullable=True, default=None)          # ["Drill down APAC?", ...]
    query_aliases = Column(JSON, nullable=True, default=None)             # From feedback loop
    description_source = Column(String(20), nullable=True, default=None)  # "auto"|"user"|"feedback"
    description_updated_at = Column(DateTime(timezone=True), nullable=True, default=None)
    generation_status = Column(String(20), nullable=True, default="idle")  # idle|queued|processing|succeeded|failed|stale
    generation_error = Column(Text, nullable=True, default=None)
    generation_requested_at = Column(DateTime(timezone=True), nullable=True, default=None)
    generation_finished_at = Column(DateTime(timezone=True), nullable=True, default=None)
    stale_reason = Column(Text, nullable=True, default=None)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    chart = relationship("Chart", back_populates="chart_meta")


class ChartParameter(Base):
    """
    Parameter definition for a chart template.
    Declares what parameters the chart can accept; does NOT store values.
    Values live in DashboardChart.parameters at runtime.
    """
    __tablename__ = "chart_parameters"

    id = Column(Integer, primary_key=True, index=True)
    chart_id = Column(Integer, ForeignKey("charts.id", ondelete="CASCADE"), nullable=False, index=True)

    # Parameter name: date_range, region, product_category
    parameter_name = Column(String(100), nullable=False)

    # Parameter type: time_range, dimension, measure
    parameter_type = Column(String(50), nullable=False)

    # Column mapping JSON: {"column": "order_date", "type": "date"}
    # Tells the system which dataset column this parameter maps to
    column_mapping = Column(JSON, nullable=True)

    # Default value used when no override is supplied
    default_value = Column(String(255), nullable=True)

    # Human-readable description of the parameter
    description = Column(Text, nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    chart = relationship("Chart", back_populates="parameters")


class SyncJob(Base):
    """
    Record of a single sync job execution for a data source.
    Tracks status, timing, rows affected, and errors.
    """
    __tablename__ = "sync_jobs"

    id = Column(Integer, primary_key=True, index=True)
    data_source_id = Column(Integer, ForeignKey("data_sources.id", ondelete="CASCADE"), nullable=False, index=True)

    # "running" | "success" | "failed" | "timeout"
    status = Column(String(20), nullable=False, default="running")

    # "full_refresh" | "incremental" | "append_only" | "manual"
    mode = Column(String(30), nullable=False)

    started_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    finished_at = Column(DateTime(timezone=True), nullable=True)

    # Rows affected in this run
    rows_synced = Column(Integer, nullable=True)
    rows_failed = Column(Integer, nullable=True)

    error_message = Column(Text, nullable=True)

    # "schedule" | "manual"
    triggered_by = Column(String(50), nullable=True, default="manual")

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    data_source = relationship("DataSource", back_populates="sync_jobs")
