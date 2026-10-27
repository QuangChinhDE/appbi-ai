"""Agent Flow as an optional extension of an AI Chat turn, over HTTP on real Postgres.

Real app, auth, `/api/v1/chat` turn route, Data Core, GQS, ledger and Postgres; a
real published Flow shared to the asker, real Knowledge documents. The Flow's RUN
(the model) is the stand-in: `dispatch.run_as_extension` is replaced by scripted
outputs, except where the real one is the point (an unshared flow).

Every case returns through the SAME canonical turn and envelope (contract C5):

  * no flow bound / a data question: the Core answers alone, the flow is never run;
  * explicit request: the verified data answer AND the flow's cited documents,
    side by side, with the "sources separate" notice; the flow's own figures are
    dropped or listed as unverified, never merged into the data;
  * a document question the Core cannot answer from data: `answered/documents_only`;
  * the flow's ceiling: no datasets, and documents only the ASKER may read - an
    owner's delegation does not widen it; a citation outside it is dropped;
  * unavailable (unshared mid-conversation), timeout, invalid output, an exception:
    the Core's answer stands, the reason is a notice, the invocation is audited;
  * cancel while the flow runs: the turn is `cancelled`, once;
  * a stored answer that cites a document is redacted for a reader who cannot open
    that document, and shown again when they can;
  * a conversation can only be bound to a flow shared with its owner.
"""
from __future__ import annotations

import asyncio
import threading
import time
import uuid

import pytest
import sqlalchemy as sa

from tests.authz_http import client, db, make_user, set_permissions, share  # noqa: F401 - fixtures
from tests.test_analyst_http_pg import _ledger_rows, _planner, ask, model  # noqa: F401 - fixtures
from tests.test_intelligence_gqs_execution_pg import SCHEMA, _owner_url, world  # noqa: F401 - fixtures

pytestmark = pytest.mark.pg

Q = "Doanh thu các vùng theo tháng gần đây thay đổi thế nào?"


@pytest.fixture()
def flow(db, world):  # noqa: F811
    """A published chat flow owned by `owner`, attaching two documents (one shared
    with the analyst, one private to the owner) and the Dataset; shared with the analyst."""
    from app.models.agent_brain import AgentBrainVersion
    from app.models.governance import GovernKnowledgeDoc
    from app.models.user import User

    owner, analyst = world["owner"], world["analyst"]
    for who in (owner, analyst):
        set_permissions(db, who, datasets="edit", explore_charts="view", chat="edit", agent_flows="view",
                        govern="view")
    set_permissions(db, owner, datasets="edit", explore_charts="view", chat="edit", agent_flows="edit",
                    govern="edit")
    pub = GovernKnowledgeDoc(title="Chính sách chiết khấu 2025", body="Chiết khấu 5% từ 01/09/2025.",
                             owner_id=owner.id, status="Published")
    priv = GovernKnowledgeDoc(title="Bảng lương", body="bí mật", owner_id=owner.id, status="Published")
    db.add_all([pub, priv])
    db.commit()
    share(db, "knowledge_doc", pub.id, analyst, "view", owner)
    key = f"ext_{uuid.uuid4().hex[:8]}"
    body = {"name": "Chính sách", "nodes": [{"key": "a", "type": "agent", "name": "A", "prompt": "p", "tools": [],
            "knowledge": [{"source": "document", "ref": str(pub.id), "description": "Chính sách chiết khấu bán hàng; tra khi hỏi về chiết khấu."},
                          {"source": "document", "ref": str(priv.id), "description": "Bảng lương nhân sự; tra khi hỏi về lương thưởng."},
                          {"source": "semantic", "ref": str(world["ds"].id), "description": "Doanh số bán hàng theo ngày; tra khi hỏi về doanh thu."}]}]}
    row = AgentBrainVersion(brain_key=key, version=1, name="Trợ lý chính sách", body=body, status="published",
                            flow_type="chat", owner_email=db.get(User, owner.id).email)
    db.add(row)
    db.commit()
    share(db, "agent_brain", key, analyst, "view", owner)
    return dict(key=key, row=row, pub=pub, priv=priv)


def _result(text="Theo tài liệu, chiết khấu 5% áp dụng từ 01/09/2025.", docs=(), blocks=None, status="ok"):
    return {"status": status, "answer": {"blocks": blocks if blocks is not None else [
        {"type": "text", "markdown": text}]},
        "citations": [{"kind": "document", "ref": str(d), "label": f"doc {d}", "quote": "5%"} for d in docs],
        "notices": [], "usage": {"llm_calls": 1}}


