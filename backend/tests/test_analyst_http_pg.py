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
from tests.test_intelligence_gqs_execution_pg import SCHEMA, _owner_url, one_drop, world  # noqa: F401 - fixtures

pytestmark = pytest.mark.pg


def _planner(world, *, view=None, explore=None, dims=("region", "order_date"), grain="month", extra=None):
    v = view or world["v"]
    raw = {"status": "plan", "explore_id": (explore or world["explore"]).id,
           "dimensions": [f"{v}.{d}" for d in dims], "measures": [f"{v}.revenue"],
           "time_grains": {f"{v}.order_date": grain} if "order_date" in dims else {},
           "interpretation": "Doanh thu theo vùng theo tháng",
           # what a real model returns: each question phrase -> the ref it names
           # (services/analyst/grounding.py only believes phrases that are in the question)
           "covered": {"doanh thu": f"{v}.revenue", "chậm": f"{v}.revenue", "vùng": f"{v}.region",
                       "các vùng": f"{v}.region", "miền bắc": f"{v}.region", "theo tháng": f"{v}.order_date"}}
    raw["covered"] = {k: r for k, r in raw["covered"].items()
                      if r.rsplit(".", 1)[-1] in {*dims, "revenue"}
                      or (k == "miền bắc" and (extra or {}).get("filters"))}
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
        set_permissions(db, p, datasets="edit", explore_charts="view", analyst="view")


@pytest.fixture(autouse=True)
def pilot(monkeypatch, world):  # noqa: F811
    """Every person in the world is on the pilot allowlist unless a test says otherwise."""
    from app.core.config import settings

    emails = [p.email for p in world.values() if hasattr(p, "email") and hasattr(p, "headers")]
    monkeypatch.setattr(settings, "ANALYST_PILOT_ALLOWLIST", ",".join(e.upper() for e in emails))
    return emails


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


def test_a_consent_is_issued_to_the_caller_only(client, db, world, consent_on):  # noqa: F811
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


# ── PO gate 4: a dedicated, fail-closed pilot permission ─────────────────────

def _ask(client, who):  # noqa: F811
    return client.post("/api/v1/analyst/ask", headers=who.headers, json={"question": "Doanh thu theo vùng?"})


def test_explore_without_the_analyst_permission_is_403(client, db, world, model):  # noqa: F811
    set_permissions(db, world["analyst"], datasets="edit", explore_charts="full")
    model(_planner(world))
    assert _ask(client, world["analyst"]).status_code == 403
    assert client.get("/api/v1/analyst/catalog", headers=world["analyst"].headers).status_code == 403


def test_the_analyst_permission_without_explore_is_403(client, db, world, model):  # noqa: F811
    set_permissions(db, world["analyst"], datasets="edit", analyst="view")
    model(_planner(world))
    assert _ask(client, world["analyst"]).status_code == 403


def test_off_the_allowlist_is_403_and_an_empty_allowlist_admits_nobody(client, db, world, model, monkeypatch):  # noqa: F811
    from app.core.config import settings

    _grant_module(db, world["analyst"])
    model(_planner(world))
    assert _ask(client, world["analyst"]).json()["status"] == "answered"
    monkeypatch.setattr(settings, "ANALYST_PILOT_ALLOWLIST", "someone-else@x.test")
    assert _ask(client, world["analyst"]).status_code == 403
    monkeypatch.setattr(settings, "ANALYST_PILOT_ALLOWLIST", "")
    r = _ask(client, world["analyst"])
    assert r.status_code == 403 and "rows" not in r.text


def test_revoking_the_analyst_permission_applies_to_the_next_request(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_planner(world))
    assert _ask(client, world["analyst"]).json()["status"] == "answered"
    set_permissions(db, world["analyst"], datasets="edit", explore_charts="view", analyst="none")
    assert _ask(client, world["analyst"]).status_code == 403
    turn = uuid.uuid4().hex
    assert client.post(f"/api/v1/analyst/turns/{turn}/cancel", headers=world["analyst"].headers).status_code == 403


def test_no_preset_but_admin_grants_the_analyst():
    from app.api.permissions import PRESETS

    assert PRESETS["admin"].get("analyst") == "view"
    assert all(PRESETS[p].get("analyst", "none") == "none" for p in ("editor", "viewer", "minimal"))


# ── PO gate 5: accepting a dropped filter re-runs the SAME validated plan ──────

@pytest.fixture()
def consent_on(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "ANALYST_DROP_CONSENT_ENABLED", True)


def test_accepting_a_dropped_filter_is_off_by_default(client, db, world, model, one_drop):  # noqa: F811
    """The pilot default: a dropped filter is a plain refusal; no consent can be
    issued or spent until the consent journey is certified."""
    _grant_module(db, world["analyst"])
    v = world["v"]
    model(_planner(world, dims=("order_date",), extra={"filters": {f"{v}.region": {"operator": "eq", "value": "Bắc"}}}))
    refused = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                          json={"question": "Doanh thu miền Bắc theo tháng?"}).json()
    assert refused["code"] == "filter_would_drop" and refused["consent_available"] is False
    d = refused["detail"]
    r = client.post("/api/v1/analyst/consents", headers=world["analyst"].headers,
                    json={"query_fingerprint": d["query_fingerprint"], "fields": [x["field"] for x in d["dropped"]]})
    assert r.status_code == 403
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "x", "drop_consent": "v1.a.b", "consented_plan": refused["plan"]}).json()
    assert body["status"] == "unsupported" and "rows" not in body


