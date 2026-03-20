"""
Models package initialization.
"""
from app.models.user import User, UserStatus
from app.models.resource_share import ResourceShare, ResourceType, SharePermission
from app.models.models import (
    DataSource,
    DataSourceType,
    Chart,
    ChartType,
    Dashboard,
    DashboardChart,
    ChartMetadata,
    ChartParameter,
    SyncJob,
)
from app.models.semantic import (
    SemanticView,
    SemanticModel,
    SemanticExplore,
)
from app.models.dataset_workspace import (
    DatasetWorkspace,
    DatasetWorkspaceTable,
)
# Commented out - using hybrid approach with filters_config JSON field instead
# from app.models.dashboard_filter import DashboardFilter

__all__ = [
    "User",
    "UserStatus",
    "ResourceShare",
    "ResourceType",
    "SharePermission",
    "DataSource",
    "DataSourceType",
    "Chart",
    "ChartType",
    "Dashboard",
    "DashboardChart",
    "ChartMetadata",
    "ChartParameter",
    "SemanticView",
    "SemanticModel",
    "DatasetWorkspace",
    "DatasetWorkspaceTable",
    "SemanticExplore",
    "SyncJob",
]
