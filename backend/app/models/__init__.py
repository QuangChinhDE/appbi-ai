"""
Models package initialization.
"""
from app.models.user import AuthProvider, User, UserStatus
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
from app.models.dataset import (
    Dataset,
    DatasetTable,
    DatasetQualityRule,
    DatasetQualityRun,
    DatasetQualitySchedule,
)
from app.models.anomaly import (
    MonitoredMetric,
    AnomalyAlert,
)
from app.models.ai_feedback import AIFeedback
from app.models.agent_report import AgentReportSpec, AgentReportRun
from app.models.personal_access_token import PersonalAccessToken
from app.models.revoked_token import RevokedToken
from app.models.audit_log import AuditLog, AuditAction, AuditSeverity
from app.models.team import Team, TeamMembership
# Workboard models live under app.modules.workboards but are re-exported here
# so SQLAlchemy metadata + alembic autogenerate always see them, regardless of
# whether the workboards module router is enabled at runtime.
from app.modules.workboards.models import (
    Workboard,
    WorkboardSubmission,
    WorkboardWorkspace,
    WorkboardAppLoginAttempt,
)
# Commented out - using hybrid approach with filters_config JSON field instead
# from app.models.dashboard_filter import DashboardFilter

__all__ = [
    "User",
    "UserStatus",
    "AuthProvider",
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
    "Dataset",
    "DatasetTable",
    "DatasetQualityRule",
    "DatasetQualityRun",
    "DatasetQualitySchedule",
    "SemanticExplore",
    "SyncJob",
    "MonitoredMetric",
    "AnomalyAlert",
    "AIFeedback",
    "AgentReportSpec",
    "AgentReportRun",
    "PersonalAccessToken",
    "RevokedToken",
    "AuditLog",
    "AuditAction",
    "AuditSeverity",
    "Team",
    "TeamMembership",
    "Workboard",
    "WorkboardSubmission",
    "WorkboardWorkspace",
    "WorkboardAppLoginAttempt",
]
