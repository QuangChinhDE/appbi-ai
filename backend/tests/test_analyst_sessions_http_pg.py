"""AI Chat conversations over HTTP on real Postgres: persisted, shareable, and never a
way around a Dataset grant. (Built as AI Analyst sessions; since the unified chat
the ONE conversation store - services/chat/conversations.py.)

Same world and fixed planner as test_analyst_http_pg.py (the model is the only
stand-in). Locked here:

  * a conversation keeps its turns: a reload returns the same answer, oracle-equal;
  * sharing through /shares needs `chat >= edit` on the owner; a view-only module
    level cannot share; revoking the share removes access on the next request;
  * A SHARED CONVERSATION NEVER SHOWS NUMBERS THE VIEWER CANNOT READ: a recipient
    without EXPLORE on the Dataset sees the question and `redacted`, no rows, no
    evidence;
  * `chat: full` oversight lists every conversation and is redacted the same way;
  * a revoked Dataset grant redacts the OWNER's own stored answer on the next read;
  * a view recipient cannot ask; an edit recipient asks AS THEMSELVES (own grants,
    own ledger row);
  * a team share reads; removal from the team removes it;
  * no access is 404 (not 403), for a foreign id and an unknown id alike;
  * rename/delete are the owner's; a deleted conversation is gone for everyone;
  * the follow-up context comes from the conversation, never from the request body;
  * a retried submit (same idempotency key) is the same turn: one row, one ledger
    read, one model call; another person cannot reuse it.
"""
from __future__ import annotations

import json
import uuid

import pytest
import sqlalchemy as sa

from tests.authz_http import client, db, make_user, set_permissions  # noqa: F401 - fixtures
from tests.test_analyst_http_pg import _ledger_rows, _planner, ask, model, sse_events  # noqa: F401 - fixtures
from tests.test_intelligence_gqs_execution_pg import SCHEMA, _owner_url, world  # noqa: F401 - fixtures

pytestmark = pytest.mark.pg

Q = "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"
TURN_KEYS = {"seq", "turn_id", "question", "status", "origin", "asked_at", "asked_by_me", "envelope", "redacted",
             "redacted_reason"}


def _module(db, who, level="view"):  # noqa: F811
    set_permissions(db, who, datasets="edit", explore_charts="view", chat=level)


