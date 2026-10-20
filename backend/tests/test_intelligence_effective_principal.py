"""EffectivePrincipal + AuthorizationContext hold ONE intersection-only formula (spec §1, I-1…I-4).

Everything runs on the REAL authorization core (`app.core.authz.decision.can`, the
Dataset policy) over in-memory SQLite. Nothing about the decision is stubbed.

Locked here:

* explore is required to query; `view` is not enough (ADR-002);
* the surface ceiling only narrows;
* an Agent Flow delegation row never widens a GQS decision (I-3);
* a PAT never reaches more than the same person in a session (PAT ⊆ human);
* a system principal cannot answer for a person (I-2);
* an unresolvable principal is refused (I-4);
* an AI-scope lookup that fails refuses, never "nothing excluded".
"""
from __future__ import annotations

import types
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.authz.decision import Action
from app.services.governed_query import (
    AuthorizationContext, EffectivePrincipal, GovernedRefusal, SurfaceCeiling,
)


@compiles(UUID, "sqlite")
def _uuid(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb(_t, _c, **_k):
    return "JSON"


OWNER = uuid.UUID("11111111-1111-1111-1111-111111111111")
ASKER = uuid.UUID("22222222-2222-2222-2222-222222222222")


def _user(uid, level="edit", pat=False):
    u = types.SimpleNamespace(id=uid, email=f"{str(uid)[:8]}@appbi.io", permissions={"datasets": level})
    if pat:
        from app.core.dependencies import PERSONAL_ACCESS_TOKEN_ID_ATTR

        setattr(u, PERSONAL_ACCESS_TOKEN_ID_ATTR, uuid.uuid4())
    return u


@pytest.fixture()
def db():
    from app.core.database import Base
    from app.models.agent_flow_delegation import AgentFlowDelegation
    from app.models.dataset import Dataset, DatasetGrant
    from app.models.team import TeamMembership

    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[
        TeamMembership.__table__, DatasetGrant.__table__, Dataset.__table__,
        AgentFlowDelegation.__table__,
    ])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="Sales", owner_id=OWNER))
        s.add(Dataset(id=2, name="Payroll", owner_id=OWNER))
        s.commit()
        yield s


def _grant(db, verb, dataset_id=1, uid=ASKER):
    from app.models.dataset import DatasetGrant

    db.add(DatasetGrant(dataset_id=dataset_id, user_id=uid, verb=verb))
    db.commit()


def _ctx(db, user, surface="analyst", ceiling=None):
    p = EffectivePrincipal.for_user(user, surface=surface)
    return AuthorizationContext(db=db, principal=p, user=user,
                                ceiling=SurfaceCeiling.of(ceiling) if ceiling is not None else SurfaceCeiling())


def _ds(db, i):
    from app.models.dataset import Dataset

    return db.get(Dataset, i)


@pytest.mark.parametrize("verb,may_query", [
    ("view", False), ("explore", True), ("build", True), ("edit", True), ("manage", True),
])
def test_querying_needs_explore_view_is_not_enough(db, verb, may_query):
    _grant(db, verb)
    ctx = _ctx(db, _user(ASKER))
    assert ctx.decide(Action.READ, _ds(db, 1)).allowed is True
    assert ctx.decide(Action.EXPLORE, _ds(db, 1)).allowed is may_query


def test_no_relation_no_query(db):
    ctx = _ctx(db, _user(ASKER))
    assert not ctx.decide(Action.EXPLORE, _ds(db, 1)).allowed
    with pytest.raises(GovernedRefusal) as exc:
        ctx.require(Action.EXPLORE, _ds(db, 1))
    assert exc.value.code == "not_authorized"


def test_the_surface_ceiling_only_narrows(db):
    _grant(db, "explore", 1)
    _grant(db, "explore", 2)
    ctx = _ctx(db, _user(ASKER), surface="studio_test", ceiling=[1])
    assert ctx.decide(Action.EXPLORE, _ds(db, 1)).allowed
    denied = ctx.decide(Action.EXPLORE, _ds(db, 2))
    assert not denied.allowed and denied.via == "surface_ceiling"
    # A ceiling never grants: dataset 1 in the ceiling, but no grant at all.
    db.query(__import__("app.models.dataset", fromlist=["DatasetGrant"]).DatasetGrant).delete()
    db.commit()
    assert not _ctx(db, _user(ASKER), ceiling=[1, 2]).decide(Action.EXPLORE, _ds(db, 1)).allowed


