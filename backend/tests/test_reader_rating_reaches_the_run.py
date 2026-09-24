# -*- coding: utf-8 -*-
"""A reader's thumb has to reach the run, not only the transcript.

WHY THIS MATTERS MORE THAN IT LOOKS.

`agent_flow_runs.rating` is the column the operator reads. The Runs tab shows
it, the pilot funnel counts it, and "which answers were bad" is answerable only
through it. The reader's thumb, however, arrives inside the session blob the
public chat client saves — so there is one hop between a viewer saying "this was
wrong" and anybody being able to see that they said it. `apply_rating` is that
hop, and it had no test.

WHAT THE CONTRACT ACTUALLY IS, AND WHY IT IS DELIBERATELY NARROW.

A public chat client does not know run ids, so the run is found by matching the
ANSWER TEXT within the caller's own session. That is not laziness: it means the
only thing a public page can rate is text the SERVER produced for THAT session.
A client cannot invent an answer and attach a verdict to it, and it cannot rate
somebody else's run by guessing at their words.

The cost of that choice is exactness — the stored answer and the client's copy
have to agree — and this file pins both halves: the match works, and the
isolation holds. It does not try to loosen the matching. Fuzzy matching here
would trade the security property for convenience, and the property is the
reason the design is shaped this way.

WHAT IS NOT COVERED HERE. Whether the browser sends the right text. That is the
reader journey's job and it is verified there; this is the server-side contract
underneath it.
"""
from __future__ import annotations

import pytest

pytest.importorskip("sqlalchemy")

from app.services.agent_flows import runs as runs_service  # noqa: E402


class _Row:
    """Minimal stand-in for an ORM row: only the attribute under test."""

    def __init__(self, rating=None):
        self.rating = rating


class _Query:
    """A query whose `.first()` answers from a fixed table of (session, answer)."""

    def __init__(self, db, rows):
        self._db = db
        self._rows = rows
        self._session = None
        self._answer = None

    def join(self, *a, **k):
        return self

    def order_by(self, *a, **k):
        return self

    def filter(self, *conditions):
        # The real filters are SQLAlchemy expressions; the fake reads the values
        # the caller bound, which is what the behaviour depends on.
        for c in conditions:
            value = getattr(c, "right", None)
            value = getattr(value, "value", value)
            if isinstance(value, str):
                if self._session is None:
                    self._session = value
                else:
                    self._answer = value
        return self

    def first(self):
        for (session, answer), row in self._rows.items():
            if session == self._session and answer == self._answer:
                return row
        return None


class _DB:
    def __init__(self, rows):
        self.rows = rows
        self.committed = 0
        self.rolled_back = 0

    def query(self, *a, **k):
        return _Query(self, self.rows)

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1


ANSWER = "Tổng doanh thu là 10.748.221,50."


@pytest.fixture()
def db():
    return _DB({
        ("sess-a", ANSWER): _Row(),
        ("sess-b", ANSWER): _Row(),
    })


def test_a_thumb_reaches_the_run_that_produced_that_answer(db):
    runs_service.apply_rating(db, session_key="sess-a", answer_text=ANSWER, rating="up")
    assert db.rows[("sess-a", ANSWER)].rating == "up"
    assert db.committed == 1


def test_it_rates_only_the_callers_own_session(db):
    """The same answer text exists in two sessions. Only the caller's is touched.

    This is the isolation that makes text-matching acceptable on a public page:
    a viewer cannot reach another viewer's run by repeating their words.
    """
    runs_service.apply_rating(db, session_key="sess-a", answer_text=ANSWER, rating="down")
    assert db.rows[("sess-a", ANSWER)].rating == "down"
    assert db.rows[("sess-b", ANSWER)].rating is None


def test_text_the_server_never_produced_rates_nothing(db):
    """A public client can only rate what the server said.

    The failure mode this forbids is a page posting an answer of its own
    invention with a verdict attached, which would put a fabricated row in the
    one table an operator trusts.
    """
    runs_service.apply_rating(
        db, session_key="sess-a", answer_text="Một câu trả lời chưa từng tồn tại.", rating="down")
    assert db.rows[("sess-a", ANSWER)].rating is None
    assert db.committed == 0


@pytest.mark.parametrize("bad", ["", "maybe", "UP", "1", "thumbs_up", None])
def test_only_up_and_down_are_ratings(db, bad):
    runs_service.apply_rating(db, session_key="sess-a", answer_text=ANSWER, rating=bad)
    assert db.rows[("sess-a", ANSWER)].rating is None
    assert db.committed == 0


def test_a_missing_session_key_rates_nothing(db):
    """Without a session there is no isolation, so there is no rating."""
    runs_service.apply_rating(db, session_key="", answer_text=ANSWER, rating="up")
    assert db.committed == 0


def test_a_broken_lookup_never_raises_into_the_caller():
    """A rating must not be able to fail the session save it arrives inside.

    The viewer already has their answer; losing a thumb is the cheaper loss, and
    a 500 here would make saving the transcript fail for everyone.
    """
    class _Exploding(_DB):
        def query(self, *a, **k):
            raise RuntimeError("the database went away")

    db = _Exploding({})
    runs_service.apply_rating(db, session_key="sess-a", answer_text=ANSWER, rating="up")
    assert db.rolled_back == 1


def test_changing_a_rating_overwrites_rather_than_accumulating(db):
    runs_service.apply_rating(db, session_key="sess-a", answer_text=ANSWER, rating="up")
    runs_service.apply_rating(db, session_key="sess-a", answer_text=ANSWER, rating="down")
    assert db.rows[("sess-a", ANSWER)].rating == "down"
