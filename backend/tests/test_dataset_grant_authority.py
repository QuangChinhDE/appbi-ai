"""A grant can never hand out more than the granter holds.

`POST /datasets/{id}/grants` checked only that the caller held `reshare`, then
wrote whatever verb the body named. A user given `reshare` (= {view, reshare})
could grant `manage` to a colleague — or to themself, by overwriting their own
row — and from there publish, delete and re-grant the dataset. `DELETE` had the
same gap (a resharer could strip a manager), and with neither `user_id` nor
`team_id` it filtered `team_id IS NULL` and deleted every user grant at once.

Rule now: a verb is grantable only when its whole capability set is inside the
caller's own; an existing grant may be changed or revoked only by someone who
could have granted it; nobody below `manage` rewrites their own grant (revoking
it is still allowed — that only ever lowers access).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetGrant


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


OWNER, RESHARER, MANAGER, VIEWER, OTHER = (uuid.uuid4() for _ in range(5))


def _user(uid):
    return SimpleNamespace(id=uid, permissions={"datasets": "edit"})


@pytest.fixture()
def db(monkeypatch):
    import app.core.permissions as perms

    # Every principal sits at module level `edit`: the ceiling allows all six
    # verbs, so only the grants decide — exactly the case under test.
    monkeypatch.setattr(perms, "get_user_module_permission", lambda _u, _m: "edit")
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetGrant.__table__])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="Sales", owner_id=None))
        s.add(DatasetGrant(dataset_id=1, user_id=RESHARER, verb="reshare"))
        s.add(DatasetGrant(dataset_id=1, user_id=MANAGER, verb="manage"))
        s.add(DatasetGrant(dataset_id=1, user_id=VIEWER, verb="view"))
        s.commit()
        yield s


def _verb(db, uid):
    row = db.query(DatasetGrant).filter(DatasetGrant.user_id == uid).first()
    return row.verb if row else None


def _grant(db, caller, **body):
    from app.api.datasets import set_dataset_grant
    return set_dataset_grant(1, body, db=db, current_user=_user(caller))


def _revoke(db, caller, **kw):
    from app.api.datasets import revoke_dataset_grant
    return revoke_dataset_grant(1, db=db, current_user=_user(caller), **kw)


def test_resharer_cannot_grant_manage_to_someone_else(db):
    with pytest.raises(HTTPException) as e:
        _grant(db, RESHARER, verb="manage", user_id=OTHER)
    assert e.value.status_code == 403
    assert _verb(db, OTHER) is None


@pytest.mark.parametrize("verb", ["explore", "build", "edit", "manage"])
def test_resharer_cannot_grant_any_verb_outside_its_own_set(db, verb):
    with pytest.raises(HTTPException) as e:
        _grant(db, RESHARER, verb=verb, user_id=OTHER)
    assert e.value.status_code == 403


def test_resharer_cannot_promote_itself(db):
    with pytest.raises(HTTPException) as e:
        _grant(db, RESHARER, verb="manage", user_id=RESHARER)
    assert e.value.status_code == 403
    assert _verb(db, RESHARER) == "reshare"


def test_resharer_cannot_downgrade_or_revoke_a_manager(db):
    with pytest.raises(HTTPException):
        _grant(db, RESHARER, verb="view", user_id=MANAGER)
    with pytest.raises(HTTPException):
        _revoke(db, RESHARER, user_id=MANAGER)
    assert _verb(db, MANAGER) == "manage"


def test_resharer_can_still_share_what_it_holds(db):
    assert _grant(db, RESHARER, verb="view", user_id=OTHER)["verb"] == "view"
    assert _grant(db, RESHARER, verb="reshare", user_id=OTHER)["verb"] == "reshare"
    assert _revoke(db, RESHARER, user_id=VIEWER)["revoked"] == 1


def test_a_grantee_may_drop_its_own_grant(db):
    assert _revoke(db, RESHARER, user_id=RESHARER)["revoked"] == 1


def test_manager_keeps_full_authority(db):
    assert _grant(db, MANAGER, verb="manage", user_id=OTHER)["verb"] == "manage"
    assert _revoke(db, MANAGER, user_id=RESHARER)["revoked"] == 1


def test_revoke_without_a_principal_deletes_nothing(db):
    before = db.query(DatasetGrant).count()
    with pytest.raises(HTTPException) as e:
        _revoke(db, MANAGER)
    assert e.value.status_code == 400
    assert db.query(DatasetGrant).count() == before
