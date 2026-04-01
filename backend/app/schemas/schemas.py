"""
Pydantic schemas for request/response validation.
"""
from pydantic import BaseModel, Field, ConfigDict, model_validator, field_serializer
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum
from uuid import UUID

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
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

    @field_serializer('config')
    def mask_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Mask sensitive credential fields before returning in API response."""
        from app.core.crypto import mask_config_for_response
        return mask_config_for_response(config)


class DataSourceTestRequest(BaseModel):
    """Schema for testing a data source connection."""
    type: DataSourceTypeSchema
    config: Dict[str, Any]
    # When editing an existing datasource, frontend can pass ID so backend
    # can fill in any sensitive fields the user left blank (masked as '').
    data_source_id: int | None = None


class DataSourceTestResponse(BaseModel):
    """Schema for data source test result."""
    success: bool
    message: str


# Chart Schemas
class ChartBase(BaseModel):
    """Base schema for chart."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    workspace_table_id: Optional[int] = Field(None, description="Workspace table source")
    chart_type: ChartTypeSchema
    config: Dict[str, Any] = Field(..., description="Chart configuration")


class ChartCreate(ChartBase):
    """Schema for creating a chart."""

    @model_validator(mode='after')
    def validate_source(self):
        """workspace_table_id must be set."""
        if self.workspace_table_id is None:
            raise ValueError("workspace_table_id must be provided")
        return self


class ChartUpdate(BaseModel):
    """Schema for updating a chart."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    chart_type: Optional[ChartTypeSchema] = None
    config: Optional[Dict[str, Any]] = None
    workspace_table_id: Optional[int] = None


# ─── Chart Metadata Schemas ────────────────────────────────────────────────────

class ChartMetadataUpsert(BaseModel):
    """Schema for creating or replacing chart semantic metadata."""
    domain: Optional[str] = Field(None, max_length=100, description="Business domain: sales / marketing / finance")
    intent: Optional[str] = Field(None, max_length=100, description="Analysis intent: trend / comparison / ranking / summary")
    metrics: Optional[List[str]] = Field(default_factory=list, description="Business metric names (semantic labels)")
    dimensions: Optional[List[str]] = Field(default_factory=list, description="Business dimension names (semantic labels)")
    tags: Optional[List[str]] = Field(default_factory=list, description="Free-form tags for search")


class ChartMetadataResponse(ChartMetadataUpsert):
    """Schema for chart metadata response."""
    id: int
    chart_id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ─── Chart Parameter Schemas ────────────────────────────────────────────────────

class ChartParameterCreate(BaseModel):
    """Schema for creating a chart parameter definition."""
    parameter_name: str = Field(..., min_length=1, max_length=100, description="e.g. date_range, region")
    parameter_type: str = Field(..., min_length=1, max_length=50, description="time_range / dimension / measure")
    column_mapping: Optional[Dict[str, Any]] = Field(
        None, description='e.g. {"column": "order_date", "type": "date"}'
    )
    default_value: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None


class ChartParameterUpdate(BaseModel):
    """Schema for updating a chart parameter definition."""
    parameter_type: Optional[str] = Field(None, max_length=50)
    column_mapping: Optional[Dict[str, Any]] = None
    default_value: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None


class ChartParameterResponse(ChartParameterCreate):
    """Schema for chart parameter response."""
    id: int
    chart_id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ─── Chart Response (extended) ──────────────────────────────────────────────────

class ChartResponse(ChartBase):
    """Schema for chart response."""
    id: int
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    # validation_alias reads from ORM attr 'chart_meta'; serialized as 'metadata' in JSON
    metadata: Optional[ChartMetadataResponse] = Field(default=None, validation_alias="chart_meta")
    parameters: List[ChartParameterResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class ChartDataResponse(BaseModel):
    """Schema for chart data response."""
    chart: ChartResponse
    data: List[Dict[str, Any]]
    pre_aggregated: bool = False


# Dashboard Schemas
# Note: DashboardChartLayout and DashboardChartItem are imported from chart_config


class DashboardBase(BaseModel):
    """Base schema for dashboard."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    filters_config: Optional[List[Dict[str, Any]]] = None  # Dashboard-level filters (hybrid v1)
    public_filters_config: Optional[List[Dict[str, Any]]] = None


class DashboardCreate(DashboardBase):
    """Schema for creating a dashboard."""
    charts: List[DashboardChartItem] = []


class DashboardUpdate(BaseModel):
    """Schema for updating a dashboard."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    filters_config: Optional[List[Dict[str, Any]]] = None
    public_filters_config: Optional[List[Dict[str, Any]]] = None


class DashboardShareRequest(BaseModel):
    """Schema for saving public-link-specific filters."""
    public_filters_config: Optional[List[Dict[str, Any]]] = None


class PublicLinkCreate(BaseModel):
    """Schema for creating a named public link."""
    name: str = Field(..., min_length=1, max_length=255)
    filters_config: Optional[List[Dict[str, Any]]] = None


class PublicLinkUpdate(BaseModel):
    """Schema for updating a public link."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    filters_config: Optional[List[Dict[str, Any]]] = None
    is_active: Optional[bool] = None


class PublicLinkResponse(BaseModel):
    """Schema for public link response."""
    id: int
    dashboard_id: int
    name: str
    token: str
    filters_config: Optional[List[Dict[str, Any]]] = None
    is_active: bool
    access_count: int
    last_accessed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DashboardChartResponse(BaseModel):
    """Schema for dashboard chart response."""
    id: int
    chart_id: int
    chart: Optional['ChartResponse'] = None  # Include full chart data
    layout: Dict[str, Any]  # Changed from Dict[str, int] to allow None values
    parameters: Optional[Dict[str, Any]] = None  # Runtime parameter values for this instance
    
    model_config = ConfigDict(from_attributes=True)


class DashboardResponse(DashboardBase):
    """Schema for dashboard response."""
    id: int
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    share_token: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    dashboard_charts: List[DashboardChartResponse] = []
    filters_config: Optional[List[Dict[str, Any]]] = None
    public_filters_config: Optional[List[Dict[str, Any]]] = None

    model_config = ConfigDict(from_attributes=True)


class DashboardAddChartRequest(BaseModel):
    """Schema for adding a chart to a dashboard."""
    chart_id: int
    layout: DashboardChartLayout
    parameters: Optional[Dict[str, Any]] = Field(
        None, description="Runtime parameter values for this chart instance"
    )


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