@pytest.fixture()
def fake_flow(monkeypatch):
    """Replace the flow RUN with a script: (result | exception | delay)."""
    from app.services.agent_flows import dispatch
    from app.services.dashboard_ai_bot.events import AgentEvent

    calls = []

    def use(result=None, delay=0.0, raise_=None):
        async def run(db, *, user, flow_key, question, context_note="", run_id=None, **kw):
            calls.append({"flow_key": flow_key, "user": str(user.id), "question": question,
                          "context": context_note, "caps": kw})
            if delay:
                await asyncio.sleep(delay)
            if raise_ is not None:
                raise raise_
            yield AgentEvent(type="result", extra={"envelope": result})
            yield AgentEvent(type="done")

        monkeypatch.setattr(dispatch, "run_as_extension", run)
        return calls

    return use


def _bound(client, who, key):  # noqa: F811
    r = client.post("/api/v1/chat/conversations", headers=who.headers, json={"extension_flow_key": key})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _invocations(turn_id):
    with sa.create_engine(_owner_url()).connect() as c:
        return c.execute(sa.text("SELECT reason, status, code, ceiling FROM chat_extension_invocations "
                                 "WHERE turn_id = :t"), {"t": turn_id}).mappings().all()


def _oracle():
    with sa.create_engine(_owner_url()).connect() as c:
        return sorted(float(s) for (s,) in c.execute(sa.text(
            f"SELECT SUM(amount) FROM {SCHEMA}.sales GROUP BY region, date_trunc('month', order_date)")))


def _data_numbers(envelope):
    data = envelope["data"]
    m = next(c["name"] for c in data["columns"] if c["role"] == "measure")
    return sorted(float(r[m]) for r in data["rows"])


# ── the Core answers without any flow ────────────────────────────────────────

def test_chat_answers_with_no_flow_bound_at_all(client, db, world, model, fake_flow):  # noqa: F811
    set_permissions(db, world["analyst"], datasets="edit", chat="view")   # no Agent Flow permission at all
    calls = fake_flow(_result(docs=[1]))
    model(_planner(world))
    body = ask(client, world["analyst"], {"question": Q, "extension": "always"}).json()
    assert body["envelope"]["status"] == "answered" and _data_numbers(body["envelope"]) == _oracle()
    assert body["envelope"]["supporting"] is None and calls == []


def test_a_data_question_never_runs_the_bound_flow(client, db, world, flow, model, fake_flow):  # noqa: F811
    calls = fake_flow(_result(docs=[flow["pub"].id]))
    model(_planner(world))
    cid = _bound(client, world["analyst"], flow["key"])
    body = ask(client, world["analyst"], {"question": Q}, conv=cid).json()
    assert body["envelope"]["status"] == "answered" and body["envelope"]["supporting"] is None
    assert calls == [] and _invocations(body["turn_id"]) == []


# ── data + documents, one answer ─────────────────────────────────────────────

def test_an_explicit_request_adds_cited_documents_beside_the_verified_data(client, db, world, flow, model,  # noqa: F811
                                                                         fake_flow):
    blocks = [{"type": "metric", "label": "Doanh thu", "value": 999999},
              {"type": "text", "markdown": "Chiết khấu 5% áp dụng từ 01/09/2025; doanh thu kỳ vọng 7.777.777."}]
    calls = fake_flow(_result(docs=[flow["pub"].id, flow["priv"].id], blocks=blocks))
    model(_planner(world))
    cid = _bound(client, world["analyst"], flow["key"])
    body = ask(client, world["analyst"], {"question": Q, "extension": "always"}, conv=cid).json()
    e = body["envelope"]
    assert e["status"] == "answered" and _data_numbers(e) == _oracle(), "the data answer is the Core's, unchanged"
    sup = e["supporting"]
    assert sup["status"] == "ok" and sup["reason"] == "explicit" and sup["flow_name"] == "Trợ lý chính sách"
    assert [d["doc_id"] for d in sup["documents"]] == [flow["pub"].id], "a document the asker cannot read is dropped"
    assert {"code": "flow_figures_dropped", "count": 1} in sup["warnings"]
    assert "7.777.777" in sup["findings"][0]["unverified_figures"] and "999999" not in str(sup["findings"])
    assert any(n["code"] == "sources_separate" for n in e["notices"])
    assert calls[0]["user"] == str(world["analyst"].id), "the flow runs for the ASKER"
    assert "Lõi dữ liệu đã trả lời" in calls[0]["context"] and "rows" not in calls[0]["context"]
    assert calls[0]["caps"]["max_llm_calls"] <= 6 and calls[0]["caps"]["max_tool_calls"] <= 16
    [inv] = _invocations(body["turn_id"])
    assert inv["reason"] == "explicit" and inv["status"] == "ok"
    assert inv["ceiling"]["dataset_ids"] == [] and inv["ceiling"]["data_reads"] == "forbidden"
    assert inv["ceiling"]["doc_ids"] == [flow["pub"].id]
    stored = client.get(f"/api/v1/chat/conversations/{cid}", headers=world["analyst"].headers).json()
    assert stored["turns"][0]["envelope"]["supporting"]["documents"][0]["doc_id"] == flow["pub"].id


