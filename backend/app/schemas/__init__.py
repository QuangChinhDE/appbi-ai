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
    DashboardShareRequest,
    PublicLinkCreate,
    PublicLinkUpdate,
    PublicLinkResponse,
    DashboardResponse,
    DashboardAddChartRequest,
    DashboardUpdateLayoutRequest,
    
    # Query
    QueryExecuteRequest,
    QueryExecuteResponse,
    
    # Error
    ErrorResponse,
)

from app.schemas.dataset import (
    # Dataset (Table-based)
    DatasetBase,
    DatasetCreate,
    DatasetUpdate,
    DatasetResponse,
    DatasetWithTables,
    DatasetTableBase,
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
    ColumnMetadata as DatasetColumnMetadata,
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
    "DashboardShareRequest",
    "PublicLinkCreate",
    "PublicLinkUpdate",
    "PublicLinkResponse",
    "DashboardResponse",
    "DashboardAddChartRequest",
    "DashboardUpdateLayoutRequest",
    
    # Query
    "QueryExecuteRequest",
    "QueryExecuteResponse",
    
    # Error
    "ErrorResponse",
    
    # Dataset (Table-based)
    "DatasetBase",
    "DatasetCreate",
    "DatasetUpdate",
    "DatasetResponse",
    "DatasetWithTables",
    "DatasetTableBase",
    "TableCreate",
    "TableUpdate",
    "TableResponse",
    "TablePreviewRequest",
    "TablePreviewResponse",
    "ExecuteQueryRequest",
    "ExecuteQueryResponse",
    "AggregationSpec",
    "FilterCondition",
    "DatasetColumnMetadata",
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
