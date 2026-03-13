"""
Pydantic schemas for request/response validation.
"""
from pydantic import BaseModel, Field, ConfigDict, model_validator
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum

from app.schemas.datasource_config import validate_datasource_config
from app.schemas.chart_config import ChartConfigBase, DashboardChartLayout, DashboardChartItem, DashboardLayoutUpdate


# Enums
class DataSourceTypeSchema(str, Enum):
    """Data source types."""
    POSTGRESQL = "postgresql"
    MYSQL = "mysql"
    BIGQUERY = "bigquery"
    GOOGLE_SHEETS = "google_sheets"
    MANUAL = "manual"


class ChartTypeSchema(str, Enum):
    """Chart types."""
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


# Data Source Schemas
class DataSourceBase(BaseModel):
    """Base schema for data source."""
    name: str = Field(..., min_length=1, max_length=255)
    type: DataSourceTypeSchema
    description: Optional[str] = None
    config: Dict[str, Any] = Field(..., description="Connection configuration")


class DataSourceCreate(DataSourceBase):
    """Schema for creating a data source."""
    
    @model_validator(mode='after')
    def validate_config(self):
        """Validate config matches the data source type."""
        self.config = validate_datasource_config(self.type.value, self.config)
        return self


class DataSourceUpdate(BaseModel):
    """Schema for updating a data source."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    type: Optional[DataSourceTypeSchema] = None
    
    @model_validator(mode='after')
    def validate_config(self):
        """Validate config if both type and config are provided."""
        if self.config is not None and self.type is not None:
            self.config = validate_datasource_config(self.type.value, self.config)
        return self


class DataSourceResponse(DataSourceBase):
    """Schema for data source response."""
    id: int
    created_at: datetime
    updated_at: datetime
    
    model_config = ConfigDict(from_attributes=True)


class DataSourceTestRequest(BaseModel):
    """Schema for testing a data source connection."""
    type: DataSourceTypeSchema
    config: Dict[str, Any]


class DataSourceTestResponse(BaseModel):
    """Schema for data source test result."""
    success: bool
    message: str


# Dataset Schemas
class ColumnMetadata(BaseModel):
    """Schema for column metadata."""
    name: str
    type: str  # SQL type as string


class DatasetBase(BaseModel):
    """Base schema for dataset."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    data_source_id: int
    sql_query: str = Field(..., min_length=1)
    transformations: Optional[List[dict]] = Field(default_factory=list, description="Transformation steps pipeline")
    transformation_version: Optional[int] = Field(default=2, description="Version of transformation format")
    materialization: Optional[Dict[str, Any]] = Field(default=None, description="Materialization configuration (v2)")


class DatasetCreate(DatasetBase):
    """Schema for creating a dataset."""
    pass


class DatasetUpdate(BaseModel):
    """Schema for updating a dataset."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    sql_query: Optional[str] = Field(None, min_length=1)
    transformations: Optional[List[dict]] = None
    transformation_version: Optional[int] = None
    materialization: Optional[Dict[str, Any]] = None


class DatasetResponse(DatasetBase):
    """Schema for dataset response."""
    id: int
    columns: Optional[List[ColumnMetadata]] = None
    created_at: datetime
    updated_at: datetime
    
    model_config = ConfigDict(from_attributes=True)


class DatasetExecuteRequest(BaseModel):
    """Schema for executing a dataset query."""
    limit: Optional[int] = Field(None, ge=1, le=10000)
    timeout_seconds: Optional[int] = Field(30, ge=1, le=300, description="Query timeout in seconds")
    apply_transformations: bool = Field(default=True, description="Whether to apply dataset transformations")


class DatasetExecuteResponse(BaseModel):
    """Schema for dataset execution result."""
    columns: List[str]
    data: List[Dict[str, Any]]
    row_count: int


class DatasetPreviewRequest(BaseModel):
    """Schema for previewing dataset with transformations."""
    # Optional fields for ad-hoc preview (without saved dataset)
    data_source_id: Optional[int] = Field(None, description="Data source ID for ad-hoc preview")
    sql_query: Optional[str] = Field(None, description="SQL query for ad-hoc preview")
    transformations: Optional[List[Dict[str, Any]]] = Field(None, description="Transformations for ad-hoc preview")
    
    # Standard preview options
    limit: Optional[int] = Field(500, ge=1, le=10000)
    stop_at_step_id: Optional[str] = Field(None, description="Stop at specific transformation step for preview")
    apply_transformations: bool = Field(default=True, description="Whether to apply transformations")


class DatasetPreviewResponse(BaseModel):
    """Schema for dataset preview result with schema info."""
    columns: List[ColumnMetadata]
    data: List[Dict[str, Any]]
    row_count: int
    step_id: Optional[str] = Field(None, description="The step ID used for preview")
    compiled_sql: Optional[str] = Field(None, description="Compiled SQL (for debug)")


class DatasetMaterializeRequest(BaseModel):
    """Schema for materializing dataset."""
    mode: str = Field(..., description="Materialization mode: none, view, or table")
    name: Optional[str] = Field(None, description="Custom name for materialized object")
    schema: Optional[str] = Field(None, description="Schema/dataset for materialized object")


class DatasetMaterializeResponse(BaseModel):
    """Schema for materialization result."""
    success: bool
    message: str
    materialization: Dict[str, Any]


# Chart Schemas
class ChartBase(BaseModel):
    """Base schema for chart."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    dataset_id: int
    chart_type: ChartTypeSchema
    config: Dict[str, Any] = Field(..., description="Chart configuration")


