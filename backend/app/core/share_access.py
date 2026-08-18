from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.dependencies import require_full_access
from app.models.agent_brain import AgentBrainVersion
from app.models.dataset import Dataset
from app.models.models import Chart, Dashboard, DataSource
from app.models.governance import GovernKnowledgeDoc
from app.models.resource_share import ResourceType
from app.models.user import User
from app.modules.workboards.models import Workboard


_RESOURCE_MODEL_MAP = {
    ResourceType.DASHBOARD: (Dashboard, "dashboards", "id"),
    ResourceType.CHART: (Chart, "explore_charts", "id"),
    ResourceType.DATASOURCE: (DataSource, "data_sources", "id"),
    ResourceType.DATASET: (Dataset, "datasets", "id"),
    ResourceType.WORKBOARD: (Workboard, "workboards", "id"),
    ResourceType.KNOWLEDGE_DOC: (GovernKnowledgeDoc, "govern", "id"),
    # Agent flows were HALF-BUILT for sharing: `ResourceType.AGENT_BRAIN` existed,
    # `_RESOURCE_TO_MODULE` mapped it, and `permissions.usable_brains()` read
    # ResourceShare rows for it — but this map had no entry, so every share
    # endpoint answered 400 "Unsupported resource type". The read side was looking
    # for shares the write side could not create. Keyed by `brain_key` so one share
    # covers the flow across all of its versions.
    ResourceType.AGENT_BRAIN: (AgentBrainVersion, "agent_flows", "brain_key"),
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
    column = getattr(model, lookup_field)

    # Most resources are keyed by an integer PK. An agent flow is keyed by its
    # STRING `brain_key`, because a share has to cover the flow itself rather than
    # one revision of it — a share pinned to a version row would silently stop
    # applying the next time the author saved.
    if lookup_field == "id":
        try:
            lookup_value: object = int(resource_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=404, detail="Resource not found")
    else:
        lookup_value = str(resource_id)

    resource = db.query(model).filter(column == lookup_value).first()
    if not resource:
        raise HTTPException(status_code=404, detail="Resource not found")

    require_full_access(db, current_user, resource, module)
    return resource
