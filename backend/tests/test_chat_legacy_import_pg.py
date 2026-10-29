"""The one-way import of both retired conversation stores into AI Chat, on real
Postgres (alembic 20261027_0001, its frozen SQL called as the migration calls it).

Locked here (contract section E, PO migration invariants):
  * no conversation, turn, share or rating disappears: legacy == imported, and a
    second run inserts nothing (idempotent);
  * authors and timestamps are kept; statuses map onto the five terminal states;
  * an Analyst turn keeps its turn_id (ledger rows and feedback still point at it);
  * a Flow run whose content retention already pruned is imported anyway, marked;
  * shares are copied at the SAME level, never widened; an orphan share is counted;
  * an imported answer is never MORE visible than before: a Flow answer needs every
    document/Dataset its flow had attached, an unknown footprint is the asker's only;
  * module access is carried, never widened (`analyst: full` becomes `chat: edit`);
  * old links resolve to the new conversation only for someone who may read it.
"""
from __future__ import annotations

import importlib.util
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import sqlalchemy as sa

from tests.authz_http import OWNER_URL, client, db, make_user  # noqa: F401 - fixtures

pytestmark = pytest.mark.pg

MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "20261027_0001_unified_chat.py"
T0 = datetime(2026, 9, 1, 8, 0, tzinfo=timezone.utc)