class ChartCreate(ChartBase):
    """Schema for creating a chart."""
    pass


class ChartUpdate(BaseModel):
    """Schema for updating a chart."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    chart_type: Optional[ChartTypeSchema] = None
    config: Optional[Dict[str, Any]] = None


class ChartResponse(ChartBase):
    """Schema for chart response."""
    id: int
    created_at: datetime
    updated_at: datetime
    
    model_config = ConfigDict(from_attributes=True)


class ChartDataResponse(BaseModel):
    """Schema for chart data response."""
    chart: ChartResponse
    data: List[Dict[str, Any]]


# Dashboard Schemas
# Note: DashboardChartLayout and DashboardChartItem are imported from chart_config


class DashboardBase(BaseModel):
    """Base schema for dashboard."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    filters_config: Optional[List[Dict[str, Any]]] = None  # Dashboard-level filters (hybrid v1)


class DashboardCreate(DashboardBase):
    """Schema for creating a dashboard."""
    charts: List[DashboardChartItem] = []


class DashboardUpdate(BaseModel):
    """Schema for updating a dashboard."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    filters_config: Optional[List[Dict[str, Any]]] = None


class DashboardChartResponse(BaseModel):
    """Schema for dashboard chart response."""
    id: int
    chart_id: int
    chart: Optional['ChartResponse'] = None  # Include full chart data
    layout: Dict[str, Any]  # Changed from Dict[str, int] to allow None values
    
    model_config = ConfigDict(from_attributes=True)


class DashboardResponse(DashboardBase):
    """Schema for dashboard response."""
    id: int
    created_at: datetime
    updated_at: datetime
    dashboard_charts: List[DashboardChartResponse] = []
    filters_config: Optional[List[Dict[str, Any]]] = None
    
    model_config = ConfigDict(from_attributes=True)


class DashboardAddChartRequest(BaseModel):
    """Schema for adding a chart to a dashboard."""
    chart_id: int
    layout: DashboardChartLayout


class DashboardUpdateLayoutRequest(BaseModel):
    """Schema for updating dashboard layout."""
    chart_layouts: List[DashboardLayoutUpdate]


# Query Execution Schemas
class QueryExecuteRequest(BaseModel):
    """Schema for executing an ad-hoc query."""
    data_source_id: int
    sql_query: str = Field(..., min_length=1)
    limit: Optional[int] = Field(None, ge=1, le=10000)
    timeout_seconds: Optional[int] = Field(30, ge=1, le=300, description="Query timeout in seconds")


class QueryExecuteResponse(BaseModel):
    """Schema for query execution result."""
    columns: List[str]
    data: List[Dict[str, Any]]
    row_count: int
    execution_time_ms: float


# Error Response Schema
class ErrorResponse(BaseModel):
    """Schema for error responses."""
    detail: str
