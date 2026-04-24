from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.dependencies import require_full_access
from app.models.chat_session import ChatSession
from app.models.dataset import Dataset
from app.models.models import Chart, Dashboard, DataSource
from app.models.report_template import ReportTemplate
from app.models.resource_share import ResourceType
from app.models.user import User


_RESOURCE_MODEL_MAP = {
    ResourceType.DASHBOARD: (Dashboard, "dashboards", "id"),
    ResourceType.CHART: (Chart, "explore_charts", "id"),
    ResourceType.DATASOURCE: (DataSource, "data_sources", "id"),
    ResourceType.DATASET: (Dataset, "datasets", "id"),
    ResourceType.CHAT_SESSION: (ChatSession, "ai_chat", "session_id"),
    ResourceType.REPORT_TEMPLATE: (ReportTemplate, "report_templates", "id"),
}


def require_share_access(
    db: Session,
    current_user: User,
    resource_type: ResourceType,
    resource_id: str,
):
    """Raise when the caller cannot share the requested resource."""
    model_info = _RESOURCE_MODEL_MAP.get(resource_type)
    if not model_info:
        raise HTTPException(status_code=400, detail="Unsupported resource type")

    model, module, lookup_field = model_info
    if lookup_field == "session_id":
        lookup_value = resource_id
    else:
        try:
            lookup_value = int(resource_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=404, detail="Resource not found")

    resource = db.query(model).filter(getattr(model, lookup_field) == lookup_value).first()
    if not resource:
        raise HTTPException(status_code=404, detail="Resource not found")

    require_full_access(db, current_user, resource, module)
    return resource