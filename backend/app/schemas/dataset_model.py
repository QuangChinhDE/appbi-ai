"""
Pydantic schemas for Dataset Model (multi-table datasets)
"""
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any, Literal
from datetime import datetime

from app.models.dataset_model import TableRole, JoinType


# ============================================================================
# Base Schemas
# ============================================================================

class JoinCondition(BaseModel):
    """Single join condition (field mapping)"""
    leftField: str = Field(..., description="Field name from left table")
    rightField: str = Field(..., description="Field name from right table")


# ============================================================================
# DatasetTable Schemas
# ============================================================================

class DatasetTableBase(BaseModel):
    """Base schema for dataset table"""
    name: str = Field(..., max_length=255, description="User-friendly table name")
    role: TableRole = Field(..., description="Table role: fact or dimension")
    data_source_id: int = Field(..., description="ID of the data source")
    base_sql: str = Field(..., description="Base SQL query (SELECT only)")
    transformations: List[Dict[str, Any]] = Field(default_factory=list, description="Transformation steps")


class DatasetTableCreate(DatasetTableBase):
    """Schema for creating a new table"""
    pass


class DatasetTableUpdate(BaseModel):
    """Schema for updating a table"""
    name: Optional[str] = Field(None, max_length=255)
    role: Optional[TableRole] = None
    data_source_id: Optional[int] = None
    base_sql: Optional[str] = None
    transformations: Optional[List[Dict[str, Any]]] = None


class DatasetTableResponse(DatasetTableBase):
    """Schema for table response"""
    id: int
    dataset_model_id: int
    columns: Optional[List[Dict[str, Any]]] = Field(default_factory=list, description="Cached column schema")
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# DatasetRelationship Schemas
# ============================================================================

class DatasetRelationshipBase(BaseModel):
    """Base schema for dataset relationship"""
    left_table_id: int = Field(..., description="ID of left table in join")
    right_table_id: int = Field(..., description="ID of right table in join")
    join_type: JoinType = Field(..., description="Join type: left or inner")
    on: List[JoinCondition] = Field(..., min_length=1, description="Join conditions")


class DatasetRelationshipCreate(DatasetRelationshipBase):
    """Schema for creating a new relationship"""
    pass


class DatasetRelationshipUpdate(BaseModel):
    """Schema for updating a relationship"""
    left_table_id: Optional[int] = None
    right_table_id: Optional[int] = None
    join_type: Optional[JoinType] = None
    on: Optional[List[JoinCondition]] = None


class DatasetRelationshipResponse(DatasetRelationshipBase):
    """Schema for relationship response"""
    id: int
    dataset_model_id: int
    created_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# DatasetCalculatedColumn Schemas
# ============================================================================

class DatasetCalculatedColumnBase(BaseModel):
    """Base schema for calculated column"""
    name: str = Field(..., max_length=255, description="Column name/alias")
    expression: str = Field(..., description="SQL expression")
    data_type: Optional[str] = Field(None, max_length=50, description="Optional data type hint")
    enabled: bool = Field(default=True, description="Whether column is enabled")


class DatasetCalculatedColumnCreate(DatasetCalculatedColumnBase):
    """Schema for creating a calculated column"""
    pass


class DatasetCalculatedColumnUpdate(BaseModel):
    """Schema for updating a calculated column"""
    name: Optional[str] = Field(None, max_length=255)
    expression: Optional[str] = None
    data_type: Optional[str] = Field(None, max_length=50)
    enabled: Optional[bool] = None


class DatasetCalculatedColumnResponse(DatasetCalculatedColumnBase):
    """Schema for calculated column response"""
    id: int
    dataset_model_id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ============================================================================
# DatasetModel Schemas
# ============================================================================

class DatasetModelBase(BaseModel):
    """Base schema for dataset model"""
    name: str = Field(..., max_length=255, description="Model name")
    description: Optional[str] = Field(None, description="Model description")


class DatasetModelCreate(DatasetModelBase):
    """Schema for creating a new dataset model"""
    pass


class DatasetModelUpdate(BaseModel):
    """Schema for updating a dataset model"""
    name: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None


class DatasetModelResponse(DatasetModelBase):
    """Schema for dataset model response (without nested data)"""
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class DatasetModelDetail(DatasetModelResponse):
    """Schema for detailed dataset model response (with nested data)"""
    tables: List[DatasetTableResponse] = Field(default_factory=list)
    relationships: List[DatasetRelationshipResponse] = Field(default_factory=list)
    calculated_columns: List[DatasetCalculatedColumnResponse] = Field(default_factory=list)


# ============================================================================
# Preview & Execute Schemas
# ============================================================================

class DatasetModelPreviewRequest(BaseModel):
    """Request schema for previewing dataset model"""
    limit: int = Field(default=200, ge=1, le=10000, description="Number of rows to return")
    stop_at: Literal["table", "join", "final"] = Field(default="final", description="Preview stage")


class DatasetModelPreviewResponse(BaseModel):
    """Response schema for dataset model preview"""
    columns: List[Dict[str, Any]] = Field(..., description="Column metadata")
    rows: List[Dict[str, Any]] = Field(..., description="Preview data rows")
    total_rows: int = Field(..., description="Number of rows returned")
    compiled_sql: Optional[str] = Field(None, description="Compiled SQL query (debug)")


class DatasetModelExecuteRequest(BaseModel):
    """Request schema for executing dataset model"""
    limit: int = Field(default=1000, ge=1, le=100000, description="Number of rows to return")


class DatasetModelExecuteResponse(BaseModel):
    """Response schema for dataset model execution"""
    columns: List[Dict[str, Any]] = Field(..., description="Column metadata")
    rows: List[Dict[str, Any]] = Field(..., description="Data rows")
    total_rows: int = Field(..., description="Number of rows returned")


# ============================================================================
# Table Preview Schema
# ============================================================================

class TablePreviewRequest(BaseModel):
    """Request schema for previewing individual table"""
    limit: int = Field(default=200, ge=1, le=10000, description="Number of rows to return")


class TablePreviewResponse(BaseModel):
    """Response schema for table preview"""
    columns: List[Dict[str, Any]] = Field(..., description="Column metadata")
    rows: List[Dict[str, Any]] = Field(..., description="Preview data rows")
    total_rows: int = Field(..., description="Number of rows returned")
    compiled_sql: Optional[str] = Field(None, description="Compiled SQL query (debug)")
