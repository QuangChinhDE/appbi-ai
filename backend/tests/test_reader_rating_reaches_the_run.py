# -*- coding: utf-8 -*-
"""A reader's thumb reaches exactly one run — the one the server produced for them.

WHAT THIS PROTECTS.

`agent_flow_runs.rating` is the column the Runs tab, the Feedback tab and the
pilot funnel read. The reader's thumb arrives from an ANONYMOUS endpoint, inside a
session snapshot the client posts, so `runs.apply_rating` is the only thing
standing between "a viewer said this answer was bad" and "anyone can write a
verdict onto any run".

THE CONTRACT, all of which must hold:

  * the caller's own `session_key`;
  * the public LINK the caller is on. Session keys are chosen by the client, so
    without this a caller on link X could reach a run served on link Y merely by
    reusing a session key — the gap independent review found;
  * the answer text byte-equal to what the server STORED. Exact, never fuzzy:
    it is what stops a page rating words the server never said.

And one property that matters because of HOW it is called: the session is saved
as a whole snapshot after every turn, so a rated message is re-sent on every
later save. The write must be a VALUE, never an increment, or three more saves
become four verdicts.

WHY A REAL DATABASE AND NOT A FAKE. The previous version faked `db.query` and
read the filter values in positional order. It passed, and it would have kept
passing had a filter been dropped — it tested the fake's parser. This runs the
real query against SQLite with the real models.
"""
from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.models.agent_flow_run import AgentFlowRun, AgentFlowRunContent
from app.services.agent_flows import runs as runs_service


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):  # pragma: no cover - dialect shim
    return "JSON"


ANSWER = "Tổng doanh thu là 10.748.221,50."
LINK_A = "link-token-A"
LINK_B = "link-token-B"


@pytest.fixture()
def db():
    engine = create_engine("sqlite://")
    AgentFlowRun.__table__.create(engine)
    AgentFlowRunContent.__table__.create(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def _run(db, *, session_key: str, link_token: str, answer: str = ANSWER, run_key: str) -> int:
    run = AgentFlowRun(
        run_key=run_key, brain_key="bi_starter", version=1, status="ok",
        session_key=session_key, link_token=link_token, is_test=False,
        created_at=dt.datetime.utcnow(),
    )
    db.add(run)
    db.flush()
    db.add(AgentFlowRunContent(run_id=run.id, question="q", answer=answer))
    db.commit()
    return run.id


def _rating(db, run_id: int):
    db.expire_all()
    return db.get(AgentFlowRun, run_id).rating


def test_the_real_answer_in_the_right_session_and_link_is_rated(db):
    rid = _run(db, session_key="s1", link_token=LINK_A, run_key="r1")
    assert runs_service.apply_rating(
        db, session_key="s1", link_token=LINK_A, answer_text=ANSWER, rating="up") is True
    assert _rating(db, rid) == "up"


def test_the_same_answer_in_another_session_cannot_be_touched(db):
    rid = _run(db, session_key="victim", link_token=LINK_A, run_key="r1")
    assert runs_service.apply_rating(
        db, session_key="attacker", link_token=LINK_A, answer_text=ANSWER, rating="down") is False
    assert _rating(db, rid) is None


def test_the_same_session_on_a_different_link_cannot_be_touched(db):
    """The gap: a client-chosen session key reused from another link."""
    rid = _run(db, session_key="s1", link_token=LINK_B, run_key="r1")
    assert runs_service.apply_rating(
        db, session_key="s1", link_token=LINK_A, answer_text=ANSWER, rating="down") is False
    assert _rating(db, rid) is None


def test_text_the_server_never_produced_rates_nothing(db):
    rid = _run(db, session_key="s1", link_token=LINK_A, run_key="r1")
    assert runs_service.apply_rating(
        db, session_key="s1", link_token=LINK_A,
        answer_text="Một câu trả lời chưa từng tồn tại.", rating="down") is False
    assert _rating(db, rid) is None


def test_near_miss_text_is_not_a_match(db):
    """Exact means exact. A fuzzy matcher is how a forged claim gets attached."""
    rid = _run(db, session_key="s1", link_token=LINK_A, run_key="r1")
    assert runs_service.apply_rating(
        db, session_key="s1", link_token=LINK_A, answer_text=ANSWER + " ", rating="up") is False
    assert _rating(db, rid) is None


@pytest.mark.parametrize("bad", ["", "maybe", "UP", "1", None])
def test_only_up_and_down_are_ratings(db, bad):
    rid = _run(db, session_key="s1", link_token=LINK_A, run_key="r1")
    assert runs_service.apply_rating(
        db, session_key="s1", link_token=LINK_A, answer_text=ANSWER, rating=bad) is False
    assert _rating(db, rid) is None


@pytest.mark.parametrize("field", ["session_key", "link_token"])
def test_a_missing_scope_key_rates_nothing(db, field):
    rid = _run(db, session_key="s1", link_token=LINK_A, run_key="r1")
    kwargs = {"session_key": "s1", "link_token": LINK_A}
    kwargs[field] = ""
    assert runs_service.apply_rating(db, answer_text=ANSWER, rating="up", **kwargs) is False
    assert _rating(db, rid) is None


def test_replaying_the_same_snapshot_is_idempotent(db):
    """A session is re-saved after every turn, carrying every earlier rating."""
    rid = _run(db, session_key="s1", link_token=LINK_A, run_key="r1")
    for _ in range(5):
        runs_service.apply_rating(
            db, session_key="s1", link_token=LINK_A, answer_text=ANSWER, rating="down")
    assert _rating(db, rid) == "down"


def test_a_changed_verdict_overwrites_rather_than_accumulating(db):
    rid = _run(db, session_key="s1", link_token=LINK_A, run_key="r1")
    runs_service.apply_rating(db, session_key="s1", link_token=LINK_A, answer_text=ANSWER, rating="up")
    runs_service.apply_rating(db, session_key="s1", link_token=LINK_A, answer_text=ANSWER, rating="down")
    assert _rating(db, rid) == "down"


def test_a_broken_lookup_never_raises_into_the_caller():
    class _Exploding:
        rolled_back = 0

        def query(self, *a, **k):
            raise RuntimeError("the database went away")

        def rollback(self):
            self.rolled_back += 1

    db = _Exploding()
    assert runs_service.apply_rating(
        db, session_key="s1", link_token=LINK_A, answer_text=ANSWER, rating="up") is False
    assert db.rolled_back == 1
