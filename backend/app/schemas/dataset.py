"""Schemas for Datasets (Table-based Datasets)"""
from datetime import date, datetime
from typing import Literal, Optional, List, Dict, Any, Union
from pydantic import BaseModel, Field, model_validator
from uuid import UUID


# ===== Dataset Schemas =====


class CalendarDimensionSettings(BaseModel):
    enabled: bool = True
    start_date: date = Field(default=date(2000, 1, 1))
    end_date: date = Field(default=date(2100, 12, 31))
    timezone: str = "UTC"
    week_start_day: str = Field(default="monday", pattern="^(monday|sunday)$")
    fiscal_year_start_month: int = Field(default=1, ge=1, le=12)
    auto_join_temporal_columns: bool = True


class DatasetSettings(BaseModel):
    calendar_dimension: CalendarDimensionSettings = Field(default_factory=CalendarDimensionSettings)


class DatasetDictionaryTerm(BaseModel):
    term: str = Field(..., min_length=1, max_length=120)
    definition: str = Field(..., min_length=1, max_length=1000)
    category: Literal["metric", "dimension", "entity", "rule", "other"] = "other"
    synonyms: List[str] = Field(default_factory=list)
    related_tables: List[int] = Field(default_factory=list)
    related_columns: List[str] = Field(default_factory=list)
    examples: List[str] = Field(default_factory=list)


class DatasetDictionaryColumnQuality(BaseModel):
    required: Optional[bool] = None
    unique: Optional[bool] = None
    accepted_values: List[str] = Field(default_factory=list)
    min_value: Optional[Union[str, float, int]] = None
    max_value: Optional[Union[str, float, int]] = None
    pattern: Optional[str] = Field(default=None, max_length=500)
    format_hint: Optional[Literal["email", "phone", "url", "date", "datetime", "currency", "percent", "custom"]] = None
    null_threshold_percent: Optional[float] = Field(default=None, ge=0, le=100)
    distinct_threshold: Optional[float] = Field(default=None, ge=0)
    severity: Optional[Literal["info", "warning", "error"]] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


class DatasetDictionaryColumnNote(BaseModel):
    column_name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    business_name: Optional[str] = Field(default=None, max_length=255)
    examples: List[str] = Field(default_factory=list)
    quality: Optional[DatasetDictionaryColumnQuality] = None


class DatasetDictionaryTableNote(BaseModel):
    table_id: int
    business_role: Optional[str] = Field(default=None, max_length=300)
    grain: Optional[str] = Field(default=None, max_length=300)
    join_hint: Optional[str] = Field(default=None, max_length=1000)
    owner_note: Optional[str] = Field(default=None, max_length=1000)
    freshness_expectation: Optional[str] = Field(default=None, max_length=300)
    row_count_expectation: Optional[str] = Field(default=None, max_length=1000)
    important_columns: List[str] = Field(default_factory=list)
    column_notes: List[DatasetDictionaryColumnNote] = Field(default_factory=list)


class DatasetDictionary(BaseModel):
    overview: Optional[str] = Field(default=None, max_length=2000)
    business_purpose: Optional[str] = Field(default=None, max_length=2000)
    usage_guidelines: Optional[str] = Field(default=None, max_length=2000)
    ai_context: Optional[str] = Field(default=None, max_length=4000)
    default_filters: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    glossary: List[DatasetDictionaryTerm] = Field(default_factory=list)
    table_notes: List[DatasetDictionaryTableNote] = Field(default_factory=list)


class DatasetDictionaryStats(BaseModel):
    glossary_terms: int = 0
    warnings: int = 0
    default_filters: int = 0
    table_notes: int = 0
    covered_tables: int = 0
    total_tables: int = 0


class DatasetDictionaryResponse(BaseModel):
    dictionary: DatasetDictionary = Field(default_factory=DatasetDictionary)
    dictionary_updated_at: Optional[datetime] = None
    stats: DatasetDictionaryStats = Field(default_factory=DatasetDictionaryStats)
    compiled_context: str = ""


class DatasetBase(BaseModel):
    """Base dataset schema"""
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    settings: Optional[DatasetSettings] = None
    dictionary: Optional[DatasetDictionary] = None


class DatasetCreate(DatasetBase):
    """Schema for creating a new dataset"""
    pass


class DatasetUpdate(BaseModel):
    """Schema for updating a dataset"""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    settings: Optional[DatasetSettings] = None


class DatasetResponse(DatasetBase):
    """Schema for dataset response"""
    id: int
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    dictionary_updated_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ===== Dataset Table Schemas =====

class DatasetTableBase(BaseModel):
    """Base table schema"""
    display_name: str = Field(..., description="User-friendly name, e.g., 'Orders'")
    enabled: bool = Field(default=True)
    transformations: Optional[List[Dict[str, Any]]] = Field(default=None, description="List of transformation steps")


