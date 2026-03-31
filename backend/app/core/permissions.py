"""
Permission-aware query helpers.

Permissions are stored as a JSONB column on the users table.
Permission levels (ascending): none < view < edit < full

Filter behaviour per level:
  none  → empty result (module hidden entirely)
  view  → own items + items shared to the user (read-only, no CRUD)
  edit  → own items + shared items (can create/update/delete own items)
  full  → all items in the module (unrestricted)

Module keys: data_sources, datasets, workspaces, explore_charts,
             dashboards, ai_chat, settings
"""
from __future__ import annotations

from typing import Dict, Type, TypeVar

from sqlalchemy import cast, or_, String
from sqlalchemy.orm import Session, Query

from app.models.resource_share import ResourceShare, ResourceType
from app.models.user import User

T = TypeVar("T")

LEVEL_ORDER: Dict[str, int] = {"none": 0, "view": 1, "edit": 2, "full": 3}

# Maps ResourceType value → module key
_RESOURCE_TO_MODULE: Dict[str, str] = {
    "dashboard": "dashboards",
    "chart": "explore_charts",
    "workspace": "workspaces",
    "datasource": "data_sources",
    "chat_session": "ai_chat",
}


def get_user_module_permission(user: User, module: str) -> str:
    """Return effective permission level string for a user on a module."""
    perms: dict = user.permissions or {}
    return perms.get(module, "none")


def _owned_or_shared(
    db: Session,
    model: Type[T],
    resource_type: ResourceType,
    user: User,
) -> Query:
    """
    Return a SQLAlchemy query filtered by the user's module permission.

    - full  → all rows
    - edit  → rows owned by user OR shared to user
    - view  → rows owned by user OR shared to user
    - none  → empty result
    """
    q = db.query(model)

    module_name = _RESOURCE_TO_MODULE.get(resource_type.value)
    if not module_name:
        return q.filter(False)

    level = get_user_module_permission(user, module_name)

    if level == "none":
        return q.filter(False)

    if level == "full":
        return q

    # view or edit: own + shared only
    # Models must have an owner_id (or user_id) column.
    owner_col = getattr(model, "owner_id", None) or getattr(model, "user_id", None)
    if owner_col is None:
        # Fallback: if model has no ownership column, return all for non-none levels
        return q

    shared_ids_subq = (
        db.query(ResourceShare.resource_id)
        .filter(
            ResourceShare.resource_type == resource_type,
            ResourceShare.user_id == user.id,
        )
        .subquery()
        .select()
    )

    return q.filter(
        or_(
            owner_col == user.id,
            cast(model.id, String).in_(shared_ids_subq),
        )
    )


# Keep old name for backward-compat with any remaining imports
def get_module_permission(db: Session, user: User, module: str) -> str:
    """Deprecated alias — use get_user_module_permission() instead."""
    return get_user_module_permission(user, module)


def stamp_owner_emails(db: Session, items) -> None:
    """Batch-set `owner_email` on a list of ORM objects that have `owner_id`."""
    owner_ids = {i.owner_id for i in items if i.owner_id}
    if not owner_ids:
        return
    users = db.query(User.id, User.email).filter(User.id.in_(owner_ids)).all()
    lookup = {u.id: u.email for u in users}
    for item in items:
        item.owner_email = lookup.get(item.owner_id)
