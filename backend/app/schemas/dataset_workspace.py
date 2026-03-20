"""Schemas for Dataset Workspaces (Table-based Datasets)"""
from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, model_validator
from uuid import UUID


# ===== Workspace Schemas =====

class WorkspaceBase(BaseModel):
    """Base workspace schema"""
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None


class WorkspaceCreate(WorkspaceBase):
    """Schema for creating a new workspace"""
    pass


class WorkspaceUpdate(BaseModel):
    """Schema for updating a workspace"""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None


class WorkspaceResponse(WorkspaceBase):
    """Schema for workspace response"""
    id: int
    owner_id: Optional[UUID] = None
    user_permission: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ===== Workspace Table Schemas =====

class WorkspaceTableBase(BaseModel):
    """Base table schema"""
    display_name: str = Field(..., description="User-friendly name, e.g., 'Orders'")
    enabled: bool = Field(default=True)
    transformations: Optional[List[Dict[str, Any]]] = Field(default=None, description="List of transformation steps")


class TableCreate(WorkspaceTableBase):
    """Schema for adding a table to workspace"""
    datasource_id: int
    source_kind: str = Field(default="physical_table", description="'physical_table' or 'sql_query'")
    source_table_name: Optional[str] = Field(None, description="Full table name for physical_table")
    source_query: Optional[str] = Field(None, description="SQL query for sql_query")
    
    @model_validator(mode='after')
    def validate_source(self):
        """Validate that source fields match source_kind"""
        if self.source_kind == "physical_table":
            if not self.source_table_name:
                raise ValueError("source_table_name is required when source_kind is 'physical_table'")
        elif self.source_kind == "sql_query":
            if not self.source_query:
                raise ValueError("source_query is required when source_kind is 'sql_query'")
        else:
            raise ValueError(f"Invalid source_kind: {self.source_kind}. Must be 'physical_table' or 'sql_query'")
        return self


class TableUpdate(BaseModel):
    """Schema for updating a table"""
    display_name: Optional[str] = None
    enabled: Optional[bool] = None
    transformations: Optional[List[Dict[str, Any]]] = None
    type_overrides: Optional[Dict[str, str]] = Field(default=None, description="User-defined column type overrides, e.g. {'price': 'float', 'created_at': 'date'}")
    column_formats: Optional[Dict[str, Any]] = Field(default=None, description="Full display format config per column")


class TableResponse(WorkspaceTableBase):
    """Schema for table response"""
    id: int
    workspace_id: int
    datasource_id: int
    source_kind: str
    source_table_name: Optional[str] = None
    source_query: Optional[str] = None
    transformations: Optional[List[Dict[str, Any]]] = None
    columns_cache: Optional[Dict[str, Any]] = None
    sample_cache: Optional[List[Dict[str, Any]]] = None
    type_overrides: Optional[Dict[str, str]] = None
    column_formats: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ===== Workspace with Tables =====

class WorkspaceWithTables(WorkspaceResponse):
    """Workspace response including its tables"""
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
    operator: str = Field(..., pattern="^(=|!=|>|<|>=|<=|LIKE|IN)$")
    value: str


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
