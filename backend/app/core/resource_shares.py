from __future__ import annotations

from typing import Iterable

from sqlalchemy import case, or_, select
from sqlalchemy.orm import Session

from app.models.resource_share import ResourceShare, ResourceType, SharePermission
from app.models.team import TeamMembership
from app.models.user import User


_SHARE_PERMISSION_ORDER = {"none": 0, "view": 1, "edit": 2}


def share_target_filter_for_user(user: User):
    return or_(
        ResourceShare.user_id == user.id,
        ResourceShare.team_id.in_(
            select(TeamMembership.team_id).where(TeamMembership.user_id == user.id)
        ),
    )


def get_highest_share_for_resource(
    db: Session,
    user: User,
    resource_type: ResourceType,
    resource_id: str,
) -> ResourceShare | None:
    permission_rank = case((ResourceShare.permission == SharePermission.EDIT, 2), else_=1)
    return (
        db.query(ResourceShare)
        .filter(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id == str(resource_id),
        )
        .filter(share_target_filter_for_user(user))
        .order_by(permission_rank.desc(), ResourceShare.id.asc())
        .first()
    )


def get_highest_share_permissions(
    db: Session,
    user: User,
    resource_type: ResourceType,
    resource_ids: Iterable[str],
) -> dict[str, str]:
    normalized_ids = [str(resource_id) for resource_id in resource_ids]
    if not normalized_ids:
        return {}

    shares = (
        db.query(ResourceShare.resource_id, ResourceShare.permission)
        .filter(
            ResourceShare.resource_type == resource_type,
            ResourceShare.resource_id.in_(normalized_ids),
        )
        .filter(share_target_filter_for_user(user))
        .all()
    )

    lookup: dict[str, str] = {}
    for resource_id, permission in shares:
        permission_value = permission.value if hasattr(permission, "value") else str(permission)
        current_value = lookup.get(resource_id, "none")
        if _SHARE_PERMISSION_ORDER.get(permission_value, 0) > _SHARE_PERMISSION_ORDER.get(current_value, 0):
            lookup[resource_id] = permission_value

    return lookup


def get_shared_resource_ids_query(db: Session, user: User, resource_type: ResourceType):
    return (
        db.query(ResourceShare.resource_id)
        .filter(ResourceShare.resource_type == resource_type)
        .filter(share_target_filter_for_user(user))
    )