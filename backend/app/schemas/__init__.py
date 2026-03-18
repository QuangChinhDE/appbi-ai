"""
Schemas package initialization.
"""
from app.schemas.schemas import (
    # Data Source
    DataSourceTypeSchema,
    DataSourceCreate,
    DataSourceUpdate,
    DataSourceResponse,
    DataSourceTestRequest,
    DataSourceTestResponse,
    
    # Dataset
    ColumnMetadata,
    DatasetCreate,
    DatasetUpdate,
    DatasetResponse,
    DatasetExecuteRequest,
    DatasetExecuteResponse,
    DatasetPreviewRequest,
    DatasetPreviewResponse,
    DatasetMaterializeRequest,
    DatasetMaterializeResponse,
    
    # Chart
    ChartTypeSchema,
    ChartCreate,
    ChartUpdate,
    ChartResponse,
    ChartDataResponse,
    ChartMetadataUpsert,
    ChartMetadataResponse,
    ChartParameterCreate,
    ChartParameterUpdate,
    ChartParameterResponse,
    
    # Dashboard
    DashboardChartLayout,
    DashboardChartItem,
    DashboardCreate,
    DashboardUpdate,
    DashboardResponse,
    DashboardAddChartRequest,
    DashboardUpdateLayoutRequest,
    
    # Query
    QueryExecuteRequest,
    QueryExecuteResponse,
    
    # Error
    ErrorResponse,
)

from app.schemas.dataset_model import (
    # Dataset Model
    JoinCondition,
    DatasetTableBase as DatasetModelTableBase,
    DatasetTableCreate as DatasetModelTableCreate,
    DatasetTableUpdate as DatasetModelTableUpdate,
    DatasetTableResponse as DatasetModelTableResponse,
    DatasetRelationshipBase,
    DatasetRelationshipCreate,
    DatasetRelationshipUpdate,
    DatasetRelationshipResponse,
    DatasetCalculatedColumnBase,
    DatasetCalculatedColumnCreate,
    DatasetCalculatedColumnUpdate,
    DatasetCalculatedColumnResponse,
    DatasetModelBase,
    DatasetModelCreate,
    DatasetModelUpdate,
    DatasetModelResponse,
    DatasetModelDetail,
    DatasetModelPreviewRequest,
    DatasetModelPreviewResponse,
    DatasetModelExecuteRequest,
    DatasetModelExecuteResponse,
    TablePreviewRequest as DatasetModelTablePreviewRequest,
    TablePreviewResponse as DatasetModelTablePreviewResponse,
)

from app.schemas.dataset_workspace import (
    # Dataset Workspace (Table-based)
    WorkspaceBase,
    WorkspaceCreate,
    WorkspaceUpdate,
    WorkspaceResponse,
    WorkspaceWithTables,
    WorkspaceTableBase,
    TableCreate,
    TableUpdate,
    TableResponse,
    TablePreviewRequest,
    TablePreviewResponse,
    ExecuteQueryRequest,
    ExecuteQueryResponse,
    AggregationSpec,
    FilterCondition,
    OrderBySpec,
    ColumnMetadata as WorkspaceColumnMetadata,
    DatasourceTable,
)

__all__ = [
    # Data Source
    "DataSourceTypeSchema",
    "DataSourceCreate",
    "DataSourceUpdate",
    "DataSourceResponse",
    "DataSourceTestRequest",
    "DataSourceTestResponse",
    
    # Dataset
    "ColumnMetadata",
    "DatasetCreate",
    "DatasetUpdate",
    "DatasetResponse",
    "DatasetExecuteRequest",
    "DatasetExecuteResponse",
    "DatasetPreviewRequest",
    "DatasetPreviewResponse",
    "DatasetMaterializeRequest",
    "DatasetMaterializeResponse",
    
    # Chart
    "ChartTypeSchema",
    "ChartCreate",
    "ChartUpdate",
    "ChartResponse",
    "ChartDataResponse",
    "ChartMetadataUpsert",
    "ChartMetadataResponse",
    "ChartParameterCreate",
    "ChartParameterUpdate",
    "ChartParameterResponse",
    
    # Dashboard
    "DashboardChartLayout",
    "DashboardChartItem",
    "DashboardCreate",
    "DashboardUpdate",
    "DashboardResponse",
    "DashboardAddChartRequest",
    "DashboardUpdateLayoutRequest",
    
    # Query
    "QueryExecuteRequest",
    "QueryExecuteResponse",
    
    # Error
    "ErrorResponse",
    
    # Dataset Model
    "JoinCondition",
    "DatasetModelTableBase",
    "DatasetModelTableCreate",
    "DatasetModelTableUpdate",
    "DatasetModelTableResponse",
    "DatasetRelationshipBase",
    "DatasetRelationshipCreate",
    "DatasetRelationshipUpdate",
    "DatasetRelationshipResponse",
    "DatasetCalculatedColumnBase",
    "DatasetCalculatedColumnCreate",
    "DatasetCalculatedColumnUpdate",
    "DatasetCalculatedColumnResponse",
    "DatasetModelBase",
    "DatasetModelCreate",
    "DatasetModelUpdate",
    "DatasetModelResponse",
    "DatasetModelDetail",
    "DatasetModelPreviewRequest",
    "DatasetModelPreviewResponse",
    "DatasetModelExecuteRequest",
    "DatasetModelExecuteResponse",
    
    # Dataset Workspace (Table-based)
    "WorkspaceBase",
    "WorkspaceCreate",
    "WorkspaceUpdate",
    "WorkspaceResponse",
    "WorkspaceWithTables",
    "WorkspaceTableBase",
    "TableCreate",
    "TableUpdate",
    "TableResponse",
    "TablePreviewRequest",
    "TablePreviewResponse",
    "ExecuteQueryRequest",
    "ExecuteQueryResponse",
    "AggregationSpec",
    "FilterCondition",
    "WorkspaceColumnMetadata",
    "DatasourceTable",
]
