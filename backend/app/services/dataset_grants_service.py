"""
Dataset access — Power-BI-style verbs on a Dataset as a governed asset (Phase 1).

DELIBERATELY NOT a linear level ladder. Build and Reshare are independent
CAPABILITIES, not "higher than edit" — so a legacy ResourceShare(EDIT) is NEVER
silently upgraded into Build/Reshare (governance principle #4). Access is the
UNION of the capability sets of every grant the user holds (own + user grant +
team grants + admin), plus a compatibility bridge from the old ResourceShare
(DATASET view/edit → view / edit only).

Verbs and what each UNLOCKS:
  view     → {view}                      consume dashboards on the dataset
  explore  → {view, explore}             ad-hoc query / preview
  build    → {view, explore, build}      create NEW content from it (dashboards,
                                          or a downstream Dataset that references it)
  reshare  → {view, reshare}             grant access to others
  edit     → {view, explore, edit}       modify the design (NOT build/reshare)
  manage   → all six                     owner-equivalent: grants, publish, delete
"""
from __future__ import annotations

import logging
from typing import Optional, Set

from sqlalchemy.orm import Session

from app.models.dataset import Dataset, DatasetGrant
from app.models.user import User

logger = logging.getLogger(__name__)

VALID_VERBS = ("view", "explore", "build", "reshare", "edit", "manage")

_CAPS: dict[str, Set[str]] = {
    "view": {"view"},
    "explore": {"view", "explore"},
    "build": {"view", "explore", "build"},
    "reshare": {"view", "reshare"},
    "edit": {"view", "explore", "edit"},
    "manage": {"view", "explore", "build", "reshare", "edit", "manage"},
}


def _team_ids(db: Session, user: User) -> list:
    try:
        from app.models.team import TeamMember
        rows = db.query(TeamMember.team_id).filter(TeamMember.user_id == user.id).all()
        return [r[0] for r in rows]
    except Exception:  # noqa: BLE001 — teams optional
        return []


def _module_capability_ceiling(user: User) -> Set[str]:
    """What the `datasets` module level alone permits, before any grant.

    The verb model is deliberately not a ladder, but the MODULE level still is,
    and it is a ceiling over every verb — a user the admin set to `datasets: none`
    has no business holding capabilities on a dataset just because they created it
    before being demoted. Without this the grants tier answered "manage" for an
    owner whose module level was `none`, which is the same owner-outranks-the-
    matrix bug the object-level tier had.
    """
    try:
        from app.core.permissions import get_user_module_permission

        level = get_user_module_permission(user, "datasets")
    except Exception:  # noqa: BLE001 — never fail open on a lookup error
        return set()

    if level == "full":
        return set(_CAPS["manage"])
    if level == "edit":
        # Everything an owner does day to day. `reshare` and `manage` stay with
        # module-full, matching require_full_access on the object-level tier.
        return {"view", "explore", "build", "edit", "reshare", "manage"}
    if level == "view":
        return {"view", "explore"}
    return set()


