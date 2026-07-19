"""Helpers for permanently deleting a user.

A hard-delete of a user row is DB-safe: child rows (module_permissions,
personal_access_tokens, team_memberships, resource_shares — both user_id and
shared_by — and anomaly subscriptions) cascade away, and every owner_id FK on a
real resource is SET NULL, so resources survive but become unowned.

"Unowned" resources are only visible to settings=full admins, so before deleting
we reassign the primary user-facing resources to the acting admin. That keeps
dashboards/datasets/etc. visible to their normal audience. Secondary owner_id
tables (governance docs, observability, dataset models) fall back to the DB's
existing SET NULL.

Imports are function-local to avoid any import-time coupling between app.core and
the model / workboards-module layers.
"""
from __future__ import annotations

import uuid

from sqlalchemy.orm import Session


def _owned_resource_models():
    """(module_key, model) pairs whose owner_id we reassign on delete."""
    from app.models.dataset import Dataset
    from app.models.models import Chart, Dashboard, DataSource
    from app.modules.workboards.models import Workboard, WorkboardWorkspace

    return [
        ("data_sources", DataSource),
        ("datasets", Dataset),
        ("explore_charts", Chart),
        ("dashboards", Dashboard),
        ("workboards", Workboard),
        ("workboards", WorkboardWorkspace),
    ]


def summarize_owned_resources(db: Session, user_id: uuid.UUID) -> dict[str, int]:
    """Count what a user owns / created, keyed for the delete-impact dialog.

    Resource keys match the FE module labels; `shares_given` and `api_tokens`
    are cascade-deleted (not reassigned) and reported so the admin knows.
    """
    from app.models.personal_access_token import PersonalAccessToken
    from app.models.resource_share import ResourceShare

    counts: dict[str, int] = {}
    for module_key, model in _owned_resource_models():
        counts[module_key] = counts.get(module_key, 0) + (
            db.query(model).filter(model.owner_id == user_id).count()
        )

    counts["shares_given"] = (
        db.query(ResourceShare).filter(ResourceShare.shared_by == user_id).count()
    )
    counts["api_tokens"] = (
        db.query(PersonalAccessToken).filter(PersonalAccessToken.owner_id == user_id).count()
    )
    return counts


def reassign_user_resources(
    db: Session, from_user_id: uuid.UUID, to_user_id: uuid.UUID
) -> int:
    """Bulk-reassign owned resources so they stay visible after the owner is gone.

    Returns the number of rows reassigned. Caller commits.
    """
    total = 0
    for _module_key, model in _owned_resource_models():
        total += (
            db.query(model)
            .filter(model.owner_id == from_user_id)
            .update({model.owner_id: to_user_id}, synchronize_session=False)
        )
    return total
