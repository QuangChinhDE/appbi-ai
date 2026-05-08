from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.dependencies import require_full_access
from app.models.dataset import Dataset
from app.models.models import Chart, Dashboard, DataSource
from app.models.resource_share import ResourceType
from app.models.user import User
from app.modules.workboards.models import Workboard


_RESOURCE_MODEL_MAP = {
    ResourceType.DASHBOARD: (Dashboard, "dashboards", "id"),
    ResourceType.CHART: (Chart, "explore_charts", "id"),
    ResourceType.DATASOURCE: (DataSource, "data_sources", "id"),
    ResourceType.DATASET: (Dataset, "datasets", "id"),
    ResourceType.WORKBOARD: (Workboard, "workboards", "id"),
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
    try:
        lookup_value = int(resource_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=404, detail="Resource not found")

    resource = db.query(model).filter(getattr(model, lookup_field) == lookup_value).first()
    if not resource:
        raise HTTPException(status_code=404, detail="Resource not found")

    require_full_access(db, current_user, resource, module)
    return resource