class TableCreate(DatasetTableBase):
    """Schema for adding a table to dataset"""
    datasource_id: Optional[int] = None
    source_kind: str = Field(default="physical_table", description="'physical_table', 'sql_query', or 'derived_table'")
    source_table_name: Optional[str] = Field(None, description="Full table name for physical_table")
    source_query: Optional[str] = Field(None, description="SQL query for sql_query or derived_table")
    
    @model_validator(mode='after')
    def validate_source(self):
        """Validate that source fields match source_kind"""
        if self.source_kind == "physical_table":
            if self.datasource_id is None:
                raise ValueError("datasource_id is required when source_kind is 'physical_table'")
            if not self.source_table_name:
                raise ValueError("source_table_name is required when source_kind is 'physical_table'")
        elif self.source_kind == "sql_query":
            if self.datasource_id is None:
                raise ValueError("datasource_id is required when source_kind is 'sql_query'")
            if not self.source_query:
                raise ValueError("source_query is required when source_kind is 'sql_query'")
        elif self.source_kind == "derived_table":
            if self.datasource_id is not None:
                raise ValueError("datasource_id must be omitted when source_kind is 'derived_table'")
            if not self.source_query:
                raise ValueError("source_query is required when source_kind is 'derived_table'")
        else:
            raise ValueError(
                f"Invalid source_kind: {self.source_kind}. Must be 'physical_table', 'sql_query', or 'derived_table'"
            )
        return self


class TableUpdate(BaseModel):
    """Schema for updating a table"""
    display_name: Optional[str] = None
    source_query: Optional[str] = None
    enabled: Optional[bool] = None
    transformations: Optional[List[Dict[str, Any]]] = None
    type_overrides: Optional[Dict[str, str]] = Field(default=None, description="User-defined column type overrides, e.g. {'price': 'float', 'created_at': 'date'}")
    column_formats: Optional[Dict[str, Any]] = Field(default=None, description="Full display format config per column")


class TableResponse(DatasetTableBase):
    """Schema for table response"""
    id: int
    dataset_id: int
    datasource_id: Optional[int] = None
    source_kind: str
    source_table_name: Optional[str] = None
    source_query: Optional[str] = None
    query_mode: str = "synced"
    estimated_row_count: Optional[int] = None
    estimated_size_bytes: Optional[int] = None
    transformations: Optional[List[Dict[str, Any]]] = None
    columns_cache: Optional[Union[List[Any], Dict[str, Any]]] = None
    sample_cache: Optional[List[Dict[str, Any]]] = None
    type_overrides: Optional[Dict[str, str]] = None
    column_formats: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ===== Dataset with Tables =====

class DatasetWithTables(DatasetResponse):
    """Dataset response including its tables"""
    tables: List[TableResponse] = []


# ===== Table Preview Schemas =====

class ColumnMetadata(BaseModel):
    """Column metadata for preview"""
    name: str
    type: str  # 'string', 'number', 'date', 'boolean', etc.
    nullable: bool = True


class TablePreviewRequest(BaseModel):
    """Request schema for table preview"""
    limit: int = Field(default=100, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)
    filters: Optional[Dict[str, Any]] = None  # For future filtering
    sort: Optional[Dict[str, str]] = None  # {'column': 'asc'|'desc'}


class TablePreviewResponse(BaseModel):
    """Response schema for table preview"""
    columns: List[ColumnMetadata]
    rows: List[Dict[str, Any]]
    total: int  # Total rows in table (without limit)
    has_more: bool  # Whether there are more rows


# ===== Datasource Table List =====

class DatasourceTable(BaseModel):
    """Schema for tables from datasource"""
    name: str  # Full table name (e.g., 'public.orders')
    schema: Optional[str] = None  # Schema name (e.g., 'public')
    table_type: str = Field(default="table")  # 'table' or 'view'


# ===== Execute Query Schemas =====

class AggregationSpec(BaseModel):
    """Aggregation specification"""
    field: str
    function: str = Field(..., pattern="^(sum|avg|count|min|max|count_distinct)$")


class FilterCondition(BaseModel):
    """Filter condition"""
    field: str
    operator: str = Field(
        ...,
        pattern="^(=|!=|>|<|>=|<=|LIKE|IN|eq|neq|gt|gte|lt|lte|like|in|not_in|between|contains|not_contains|starts_with|is_null|is_not_null)$",
    )
    value: Any = None


class OrderBySpec(BaseModel):
    """Order by specification"""
    field: str
    direction: str = Field(default="DESC", pattern="^(ASC|DESC)$")


class ExecuteQueryRequest(BaseModel):
    """Request schema for executing query with aggregations"""
    dimensions: Optional[List[str]] = None
    measures: Optional[List[AggregationSpec]] = None
    filters: Optional[List[FilterCondition]] = None
    order_by: Optional[List[OrderBySpec]] = None
    limit: int = Field(default=1000, ge=1, le=10000)


class ExecuteQueryResponse(BaseModel):
    """Response schema for executed query"""
    columns: List[ColumnMetadata]
    rows: List[Dict[str, Any]]
