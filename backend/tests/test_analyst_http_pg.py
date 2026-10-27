"""The Data Core of AI Chat over HTTP on real Postgres (built as the AI Analyst).

Real app, real auth, real routing, the real `/api/v1/chat` turn route, real
Governed Query Service, the real durable ledger (as the app role) and real
Postgres. The ONLY stand-in is the language model: a fixed planner returns the
JSON a model would. Real-model behaviour is evaluated separately (and reported
NOT VERIFIED when not run).

Numbers are checked against an independent oracle: plain SQL over the source
table, not the engine.

Locked here (unchanged since the Analyst; only the route moved to the one Chat):
  * a person with `explore` gets an answer whose rows equal the oracle, with
    evidence, a ledger row (surface chat, run = the turn) and a chart draft;
  * a person with only `view` on the Dataset sees no source and gets no rows;
    a person without the `chat` module gets 403; a revoked grant is honoured next turn;
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
           # (services/data_core/grounding.py only believes phrases that are in the question)
           "covered": {"doanh thu": f"{v}.revenue", "chậm": f"{v}.revenue", "vùng": f"{v}.region",
                       "các vùng": f"{v}.region", "miền bắc": f"{v}.region", "theo tháng": f"{v}.order_date"}}
    raw["covered"] = {k: r for k, r in raw["covered"].items()
                      if r.rsplit(".", 1)[-1] in {*dims, "revenue"}
                      or (k == "miền bắc" and (extra or {}).get("filters"))}
    raw.update(extra or {})
    return lambda prompt, system=None, max_tokens=None: raw


@pytest.fixture()
def model(monkeypatch):
    from app.services.chat import orchestrator

    deps = orchestrator.core_deps()

    def use(fn):
        monkeypatch.setattr(deps, "complete", fn)

    return use


def _grant_module(db, *who):  # noqa: F811
    for p in who:
        set_permissions(db, p, datasets="edit", explore_charts="view", chat="view")


# ── the one Chat turn route, read the way these tests read the Data Core ─────

class _R:
    """A turn's outcome: HTTP status, and the Data Core's response (`envelope.data`)
    with the envelope, turn id and conversation id beside it."""

    def __init__(self, status_code: int, body, text: str = ""):
        self.status_code = status_code
        self._body = body
        self.text = text or json.dumps(body, ensure_ascii=False, default=str)

    def json(self):
        return self._body


def sse_events(text: str) -> list[dict]:
    return [json.loads(line[6:]) for line in text.splitlines() if line.startswith("data: ")]


def new_conversation(client, who, **body):
    return client.post("/api/v1/chat/conversations", headers=who.headers, json=body)


def ask(client, who, body: dict, conv=None, key=None) -> _R:
    """Ask in `conv` (a new conversation when None) through the one turn route."""
    body = dict(body)
    body.pop("turn_id", None)  # the server names every turn
    assert "previous_plan" not in body, "a follow-up's context is the conversation's, never the request's"
    follow = conv is not None
    if conv is None:
        r = new_conversation(client, who)
        if r.status_code != 201:
            return _R(r.status_code, r.json() if r.content else None, r.text)
        conv = r.json()["id"]
    r = client.post(f"/api/v1/chat/conversations/{conv}/turns", headers=who.headers,
                    json={"idempotency_key": key or uuid.uuid4().hex, "follow_up": follow, **body})
    if r.status_code != 200:
        return _R(r.status_code, r.json() if r.content else None, r.text)
    final = next(e for e in sse_events(r.text) if e["type"] == "final")
    envelope = final["envelope"]
    data = dict(envelope.get("data") or {"status": envelope["status"], "code": envelope.get("code"),
                                         "message": envelope.get("message")})
    data.update({"envelope": envelope, "turn_id": final["turn_id"], "conversation_id": conv})
    return _R(200, data, r.text)


def _ledger_rows(run_id):
    with sa.create_engine(_owner_url()).connect() as c:
        return c.execute(sa.text("SELECT status, surface, user_id FROM governed_query_executions WHERE run_id = :r"),
                         {"r": run_id}).all()


def test_an_answer_equals_the_oracle_with_evidence(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_planner(world))
    r = ask(client, world["analyst"], {"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"})
    assert r.status_code == 200, r.text
    body = r.json()
    turn = body["turn_id"]
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
    assert [(s, surf) for s, surf, _ in _ledger_rows(turn)] == [("ok", "chat")]
    assert body["envelope"]["status"] == "answered" and body["envelope"]["supporting"] is None
    assert "select " not in json.dumps(body).lower(), "SQL text reached the response"


def test_view_only_sees_no_source_and_gets_no_rows(client, db, world, model):  # noqa: F811
    _grant_module(db, world["viewer"])
    model(_planner(world))
    assert client.get("/api/v1/chat/catalog", headers=world["viewer"].headers).json()["sources"] == [] or all(
        s["explore_id"] not in (world["explore"].id, world["slow_explore"].id)
        for s in client.get("/api/v1/chat/catalog", headers=world["viewer"].headers).json()["sources"])
    body = ask(client, world["viewer"], {"question": "Doanh thu theo vùng?"}).json()
    turn = body["turn_id"]
    assert body["status"] == "unsupported" and "rows" not in body
    assert body["envelope"]["status"] == "refused" and body["envelope"]["code"] == "unsupported"
    assert _ledger_rows(turn) == []


def test_without_the_module_it_is_403(client, world, model):  # noqa: F811
    model(_planner(world))
    r = ask(client, world["stranger"], {"question": "Doanh thu?"})
    assert r.status_code == 403


def test_a_revoked_grant_is_honoured_on_the_next_turn(client, db, world, model):  # noqa: F811
    from app.models.dataset import DatasetGrant

    _grant_module(db, world["analyst"])
    model(_planner(world))
    first = ask(client, world["analyst"], {"question": "Doanh thu?"})
    assert first.json()["status"] == "answered"
    db.query(DatasetGrant).filter(DatasetGrant.dataset_id == world["ds"].id,
                                  DatasetGrant.user_id == world["analyst"].id).delete()
    db.commit()
    again = ask(client, world["analyst"], {"question": "Doanh thu?"})
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
    body = ask(client, world["analyst"], {"question": "Doanh thu?"}).json()
    assert body["status"] == "unsupported", body
    assert _ledger_rows(body["turn_id"]) == []


def test_a_clarification_is_passed_to_the_person(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(lambda *a, **k: {"status": "clarify", "question": "Doanh thu gộp hay thuần?", "options": ["Gộp", "Thuần"]})
    body = ask(client, world["analyst"], {"question": "Doanh thu?"}).json()
    assert body["status"] == "clarify" and body["options"] == ["Gộp", "Thuần"]


def _running_turn(who, timeout=20.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with sa.create_engine(_owner_url()).connect() as c:
            turn = c.execute(sa.text("SELECT turn_id FROM chat_turns WHERE asked_by = :u AND status = 'running'"),
                             {"u": str(who.id)}).scalar()
        if turn and any(s == "running" for s, _, _ in _ledger_rows(turn)):
            return turn
        time.sleep(0.1)
    raise AssertionError("no running turn")


def test_cancel_is_the_askers_only_and_stops_the_turn(client, db, world, model):  # noqa: F811
    _grant_module(db, world["owner"], world["analyst"])
    model(_planner(world, view=world["slow_view"].name, explore=world["slow_explore"], dims=()))
    box = {}

    def run():
        box["r"] = ask(client, world["owner"], {"question": "Doanh thu (chậm)?"})

    th = threading.Thread(target=run, daemon=True)
    th.start()
    turn = _running_turn(world["owner"])
    other = client.post(f"/api/v1/chat/turns/{turn}/cancel", headers=world["analyst"].headers)
    assert other.status_code == 404, "someone else's turn is not theirs to stop, nor an oracle"
    mine = client.post(f"/api/v1/chat/turns/{turn}/cancel", headers=world["owner"].headers)
    assert mine.json() == {"cancelled": True, "status": "cancelled"}
    th.join(timeout=60)
    body = box["r"].json()
    assert body["envelope"]["status"] == "cancelled" and body["envelope"]["data"] is None, body
    assert [s for s, _, _ in _ledger_rows(turn)] == ["cancelled"]
    again = client.post(f"/api/v1/chat/turns/{turn}/cancel", headers=world["owner"].headers)
    assert again.json() == {"cancelled": False, "status": "cancelled"}, "a turn ends exactly once"


def test_an_unknown_turn_cannot_be_cancelled(client, db, world):  # noqa: F811
    _grant_module(db, world["analyst"])
    assert client.post("/api/v1/chat/turns/not_a_turn/cancel", headers=world["analyst"].headers).status_code == 404
    assert client.post(f"/api/v1/chat/turns/{uuid.uuid4().hex}/cancel",
                       headers=world["analyst"].headers).status_code == 404


def test_a_consent_is_issued_to_the_caller_only(client, db, world, consent_on):  # noqa: F811
    from app.services.governed_query import GovernedRefusal, consent

    _grant_module(db, world["analyst"])
    fp = "a" * 64
    r = client.post("/api/v1/chat/consents", headers=world["analyst"].headers,
                    json={"query_fingerprint": fp, "fields": ["x.region"]})
    token = r.json()["drop_consent"]
    assert consent.verify(token, user_id=world["analyst"].id, query_fp=fp, dropped_fields=["x.region"])
    with pytest.raises(GovernedRefusal):
        consent.verify(token, user_id=world["owner"].id, query_fp=fp, dropped_fields=["x.region"])


def test_a_follow_up_stays_on_the_previous_source(client, db, world, model):  # noqa: F811
    """Real-model browser run: "and by quarter?" jumped to another dataset. A
    follow-up is held to the previous explore - the CONVERSATION's previous answer,
    read on the server; a plan elsewhere is not run."""
    _grant_module(db, world["analyst"])
    model(_planner(world))
    first = ask(client, world["analyst"], {"question": "Doanh thu?"}).json()
    assert first["status"] == "answered"
    conv = first["conversation_id"]
    model(_planner(world, view=world["slow_view"].name, explore=world["slow_explore"], dims=()))
    follow = ask(client, world["analyst"], {"question": "Còn theo quý?"}, conv=conv).json()
    assert follow["status"] == "unsupported", follow
    assert _ledger_rows(follow["turn_id"]) == []
    model(_planner(world, grain="quarter"))
    again = ask(client, world["analyst"], {"question": "Còn theo quý?"}, conv=conv).json()
    assert again["status"] == "answered" and again["plan"]["explore_id"] == world["explore"].id


# ── who may ask: the `chat` module, and per Dataset the EXPLORE relation ──────

def _ask(client, who):  # noqa: F811
    return ask(client, who, {"question": "Doanh thu theo vùng?"})


def test_without_the_chat_module_it_is_403(client, db, world, model):  # noqa: F811
    set_permissions(db, world["analyst"], datasets="edit", explore_charts="full")
    model(_planner(world))
    assert _ask(client, world["analyst"]).status_code == 403
    assert client.get("/api/v1/chat/catalog", headers=world["analyst"].headers).status_code == 403


def test_chat_alone_answers_from_the_persons_explore_grant(client, db, world, model):  # noqa: F811
    """ADR-4/5: `chat: view` is the only module gate; the DATA gate is the Dataset's
    EXPLORE relation, decided by GQS on every read. No Analyst, Explore-module or
    Flow permission is needed - and none is granted to anybody without EXPLORE."""
    set_permissions(db, world["analyst"], datasets="edit", chat="view")
    model(_planner(world))
    body = _ask(client, world["analyst"]).json()
    assert body["status"] == "answered" and body["can_save"] is False
    set_permissions(db, world["viewer"], datasets="edit", chat="view")
    viewer = _ask(client, world["viewer"]).json()
    assert viewer["status"] == "unsupported" and "rows" not in viewer


def test_the_emergency_switch_stops_new_turns_and_never_reroutes(client, db, world, model, monkeypatch):  # noqa: F811
    from app.core.config import settings

    _grant_module(db, world["analyst"])
    model(_planner(world))
    first = _ask(client, world["analyst"]).json()
    monkeypatch.setattr(settings, "AI_CHAT_ENABLED", False)
    r = ask(client, world["analyst"], {"question": "Doanh thu theo vùng?"}, conv=first["conversation_id"])
    assert r.status_code == 503 and "rows" not in r.text
    history = client.get(f"/api/v1/chat/conversations/{first['conversation_id']}", headers=world["analyst"].headers)
    assert history.status_code == 200 and len(history.json()["turns"]) == 1
    monkeypatch.setattr(settings, "AI_CHAT_ENABLED", True)
    assert _ask(client, world["analyst"]).json()["status"] == "answered"


def test_revoking_the_chat_permission_applies_to_the_next_request(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_planner(world))
    assert _ask(client, world["analyst"]).json()["status"] == "answered"
    set_permissions(db, world["analyst"], datasets="edit", explore_charts="view", chat="none")
    assert _ask(client, world["analyst"]).status_code == 403
    turn = uuid.uuid4().hex
    assert client.post(f"/api/v1/chat/turns/{turn}/cancel", headers=world["analyst"].headers).status_code == 403


def test_presets_carry_chat_and_no_analyst_module():
    from app.api.permissions import PRESETS

    assert PRESETS["admin"].get("chat") == "full"
    assert all("analyst" not in p for p in PRESETS.values())


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
    refused = ask(client, world["analyst"], {"question": "Doanh thu miền Bắc theo tháng?"}).json()
    assert refused["code"] == "filter_would_drop" and refused["consent_available"] is False
    d = refused["detail"]
    r = client.post("/api/v1/chat/consents", headers=world["analyst"].headers,
                    json={"query_fingerprint": d["query_fingerprint"], "fields": [x["field"] for x in d["dropped"]]})
    assert r.status_code == 403
    body = ask(client, world["analyst"], {"question": "x", "drop_consent": "v1.a.b", "consented_plan": refused["plan"]}).json()
    assert body["status"] == "unsupported" and "rows" not in body


def _drop_turn(client, world, model):  # noqa: F811
    v = world["v"]
    model(_planner(world, dims=("order_date",), extra={"filters": {f"{v}.region": {"operator": "eq", "value": "Bắc"}}}))
    refused = ask(client, world["analyst"], {"question": "Doanh thu miền Bắc theo tháng?"}).json()
    assert refused["status"] == "refused" and refused["code"] == "filter_would_drop", refused
    d = refused["detail"]
    token = client.post("/api/v1/chat/consents", headers=world["analyst"].headers,
                        json={"query_fingerprint": d["query_fingerprint"],
                              "fields": [x["field"] for x in d["dropped"]]}).json()["drop_consent"]
    return refused, token


def _never_called(*_a, **_k):
    raise AssertionError("the model must not be asked again when a consent is spent")


def test_an_accepted_drop_runs_the_refused_plan_without_asking_the_model(client, db, world, model, one_drop, consent_on):  # noqa: F811
    _grant_module(db, world["analyst"])
    refused, token = _drop_turn(client, world, model)
    model(_never_called)
    body = ask(client, world["analyst"], {"question": "Doanh thu miền Bắc theo tháng?",
                                          "drop_consent": token, "consented_plan": refused["plan"]}).json()
    assert body["status"] == "answered", body
    dropped = body["evidence"]["filters_dropped"]
    assert [x["field"] for x in dropped] == [one_drop] and all(x["accepted_by_user"] for x in dropped)
    # the same consent cannot be spent twice
    again = ask(client, world["analyst"], {"question": "Doanh thu miền Bắc theo tháng?", "drop_consent": token,
                              "consented_plan": refused["plan"]}).json()
    assert again["status"] == "refused" and "rows" not in again


def test_a_changed_plan_cannot_spend_the_consent(client, db, world, model, one_drop, consent_on):  # noqa: F811
    _grant_module(db, world["analyst"])
    refused, token = _drop_turn(client, world, model)
    model(_never_called)
    wider = {**refused["plan"], "dimensions": [f"{world['v']}.order_date", f"{world['v']}.region"],
             "time_grains": {f"{world['v']}.order_date": "month"}}
    body = ask(client, world["analyst"], {"question": "x", "drop_consent": token, "consented_plan": wider}).json()
    assert body["status"] == "refused" and body["code"] == "consent_invalid" and "rows" not in body, body


def test_a_plan_outside_the_catalog_is_refused_even_with_a_consent(client, db, world, model, one_drop, consent_on):  # noqa: F811
    _grant_module(db, world["analyst"])
    refused, token = _drop_turn(client, world, model)
    model(_never_called)
    for bad in ({**refused["plan"], "explore_id": 999999999},
                {**refused["plan"], "measures": ["other_view.secret"]}):
        body = ask(client, world["analyst"], {"question": "x", "drop_consent": token, "consented_plan": bad}).json()
        assert body["status"] == "unsupported" and "rows" not in body, body


def test_a_consented_plan_after_the_grant_is_revoked_returns_nothing(client, db, world, model, one_drop, consent_on):  # noqa: F811
    from app.models.dataset import DatasetGrant

    _grant_module(db, world["analyst"])
    refused, token = _drop_turn(client, world, model)
    model(_never_called)
    db.query(DatasetGrant).filter(DatasetGrant.dataset_id == world["ds"].id,
                                  DatasetGrant.user_id == world["analyst"].id).delete()
    db.commit()
    body = ask(client, world["analyst"], {"question": "x", "drop_consent": token, "consented_plan": refused["plan"]}).json()
    assert body["status"] == "unsupported" and "rows" not in body


def test_another_persons_consent_is_refused(client, db, world, model, one_drop, consent_on):  # noqa: F811
    _grant_module(db, world["analyst"], world["owner"])
    refused, _mine = _drop_turn(client, world, model)
    d = refused["detail"]
    owners = client.post("/api/v1/chat/consents", headers=world["owner"].headers,
                         json={"query_fingerprint": d["query_fingerprint"],
                               "fields": [x["field"] for x in d["dropped"]]}).json()["drop_consent"]
    model(_never_called)
    body = ask(client, world["analyst"], {"question": "x", "drop_consent": owners, "consented_plan": refused["plan"]}).json()
    assert body["status"] == "refused" and body["code"] == "consent_invalid"


def test_a_plan_without_a_consent_is_not_a_way_around_the_model(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_never_called)
    plan = {"explore_id": world["explore"].id, "dimensions": [], "measures": [f"{world['v']}.revenue"]}
    body = ask(client, world["analyst"], {"question": "x", "consented_plan": plan}).json()
    assert body["status"] == "unsupported" and "rows" not in body


# ── PO A4: a source the person chose is the only source of the turn ──────────

def test_a_chosen_source_pins_the_turn_and_an_unavailable_one_is_refused(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_planner(world))
    # the Chat source picker offers each catalog source WITH the Dataset it pins
    sources = client.get("/api/v1/chat/catalog", headers=world["analyst"].headers).json()["sources"]
    assert any(s["dataset_id"] == world["ds"].id and s["explore_id"] == world["explore"].id for s in sources)
    ok = ask(client, world["analyst"], {"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?",
                           "dataset_id": world["ds"].id}).json()
    assert ok["status"] == "answered", ok
    assert ok["evidence"]["datasets"] == [world["ds"].id]
    other = ask(client, world["analyst"], {"question": "Doanh thu theo vùng?", "dataset_id": 987654321}).json()
    assert other["status"] == "unsupported" and "rows" not in other


def test_the_save_button_is_offered_only_to_someone_the_chart_api_lets_save(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])   # explore_charts: view -> may not save
    model(_planner(world))
    body = ask(client, world["analyst"], {"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"}).json()
    assert body["status"] == "answered" and body["can_save"] is False
    r = client.post("/api/v1/charts/", headers=world["analyst"].headers, json=body["chart_draft"])
    assert r.status_code == 403  # the API agrees with what the page was told


# ── dogfood: feedback on an answer ────────────────────────────────────────────

def test_a_person_rates_their_own_answer_and_only_their_own(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"], world["owner"])
    model(_planner(world))
    body = ask(client, world["analyst"], {"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"}).json()
    assert body["status"] == "answered"
    turn = body["turn_id"]
    ok = client.post(f"/api/v1/chat/turns/{turn}/feedback", headers=world["analyst"].headers,
                     json={"verdict": "down", "comment": "sai vùng"})
    assert ok.status_code == 201, ok.text
    with sa.create_engine(_owner_url()).connect() as c:
        row = c.execute(sa.text("SELECT verdict, comment, user_id FROM chat_feedback WHERE turn_id = :t"),
                        {"t": turn}).one()
    assert row[0] == "down" and row[1] == "sai vùng" and str(row[2]) == str(world["analyst"].id)
    other = client.post(f"/api/v1/chat/turns/{turn}/feedback", headers=world["owner"].headers,
                        json={"verdict": "up"})
    assert other.status_code == 404                          # not the owner's turn
    bad = client.post(f"/api/v1/chat/turns/{turn}/feedback", headers=world["analyst"].headers,
                      json={"verdict": "maybe"})
    assert bad.status_code == 422
    stranger = client.post(f"/api/v1/chat/turns/{turn}/feedback", headers=world["stranger"].headers,
                           json={"verdict": "up"})
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
    first = ask(client, world["analyst"], {"question": "Doanh thu vùng Atlantis"}).json()
    assert first["status"] == "clarify" and set(first["options"]) == {"Bắc", "Nam", "Trung"}, first
    assert first["choice_field"] == f"{v}.region"
    model(_never_called)  # the pick re-runs the shown plan; the model is not asked again
    body = ask(client, world["analyst"], {
        "question": "Doanh thu vùng Atlantis — Nam",
        "value_choice": {"plan": first["plan"], "field": first["choice_field"], "value": "Nam"}}).json()
    assert body["status"] == "answered", body
    assert body["plan"]["filters"] == {f"{v}.region": {"operator": "eq", "value": "Nam"}}
    assert [float(r[c["name"]]) for r in body["rows"] for c in body["columns"] if c["role"] == "measure"] == [30.0]


def test_a_picked_value_not_in_the_data_is_offered_again_not_queried_as_zero(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_atlantis(world))
    first = ask(client, world["analyst"], {"question": "Doanh thu vùng Atlantis"}).json()
    model(_never_called)
    body = ask(client, world["analyst"], {
        "question": "x", "value_choice": {"plan": first["plan"], "field": first["choice_field"], "value": "Mars"}}).json()
    assert body["status"] == "clarify" and "rows" not in body


def test_a_pick_cannot_change_another_field_or_leave_the_catalog(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_atlantis(world))
    first = ask(client, world["analyst"], {"question": "Doanh thu vùng Atlantis"}).json()
    model(_never_called)
    v = world["v"]
    for choice in ({"plan": first["plan"], "field": f"{v}.order_date", "value": "Nam"},  # not a filter of the plan
                   {"plan": {**first["plan"], "explore_id": 987654321}, "field": f"{v}.region", "value": "Nam"},
                   {"plan": first["plan"], "field": f"{v}.region", "value": ""}):
        body = ask(client, world["analyst"], {"question": "x", "value_choice": choice}).json()
        assert body["status"] == "unsupported" and "rows" not in body, (choice, body)


def test_a_pick_for_an_excluded_value_stays_an_exclusion(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    v = world["v"]
    model(_planner(world, dims=("region",), extra={
        "filters": {f"{v}.region": {"operator": "ne", "value": "Atlantis"}},
        "covered": {"doanh thu": f"{v}.revenue", "vùng": f"{v}.region", "không tính vùng Atlantis": f"{v}.region"}}))
    first = ask(client, world["analyst"], {"question": "Doanh thu theo vùng không tính vùng Atlantis"}).json()
    assert first["status"] == "clarify" and first["choice_field"] == f"{v}.region", first
    model(_never_called)
    body = ask(client, world["analyst"], {
        "question": "x", "value_choice": {"plan": first["plan"], "field": f"{v}.region", "value": "Nam"}}).json()
    assert body["status"] == "answered", body
    assert body["plan"]["filters"] == {f"{v}.region": {"operator": "ne", "value": "Nam"}}
    regions = {r[c["name"]] for r in body["rows"] for c in body["columns"] if c["ref"] == f"{v}.region"}
    assert regions == {"Bắc", "Trung"}



# ── Ranking / Top-N contract (sealed set 8 class) ──────────────────────────────

def test_top_n_returns_exactly_n_groups_in_order_and_names_them(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    v = world["v"]
    model(_planner(world, dims=("region",), extra={"covered": {"doanh thu": f"{v}.revenue", "vùng": f"{v}.region"}}))
    body = ask(client, world["analyst"], {"question": "Top 2 vùng có doanh thu cao nhất"}).json()
    assert body["status"] == "answered", body
    col = {c["role"]: c["name"] for c in body["columns"]}
    assert [r[col["dimension"]] for r in body["rows"]] == ["Bắc", "Nam"]          # oracle: Bắc 150, Nam 30, Trung 20
    assert body["plan"]["limit"] == 2
    # no tie at the cut, one metric, one breakdown: the chart's LIMIT gives the same rows
    assert body["chart_draft"]["config"]["styleConfig"]["dataLimit"] == 2
    assert "Bắc" in body["answer"]["headline"] and "Trung" not in body["answer"]["headline"]
    low = ask(client, world["analyst"], {"question": "1 vùng có doanh thu thấp nhất"}).json()
    assert [r[col["dimension"]] for r in low["rows"]] == ["Trung"], low


def test_a_plain_breakdown_reads_in_ranking_order(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    v = world["v"]
    model(_planner(world, dims=("region",), extra={"sorts": [{"field": f"{v}.region", "direction": "asc"}],
                                                   "covered": {"doanh thu": f"{v}.revenue", "vùng": f"{v}.region"}}))
    body = ask(client, world["analyst"], {"question": "Doanh thu theo vùng"}).json()
    col = {c["role"]: c["name"] for c in body["columns"]}
    assert [r[col["dimension"]] for r in body["rows"]] == ["Bắc", "Nam", "Trung"]  # by value, as the headline ranks


# ── Value resolution (sealed set 8 class: product names with numbers, model codes) ──

def _revenue_of(body):
    return [float(r[c["name"]]) for r in body["rows"] for c in body["columns"] if c["role"] == "measure"]


def test_a_real_value_written_on_the_wrong_field_moves_to_the_field_that_has_it(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    v = world["v"]
    model(_planner(world, dims=(), extra={"filters": {f"{v}.has_phone": {"operator": "eq", "value": "Nam"}},
                                          "covered": {"doanh thu": f"{v}.revenue", "Nam": f"{v}.has_phone"}}))
    body = ask(client, world["analyst"], {"question": "Doanh thu của Nam"}).json()
    assert body["status"] == "answered", body
    assert body["plan"]["filters"] == {f"{v}.region": {"operator": "eq", "value": "Nam"}}
    assert _revenue_of(body) == [30.0]


def test_a_value_the_question_never_says_is_re_resolved_from_its_words_or_refused(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    v = world["v"]
    # the model wrote a code ("N-02") for "vùng Nam": re-resolved from the question's words
    model(_planner(world, dims=(), extra={"filters": {f"{v}.region": {"operator": "eq", "value": "N-02"}},
                                          "covered": {"doanh thu": f"{v}.revenue", "vùng Nam": f"{v}.region"}}))
    body = ask(client, world["analyst"], {"question": "Doanh thu vùng Nam"}).json()
    assert body["status"] == "answered" and _revenue_of(body) == [30.0], body
    # adversarial: the question names no real value at all -> refused, never another value's number
    model(_planner(world, dims=(), extra={"filters": {f"{v}.region": {"operator": "eq", "value": "Bắc"}},
                                          "covered": {"doanh thu": f"{v}.revenue"}}))
    body = ask(client, world["analyst"], {"question": "Doanh thu vùng Atlantis"}).json()
    assert body["status"] != "answered" and "rows" not in body, body


# ── Metric/source clarification: a server-signed, re-validated choice (PO 2026-10-22) ──
# A pick re-asked as "<question> — <option>" was refused by grounding ("tốt"). The
# option now carries a token binding user, question, Dataset, explore, metric and the
# catalog version, with an expiry; the pick is re-authorised against the current
# catalog, so a replayed or forged token never widens access.

def _clarify_then(world, after):
    v, ex = world["v"], world["explore"].id
    state = {"n": 0}

    def complete(prompt, system=None, max_tokens=None):
        state["n"] += 1
        if '"chosen_metric"' in prompt:
            return after
        return {"status": "clarify", "question": "Tốt theo nghĩa nào?",
                "options": [{"label": "Doanh thu", "explore_id": ex, "measure": f"{v}.revenue"},
                            {"label": "Số đơn", "explore_id": ex, "measure": f"{v}.orders"},
                            {"label": "Ngoài phạm vi", "explore_id": 987654321, "measure": "x.y"}]}
    return complete


def _region_plan(world):
    v = world["v"]
    return {"status": "plan", "explore_id": world["explore"].id, "dimensions": [f"{v}.region"],
            "measures": [f"{v}.revenue"], "covered": {"vùng": f"{v}.region"}}


Q_BEST = "Vùng nào tốt nhất?"


def test_a_metric_pick_is_answered_with_exactly_that_metric_as_a_ranking(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_clarify_then(world, _region_plan(world)))
    first = ask(client, world["analyst"], {"question": Q_BEST}).json()
    assert first["status"] == "clarify", first
    assert [c["label"] for c in first["choices"]] == ["Doanh thu", "Số đơn"]   # the out-of-catalog option is not pickable
    body = ask(client, world["analyst"], {"question": Q_BEST, "choice_token": first["choices"][0]["token"]}).json()
    assert body["status"] == "answered", body
    v = world["v"]
    assert body["plan"]["measures"] == [f"{v}.revenue"]
    assert body["plan"]["sorts"] == [{"field": f"{v}.revenue", "direction": "desc"}]
    assert body["answer"]["headline"].startswith(body["answer"]["headline"].split(":")[0]) and "Bắc" in body["answer"]["headline"]


def test_a_forged_foreign_or_misdirected_choice_is_refused(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"], world["viewer"])
    model(_clarify_then(world, _region_plan(world)))
    first = ask(client, world["analyst"], {"question": Q_BEST}).json()
    token = first["choices"][0]["token"]
    body, mac = token.rsplit(".", 1)
    for who, question, tok in ((world["analyst"], Q_BEST, body + "." + ("0" * len(mac))),   # tampered
                               (world["viewer"], Q_BEST, token),                          # another person
                               (world["analyst"], "Doanh thu theo vùng?", token)):       # another question
        r = ask(client, who, {"question": question, "choice_token": tok})
        assert r.status_code in (200, 403), r.text
        if r.status_code == 200:
            assert r.json()["status"] == "unsupported" and "rows" not in r.json(), r.json()


def test_an_expired_stale_or_revoked_choice_is_refused(client, db, world, model, monkeypatch):  # noqa: F811
    from app.models.dataset import DatasetGrant
    from app.models.semantic import SemanticView
    from app.services.data_core import service as svc

    _grant_module(db, world["analyst"])
    model(_clarify_then(world, _region_plan(world)))

    def pick():
        first = ask(client, world["analyst"], {"question": Q_BEST}).json()
        return first["choices"][0]["token"]

    def answer(tok):
        return ask(client, world["analyst"], {"question": Q_BEST, "choice_token": tok}).json()

    monkeypatch.setattr(svc, "CHOICE_TTL_SECONDS", -1)
    assert "hết hạn" in answer(pick())["message"]
    monkeypatch.setattr(svc, "CHOICE_TTL_SECONDS", 900)
    tok = pick()
    view = db.query(SemanticView).filter(SemanticView.name == world["v"]).one()
    view.measures = [{**m, "label": "Doanh thu gộp"} if m.get("name") == "revenue" else m for m in view.measures]
    db.commit()
    assert "thay đổi" in answer(tok)["message"]                     # the catalog moved under the pick
    tok = pick()
    db.query(DatasetGrant).filter(DatasetGrant.dataset_id == world["ds"].id,
                                  DatasetGrant.user_id == world["analyst"].id).delete()
    db.commit()
    gone = answer(tok)
    assert gone["status"] == "unsupported" and "rows" not in gone, gone


def test_asking_again_after_a_pick_is_not_a_loop(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    again = {"status": "clarify", "question": "?", "options": ["a", "b"]}
    model(_clarify_then(world, again))
    first = ask(client, world["analyst"], {"question": Q_BEST}).json()
    body = ask(client, world["analyst"], {"question": Q_BEST, "choice_token": first["choices"][1]["token"]}).json()
    assert body["status"] == "unsupported" and "rows" not in body


def test_a_source_choice_token_pins_the_dataset_and_is_bound_to_the_person(client, db, world, model):  # noqa: F811
    from app.services.data_core import service as svc
    from app.services.data_core.catalog import discover
    from app.services.governed_query import AuthorizationContext, EffectivePrincipal, SurfaceCeiling

    _grant_module(db, world["analyst"])
    u = world["analyst"]
    from app.models.user import User

    user = db.get(User, u.id)
    authz = AuthorizationContext(db=db, principal=EffectivePrincipal.for_user(user, surface="chat", request_id="t"),
                                 user=user, ceiling=SurfaceCeiling.of(None))
    cat = discover(authz)
    tok = svc.sign_choice(user_id=str(u.id), question="Doanh thu?", catalog=cat, dataset_id=world["ds"].id)
    ok, why = svc.verify_choice(tok, user_id=str(u.id), question="Doanh thu?", catalog=cat)
    assert ok == {"dataset_id": world["ds"].id, "explore_id": None, "measure": None}, why
    assert svc.verify_choice(tok, user_id="someone-else", question="Doanh thu?", catalog=cat)[0] is None
    assert svc.verify_choice(tok, user_id=str(u.id), question="Doanh thu?", catalog=[])[0] is None


# ── Workstream C: a filtered answer saved as a chart reproduces the same numbers ──

def test_a_filtered_answer_saved_as_a_chart_gives_the_same_rows_on_reopen(client, db, world, model):  # noqa: F811
    owner = world["owner"]
    set_permissions(db, owner, datasets="edit", explore_charts="edit", chat="view")
    v = world["v"]
    model(_planner(world, dims=("region",), extra={
        "filters": {f"{v}.region": {"operator": "ne", "value": "Trung"}},
        "covered": {"doanh thu": f"{v}.revenue", "vùng": f"{v}.region", "không tính vùng Trung": f"{v}.region"}}))
    body = ask(client, owner, {"question": "Doanh thu theo vùng không tính vùng Trung"}).json()
    assert body["status"] == "answered" and body["chart_draft"], body.get("chart_draft_unavailable")
    want = {r[c["name"]]: float(r[next(x["name"] for x in body["columns"] if x["role"] == "measure")])
            for r in body["rows"] for c in body["columns"] if c["role"] == "dimension"}
    assert want == {"Bắc": 150.0, "Nam": 30.0}
    saved = client.post("/api/v1/charts/", headers=owner.headers, json=body["chart_draft"])
    assert saved.status_code in (200, 201), saved.text
    data = client.get(f"/api/v1/charts/{saved.json()['id']}/data", headers=owner.headers)
    assert data.status_code == 200, data.text
    rows = data.json()["data"]
    got = {}
    for r in rows:
        region = next(val for key, val in r.items() if isinstance(val, str) and val in ("Bắc", "Nam", "Trung"))
        got[region] = float(next(val for key, val in r.items() if isinstance(val, (int, float)) and not isinstance(val, bool)))
    assert got == want                                   # Trung stays excluded on reopen


def test_feedback_records_what_was_wrong_and_refuses_an_unknown_reason(client, db, world, model):  # noqa: F811
    _grant_module(db, world["analyst"])
    model(_planner(world))
    turn = ask(client, world["analyst"], {"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"}).json()["turn_id"]
    ok = client.post(f"/api/v1/chat/turns/{turn}/feedback", headers=world["analyst"].headers,
                     json={"verdict": "down", "reason": "wrong_filter", "comment": "thiếu năm"})
    assert ok.status_code == 201, ok.text
    bad = client.post(f"/api/v1/chat/turns/{turn}/feedback", headers=world["analyst"].headers,
                      json={"verdict": "down", "reason": "anything"})
    assert bad.status_code == 422
    with sa.create_engine(_owner_url()).connect() as c:
        assert c.execute(sa.text("SELECT reason FROM chat_feedback WHERE turn_id = :t"), {"t": turn}).scalar()             == "wrong_filter"


def test_feedback_accepts_every_preview_category_with_turn_and_build(client, db, world, model, monkeypatch):  # noqa: F811
    # Internal AI Preview triage classes; the pre-preview value stays accepted for old clients.
    monkeypatch.setenv("APPBI_BUILD_SHA", "abc1234")
    _grant_module(db, world["analyst"])
    model(_planner(world))
    turn = ask(client, world["analyst"], {"question": "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"}).json()["turn_id"]
    reasons = ["correct", "wrong_metric", "wrong_dataset", "wrong_filter", "incorrect_number",
               "wrong_interpretation", "unsupported_but_answerable", "ux_issue", "wrong_metric_or_source"]
    for r in reasons:
        res = client.post(f"/api/v1/chat/turns/{turn}/feedback", headers=world["analyst"].headers,
                          json={"verdict": "up" if r == "correct" else "down", "reason": r})
        assert res.status_code == 201, (r, res.text)
    with sa.create_engine(_owner_url()).connect() as c:
        rows = c.execute(sa.text("SELECT reason, rc_sha, turn_id FROM chat_feedback WHERE turn_id = :t"), {"t": turn}).all()
    assert sorted(r[0] for r in rows) == sorted(reasons)
    assert {r[1] for r in rows} == {"abc1234"} and {r[2] for r in rows} == {turn}



def test_a_follow_up_that_only_ranks_reuses_the_previous_plan_when_the_model_refuses(client, db, world, model):  # noqa: F811
    """Set 9 dev (S9-034): "Chỉ lấy top 2 thôi" after an answer by region was refused by
    the model. The previous plan, re-validated, is ranked by the server; the model is
    not trusted to re-read it."""
    _grant_module(db, world["analyst"])
    v = world["v"]
    model(_planner(world, dims=("region",), extra={"covered": {"doanh thu": f"{v}.revenue", "vùng": f"{v}.region"}}))
    first = ask(client, world["analyst"], {"question": "Doanh thu theo vùng"}).json()
    assert first["status"] == "answered", first
    model(lambda *a, **k: {"status": "unsupported", "reason": "?"})
    conv = first["conversation_id"]
    body = ask(client, world["analyst"], {"question": "Chỉ lấy top 2 thôi"}, conv=conv).json()
    assert body["status"] == "answered", body
    col = {c["role"]: c["name"] for c in body["columns"]}
    assert [r[col["dimension"]] for r in body["rows"]] == ["Bắc", "Nam"] and body["plan"]["limit"] == 2
    # a follow-up that says more than a ranking is NOT re-run from the previous plan
    other = ask(client, world["analyst"], {"question": "Chỉ lấy top 2 sản phẩm lợi nhuận"}, conv=conv).json()
    assert other["status"] != "answered" and "rows" not in other


# ── Gate 4: every drafted chart type re-executes the SAME semantic meaning ────────

def _save_and_requery(client, who, body):
    saved = client.post("/api/v1/charts/", headers=who.headers, json=body["chart_draft"])
    assert saved.status_code in (200, 201), saved.text
    data = client.get(f"/api/v1/charts/{saved.json()['id']}/data", headers=who.headers)
    assert data.status_code == 200, data.text
    return saved.json(), data.json()["data"]


def _numbers(rows):
    return sorted(round(float(v), 4) for r in rows for v in r.values()
                  if isinstance(v, (int, float)) and not isinstance(v, bool))


@pytest.mark.parametrize("case", ["kpi_filtered", "line_trend", "table_two_dims", "top_n_bar"])
def test_a_saved_chart_reproduces_the_answer(client, db, world, model, case):  # noqa: F811
    owner = world["owner"]
    set_permissions(db, owner, datasets="edit", explore_charts="edit", chat="view")
    v = world["v"]
    plans = {
        # (a date range needs a CERTIFIED date field, which this fixture's order_date is not:
        # GQS refuses it by design; the draft's [from, to) -> between conversion is the one GQS applies)
        "kpi_filtered": (dict(dims=(), extra={"filters": {f"{v}.region": {"operator": "eq", "value": "Bắc"}},
                                              "covered": {"doanh thu": f"{v}.revenue", "Bắc": f"{v}.region"}}),
                         "Doanh thu Bắc", "KPI"),
        "line_trend": (dict(dims=("order_date",), grain="month"), "Doanh thu theo tháng", "LINE"),
        "table_two_dims": (dict(dims=("region", "order_date"), grain="month"), "Doanh thu các vùng theo tháng", "LINE"),
        "top_n_bar": (dict(dims=("region",), extra={"covered": {"doanh thu": f"{v}.revenue", "vùng": f"{v}.region"}}),
                      "Top 2 vùng có doanh thu cao nhất", "BAR"),
    }
    kwargs, question, kind = plans[case]
    model(_planner(world, **kwargs))
    body = ask(client, owner, {"question": question}).json()
    assert body["status"] == "answered", body
    assert body["chart_draft"], body.get("chart_draft_unavailable")
    assert body["chart_draft"]["chart_type"] == kind
    m = next(c["name"] for c in body["columns"] if c["role"] == "measure")
    want = sorted(round(float(r[m]), 4) for r in body["rows"])
    chart, rows = _save_and_requery(client, owner, body)
    assert [x for x in _numbers(rows) if x in want] == want or _numbers(rows) == want, (want, rows)
    if case == "kpi_filtered":
        assert want == [150.0] and _numbers(rows) == [150.0]      # Bắc 100 + 50, the filter kept on reopen
    if case == "top_n_bar":
        assert len(rows) == 2 and chart["config"]["styleConfig"]["dataLimit"] == 2


def test_a_person_over_the_daily_query_budget_is_refused_before_the_model_is_asked(client, db, world, model,  # noqa: F811
                                                                                   monkeypatch):
    """QA live run (2026-10-24): a tester past ANALYST_MAX_QUERIES_PER_USER_DAY was refused
    every question, yet each one still went to the paid model first - GQS only checks
    the budget after planning. The daily budget is a cost control: once it is spent,
    the turn is refused with the same reason and the model is not called."""
    from app.services.chat import orchestrator

    _grant_module(db, world["analyst"])
    model(_planner(world))
    first = ask(client, world["analyst"], {"question": "Doanh thu?"})
    assert first.json()["status"] == "answered", first.json()
    with sa.create_engine(_owner_url()).connect() as c:
        used = int(c.execute(sa.text("SELECT count(*) FROM governed_query_executions WHERE user_id = :u "
                                     "AND started_at >= date_trunc('day', now()) AND status <> 'refused'"),
                             {"u": str(world["analyst"].id)}).scalar())
    import dataclasses

    ledger = orchestrator.core_deps().ledger
    monkeypatch.setattr(ledger, "budgets", dataclasses.replace(ledger.budgets, max_queries_per_user_day=used))
    calls = []
    model(lambda prompt, system=None, max_tokens=None: calls.append(1) or _planner(world)(prompt))
    body = ask(client, world["analyst"], {"question": "Doanh thu?"}).json()
    assert body["status"] == "refused" and body["code"] == "budget_exceeded" and "rows" not in body, body
    assert body["message"] == "Đã vượt hạn mức truy vấn được phép."
    assert calls == [], "the model was asked although the daily query budget was spent"