def _migration():
    spec = importlib.util.spec_from_file_location("m20261027", MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run_import():
    m = _migration()
    with sa.create_engine(OWNER_URL).begin() as conn:
        counts = m.import_legacy(conn)
        carried = m._carry_module_access(conn)
    return counts, carried


def _rows(sql, **kw):
    with sa.create_engine(OWNER_URL).connect() as c:
        return c.execute(sa.text(sql), kw).mappings().all()


@pytest.fixture()
def legacy(db):  # noqa: F811
    from app.models.agent_flow_chat_thread import AgentFlowChatThread
    from app.models.agent_flow_run import AgentFlowRun, AgentFlowRunContent
    from app.models.analyst_feedback import AnalystFeedback
    from app.models.analyst_session import AnalystSession, AnalystSessionTurn
    from app.models.resource_share import ResourceShare, ResourceType, SharePermission

    owner = make_user(db, "lg-owner", analyst="edit", datasets="edit")
    viewer = make_user(db, "lg-viewer", analyst="view")
    keeper = make_user(db, "lg-keeper", analyst="full", chat="view")
    higher = make_user(db, "lg-higher", analyst="view", chat="full")
    admin = make_user(db, "lg-admin", settings="full", analyst="full")
    friend = make_user(db, "lg-friend", chat="view")
    stranger = make_user(db, "lg-stranger", chat="view")

    s = AnalystSession(user_id=owner.id, title="Q2 review", created_at=T0, last_active_at=T0 + timedelta(hours=1))
    gone = AnalystSession(user_id=owner.id, title="old", created_at=T0, last_active_at=T0, deleted_at=T0)
    db.add_all([s, gone])
    db.flush()
    turn_ids = [uuid.uuid4().hex for _ in range(3)]
    db.add_all([
        AnalystSessionTurn(session_id=s.id, seq=1, turn_id=turn_ids[0], asked_by=owner.id, question="Doanh thu?",
                           status="answered", dataset_ids=[987654321], refs=["v.revenue"], created_at=T0,
                           response={"status": "answered", "turn_id": turn_ids[0], "rows": [{"v": 150}],
                                     "plan": {"explore_id": 1, "measures": ["v.revenue"]}}),
        AnalystSessionTurn(session_id=s.id, seq=2, turn_id=turn_ids[1], asked_by=owner.id, question="Ai là ai?",
                           status="unsupported", created_at=T0 + timedelta(minutes=1),
                           response={"status": "unsupported", "message": "không"}),
        AnalystSessionTurn(session_id=s.id, seq=3, turn_id=turn_ids[2], asked_by=owner.id, question="Doanh thu nào?",
                           status="clarify", created_at=T0 + timedelta(minutes=2),
                           response={"status": "clarify", "options": ["Gộp", "Thuần"]}),
    ])
    th = AgentFlowChatThread(user_id=owner.id, brain_key="legacy_flow", title="Hỏi chính sách",
                             session_key=f"dc_{uuid.uuid4().hex}", created_at=T0, last_active_at=T0)
    db.add(th)
    db.flush()
    runs = [AgentFlowRun(run_key=f"r_{uuid.uuid4().hex}", brain_key="legacy_flow", status=st, chat_thread_id=th.id,
                         question_norm=q, rating=rating, created_at=T0 + timedelta(minutes=i))
            for i, (st, q, rating) in enumerate([("ok", "chinh sach la gi", "up"), ("blocked", "hoi tiep", None),
                                                 ("failed", "cau cu da bi xoa noi dung", None),
                                                 ("ok", "chao ban", None)])]
    db.add_all(runs)
    db.flush()
    db.add_all([
        AgentFlowRunContent(run_id=runs[0].id, question="Chính sách là gì?", answer="Chiết khấu 5%.",
                            citations=[{"kind": "document", "ref": "424242"}],
                            notices=[{"code": "x", "text": "author only", "audience": "author"}],
                            input_envelope={"binding": {"knowledge": {"doc_ids": [424242], "dataset_ids": []}}}),
        AgentFlowRunContent(run_id=runs[1].id, question="Hỏi tiếp?", answer="Trợ lý không còn hoạt động.",
                            input_envelope={"binding": {"knowledge": {"doc_ids": [], "dataset_ids": []}}}),
        # runs[2]: content pruned by retention - no row
        AgentFlowRunContent(run_id=runs[3].id, question="Chào bạn", answer="Xin chào!",
                            input_envelope={"binding": {"knowledge": {"doc_ids": [], "dataset_ids": []}}}),
    ])
    db.add_all([
        ResourceShare(resource_type=ResourceType.ANALYST_SESSION, resource_id=str(s.id), user_id=friend.id,
                      permission=SharePermission.VIEW, shared_by=owner.id),
        ResourceShare(resource_type=ResourceType.CHAT_THREAD, resource_id=str(th.id), user_id=friend.id,
                      permission=SharePermission.EDIT, shared_by=owner.id),
        ResourceShare(resource_type=ResourceType.CHAT_THREAD, resource_id="999999999", user_id=friend.id,
                      permission=SharePermission.VIEW, shared_by=owner.id),
        AnalystFeedback(user_id=owner.id, turn_id=turn_ids[0], verdict="down", reason="wrong_filter",
                        comment="thiếu năm"),
    ])
    db.commit()
    return dict(owner=owner, viewer=viewer, keeper=keeper, higher=higher, admin=admin, friend=friend,
                stranger=stranger, session=s, gone=gone, thread=th, runs=runs, turn_ids=turn_ids)


def test_every_legacy_row_is_imported_once_with_its_author_and_time(db, legacy):  # noqa: F811
    counts, _ = _run_import()
    for name in ("analyst_sessions", "analyst_turns", "flow_threads", "flow_turns", "shares", "feedback"):
        assert counts[name][0] == counts[name][1], (name, counts[name])
    assert counts["orphan_shares"] >= 1
    total = _rows("SELECT count(*) AS n FROM chat_turns")[0]["n"]
    again, _ = _run_import()
    assert _rows("SELECT count(*) AS n FROM chat_turns")[0]["n"] == total, "a second run inserted rows"
    assert again["analyst_turns"] == counts["analyst_turns"]

    [conv] = _rows("SELECT * FROM chat_conversations WHERE legacy_kind = 'analyst_session' AND legacy_id = :i",
                   i=legacy["session"].id)
    assert str(conv["user_id"]) == str(legacy["owner"].id) and conv["title"] == "Q2 review"
    assert conv["created_at"] == T0 and conv["last_active_at"] == T0 + timedelta(hours=1)
    assert conv["deleted_at"] is None and conv["extension_flow_key"] is None
    turns = _rows("SELECT seq, turn_id, status, origin, asked_by, created_at FROM chat_turns "
                  "WHERE conversation_id = :c ORDER BY seq", c=conv["id"])
    assert [t["turn_id"] for t in turns] == legacy["turn_ids"], "an Analyst turn keeps its id"
    assert [t["status"] for t in turns] == ["answered", "refused", "clarification_required"]
    assert {t["origin"] for t in turns} == {"analyst_v1"}
    assert all(str(t["asked_by"]) == str(legacy["owner"].id) for t in turns)
    assert turns[0]["created_at"] == T0

    [deleted] = _rows("SELECT deleted_at FROM chat_conversations WHERE legacy_kind = 'analyst_session' "
                      "AND legacy_id = :i", i=legacy["gone"].id)
    assert deleted["deleted_at"] == T0, "a deleted session stays deleted"


def test_a_flow_thread_keeps_every_run_even_a_pruned_one(db, legacy):  # noqa: F811
    _run_import()
    [conv] = _rows("SELECT * FROM chat_conversations WHERE legacy_kind = 'flow_thread' AND legacy_id = :i",
                   i=legacy["thread"].id)
    assert conv["extension_flow_key"] == "legacy_flow" and conv["title"] == "Hỏi chính sách"
    turns = _rows("SELECT seq, status, origin, question, doc_ids, envelope, legacy_run_id FROM chat_turns "
                  "WHERE conversation_id = :c ORDER BY seq", c=conv["id"])
    assert [t["seq"] for t in turns] == [1, 2, 3, 4]
    assert [t["legacy_run_id"] for t in turns] == [r.id for r in legacy["runs"]]
    assert [t["status"] for t in turns] == ["answered", "refused", "failed", "answered"]
    assert turns[0]["question"] == "Chính sách là gì?" and turns[0]["doc_ids"] == [424242]
    pruned = turns[2]
    assert pruned["question"] == "cau cu da bi xoa noi dung" and pruned["envelope"]["content_pruned"] is True
    assert pruned["envelope"]["footprint_known"] is False


def test_shares_are_copied_at_the_same_level_and_ratings_kept(db, legacy):  # noqa: F811
    _run_import()
    got = _rows("SELECT c.legacy_kind, s.permission::text AS level FROM resource_shares s JOIN chat_conversations c "
                "ON s.resource_type = 'chat_conversation' AND s.resource_id = c.id::text "
                "WHERE s.user_id = :u ORDER BY c.legacy_kind", u=str(legacy["friend"].id))
    assert [(r["legacy_kind"], r["level"]) for r in got] == [("analyst_session", "view"), ("flow_thread", "edit")]
    fb = _rows("SELECT verdict, reason, comment, legacy_source FROM chat_feedback WHERE turn_id = :t",
               t=legacy["turn_ids"][0])
    assert [(f["verdict"], f["reason"], f["comment"]) for f in fb] == [("down", "wrong_filter", "thiếu năm")]
    rated = _rows("SELECT f.verdict FROM chat_feedback f JOIN chat_turns t ON t.turn_id = f.turn_id "
                  "WHERE t.legacy_run_id = :r", r=legacy["runs"][0].id)
    assert [r["verdict"] for r in rated] == ["up"]


def test_module_access_is_carried_never_widened(db, legacy):  # noqa: F811
    _, carried = _run_import()
    assert carried >= 3

    def chat(who):
        return _rows("SELECT permissions->>'chat' AS c FROM users WHERE id = :i", i=str(legacy[who].id))[0]["c"]

    assert chat("owner") == "edit" and chat("viewer") == "view"
    assert chat("keeper") == "edit", "`analyst: full` is not oversight of every conversation"
    assert chat("higher") == "full", "an existing higher level is never lowered"
    assert chat("admin") == "none", "a settings:full account is left as stored (its keys back-fill at read time)"


def test_imported_history_is_never_more_visible_than_before(client, db, legacy):  # noqa: F811
    _run_import()
    owner, friend, stranger = legacy["owner"], legacy["friend"], legacy["stranger"]
    r = client.get(f"/api/v1/chat/legacy/analyst_session/{legacy['session'].id}", headers=owner.headers)
    assert r.status_code == 200
    body = client.get(f"/api/v1/chat/conversations/{r.json()['conversation_id']}", headers=owner.headers).json()
    first = body["turns"][0]
    # the Dataset it read is not in the owner's catalog today: hidden from them too
    assert first["redacted"] is True and first["redacted_reason"] == "source_access" and "150" not in str(first)

    cid = client.get(f"/api/v1/chat/legacy/flow_thread/{legacy['thread'].id}",
                     headers=friend.headers).json()["conversation_id"]
    seen = client.get(f"/api/v1/chat/conversations/{cid}", headers=friend.headers).json()
    assert seen["access"] == "edit"
    by_seq = {t["seq"]: t for t in seen["turns"]}
    assert by_seq[1]["redacted"] is True, "a flow answer needs every document its flow had attached"
    assert by_seq[4]["redacted"] is False and by_seq[4]["envelope"]["legacy"]["answer"] == "Xin chào!"
    assert by_seq[4]["envelope"]["data"] is None, "an old flow answer is never presented as verified data"
    assert by_seq[3]["redacted"] is True and by_seq[3]["redacted_reason"] == "asker_only"
    mine = client.get(f"/api/v1/chat/conversations/{cid}", headers=owner.headers).json()
    assert {t["seq"]: t["redacted"] for t in mine["turns"]}[3] is False, "the asker still sees their pruned turn"

    assert client.get(f"/api/v1/chat/legacy/flow_thread/{legacy['thread'].id}",
                      headers=stranger.headers).status_code == 404
    assert client.get(f"/api/v1/chat/legacy/analyst_session/{legacy['gone'].id}",
                      headers=owner.headers).status_code == 404