def test_an_agent_flow_delegation_never_widens_a_governed_decision(db):
    """I-3. The owner delegated dataset 2 to the asker for a flow; the asker holds
    nothing on dataset 2. Agent Flow's run_scope would add it (caller ∪ delegated);
    GQS does not."""
    from app.models.agent_flow_delegation import AgentFlowDelegation

    db.add(AgentFlowDelegation(brain_key="flow_x", grantee_user_id=ASKER, resource_type="dataset",
                               resource_id=2, action="read", created_by=OWNER))
    db.commit()
    for surface in ("analyst", "agent_flow", "studio_test"):
        assert not _ctx(db, _user(ASKER), surface=surface).decide(Action.EXPLORE, _ds(db, 2)).allowed


def test_the_owner_queries_their_own_dataset(db):
    assert _ctx(db, _user(OWNER)).decide(Action.EXPLORE, _ds(db, 1)).allowed


@pytest.mark.parametrize("action", [Action.READ, Action.EXPLORE, Action.BUILD, Action.EDIT, Action.MANAGE])
def test_a_pat_never_reaches_more_than_the_person(db, action):
    """PAT ⊆ human. The PAT is capped at `datasets: view`; the same person in a
    session holds `datasets: edit`."""
    human = _ctx(db, _user(OWNER, "edit")).decide(action, _ds(db, 1)).allowed
    pat_ctx = _ctx(db, _user(OWNER, "view", pat=True))
    assert pat_ctx.principal.kind == "pat"
    pat = pat_ctx.decide(action, _ds(db, 1)).allowed
    assert not (pat and not human)
    if action in (Action.BUILD, Action.EDIT, Action.MANAGE):
        assert pat is False, "a view-capped PAT cannot build/edit/manage"


def test_a_system_principal_cannot_answer_for_a_person(db):
    p = EffectivePrincipal(user_id=OWNER, kind="system", surface="analyst", request_id="r")
    with pytest.raises(GovernedRefusal) as exc:
        AuthorizationContext(db=db, principal=p, user=_user(OWNER))
    assert exc.value.code == "not_authorized"


def test_an_unresolvable_principal_is_refused(db):
    with pytest.raises(GovernedRefusal) as exc:
        EffectivePrincipal.for_user(None, surface="analyst")
    assert exc.value.code == "not_authenticated"
    p = EffectivePrincipal.for_user(_user(ASKER), surface="analyst")
    with pytest.raises(GovernedRefusal):
        AuthorizationContext(db=db, principal=p, user=_user(OWNER))  # someone else's session


def test_a_failed_ai_scope_lookup_refuses(db, monkeypatch):
    from app.services.governance_ai_service import GovernanceAIService

    def boom(*_a, **_k):
        raise RuntimeError("store down")

    monkeypatch.setattr(GovernanceAIService, "scope_exclusions", boom)
    with pytest.raises(GovernedRefusal) as exc:
        _ctx(db, _user(OWNER)).excluded_columns([1])
    assert exc.value.code == "policy_unavailable"


def test_ai_scope_exclusions_are_returned_folded(db, monkeypatch):
    from app.services.governance_ai_service import GovernanceAIService

    monkeypatch.setattr(GovernanceAIService, "scope_exclusions",
                        staticmethod(lambda _db, _ids: ({"Salary", "CMND"}, set())))
    assert _ctx(db, _user(OWNER)).excluded_columns([1]) == {"salary", "cmnd"}


def test_the_principal_ref_carries_no_pii():
    p = EffectivePrincipal.for_user(_user(ASKER), surface="analyst")
    assert p.ref == f"human:{ASKER}@analyst"
    assert "@appbi.io" not in p.ref
