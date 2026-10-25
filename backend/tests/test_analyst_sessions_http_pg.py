"""AI Analyst sessions over HTTP on real Postgres: persisted, shareable, and never a
way around a Dataset grant.

Same world and fixed planner as test_analyst_http_pg.py (the model is the only
stand-in). Locked here:

  * a session keeps its turns: a reload returns the same answer, oracle-equal;
  * sharing through /shares needs `analyst >= edit` on the owner; a view-only module
    level cannot share; revoking the share removes access on the next request;
  * A SHARED SESSION NEVER SHOWS NUMBERS THE VIEWER CANNOT READ: a recipient without
    EXPLORE on the Dataset sees the question and `redacted`, no rows, no evidence;
  * `analyst: full` oversight lists every session and is redacted the same way;
  * a revoked Dataset grant redacts the OWNER's own stored answer on the next read;
  * a view recipient cannot ask; an edit recipient asks AS THEMSELVES (own grants,
    own ledger row);
  * a team share reads; removal from the team removes it;
  * no access is 404 (not 403), for a foreign id and an unknown id alike;
  * rename/delete are the owner's; a deleted session is gone for everyone;
  * the follow-up context comes from the session, never from the request body.
"""
from __future__ import annotations

import json
import uuid

import pytest
import sqlalchemy as sa

from tests.authz_http import client, db, make_user, set_permissions  # noqa: F401 - fixtures
from tests.test_analyst_http_pg import _ledger_rows, _planner, model, pilot  # noqa: F401 - fixtures
from tests.test_intelligence_gqs_execution_pg import SCHEMA, _owner_url, world  # noqa: F401 - fixtures

pytestmark = pytest.mark.pg

Q = "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"


def _module(db, who, level="view"):  # noqa: F811
    set_permissions(db, who, datasets="edit", explore_charts="view", analyst=level)


