"""Studio "Test as chat" runs with the TESTER's rights, over HTTP, on Postgres (SEC-03).

The unit ledger (`test_intelligence_phase0_security_repro.py`) proves `run_preview`
passes the caller and adopts the caller-bounded datasets. This proves the whole
path a shared editor actually takes:

    POST /api/v1/agent-flows/brains/{key}/test-as-chat
      → `_may_edit_flow` (a shared editor passes)
      → run_scope(..., caller=user) in the endpoint
      → run_preview(..., caller=user) recomputing it
      → the context handed to the flow runtime

with real users, real grants and real flow-sharing rows on Postgres, through the
non-superuser application role. Only two things are stubbed. The model call
(`executor.run_flow`) is replaced by a recorder of the context it would receive.
The per-step AI-key check is skipped, because no provider key exists in a test
database.

Before the fix, the editor's context carried the OWNER's private dataset.
"""
from __future__ import annotations

import uuid

import pytest

from tests.authz_http import client, db, make_user, share  # noqa: F401

pytestmark = pytest.mark.pg


@pytest.fixture()
def world(db):  # noqa: F811
    from app.models.agent_brain import AgentBrainVersion
    from app.models.dataset import Dataset
    from app.models.user import User

    owner = make_user(db, "st-owner", agent_flows="edit", datasets="edit", chat="edit")
    editor = make_user(db, "st-editor", agent_flows="edit", datasets="view", chat="view")
    ds_private = Dataset(name=f"payroll-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    ds_shared = Dataset(name=f"sales-{uuid.uuid4().hex[:6]}", owner_id=owner.id)
    db.add_all([ds_private, ds_shared])
    db.commit()
    share(db, "dataset", ds_shared.id, editor, "view", owner)
    key = f"flow_{uuid.uuid4().hex[:8]}"
    body = {"name": "F", "flow_type": "chat", "nodes": [{
        "key": "a", "type": "agent", "name": "A", "prompt": "p", "tools": [],
        "knowledge": [
            {"source": "semantic", "ref": str(ds_private.id),
             "description": "Bảng lương nhân sự; tra khi hỏi về lương thưởng."},
            {"source": "semantic", "ref": str(ds_shared.id),
             "description": "Doanh số bán hàng theo ngày; tra khi hỏi về doanh thu."},
        ],
    }]}
    db.add(AgentBrainVersion(brain_key=key, version=1, name="F", body=body, status="draft",
                             owner_email=db.get(User, owner.id).email))
    db.commit()
    # Shared at EDIT: the Test button is reachable by this person.
    share(db, "agent_brain", key, editor, "edit", owner)
    return dict(owner=owner, editor=editor, key=key, private=ds_private, shared=ds_shared)


@pytest.fixture()
def recorded(monkeypatch):
    """Replace the model call with a recorder of the context the runtime gets."""
    from app.modules.agent_flows import api as af_api
    from app.services.agent_flows.runtime import executor

    seen: dict = {}

    async def run_flow(inp, *, flow, ctx, **_kw):
        seen["ctx"] = ctx
        if False:  # pragma: no cover - an async generator that yields nothing
            yield None

    monkeypatch.setattr(executor, "run_flow", run_flow)
    monkeypatch.setattr(af_api, "_require_keys", lambda *_a, **_k: None)
    return seen


def _test_as_chat(client, world, who):  # noqa: F811
    r = client.post(f"/api/v1/agent-flows/brains/{world['key']}/test-as-chat",
                    headers=world[who].headers, json={"question": "doanh thu tháng 9?"})
    assert r.status_code == 200, r.text
    return r


def test_a_shared_editor_testing_reaches_only_their_own_data(client, db, world, recorded):  # noqa: F811
    _test_as_chat(client, world, "editor")
    ctx = recorded["ctx"]
    assert set(ctx.knowledge_scope["dataset_ids"]) == {world["shared"].id}
    assert world["private"].id not in set(ctx.run_scope_ceiling["dataset_ids"])
    # The chat surface withholds raw rows live; the Test panel now runs the same.
    assert ctx.read_rows is False


def test_the_owner_testing_still_reaches_everything_attached(client, db, world, recorded):  # noqa: F811
    """The allow half: the fix bounds the tester, it does not empty the owner."""
    _test_as_chat(client, world, "owner")
    assert set(recorded["ctx"].knowledge_scope["dataset_ids"]) == {world["private"].id, world["shared"].id}


def test_a_viewer_of_the_flow_cannot_press_test(client, db, world):  # noqa: F811
    from app.models.user import User
    from tests.authz_http import make_user as _mk

    viewer = _mk(db, "st-viewer", agent_flows="edit", datasets="view", chat="view")
    share(db, "agent_brain", world["key"], viewer, "view", world["owner"])
    r = client.post(f"/api/v1/agent-flows/brains/{world['key']}/test-as-chat",
                    headers=viewer.headers, json={"question": "q"})
    assert r.status_code in (403, 404), r.text
    assert db.get(User, viewer.id) is not None
