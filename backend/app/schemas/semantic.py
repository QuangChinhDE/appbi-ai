"""
Semantic Layer Schemas
Pydantic schemas for LookML-style semantic definitions
"""
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field
from datetime import datetime


# Dimension & Measure Definitions
class DimensionDefinition(BaseModel):
    """LookML-style dimension definition"""
    name: str
    type: Literal["string", "number", "date", "datetime", "yesno"] = "string"
    sql: Optional[str] = None  # SQL template, can use ${TABLE} placeholder
    label: Optional[str] = None
    description: Optional[str] = None
    hidden: bool = False


class MeasureDefinition(BaseModel):
    """LookML-style measure definition"""
    name: str
    type: Literal["count", "sum", "avg", "min", "max", "count_distinct", "percent_of_total"]
    sql: Optional[str] = None  # SQL template for the measure
    label: Optional[str] = None
    description: Optional[str] = None
    hidden: bool = False


# Join Definition
class JoinDefinition(BaseModel):
    """LookML-style join definition"""
    name: str
    view: str  # Name of the view to join
    type: Literal["left", "inner", "right", "full"] = "left"
    sql_on: str  # SQL join condition, can use ${view.field} placeholders
    relationship: Optional[Literal["one_to_one", "one_to_many", "many_to_one", "many_to_many"]] = None


# Semantic View
class SemanticViewBase(BaseModel):
    name: str
    sql_table_name: Optional[str] = None
    dataset_id: Optional[int] = None
    dimensions: List[DimensionDefinition] = []
    measures: List[MeasureDefinition] = []
    description: Optional[str] = None


class SemanticViewCreate(SemanticViewBase):
    pass


class SemanticViewUpdate(BaseModel):
    name: Optional[str] = None
    sql_table_name: Optional[str] = None
    dataset_id: Optional[int] = None
    dimensions: Optional[List[DimensionDefinition]] = None
    measures: Optional[List[MeasureDefinition]] = None
    description: Optional[str] = None


class SemanticView(SemanticViewBase):
    id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Semantic Explore
class SemanticExploreBase(BaseModel):
    name: str
    base_view_name: str
    base_view_id: int
    joins: List[JoinDefinition] = []
    default_filters: Optional[Dict[str, Any]] = {}
    description: Optional[str] = None


class SemanticExploreCreate(SemanticExploreBase):
    model_id: int


class SemanticExploreUpdate(BaseModel):
    name: Optional[str] = None
    base_view_name: Optional[str] = None
    base_view_id: Optional[int] = None
    joins: Optional[List[JoinDefinition]] = None
    default_filters: Optional[Dict[str, Any]] = None
    description: Optional[str] = None


class SemanticExplore(SemanticExploreBase):
    id: int
    model_id: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Semantic Model
class SemanticModelBase(BaseModel):
    name: str
    description: Optional[str] = None


class SemanticModelCreate(SemanticModelBase):
    pass


class SemanticModelUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class SemanticModel(SemanticModelBase):
    id: int
    created_at: datetime
    updated_at: datetime
    explores: List[SemanticExplore] = []

    class Config:
        from_attributes = True


# Query Request & Response
class FilterCondition(BaseModel):
    """Filter condition for semantic query"""
    operator: Literal["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "starts_with", "ends_with"]
    value: Any


class WindowFunctionDefinition(BaseModel):
    """Window function definition for semantic query"""
    name: str  # Output column name
    base_measure: str  # e.g. "orders.total_revenue"
    partition_by: List[str] = []  # Dimension fields
    order_by: List[str] = []  # Dimension/measure fields
    type: Literal["running_sum", "running_avg", "rank", "dense_rank", "row_number"]


class CalculatedFieldDefinition(BaseModel):
    """Calculated field definition for semantic query"""
    name: str  # Output column name
    sql: str  # SQL expression with ${view.field} placeholders
    type: Literal["string", "number", "date", "datetime"] = "number"


class SortDefinition(BaseModel):
    """Sort definition for semantic query"""
    field: str  # Qualified field name
    direction: Literal["asc", "desc"] = "asc"


class TopNDefinition(BaseModel):
    """Top N filtering definition"""
    field: str  # Field to rank by
    n: int = Field(ge=1, le=1000)


class SemanticQueryRequest(BaseModel):
    """Request to execute a semantic query (v2 with advanced features)"""
    explore: str  # Explore name
    dimensions: List[str] = []  # Qualified field names like "orders.order_date"
    measures: List[str] = []  # Qualified field names like "orders.total_revenue"
    filters: Dict[str, FilterCondition] = {}  # Field name -> filter condition
    pivots: List[str] = []  # Dimensions to pivot (currently supports max 1)
    sorts: List[SortDefinition] = []  # Sort specifications
    limit: int = Field(default=500, ge=1, le=10000)
    window_functions: List[WindowFunctionDefinition] = []  # Window function definitions
    calculated_fields: List[CalculatedFieldDefinition] = []  # Calculated fields
    time_grains: Dict[str, Literal["day", "week", "month", "quarter", "year"]] = {}  # Dimension -> grain
    top_n: Optional[TopNDefinition] = None  # Top N filtering


class PivotedColumn(BaseModel):
    """Metadata for pivoted column"""
    base_field: str  # Original pivot dimension
    value: str  # Pivot value (e.g. "US")
    alias: str  # Column alias (e.g. "total_revenue_US")


class SemanticQueryResponse(BaseModel):
    """Response from semantic query execution (v2 with pivot metadata)"""
    sql: str
    columns: List[str]
    data: List[Dict[str, Any]]
    row_count: int
    execution_time_ms: Optional[float] = None
    pivoted_columns: List[PivotedColumn] = []  # Metadata for pivoted columns
    warnings: List[str] = []  # Any warnings about query execution