def _new(client, who, title=None):  # noqa: F811
    r = client.post("/api/v1/analyst/sessions", headers=who.headers, json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _ask(client, who, sid, question=Q, **extra):  # noqa: F811
    return client.post(f"/api/v1/analyst/sessions/{sid}/ask", headers=who.headers,
                       json={"question": question, "turn_id": uuid.uuid4().hex, **extra})


def _get(client, who, sid):  # noqa: F811
    return client.get(f"/api/v1/analyst/sessions/{sid}", headers=who.headers)


def _oracle():
    with sa.create_engine(_owner_url()).connect() as c:
        return sorted(float(s) for (s,) in c.execute(sa.text(
            f"SELECT SUM(amount) FROM {SCHEMA}.sales GROUP BY region, date_trunc('month', order_date)")))


def _numbers(turn):
    resp = turn["response"]
    m = next(c["name"] for c in resp["columns"] if c["role"] == "measure")
    return sorted(float(r[m]) for r in resp["rows"])


def _share(client, owner, sid, who=None, team=None, permission="view"):  # noqa: F811
    body = {"permission": permission, **({"team_id": str(team)} if team else {"user_id": str(who.id)})}
    return client.post(f"/api/v1/shares/analyst_session/{sid}", headers=owner.headers, json=body)


@pytest.fixture()
def answered(client, db, world, model):  # noqa: F811
    """The analyst (EXPLORE on the Dataset, analyst: edit) asked one question in a session."""
    _module(db, world["analyst"], "edit")
    model(_planner(world))
    sid = _new(client, world["analyst"])
    r = _ask(client, world["analyst"], sid)
    assert r.status_code == 200 and r.json()["status"] == "answered", r.text
    return sid


def _assert_redacted(body):
    turn = body["turns"][0]
    assert turn["redacted"] is True and turn["response"] is None
    text = json.dumps(body)
    for leak in ('"rows"', '"evidence"', '"columns"', '"plan"', "query_id"):
        assert leak not in text, f"{leak} reached a viewer without the Dataset"
    assert set(turn) == {"seq", "turn_id", "question", "status", "asked_at", "asked_by_me", "response", "redacted"}
    oracle = set(_oracle())

    def numbers(x):
        if isinstance(x, dict):
            return [n for k, v in x.items() if k != "seq" for n in numbers(v)]
        if isinstance(x, list):
            return [n for v in x for n in numbers(v)]
        return [float(x)] if isinstance(x, (int, float)) and not isinstance(x, bool) else []

    assert not oracle & set(numbers(body["turns"])), "a number reached a viewer without the Dataset"


def test_a_session_keeps_its_answer_across_a_reload_and_is_listed(client, db, world, answered):  # noqa: F811
    body = _get(client, world["analyst"], answered).json()
    assert body["access"] == "owner" and body["title"] == Q[:120]
    [turn] = body["turns"]
    assert turn["redacted"] is False and turn["asked_by_me"] is True
    assert _numbers(turn) == _oracle()
    assert "select " not in json.dumps(body).lower()
    listed = client.get("/api/v1/analyst/sessions", headers=world["analyst"].headers).json()["sessions"]
    assert any(s["id"] == answered for s in listed)


def test_a_view_module_level_cannot_share_and_edit_can(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    _module(db, world["analyst"], "view")
    assert _share(client, world["analyst"], answered, world["viewer"]).status_code == 403
    _module(db, world["analyst"], "edit")
    assert _share(client, world["analyst"], answered, world["viewer"]).status_code == 201


def test_a_shared_session_never_shows_numbers_the_recipient_cannot_read(client, db, world, answered):  # noqa: F811
    # viewer: a VIEW (not explore) grant on the Dataset, so no Analyst catalog for it
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
    turn_id = uuid.uuid4().hex
    r = client.post(f"/api/v1/analyst/sessions/{answered}/ask", headers=world["viewer"].headers,
                    json={"question": Q, "turn_id": turn_id})
    assert r.status_code == 200 and r.json()["status"] == "unsupported" and "rows" not in r.json()
    assert _ledger_rows(turn_id) == []                       # nothing was read with the owner's rights
    _assert_redacted({"turns": _get(client, world["viewer"], answered).json()["turns"][:1]})


def test_revoking_the_share_removes_access_next_request(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    share_id = _share(client, world["analyst"], answered, world["viewer"]).json()["id"]
    assert _get(client, world["viewer"], answered).status_code == 200
    r = client.delete(f"/api/v1/shares/analyst_session/{answered}/entries/{share_id}", headers=world["analyst"].headers)
    assert r.status_code == 204, r.text
    assert _get(client, world["viewer"], answered).status_code == 404
    assert all(s["id"] != answered for s in
               client.get("/api/v1/analyst/sessions", headers=world["viewer"].headers).json()["sessions"])


def test_a_team_share_reads_and_leaving_the_team_removes_it(client, db, world, answered):  # noqa: F811
    from app.models.team import Team, TeamMembership

    _module(db, world["viewer"])
    team = Team(name=f"analyst-team-{uuid.uuid4().hex[:8]}")
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


def test_revoking_the_module_closes_every_session_route(client, db, world, answered):  # noqa: F811
    set_permissions(db, world["analyst"], datasets="edit", explore_charts="view", analyst="none")
    assert _get(client, world["analyst"], answered).status_code == 403
    assert client.get("/api/v1/analyst/sessions", headers=world["analyst"].headers).status_code == 403
    assert _ask(client, world["analyst"], answered).status_code == 403


def test_module_oversight_lists_every_session_but_is_still_redacted(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"], "full")
    listed = client.get("/api/v1/analyst/sessions", headers=world["viewer"].headers).json()["sessions"]
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
    assert client.patch(f"/api/v1/analyst/sessions/{answered}", headers=world["viewer"].headers,
                        json={"title": "x"}).status_code == 404


def test_rename_and_delete_are_the_owners(client, db, world, answered):  # noqa: F811
    _module(db, world["viewer"])
    _share(client, world["analyst"], answered, world["viewer"], permission="edit")
    assert client.patch(f"/api/v1/analyst/sessions/{answered}", headers=world["viewer"].headers,
                        json={"title": "x"}).status_code == 403
    assert client.delete(f"/api/v1/analyst/sessions/{answered}", headers=world["viewer"].headers).status_code == 403
    r = client.patch(f"/api/v1/analyst/sessions/{answered}", headers=world["analyst"].headers, json={"title": "Q3 review"})
    assert r.status_code == 200 and r.json()["title"] == "Q3 review"
    assert client.delete(f"/api/v1/analyst/sessions/{answered}", headers=world["analyst"].headers).status_code == 204
    assert _get(client, world["analyst"], answered).status_code == 404
    assert _get(client, world["viewer"], answered).status_code == 404


def test_the_follow_up_context_comes_from_the_session_not_the_request(client, db, world, answered, monkeypatch):  # noqa: F811
    from app.services.analyst import service

    seen = []
    real = service.ask

    def spy(*a, **k):
        seen.append(k.get("previous"))
        return real(*a, **k)

    monkeypatch.setattr(service, "ask", spy)
    forged = {"explore_id": 999999, "dimensions": ["x.y"], "measures": ["x.z"]}
    r = _ask(client, world["analyst"], answered, "còn theo quý thì sao", previous_plan=forged)
    assert r.status_code == 200
    assert seen and seen[0] is not None and seen[0]["explore_id"] == world["explore"].id
    _ask(client, world["analyst"], answered, Q, follow_up=False)
    assert seen[-1] is None


def test_a_reused_turn_id_is_refused(client, db, world, answered):  # noqa: F811
    turn_id = _get(client, world["analyst"], answered).json()["turns"][0]["turn_id"]
    r = client.post(f"/api/v1/analyst/sessions/{answered}/ask", headers=world["analyst"].headers,
                    json={"question": Q, "turn_id": turn_id})
    assert r.status_code == 409