def dataset_capabilities(db: Session, user: User, dataset: Dataset) -> Set[str]:
    """Union of every capability the user has on the dataset, capped by the
    `datasets` module level."""
    caps: Set[str] = set()
    if user is None or dataset is None:
        return caps

    ceiling = _module_capability_ceiling(user)
    if not ceiling:
        # `datasets: none` — the module is hidden entirely, grants included.
        return caps

    # Owner → manage (all), bounded by the module ceiling.
    if dataset.owner_id is not None and dataset.owner_id == user.id:
        return set(_CAPS["manage"]) & ceiling

    # Admin / module-full on datasets → manage.
    try:
        from app.core.permissions import get_user_module_permission
        if get_user_module_permission(user, "datasets") == "full":
            return set(_CAPS["manage"])
    except Exception:  # noqa: BLE001
        pass

    team_ids = _team_ids(db, user)
    grants = (
        db.query(DatasetGrant)
        .filter(DatasetGrant.dataset_id == dataset.id)
        .all()
    )
    for g in grants:
        applies = (g.user_id == user.id) or (g.team_id is not None and g.team_id in team_ids)
        if applies and g.verb in _CAPS:
            caps |= _CAPS[g.verb]

    # Compatibility bridge from the legacy shared ResourceShare (principle #4:
    # edit → edit ONLY, never build/reshare).
    try:
        from app.models.resource_share import ResourceShare, ResourceType, SharePermission
        shares = (
            db.query(ResourceShare)
            .filter(
                ResourceShare.resource_type == ResourceType.DATASET,
                ResourceShare.resource_id == str(dataset.id),
            )
            .all()
        )
        for s in shares:
            applies = (s.user_id == user.id) or (s.team_id is not None and s.team_id in team_ids)
            if not applies:
                continue
            if s.permission == SharePermission.EDIT:
                caps |= _CAPS["edit"]
            else:
                caps |= _CAPS["view"]
    except Exception:  # noqa: BLE001 — resource-share bridge is best-effort
        pass

    return caps & ceiling


def can(db: Session, user: User, dataset: Dataset, capability: str) -> bool:
    return capability in dataset_capabilities(db, user, dataset)


def require_capability(db: Session, user: User, dataset: Dataset, capability: str) -> None:
    """Raise 403 if the user lacks `capability` on the dataset."""
    if not can(db, user, dataset, capability):
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Bạn không có quyền '{capability}' trên Dataset này.",
        )


def require_view_lineage(db: Session, user: User, child_dataset_id: int) -> None:
    """Composition principle #3: a viewer of a composed dataset needs View on it
    AND on EVERY parent dataset (transitively). This is a NO-OP for datasets with
    no parent-ref tables, so existing (non-composition) reads are unaffected —
    the check only ever fires for a Dataset-on-Dataset composition. Owner /
    module-full / explicit grants all satisfy `view` via dataset_capabilities."""
    from app.services import dataset_composition_service as comp
    # Collect all transitive parents.
    seen: set[int] = set()
    stack: list[int] = list(comp.parent_dataset_ids(db, child_dataset_id))
    stack += comp._direct_parents(db, child_dataset_id)
    all_parents: set[int] = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        all_parents.add(pid)
        stack.extend(comp._direct_parents(db, pid))
    if not all_parents:
        return
    from fastapi import HTTPException, status
    for pid in all_parents:
        parent = db.query(Dataset).filter(Dataset.id == pid).first()
        if parent is None:
            continue
        if not can(db, user, parent, "view"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Bạn cần quyền View trên Dataset cha '{parent.name}' để xem báo cáo dựng trên Dataset này.",
            )


def set_grant(db: Session, dataset_id: int, *, verb: str,
              user_id=None, team_id=None, granted_by=None) -> DatasetGrant:
    """Upsert a single grant (one verb per principal per dataset)."""
    if verb not in VALID_VERBS:
        raise ValueError(f"Invalid verb '{verb}'")
    if (user_id is None) == (team_id is None):
        raise ValueError("Exactly one of user_id / team_id must be set")
    q = db.query(DatasetGrant).filter(DatasetGrant.dataset_id == dataset_id)
    q = q.filter(DatasetGrant.user_id == user_id) if user_id else q.filter(DatasetGrant.team_id == team_id)
    row = q.first()
    if row is None:
        row = DatasetGrant(dataset_id=dataset_id, user_id=user_id, team_id=team_id,
                           verb=verb, granted_by=granted_by)
        db.add(row)
    else:
        row.verb = verb
    db.commit()
    return row


def revoke_grant(db: Session, dataset_id: int, *, user_id=None, team_id=None) -> int:
    q = db.query(DatasetGrant).filter(DatasetGrant.dataset_id == dataset_id)
    q = q.filter(DatasetGrant.user_id == user_id) if user_id else q.filter(DatasetGrant.team_id == team_id)
    n = q.delete()
    db.commit()
    return n