def test_a_document_question_is_answered_from_documents_only(client, db, world, flow, model, fake_flow):  # noqa: F811
    fake_flow(_result(docs=[flow["pub"].id]))
    model(lambda *a, **k: {"status": "unsupported", "reason": "không phải câu hỏi dữ liệu"})
    cid = _bound(client, world["analyst"], flow["key"])
    body = ask(client, world["analyst"], {"question": "Chính sách chiết khấu mới là gì?"}, conv=cid).json()
    e = body["envelope"]
    assert (e["status"], e["code"]) == ("answered", "documents_only")
    assert e["data"]["status"] == "unsupported" and "rows" not in e["data"], "no number came from anywhere"
    assert e["supporting"]["reason"] == "document_need"


def test_a_finding_with_no_readable_source_is_not_an_answer(client, db, world, flow, model, fake_flow):  # noqa: F811
    fake_flow(_result(docs=[flow["priv"].id]))          # cites only what the asker may not read
    model(lambda *a, **k: {"status": "unsupported", "reason": "?"})
    cid = _bound(client, world["analyst"], flow["key"])
    e = ask(client, world["analyst"], {"question": "Quy định về lương?"}, conv=cid).json()["envelope"]
    assert e["status"] == "refused" and e["supporting"]["documents"] == [] and e["supporting"]["findings"] == []
    assert "bí mật" not in str(e)


# ── the ceiling ──────────────────────────────────────────────────────────────

def test_the_extension_ceiling_is_the_askers_documents_and_no_data(client, db, world, flow):  # noqa: F811
    from app.models.user import User
    from app.services.agent_flows import registry as reg
    from app.services.agent_flows.permissions import extension_scope, run_scope

    url = f"/api/v1/agent-flows/brains/{flow['key']}/delegations"
    r = client.post(url, headers=world["owner"].headers,
                    json={"grantee_user_id": str(world["analyst"].id), "resource_type": "document",
                          "resource_id": flow["priv"].id})
    assert r.status_code == 201, r.text
    db.expire_all()
    asker = db.get(User, world["analyst"].id)
    parsed = reg.parse_flow(flow["row"])
    lent = run_scope(db, flow["row"], parsed, None, caller=asker)
    assert flow["priv"].id in lent["doc_ids"], "precondition: the delegation is live for other surfaces"
    ceiling = extension_scope(db, flow["row"], parsed, asker)
    assert ceiling == {"doc_ids": [flow["pub"].id], "dataset_ids": [], "metric_names": []}


# ── Case D: the extension is unavailable; the Core answer stands ─────────────

@pytest.mark.parametrize("script", ["unshared", "exception", "invalid", "timeout"])
def test_an_unavailable_flow_leaves_the_core_answer_whole(client, db, world, flow, model, fake_flow, monkeypatch,  # noqa: F811
                                                          script):
    from app.core.config import settings
    from app.models.resource_share import ResourceShare

    model(_planner(world))
    cid = _bound(client, world["analyst"], flow["key"])
    if script == "unshared":
        db.query(ResourceShare).filter(ResourceShare.resource_id == flow["key"]).delete()
        db.commit()           # the REAL runner re-checks the flow's share on every call
    elif script == "exception":
        fake_flow(raise_=RuntimeError("model provider down"))
    elif script == "invalid":
        fake_flow("this is not an envelope")
    else:
        monkeypatch.setattr(settings, "AI_CHAT_EXTENSION_TIMEOUT_SECONDS", 1)
        fake_flow(_result(docs=[flow["pub"].id]), delay=5)
    body = ask(client, world["analyst"], {"question": Q, "extension": "always"}, conv=cid).json()
    e = body["envelope"]
    assert e["status"] == "answered" and _data_numbers(e) == _oracle()
    assert e["supporting"]["status"] in ("unavailable", "failed", "timeout") and e["supporting"]["documents"] == []
    assert any(n["code"] == "extension_unavailable" for n in e["notices"])
    [inv] = _invocations(body["turn_id"])
    assert inv["status"] == e["supporting"]["status"]


