"""AppBI Analyst (M2) over HTTP on real Postgres: the first GQS consumer.

Real app, real auth, real routing, real Governed Query Service, the real
durable ledger (as the app role) and real Postgres. The ONLY stand-in is the
language model: a fixed planner returns the JSON a model would. Real-model
behaviour is evaluated separately (and reported NOT VERIFIED when not run).

Numbers are checked against an independent oracle: plain SQL over the source
table, not the engine.

Locked here:
  * a person with `explore` gets an answer whose rows equal the oracle, with
    evidence, a ledger row (surface analyst, run = the turn) and a chart draft;
  * a person with only `view` on the Dataset sees no source and gets no rows;
    a person without the module gets 403; a revoked grant is honoured next turn;
  * a plan naming a field outside the catalog, or another explore, is
    `unsupported` and nothing reaches the ledger;
  * the response carries no SQL text;
  * cancel: another person cannot cancel my turn; my cancel stops my running
    turn and it is recorded `cancelled`;
  * the consent endpoint issues a token bound to the caller only.
"""
from __future__ import annotations

import json
import threading
import time
import uuid

import pytest
import sqlalchemy as sa

from tests.authz_http import client, db, make_user, set_permissions  # noqa: F401 - fixtures
from tests.test_intelligence_gqs_execution_pg import SCHEMA, _owner_url, world  # noqa: F401 - fixtures

pytestmark = pytest.mark.pg


def _planner(world, *, view=None, explore=None, dims=("region", "order_date"), grain="month", extra=None):
    v = view or world["v"]
    raw = {"status": "plan", "explore_id": (explore or world["explore"]).id,
           "dimensions": [f"{v}.{d}" for d in dims], "measures": [f"{v}.revenue"],
           "time_grains": {f"{v}.order_date": grain} if "order_date" in dims else {},
           "interpretation": "Doanh thu theo vùng theo tháng"}
    raw.update(extra or {})
    return lambda prompt, system=None, max_tokens=None: raw


@pytest.fixture()
def model(monkeypatch):
    from app.api import analyst as api

    deps = api._analyst_deps()

    def use(fn):
        monkeypatch.setattr(deps, "complete", fn)

    return use


def _grant_module(db, *who):  # noqa: F811
    for p in who:
        set_permissions(db, p, datasets="edit", explore_charts="view")


def _ledger_rows(run_id):
    with sa.create_engine(_owner_url()).connect() as c:
        return c.execute(sa.text("SELECT status, surface, user_id FROM governed_query_executions WHERE run_id = :r"),
                         {"r": run_id}).all()


def test_an_answer_equals_the_oracle_with_evidence(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_planner(world))
    turn = uuid.uuid4().hex
    r = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                    json={"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?", "turn_id": turn})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "answered", body
    with sa.create_engine(_owner_url()).connect() as c:
        oracle = {(reg, m.strftime("%Y-%m")): float(s) for reg, m, s in c.execute(sa.text(
            f"SELECT region, date_trunc('month', order_date)::date, SUM(amount) FROM {SCHEMA}.sales GROUP BY 1, 2"))}
    cols = {c["role"] + ":" + (c["ref"] or ""): c["name"] for c in body["columns"]}
    v = world["v"]
    got = {(row[cols[f"dimension:{v}.region"]], str(row[cols[f"dimension:{v}.order_date"]])[:7]):
           float(row[cols[f"measure:{v}.revenue"]]) for row in body["rows"]}
    assert got == oracle
    ev = body["evidence"]
    assert ev["query_id"] and ev["rows_returned"] == len(oracle) and ev["filters_dropped"] == []
    assert body["chart_draft"]["chart_type"] == "LINE"
    assert body["chart_draft"]["config"]["roleConfig"]["breakdown"] == f"{v}.region"
    assert [(s, surf) for s, surf, _ in _ledger_rows(turn)] == [("ok", "analyst")]
    assert "select " not in json.dumps(body).lower(), "SQL text reached the response"


def test_view_only_sees_no_source_and_gets_no_rows(client, db, world, model):  # noqa: F811
    _grant_module(db, world["viewer"])
    model(_planner(world))
    assert client.get("/api/v1/analyst/catalog", headers=world["viewer"].headers).json()["sources"] == [] or all(
        s["explore_id"] not in (world["explore"].id, world["slow_explore"].id)
        for s in client.get("/api/v1/analyst/catalog", headers=world["viewer"].headers).json()["sources"])
    turn = uuid.uuid4().hex
    body = client.post("/api/v1/analyst/ask", headers=world["viewer"].headers,
                       json={"question": "Doanh thu theo vùng?", "turn_id": turn}).json()
    assert body["status"] == "unsupported" and "rows" not in body
    assert _ledger_rows(turn) == []


def test_without_the_module_it_is_403(client, world, model):  # noqa: F811
    model(_planner(world))
    r = client.post("/api/v1/analyst/ask", headers=world["stranger"].headers, json={"question": "Doanh thu?"})
    assert r.status_code == 403


