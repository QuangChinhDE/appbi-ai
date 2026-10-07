"""
Dataset access — the canonical Dataset capability model.

Capabilities (what a holder may do with ONE dataset):

  view     metadata / basic consumption
  explore  raw rows: preview, query, export
  build    use the dataset as input to downstream content (charts,
           dashboards, workboards, compositions, agent-flow attachments)
  edit     change the dataset definition / model
  reshare  delegate a subset of what the holder can use
  manage   owner-equivalent administration (publish, destination, grant any
           verb, delete)

Grant verbs and the capabilities they carry:

  view     -> {view}
  explore  -> {view, explore}
  build    -> {view, explore, build}
  edit     -> {view, explore, build, edit}
  reshare  -> {view, reshare}
  manage   -> all six

Legacy ResourceShare(DATASET) rows are read through the same table:
  VIEW -> explore (no build), EDIT -> edit (no publish / reshare / manage).

The `datasets` MODULE level is a ceiling, never a source of capability:
  none -> nothing;  view -> at most {view, explore};
  edit -> no ceiling on the verbs a relation (owner / grant) gives;
  full -> module administrator: manage on every dataset, explicitly.
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
    "edit": {"view", "explore", "build", "edit"},
    "manage": {"view", "explore", "build", "reshare", "edit", "manage"},
}


def _team_ids(db: Session, user: User) -> list:
    """Teams the user belongs to. Resolved through TeamMembership — the model the
    generic share engine uses. This used to import a `TeamMember` class that has
    never existed, swallow the ImportError and return [], so every team grant was
    silently ignored while the grants UI showed it as granted."""
    from app.models.team import TeamMembership

    rows = db.query(TeamMembership.team_id).filter(TeamMembership.user_id == user.id).all()
    return [r[0] for r in rows]


def _module_capability_ceiling(user: User) -> Set[str]:
    """What the `datasets` module level alone permits, before any grant.

    The verb model is deliberately not a ladder, but the MODULE level still is,
    and it is a ceiling over every verb — a user the admin set to `datasets: none`
    has no business holding capabilities on a dataset just because they created it
    before being demoted. Without this the grants tier answered "manage" for an
    owner whose module level was `none`, which is the same owner-outranks-the-
    matrix bug the object-level tier had.
    """
    from app.core.permissions import get_user_module_permission

    level = get_user_module_permission(user, "datasets")

    # A CEILING: these sets bound what a relation can give; they never give
    # anything on their own (a user with no relation to a dataset gets nothing
    # whatever their module level, except a module administrator - see
    # dataset_capabilities).
    if level in ("full", "edit"):
        return set(_CAPS["manage"])
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

    # Module administrator: manage on every dataset, explicitly.
    from app.core.permissions import get_user_module_permission

    if get_user_module_permission(user, "datasets") == "full":
        return set(_CAPS["manage"])

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

    # There is no second storage: legacy ResourceShare(DATASET) rows were
    # converted to grants by migration 20261008_0001 and are no longer read.

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


#: Verbs a holder of `reshare` (but not `manage`) may hand out. Re-sharing passes
#: on what you can USE, never the right to administer: reshare/edit/manage stay
#: with `manage` holders (owner, module admin, an explicit manage grant).
_RESHARE_DELEGABLE = ("view", "explore", "build")


def delegable_verbs(caps: Set[str]) -> Set[str]:
    """The verbs a principal with capability set `caps` may grant or revoke.

    A grant can never carry more than the grantor holds: every verb returned has
    its whole capability set inside `caps`."""
    if "manage" in caps:
        return set(VALID_VERBS)
    if "reshare" not in caps:
        return set()
    return {v for v in _RESHARE_DELEGABLE if _CAPS[v] <= caps}


class GrantError(Exception):
    """A grant/revoke request that must be refused. `status` is the HTTP status."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def parse_target(user_id, team_id):
    """Exactly one of user_id / team_id, as a UUID. Anything else is a 400 —
    an absent or empty target must never be read as "every grant"."""
    import uuid as _uuid

    def _one(v):
        if v is None or (isinstance(v, str) and not v.strip()):
            return None
        try:
            return _uuid.UUID(str(v))
        except (ValueError, AttributeError, TypeError):
            raise GrantError(400, "Invalid grant target id") from None

    u, t = _one(user_id), _one(team_id)
    if (u is None) == (t is None):
        raise GrantError(400, "Exactly one of user_id / team_id must be set")
    return u, t


def _existing(db: Session, dataset_id: int, user_id, team_id):
    q = db.query(DatasetGrant).filter(DatasetGrant.dataset_id == dataset_id)
    if user_id is not None:
        return q.filter(DatasetGrant.user_id == user_id, DatasetGrant.team_id.is_(None)).first()
    return q.filter(DatasetGrant.team_id == team_id, DatasetGrant.user_id.is_(None)).first()


def grant_as(db: Session, actor: User, dataset: Dataset, *, verb, user_id=None, team_id=None) -> DatasetGrant:
    """Grant `verb` on `dataset` to one user or team, ON BEHALF OF `actor`.

    Refused when: the verb is unknown; the target is not exactly one valid,
    existing user/team; the actor targets themselves; the verb exceeds what the
    actor may delegate; or an existing grant on that target already exceeds it
    (a re-sharer may not downgrade a manager)."""
    from app.models.team import Team

    if verb not in VALID_VERBS:
        raise GrantError(400, f"Invalid verb '{verb}'")
    u, t = parse_target(user_id, team_id)
    if u is not None and u == actor.id:
        raise GrantError(403, "You cannot change your own access to this dataset")
    if u is not None and db.get(User, u) is None:
        raise GrantError(400, "Unknown user")
    if t is not None and db.get(Team, t) is None:
        raise GrantError(400, "Unknown team")
    allowed = delegable_verbs(dataset_capabilities(db, actor, dataset))
    if verb not in allowed:
        raise GrantError(403, f"You cannot grant '{verb}' on this dataset")
    row = _existing(db, dataset.id, u, t)
    if row is not None and row.verb not in allowed:
        raise GrantError(403, f"You cannot change an existing '{row.verb}' grant")
    if row is None:
        row = DatasetGrant(dataset_id=dataset.id, user_id=u, team_id=t, verb=verb, granted_by=actor.id)
        db.add(row)
    else:
        row.verb = verb
        row.granted_by = actor.id
    db.commit()
    return row


