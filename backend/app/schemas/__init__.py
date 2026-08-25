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
    DashboardRelayoutRequest,
    PresentationPlanRequest,
    PresentationPlanResponse,
    DashboardUpdateDraftFiltersRequest,
    DashboardUpdateLayoutRequest,
    DashboardUpdateWidgetRequest,

    # Query
    QueryExecuteRequest,
    QueryExecuteResponse,
    SqlValidateRequest,
    SqlValidateResponse,
    
    # Error
    ErrorResponse,
)

from app.schemas.dataset import (
    # Dataset (Table-based)
    CalendarDimensionSettings,
    DatasetBase,
    DatasetCreate,
    DatasetDictionary,
    DatasetDictionaryResponse,
    DatasetDictionaryStats,
    DatasetDictionaryTableNote,
    DatasetSettings,
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
    # Quality
    QualityRuleCreate,
    QualityRuleUpdate,
    QualityRuleResponse,
    QualityRuleResult,
    QualityRunTriggerResponse,
    QualityRunResponse,
    QualityDimensionSummary,
    QualitySummaryResponse,
    QualityRulePreviewRequest,
    QualityRulePreviewResponse,
    QualityRuleTestRequest,
    QualityRuleTestResponse,
)
from app.schemas.personal_access_token import (
    PersonalAccessTokenCreate,
    PersonalAccessTokenCreateResponse,
    PersonalAccessTokenResponse,
    PersonalAccessTokenUpdate,
)
from app.schemas.dashboard_html_import import (
    DashboardHtmlImportAnalyzeResponse,
    DashboardHtmlImportBatchAnalyzeDocumentResponse,
    DashboardHtmlImportBatchAnalyzeResponse,
    DashboardHtmlImportBatchBuildPageResponse,
    DashboardHtmlImportBatchBuildResponse,
    DashboardHtmlImportBuildResponse,
    DashboardHtmlImportTypeChange,
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
    "DashboardUpdateDraftFiltersRequest",
    "DashboardUpdateLayoutRequest",
    "DashboardUpdateWidgetRequest",
    
    # Query
    "QueryExecuteRequest",
    "QueryExecuteResponse",
    
    # Error
    "ErrorResponse",
    
    # Dataset (Table-based)
    "CalendarDimensionSettings",
    "DatasetBase",
    "DatasetCreate",
    "DatasetDictionary",
    "DatasetDictionaryResponse",
    "DatasetDictionaryStats",
    "DatasetDictionaryTableNote",
    "DatasetSettings",
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
    # Quality
    "QualityRuleCreate",
    "QualityRuleUpdate",
    "QualityRuleResponse",
    "QualityRuleResult",
    "QualityRunTriggerResponse",
    "QualityRunResponse",
    "QualityDimensionSummary",
    "QualitySummaryResponse",
    "QualityRulePreviewRequest",
    "QualityRulePreviewResponse",
    "QualityRuleTestRequest",
    "QualityRuleTestResponse",

    # Dashboard HTML import
    "DashboardHtmlImportAnalyzeResponse",
    "DashboardHtmlImportBuildResponse",
    "DashboardHtmlImportTypeChange",

    # Personal access tokens
    "PersonalAccessTokenCreate",
    "PersonalAccessTokenCreateResponse",
    "PersonalAccessTokenResponse",
    "PersonalAccessTokenUpdate",

    # Dashboard HTML import
    "DashboardHtmlImportAnalyzeResponse",
    "DashboardHtmlImportBatchAnalyzeDocumentResponse",
    "DashboardHtmlImportBatchAnalyzeResponse",
    "DashboardHtmlImportBatchBuildPageResponse",
    "DashboardHtmlImportBatchBuildResponse",
    "DashboardHtmlImportBuildResponse",
    "DashboardHtmlImportTypeChange",
]