def test_a_revoked_grant_is_honoured_on_the_next_turn(client, db, world, model):  # noqa: F811
    from app.models.dataset import DatasetGrant

    _grant_module(db, world["analyst"])
    model(_planner(world))
    first = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers, json={"question": "Doanh thu?"})
    assert first.json()["status"] == "answered"
    db.query(DatasetGrant).filter(DatasetGrant.dataset_id == world["ds"].id,
                                  DatasetGrant.user_id == world["analyst"].id).delete()
    db.commit()
    again = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers, json={"question": "Doanh thu?"})
    assert again.json()["status"] == "unsupported" and "rows" not in again.json()


@pytest.mark.parametrize("bad", [
    {"measures": ["other_view.not_a_measure"]},
    {"dimensions": ["{v}.customer_phone_raw"]},
    {"explore_id": 999999999},
    {"time_grains": {"{v}.order_date": "not_a_grain"}},
    {"filters": {"{v}.region": {"operator": "invalid_op", "value": "x"}}},
], ids=["foreign_measure", "unknown_dimension", "foreign_explore", "bad_grain", "bad_operator"])
def test_an_invalid_plan_is_unsupported_and_runs_nothing(client, db, world, model, bad):  # noqa: F811
    _grant_module(db, world["analyst"])
    v = world["v"]
    fixed = json.loads(json.dumps(bad).replace("{v}", v))
    model(_planner(world, extra=fixed))
    turn = uuid.uuid4().hex
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "Doanh thu?", "turn_id": turn}).json()
    assert body["status"] == "unsupported", body
    assert _ledger_rows(turn) == []


def test_a_clarification_is_passed_to_the_person(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(lambda *a, **k: {"status": "clarify", "question": "Doanh thu gộp hay thuần?", "options": ["Gộp", "Thuần"]})
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers, json={"question": "Doanh thu?"}).json()
    assert body["status"] == "clarify" and body["options"] == ["Gộp", "Thuần"]


def test_cancel_is_the_owners_only_and_stops_the_turn(client, db, world, model):  # noqa: F811
    _grant_module(db, world["owner"], world["analyst"])
    model(_planner(world, view=world["slow_view"].name, explore=world["slow_explore"], dims=()))
    turn = uuid.uuid4().hex
    box = {}

    def run():
        box["r"] = client.post("/api/v1/analyst/ask", headers=world["owner"].headers,
                               json={"question": "Doanh thu (chậm)?", "turn_id": turn})

    th = threading.Thread(target=run, daemon=True)
    th.start()
    deadline = time.time() + 20
    while time.time() < deadline and not any(s == "running" for s, _, _ in _ledger_rows(turn)):
        time.sleep(0.1)
    other = client.post(f"/api/v1/analyst/turns/{turn}/cancel", headers=world["analyst"].headers)
    assert other.json() == {"cancel_requested": 0}
    mine = client.post(f"/api/v1/analyst/turns/{turn}/cancel", headers=world["owner"].headers)
    assert mine.json() == {"cancel_requested": 1}
    th.join(timeout=30)
    body = box["r"].json()
    assert body["status"] == "refused" and body["code"] == "cancelled", body
    assert [s for s, _, _ in _ledger_rows(turn)] == ["cancelled"]


def test_a_turn_id_must_be_plain_hex(client, db, world):  # noqa: F811
    _grant_module(db, world["analyst"])
    r = client.post("/api/v1/analyst/turns/not_a_turn/cancel", headers=world["analyst"].headers)
    assert r.status_code == 422


def test_a_consent_is_issued_to_the_caller_only(client, db, world):  # noqa: F811
    from app.services.governed_query import GovernedRefusal, consent

    _grant_module(db, world["analyst"])
    fp = "a" * 64
    r = client.post("/api/v1/analyst/consents", headers=world["analyst"].headers,
                    json={"query_fingerprint": fp, "fields": ["x.region"]})
    token = r.json()["drop_consent"]
    assert consent.verify(token, user_id=world["analyst"].id, query_fp=fp, dropped_fields=["x.region"])
    with pytest.raises(GovernedRefusal):
        consent.verify(token, user_id=world["owner"].id, query_fp=fp, dropped_fields=["x.region"])


def test_a_follow_up_stays_on_the_previous_source(client, db, world, model):  # noqa: F811
    """Real-model browser run: "and by quarter?" jumped to another dataset. A
    follow-up is held to the previous explore; a plan elsewhere is not run."""
    _grant_module(db, world["analyst"])
    model(_planner(world))
    first = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers, json={"question": "Doanh thu?"}).json()
    assert first["status"] == "answered"
    model(_planner(world, view=world["slow_view"].name, explore=world["slow_explore"], dims=()))
    turn = uuid.uuid4().hex
    follow = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                         json={"question": "Còn theo quý?", "turn_id": turn, "previous_plan": first["plan"]}).json()
    assert follow["status"] == "unsupported", follow
    assert _ledger_rows(turn) == []
    model(_planner(world, grain="quarter"))
    again = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                        json={"question": "Còn theo quý?", "previous_plan": first["plan"]}).json()
    assert again["status"] == "answered" and again["plan"]["explore_id"] == world["explore"].id
