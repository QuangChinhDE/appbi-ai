"""
Permission-aware query helpers.

Permissions are stored as a JSONB column on the users table.
Permission levels (ascending): none < view < edit < full

Filter behaviour per level:
  none  → empty result (module hidden entirely)
  view  → own items + items shared to the user (read-only, no CRUD)
  edit  → own items + shared items (can create/update/delete own items)
  full  → all items in the module (unrestricted)

Module keys: data_sources, datasets, explore_charts,
             dashboards, workboards, settings
"""
from __future__ import annotations

from typing import Dict, Type, TypeVar

from sqlalchemy import cast, func, or_, select, String
from sqlalchemy.orm import Session, Query

from app.core.resource_shares import share_target_filter_for_user
from app.models.resource_share import ResourceShare, ResourceType
from app.models.user import User

T = TypeVar("T")

from app.core.authz.registry import LEVEL_ORDER  # noqa: E402  (single ladder)

# ResourceType value -> module key: derived from the authz registry.
from app.core.authz.registry import RESOURCE_TO_MODULE as _RESOURCE_TO_MODULE  # noqa: E402


def get_user_module_permission(user: User, module: str) -> str:
    """Return effective permission level string for a user on a module.

    Routes through ``_normalize_permissions`` so a scoped personal access token is
    capped HERE too. Reading ``user.permissions`` directly was a second, uncapped
    answer to "what may this user do": a PAT scoped to ``datasets: view`` owned by
    someone with ``datasets: full`` still listed every dataset in the deployment,
    because the list filter below never saw the cap that the route dependency did.
    """
    from app.core.dependencies import _normalize_permissions

    return _normalize_permissions(user).get(module, "none")


def _owner_predicate(model, user: User):
    """The "this row belongs to me" SQL predicate for *model*, or ``None`` when the
    model declares no ownership at all.

    Three spellings are recognised, in priority order: ``owner_id``, ``user_id``,
    and ``owner_email``. The last exists because some tables key ownership by email
    rather than by FK (``agent_brain_versions``); without it those models fell into
    the no-ownership branch and were never filtered.
    """
    from app.core.authz.registry import spec_for_model

    spec = spec_for_model(model)
    attrs = spec.owner_attrs if spec is not None else ("owner_id", "user_id", "owner_email")
    for attr in attrs:
        col = getattr(model, attr, None)
        if col is None:
            continue
        if attr.endswith("_email"):
            user_email = str(getattr(user, "email", "") or "").strip().lower()
            if not user_email:
                return None
            return func.lower(col) == user_email
        return col == user.id

    return None


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
    owner_predicate = _owner_predicate(model, user)
    if owner_predicate is None:
        # Fail CLOSED. This used to `return q` — EVERY row, for every level above
        # `none` — whenever a model had no ownership column. AgentBrainVersion is
        # exactly such a model (it keys ownership by `owner_email`), so "flows
        # shared with me" silently meant "every flow in the deployment". A filter
        # that cannot be built is not a reason to skip filtering.
        return q.filter(False)

    shared_ids_subq = (
        select(ResourceShare.resource_id)
        .where(ResourceShare.resource_type == resource_type)
        .where(share_target_filter_for_user(user))
    )

    visible = [owner_predicate, cast(model.id, String).in_(shared_ids_subq)]
    if resource_type == ResourceType.DATASET:
        # The Dataset policy also grants through DatasetGrant (user or team):
        # the list must show exactly what the object check allows.
        from app.services.dataset_grants_service import grants_scope_subquery

        visible.append(model.id.in_(grants_scope_subquery(user, db)))
    return q.filter(or_(*visible))


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