def revoke_as(db: Session, actor: User, dataset: Dataset, *, user_id=None, team_id=None) -> int:
    """Revoke the ONE grant held by one user or team. Deletes at most one row;
    a missing/blank/both target is a 400, never a filter that matches everything."""
    u, t = parse_target(user_id, team_id)
    row = _existing(db, dataset.id, u, t)
    if row is None:
        return 0
    allowed = delegable_verbs(dataset_capabilities(db, actor, dataset))
    if row.verb not in allowed:
        raise GrantError(403, f"You cannot revoke a '{row.verb}' grant")
    db.delete(row)
    db.commit()
    return 1


def level_from_capabilities(caps: Set[str]) -> str:
    """The generic effective level that corresponds to a Dataset capability set.

    Every generic object check (get_effective_permission, require_*_access, the
    `user_permission` the API returns) reads a Dataset THROUGH this mapping, so
    the generic tier and the Dataset policy can no longer give two answers:
        manage -> full, edit -> edit, any other capability -> view, none -> none.
    """
    if "manage" in caps:
        return "full"
    if "edit" in caps:
        return "edit"
    return "view" if caps else "none"


def batch_dataset_capabilities(db: Session, user: User, datasets) -> dict:
    """``dataset_capabilities`` for many datasets with a constant number of
    queries (list endpoints). Must agree row for row with the single version."""
    from app.core.permissions import get_user_module_permission

    datasets = [d for d in datasets if d is not None]
    out = {d.id: set() for d in datasets}
    if user is None or not datasets:
        return out
    ceiling = _module_capability_ceiling(user)
    if not ceiling:
        return out
    if get_user_module_permission(user, "datasets") == "full":
        return {d.id: set(_CAPS["manage"]) for d in datasets}
    ids = [d.id for d in datasets]
    team_ids = _team_ids(db, user)
    grants = db.query(DatasetGrant).filter(DatasetGrant.dataset_id.in_(ids)).all()
    for d in datasets:
        if d.owner_id is not None and d.owner_id == user.id:
            out[d.id] = set(_CAPS["manage"]) & ceiling
            continue
        caps: Set[str] = set()
        for g in grants:
            if g.dataset_id == d.id and g.verb in _CAPS and (
                g.user_id == user.id or (g.team_id is not None and g.team_id in team_ids)
            ):
                caps |= _CAPS[g.verb]
        out[d.id] = caps & ceiling
    return out


def grants_scope_subquery(user: User, db: Session):
    """SELECT dataset_id the user holds a DatasetGrant on (directly or via a team)."""
    from sqlalchemy import or_, select

    team_ids = _team_ids(db, user)
    cond = DatasetGrant.user_id == user.id
    if team_ids:
        cond = or_(cond, DatasetGrant.team_id.in_(team_ids))
    return select(DatasetGrant.dataset_id).where(cond)


# ── The generic /shares API, for datasets, is an adapter over grants ─────────
# The ShareDialog speaks view/edit. For a dataset: view -> `explore`,
# edit -> `edit` (the same reading legacy shares got). Every write goes through
# grant_as / revoke_as, so the anti-escalation rules apply here too.

SHARE_TO_VERB = {"view": "explore", "edit": "edit"}


def share_level_of(verb: str) -> str:
    return "edit" if verb in ("edit", "manage") else "view"


def cascade_grant(db: Session, dataset_id: int, verb: str, *, user_id=None, team_id=None,
                  granted_by=None, source: str) -> None:
    """Grant created by sharing something that USES the dataset (a dashboard).
    Never downgrades or replaces an existing grant that already covers it;
    tagged with ``source`` so revoking that share removes only what it added."""
    u, t = (user_id, None) if user_id is not None else (None, team_id)
    row = _existing(db, dataset_id, u, t)
    if row is not None:
        if _CAPS.get(row.verb, set()) >= _CAPS[verb]:
            return
        if row.source is None or row.source == "legacy_share":
            return  # a direct grant is never rewritten by a cascade
        row.verb = verb
        row.source = source
        return
    db.add(DatasetGrant(dataset_id=dataset_id, user_id=u, team_id=t, verb=verb,
                        granted_by=granted_by, source=source))


def revoke_cascade_grants(db: Session, dataset_ids, *, user_id=None, team_id=None, source: str) -> int:
    q = db.query(DatasetGrant).filter(DatasetGrant.dataset_id.in_(list(dataset_ids)),
                                      DatasetGrant.source == source)
    q = q.filter(DatasetGrant.user_id == user_id) if user_id is not None else q.filter(DatasetGrant.team_id == team_id)
    return q.delete(synchronize_session=False)



def list_grants(db: Session, dataset_id: int) -> list:
    return db.query(DatasetGrant).filter(DatasetGrant.dataset_id == dataset_id).all()


def datasets_with_grants(db: Session, dataset_ids) -> set:
    """Of ``dataset_ids``, those shared with anyone (any grant)."""
    ids = [int(i) for i in dataset_ids]
    if not ids:
        return set()
    return {r[0] for r in db.query(DatasetGrant.dataset_id).filter(DatasetGrant.dataset_id.in_(ids)).distinct()}