def _drop_turn(client, world, model):  # noqa: F811
    v = world["v"]
    model(_planner(world, dims=("order_date",), extra={"filters": {f"{v}.region": {"operator": "eq", "value": "Bắc"}}}))
    refused = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                          json={"question": "Doanh thu miền Bắc theo tháng?"}).json()
    assert refused["status"] == "refused" and refused["code"] == "filter_would_drop", refused
    d = refused["detail"]
    token = client.post("/api/v1/analyst/consents", headers=world["analyst"].headers,
                        json={"query_fingerprint": d["query_fingerprint"],
                              "fields": [x["field"] for x in d["dropped"]]}).json()["drop_consent"]
    return refused, token


def _never_called(*_a, **_k):
    raise AssertionError("the model must not be asked again when a consent is spent")


def test_an_accepted_drop_runs_the_refused_plan_without_asking_the_model(client, db, world, model, one_drop, consent_on):  # noqa: F811
    _grant_module(db, world["analyst"])
    refused, token = _drop_turn(client, world, model)
    model(_never_called)
    turn = uuid.uuid4().hex
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "Doanh thu miền Bắc theo tháng?", "turn_id": turn,
                             "drop_consent": token, "consented_plan": refused["plan"]}).json()
    assert body["status"] == "answered", body
    dropped = body["evidence"]["filters_dropped"]
    assert [x["field"] for x in dropped] == [one_drop] and all(x["accepted_by_user"] for x in dropped)
    # the same consent cannot be spent twice
    again = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                        json={"question": "Doanh thu miền Bắc theo tháng?", "drop_consent": token,
                              "consented_plan": refused["plan"]}).json()
    assert again["status"] == "refused" and "rows" not in again


def test_a_changed_plan_cannot_spend_the_consent(client, db, world, model, one_drop, consent_on):  # noqa: F811
    _grant_module(db, world["analyst"])
    refused, token = _drop_turn(client, world, model)
    model(_never_called)
    wider = {**refused["plan"], "dimensions": [f"{world['v']}.order_date", f"{world['v']}.region"],
             "time_grains": {f"{world['v']}.order_date": "month"}}
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "x", "drop_consent": token, "consented_plan": wider}).json()
    assert body["status"] == "refused" and body["code"] == "consent_invalid" and "rows" not in body, body


def test_a_plan_outside_the_catalog_is_refused_even_with_a_consent(client, db, world, model, one_drop, consent_on):  # noqa: F811
    _grant_module(db, world["analyst"])
    refused, token = _drop_turn(client, world, model)
    model(_never_called)
    for bad in ({**refused["plan"], "explore_id": 999999999},
                {**refused["plan"], "measures": ["other_view.secret"]}):
        body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                           json={"question": "x", "drop_consent": token, "consented_plan": bad}).json()
        assert body["status"] == "unsupported" and "rows" not in body, body


def test_a_consented_plan_after_the_grant_is_revoked_returns_nothing(client, db, world, model, one_drop, consent_on):  # noqa: F811
    from app.models.dataset import DatasetGrant

    _grant_module(db, world["analyst"])
    refused, token = _drop_turn(client, world, model)
    model(_never_called)
    db.query(DatasetGrant).filter(DatasetGrant.dataset_id == world["ds"].id,
                                  DatasetGrant.user_id == world["analyst"].id).delete()
    db.commit()
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "x", "drop_consent": token, "consented_plan": refused["plan"]}).json()
    assert body["status"] == "unsupported" and "rows" not in body


def test_another_persons_consent_is_refused(client, db, world, model, one_drop, consent_on):  # noqa: F811
    _grant_module(db, world["analyst"], world["owner"])
    refused, _mine = _drop_turn(client, world, model)
    d = refused["detail"]
    owners = client.post("/api/v1/analyst/consents", headers=world["owner"].headers,
                         json={"query_fingerprint": d["query_fingerprint"],
                               "fields": [x["field"] for x in d["dropped"]]}).json()["drop_consent"]
    model(_never_called)
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "x", "drop_consent": owners, "consented_plan": refused["plan"]}).json()
    assert body["status"] == "refused" and body["code"] == "consent_invalid"


def test_a_plan_without_a_consent_is_not_a_way_around_the_model(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_never_called)
    plan = {"explore_id": world["explore"].id, "dimensions": [], "measures": [f"{world['v']}.revenue"]}
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "x", "consented_plan": plan}).json()
    assert body["status"] == "unsupported" and "rows" not in body


# ── PO A4: a source the person chose is the only source of the turn ──────────