def _new(client, who, title=None):  # noqa: F811
    r = client.post("/api/v1/chat/conversations", headers=who.headers, json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _ask(client, who, cid, question=Q, key=None, **extra):  # noqa: F811
    return ask(client, who, {"question": question, **extra}, conv=cid, key=key)


def _get(client, who, cid):  # noqa: F811
    return client.get(f"/api/v1/chat/conversations/{cid}", headers=who.headers)


def _oracle():
    with sa.create_engine(_owner_url()).connect() as c:
        return sorted(float(s) for (s,) in c.execute(sa.text(
            f"SELECT SUM(amount) FROM {SCHEMA}.sales GROUP BY region, date_trunc('month', order_date)")))


def _numbers(turn):
    data = turn["envelope"]["data"]
    m = next(c["name"] for c in data["columns"] if c["role"] == "measure")
    return sorted(float(r[m]) for r in data["rows"])


def _share(client, owner, cid, who=None, team=None, permission="view"):  # noqa: F811
    body = {"permission": permission, **({"team_id": str(team)} if team else {"user_id": str(who.id)})}
    return client.post(f"/api/v1/shares/chat_conversation/{cid}", headers=owner.headers, json=body)


@pytest.fixture()
def answered(client, db, world, model):  # noqa: F811
    """The analyst (EXPLORE on the Dataset, chat: edit) asked one question in a conversation."""
    _module(db, world["analyst"], "edit")
    model(_planner(world))
    cid = _new(client, world["analyst"])
    r = _ask(client, world["analyst"], cid)
    assert r.status_code == 200 and r.json()["status"] == "answered", r.text
    return cid


def _assert_redacted(body):
    turn = body["turns"][0]
    assert turn["redacted"] is True and turn["envelope"] is None
    text = json.dumps(body)
    for leak in ('"rows"', '"evidence"', '"columns"', '"plan"', "query_id"):
        assert leak not in text, f"{leak} reached a viewer without the Dataset"
    assert set(turn) == TURN_KEYS
    assert turn["redacted_reason"] == "source_access"
    oracle = set(_oracle())

    def numbers(x):
        if isinstance(x, dict):
            return [n for k, v in x.items() if k != "seq" for n in numbers(v)]
        if isinstance(x, list):
            return [n for v in x for n in numbers(v)]
        return [float(x)] if isinstance(x, (int, float)) and not isinstance(x, bool) else []

    assert not oracle & set(numbers(body["turns"])), "a number reached a viewer without the Dataset"


def test_a_conversation_keeps_its_answer_across_a_reload_and_is_listed(client, db, world, answered):  # noqa: F811
    body = _get(client, world["analyst"], answered).json()
    assert body["access"] == "owner" and body["title"] == Q[:120] and body["extension_flow_key"] is None
    [turn] = body["turns"]
    assert set(turn) == TURN_KEYS and turn["origin"] == "core"
    assert turn["redacted"] is False and turn["asked_by_me"] is True and turn["status"] == "answered"
    assert _numbers(turn) == _oracle()
    assert "select " not in json.dumps(body).lower()
    assert all("token" not in json.dumps(o) for o in (turn["envelope"]["data"].get("choices") or []))
    listed = client.get("/api/v1/chat/conversations", headers=world["analyst"].headers).json()["conversations"]
    assert any(s["id"] == answered for s in listed)


def test_a_view_module_level_cannot_share_and_edit_can(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    _module(db, world["analyst"], "view")
    assert _share(client, world["analyst"], answered, world["viewer"]).status_code == 403
    _module(db, world["analyst"], "edit")
    assert _share(client, world["analyst"], answered, world["viewer"]).status_code == 201


def test_a_shared_conversation_never_shows_numbers_the_recipient_cannot_read(client, db, world, answered):  # noqa: F811
    # viewer: a VIEW (not explore) grant on the Dataset, so no data catalog for it
    _module(db, world["viewer"])
    assert _share(client, world["analyst"], answered, world["viewer"]).status_code == 201
    r = _get(client, world["viewer"], answered)
    assert r.status_code == 200 and r.json()["access"] == "view" and r.json()["can_ask"] is False
    _assert_redacted(r.json())


def test_a_recipient_who_holds_the_dataset_sees_the_answer(client, db, world, answered):  # noqa: F811
    from tests.authz_http import share

    _module(db, world["stranger"])
    share(db, "dataset", world["ds"].id, world["stranger"], "view", world["owner"])  # view share = EXPLORE grant
    assert _share(client, world["analyst"], answered, world["stranger"]).status_code == 201
    turn = _get(client, world["stranger"], answered).json()["turns"][0]
    assert turn["redacted"] is False and _numbers(turn) == _oracle()


def test_a_view_recipient_cannot_ask_and_an_edit_recipient_asks_as_themselves(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    _share(client, world["analyst"], answered, world["viewer"])
    assert _ask(client, world["viewer"], answered).status_code == 403
    _share(client, world["analyst"], answered, world["viewer"], permission="edit")
    r = _ask(client, world["viewer"], answered)
    assert r.status_code == 200 and r.json()["status"] == "unsupported" and "rows" not in r.json()
    assert _ledger_rows(r.json()["turn_id"]) == []            # nothing was read with the owner's rights
    _assert_redacted({"turns": _get(client, world["viewer"], answered).json()["turns"][:1]})
    # the recipient's turn read no source: private to them, and the owner is told exactly that
    theirs = _get(client, world["analyst"], answered).json()["turns"][1]
    assert theirs["redacted"] is True and theirs["redacted_reason"] == "asker_only" and theirs["asked_by_me"] is False


def test_revoking_the_share_removes_access_next_request(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    share_id = _share(client, world["analyst"], answered, world["viewer"]).json()["id"]
    assert _get(client, world["viewer"], answered).status_code == 200
    r = client.delete(f"/api/v1/shares/chat_conversation/{answered}/entries/{share_id}",
                      headers=world["analyst"].headers)
    assert r.status_code == 204, r.text
    assert _get(client, world["viewer"], answered).status_code == 404
    assert all(s["id"] != answered for s in
               client.get("/api/v1/chat/conversations", headers=world["viewer"].headers).json()["conversations"])


def test_a_team_share_reads_and_leaving_the_team_removes_it(client, db, world, answered):  # noqa: F811
    from app.models.team import Team, TeamMembership

    _module(db, world["viewer"])
    team = Team(name=f"chat-team-{uuid.uuid4().hex[:8]}")
    db.add(team)
    db.flush()
    db.add(TeamMembership(team_id=team.id, user_id=world["viewer"].id))
    db.commit()
    try:
        assert _share(client, world["analyst"], answered, team=team.id).status_code == 201
        assert _get(client, world["viewer"], answered).status_code == 200
        db.query(TeamMembership).filter(TeamMembership.team_id == team.id).delete()
        db.commit()
        assert _get(client, world["viewer"], answered).status_code == 404
    finally:
        db.query(Team).filter(Team.id == team.id).delete()
        db.commit()


def test_a_revoked_dataset_grant_redacts_the_owners_own_stored_answer(client, db, world, answered):  # noqa: F811
    from app.models.dataset import DatasetGrant

    db.query(DatasetGrant).filter(DatasetGrant.dataset_id == world["ds"].id,
                                  DatasetGrant.user_id == world["analyst"].id).delete()
    db.commit()
    _assert_redacted(_get(client, world["analyst"], answered).json())


def test_revoking_the_module_closes_every_conversation_route(client, db, world, answered):  # noqa: F811
    set_permissions(db, world["analyst"], datasets="edit", explore_charts="view", chat="none")
    assert _get(client, world["analyst"], answered).status_code == 403
    assert client.get("/api/v1/chat/conversations", headers=world["analyst"].headers).status_code == 403
    assert _ask(client, world["analyst"], answered).status_code == 403


def test_module_oversight_lists_every_conversation_but_is_still_redacted(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"], "full")
    listed = client.get("/api/v1/chat/conversations", headers=world["viewer"].headers).json()["conversations"]
    assert any(s["id"] == answered and s["access"] == "full" for s in listed)
    body = _get(client, world["viewer"], answered).json()
    assert body["can_ask"] is False
    _assert_redacted(body)


def test_no_access_is_404_for_a_foreign_and_an_unknown_id_alike(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    foreign = _get(client, world["viewer"], answered)
    unknown = _get(client, world["viewer"], 2_000_000_000)
    assert foreign.status_code == unknown.status_code == 404 and foreign.json() == unknown.json()
    assert _ask(client, world["viewer"], answered).status_code == 404
    assert client.patch(f"/api/v1/chat/conversations/{answered}", headers=world["viewer"].headers,
                        json={"title": "x"}).status_code == 404


def test_rename_and_delete_are_the_owners(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    _share(client, world["analyst"], answered, world["viewer"], permission="edit")
    assert client.patch(f"/api/v1/chat/conversations/{answered}", headers=world["viewer"].headers,
                        json={"title": "x"}).status_code == 403
    assert client.delete(f"/api/v1/chat/conversations/{answered}", headers=world["viewer"].headers).status_code == 403
    r = client.patch(f"/api/v1/chat/conversations/{answered}", headers=world["analyst"].headers,
                     json={"title": "Q3 review"})
    assert r.status_code == 200 and r.json()["title"] == "Q3 review"
    assert client.delete(f"/api/v1/chat/conversations/{answered}", headers=world["analyst"].headers).status_code == 204
    assert _get(client, world["analyst"], answered).status_code == 404
    assert _get(client, world["viewer"], answered).status_code == 404


def test_the_follow_up_context_comes_from_the_conversation_not_the_request(client, db, world, answered,  # noqa: F811
                                                                         monkeypatch):
    from app.services.data_core import service

    seen = []
    real = service.ask

    def spy(*a, **k):
        seen.append(k.get("previous"))
        return real(*a, **k)

    monkeypatch.setattr(service, "ask", spy)
    forged = {"explore_id": 999999, "dimensions": ["x.y"], "measures": ["x.z"]}
    # a body carrying a plan is not a way to set the context: the field does not exist
    r = client.post(f"/api/v1/chat/conversations/{answered}/turns", headers=world["analyst"].headers,
                    json={"question": "còn theo quý thì sao", "idempotency_key": uuid.uuid4().hex,
                          "previous_plan": forged})
    assert r.status_code == 200
    assert seen and seen[0] is not None and seen[0]["explore_id"] == world["explore"].id
    _ask(client, world["analyst"], answered, Q, follow_up=False)
    assert seen[-1] is None


def test_a_retried_submit_is_the_same_turn_and_runs_once(client, db, world, answered, model):  # noqa: F811
    calls = []
    model(lambda prompt, system=None, max_tokens=None: calls.append(1) or _planner(world)(prompt))
    key = uuid.uuid4().hex
    first = _ask(client, world["analyst"], answered, Q, key=key)
    second = _ask(client, world["analyst"], answered, Q, key=key)
    assert first.json()["turn_id"] == second.json()["turn_id"]
    accepted = [e for e in sse_events(second.text) if e["type"] == "accepted"][0]
    assert accepted["replayed"] is True
    assert len(calls) == 1, "a retried submit called the model again"
    assert len(_ledger_rows(first.json()["turn_id"])) == 1
    turns = _get(client, world["analyst"], answered).json()["turns"]
    assert [t["turn_id"] for t in turns].count(first.json()["turn_id"]) == 1 and len(turns) == 2
    assert _numbers(turns[1]) == _oracle()


def test_another_person_cannot_reuse_an_idempotency_key(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    _share(client, world["analyst"], answered, world["viewer"], permission="edit")
    key = uuid.uuid4().hex
    assert _ask(client, world["analyst"], answered, Q, key=key).status_code == 200
    stolen = _ask(client, world["viewer"], answered, Q, key=key)
    assert stolen.status_code == 409 and "rows" not in stolen.text
