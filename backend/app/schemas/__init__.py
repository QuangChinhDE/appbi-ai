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
from app.schemas.agent_report import (
    AgentReportSpecCreate,
    AgentReportSpecUpdate,
    AgentReportSpecResponse,
    AgentReportSpecDetailResponse,
    AgentReportRunCreate,
    AgentReportRunUpdate,
    AgentReportRunResponse,
)

__all__ = [
    # Data Source
    "DataSourceTypeSchema",
    "DataSourceCreate",
    "DataSourceUpdate",
    "DataSourceResponse",
    "DataSourceTestRequest",
    "DataSourceTestResponse",
    
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

    # AI Agent saved reports
    "AgentReportSpecCreate",
    "AgentReportSpecUpdate",
    "AgentReportSpecResponse",
    "AgentReportSpecDetailResponse",
    "AgentReportRunCreate",
    "AgentReportRunUpdate",
    "AgentReportRunResponse",
]