def test_a_chosen_source_pins_the_turn_and_an_unavailable_one_is_refused(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_planner(world))
    ok = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                     json={"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?",
                           "dataset_id": world["ds"].id}).json()
    assert ok["status"] == "answered", ok
    other = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                        json={"question": "Doanh thu theo vùng?", "dataset_id": 987654321}).json()
    assert other["status"] == "unsupported" and "rows" not in other


def test_the_save_button_is_offered_only_to_someone_the_chart_api_lets_save(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])   # explore_charts: view -> may not save
    model(_planner(world))
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"}).json()
    assert body["status"] == "answered" and body["can_save"] is False
    r = client.post("/api/v1/charts/", headers=world["analyst"].headers, json=body["chart_draft"])
    assert r.status_code == 403  # the API agrees with what the page was told


# ── dogfood: feedback on an answer ────────────────────────────────────────────

def test_a_person_rates_their_own_answer_and_only_their_own(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"], world["owner"])
    model(_planner(world))
    turn = uuid.uuid4().hex
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                       json={"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?", "turn_id": turn}).json()
    assert body["status"] == "answered"
    ok = client.post("/api/v1/analyst/feedback", headers=world["analyst"].headers,
                     json={"turn_id": turn, "verdict": "down", "comment": "sai vùng"})
    assert ok.status_code == 201, ok.text
    with sa.create_engine(_owner_url()).connect() as c:
        row = c.execute(sa.text("SELECT verdict, comment, user_id FROM analyst_feedback WHERE turn_id = :t"),
                        {"t": turn}).one()
    assert row[0] == "down" and row[1] == "sai vùng" and str(row[2]) == str(world["analyst"].id)
    other = client.post("/api/v1/analyst/feedback", headers=world["owner"].headers,
                        json={"turn_id": turn, "verdict": "up"})
    assert other.status_code == 404                          # not the owner's turn
    bad = client.post("/api/v1/analyst/feedback", headers=world["analyst"].headers,
                      json={"turn_id": turn, "verdict": "maybe"})
    assert bad.status_code == 422
    stranger = client.post("/api/v1/analyst/feedback", headers=world["stranger"].headers,
                           json={"turn_id": turn, "verdict": "up"})
    assert stranger.status_code == 403


# ── Dogfood 2026-10-22: picking a real value from a value clarification ──────
# The UI re-asked "<question> — <value>" and grounding refused the very word the
# pick replaced ("Atlantis"), so a clarification could never be answered. A pick
# is now structured {plan, field, value}: the echoed plan is re-validated against
# this turn's catalog, only that filter changes, and the value is re-checked
# against the real data before the query.

def _atlantis(world):
    v = world["v"]
    return _planner(world, dims=(), extra={"filters": {f"{v}.region": {"operator": "eq", "value": "Atlantis"}},
                                           "covered": {"doanh thu": f"{v}.revenue", "vùng Atlantis": f"{v}.region"}})


def test_a_value_clarification_names_its_field_and_a_pick_is_answered(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_atlantis(world))
    v = world["v"]
    first = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                        json={"question": "Doanh thu vùng Atlantis"}).json()
    assert first["status"] == "clarify" and set(first["options"]) == {"Bắc", "Nam", "Trung"}, first
    assert first["choice_field"] == f"{v}.region"
    model(_never_called)  # the pick re-runs the shown plan; the model is not asked again
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers, json={
        "question": "Doanh thu vùng Atlantis — Nam",
        "value_choice": {"plan": first["plan"], "field": first["choice_field"], "value": "Nam"}}).json()
    assert body["status"] == "answered", body
    assert body["plan"]["filters"] == {f"{v}.region": {"operator": "eq", "value": "Nam"}}
    assert [float(r[c["name"]]) for r in body["rows"] for c in body["columns"] if c["role"] == "measure"] == [30.0]


def test_a_picked_value_not_in_the_data_is_offered_again_not_queried_as_zero(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_atlantis(world))
    first = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                        json={"question": "Doanh thu vùng Atlantis"}).json()
    model(_never_called)
    body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers, json={
        "question": "x", "value_choice": {"plan": first["plan"], "field": first["choice_field"], "value": "Mars"}}).json()
    assert body["status"] == "clarify" and "rows" not in body


def test_a_pick_cannot_change_another_field_or_leave_the_catalog(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_atlantis(world))
    first = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                        json={"question": "Doanh thu vùng Atlantis"}).json()
    model(_never_called)
    v = world["v"]
    for choice in ({"plan": first["plan"], "field": f"{v}.order_date", "value": "Nam"},  # not a filter of the plan
                   {"plan": {**first["plan"], "explore_id": 987654321}, "field": f"{v}.region", "value": "Nam"},
                   {"plan": first["plan"], "field": f"{v}.region", "value": ""}):
        body = client.post("/api/v1/analyst/ask", headers=world["analyst"].headers,
                           json={"question": "x", "value_choice": choice}).json()
        assert body["status"] == "unsupported" and "rows" not in body, (choice, body)