# ── cancel while the flow runs ───────────────────────────────────────────────

def test_cancel_while_the_flow_runs_ends_the_turn_once(client, db, world, flow, model, fake_flow):  # noqa: F811
    model(_planner(world))
    fake_flow(_result(docs=[flow["pub"].id]), delay=20)
    cid = _bound(client, world["analyst"], flow["key"])
    box = {}
    th = threading.Thread(target=lambda: box.update(r=ask(client, world["analyst"],
                                                          {"question": Q, "extension": "always"}, conv=cid)),
                          daemon=True)
    th.start()
    deadline, turn = time.time() + 30, None
    while time.time() < deadline and turn is None:
        with sa.create_engine(_owner_url()).connect() as c:
            turn = c.execute(sa.text("SELECT turn_id FROM chat_extension_invocations WHERE conversation_id = :c "
                                     "AND status = 'running'"), {"c": cid}).scalar()
        time.sleep(0.2)
    assert turn, "the extension never started"
    r = client.post(f"/api/v1/chat/turns/{turn}/cancel", headers=world["analyst"].headers)
    assert r.json() == {"cancelled": True, "status": "cancelled"}
    th.join(timeout=30)
    assert box["r"].json()["envelope"]["status"] == "cancelled"
    assert _invocations(turn)[0]["status"] == "cancelled"
    turns = client.get(f"/api/v1/chat/conversations/{cid}", headers=world["analyst"].headers).json()["turns"]
    assert [t["status"] for t in turns] == ["cancelled"]


# ── a stored document answer follows the reader's document rights ────────────

def test_a_cited_document_is_redacted_for_a_reader_who_cannot_open_it(client, db, world, flow, model,  # noqa: F811
                                                                    fake_flow):
    from app.models.resource_share import ResourceShare

    fake_flow(_result(docs=[flow["pub"].id]))
    model(lambda *a, **k: {"status": "unsupported", "reason": "?"})
    cid = _bound(client, world["analyst"], flow["key"])
    assert ask(client, world["analyst"], {"question": "Chính sách chiết khấu là gì?"},
               conv=cid).json()["envelope"]["code"] == "documents_only"
    reader = world["stranger"]
    set_permissions(db, reader, chat="view", govern="view")
    assert client.post(f"/api/v1/shares/chat_conversation/{cid}", headers=world["analyst"].headers,
                       json={"user_id": str(reader.id), "permission": "view"}).status_code == 201
    turn = client.get(f"/api/v1/chat/conversations/{cid}", headers=reader.headers).json()["turns"][0]
    assert turn["redacted"] is True and turn["redacted_reason"] == "source_access" and "5%" not in str(turn)
    share(db, "knowledge_doc", flow["pub"].id, reader, "view", world["owner"])
    turn = client.get(f"/api/v1/chat/conversations/{cid}", headers=reader.headers).json()["turns"][0]
    assert turn["redacted"] is False and turn["envelope"]["supporting"]["documents"][0]["doc_id"] == flow["pub"].id
    db.query(ResourceShare).filter(ResourceShare.resource_id == str(flow["pub"].id),
                                   ResourceShare.user_id == reader.id).delete()
    db.commit()
    turn = client.get(f"/api/v1/chat/conversations/{cid}", headers=reader.headers).json()["turns"][0]
    assert turn["redacted"] is True, "a revoked document is hidden on the next read"


def test_a_conversation_binds_only_a_flow_shared_with_its_owner(client, db, world, flow):  # noqa: F811
    set_permissions(db, world["viewer"], chat="view", agent_flows="view")
    r = client.post("/api/v1/chat/conversations", headers=world["viewer"].headers,
                    json={"extension_flow_key": flow["key"]})
    assert r.status_code == 404
    cid = client.post("/api/v1/chat/conversations", headers=world["viewer"].headers, json={}).json()["id"]
    r = client.patch(f"/api/v1/chat/conversations/{cid}", headers=world["viewer"].headers,
                     json={"extension_flow_key": flow["key"]})
    assert r.status_code == 404
    listed = client.get("/api/v1/chat/catalog", headers=world["analyst"].headers).json()["extensions"]
    assert [x["flow_key"] for x in listed] == [flow["key"]]
    assert all("body" not in x and "nodes" not in x for x in listed)
