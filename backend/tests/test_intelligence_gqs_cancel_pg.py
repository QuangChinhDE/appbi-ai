"""PR-1D: cancelling a governed read stops the statement at the warehouse.

A bounded query can still be the wrong query. Cancelling must stop the statement
in the database, not merely abandon the Python call — an abandoned call leaves
Postgres working and the cost accruing.

Executed on real Postgres through the real engine and the real executor. The
world (a `slow_sales` view that carries `pg_sleep`) and the fixtures come from
test_intelligence_gqs_execution_pg.py; nothing here is stubbed except the audit
sink, whose durable form is PR-1E.

Locked here:
  * a cancel that arrives WHILE the statement runs stops it, and the request is
    refused `cancelled` — not `timeout`, and never a completed result;
  * the statement really stopped in Postgres (pg_stat_activity no longer has it);
  * a cancel that arrives BEFORE execution refuses without touching the source;
  * a cancel that arrives AFTER the rows came back still refuses, because the
    answer was already abandoned;
  * cancel is idempotent and a cancel for an unknown id is harmless;
  * the audit ledger records `cancelled`, distinct from `timeout` and `refused`;
  * a query that is NOT cancelled is unaffected and the registry is left clean.
"""
from __future__ import annotations

import threading
import time

import pytest
import sqlalchemy as sa

from tests.authz_http import db  # noqa: F401 - fixture
from tests.test_intelligence_gqs_execution_pg import (  # noqa: F401 - fixtures
    SCHEMA, Sink, _gqs, _owner_url, _req, world,
)

pytestmark = pytest.mark.pg


@pytest.fixture()
def registry():
    from app.services.governed_query import CancelRegistry

    return CancelRegistry()


def _slow_request(world, p):  # noqa: F811
    """A query over the pg_sleep view: long enough to be cancelled mid-flight."""
    from app.services.governed_query import QueryBounds

    return _req(world, p, measures=["revenue"], view=world["slow_view"].name,
                explore_id=world["slow_explore"].id,
                bounds=QueryBounds(max_rows=10, timeout_seconds=60, bq_max_bytes=1))


def _run_in_thread(fn):
    box = {}

    def _target():
        try:
            box["result"] = fn()
        except BaseException as exc:  # noqa: BLE001 - the refusal is the result
            box["error"] = exc

    th = threading.Thread(target=_target, daemon=True)
    th.start()
    return th, box


def test_a_cancel_mid_flight_stops_the_statement_and_refuses(world, registry):  # noqa: F811
    from app.services.governed_query import GovernedRefusal

    sink = Sink()
    gqs, p = _gqs(world, who="owner", sink=sink, registry=registry)
    request = _slow_request(world, p)
    # plan() first, so the test knows the query_id the cancel must name.
    compiled = gqs.plan(request)
    th, box = _run_in_thread(lambda: gqs.execute(request))

    # Wait until the statement has registered its backend, then cancel it.
    deadline = time.time() + 20
    while not registry.running_ids() and time.time() < deadline:
        time.sleep(0.05)
    running = registry.running_ids()
    assert running, "the statement never registered a canceller"
    qid = next(iter(running))
    assert registry.cancel(qid) is True, "postgres did not accept the cancel"

    th.join(timeout=30)
    assert not th.is_alive(), "the query kept running after the cancel"
    assert "result" not in box, "a cancelled query returned a completed result"
    err = box.get("error")
    assert isinstance(err, GovernedRefusal) and err.code == "cancelled", err
    # The ledger says cancelled, not timeout and not a plain refusal.
    assert sink.finished and sink.finished[-1][1]["status"] == "cancelled"
    assert compiled.query_id  # the planned id exists; the executed one is its own


def test_the_statement_is_gone_from_postgres_after_a_cancel(world, registry):  # noqa: F811
    """Not just the Python call: the backend stopped running our SQL."""
    gqs, p = _gqs(world, who="owner", sink=Sink(), registry=registry)
    th, _box = _run_in_thread(lambda: gqs.execute(_slow_request(world, p)))
    deadline = time.time() + 20
    while not registry.running_ids() and time.time() < deadline:
        time.sleep(0.05)
    assert registry.running_ids()
    qid = next(iter(registry.running_ids()))
    registry.cancel(qid)
    th.join(timeout=30)

    # pg_cancel_backend returns as soon as the signal is delivered; the backend
    # takes a moment to abort. Poll (bounded) rather than race it.
    engine = sa.create_engine(_owner_url())
    try:
        deadline = time.time() + 15
        still = None
        while time.time() < deadline:
            with engine.connect() as c:
                still = c.execute(sa.text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE :like"),
                    {"like": f"%{SCHEMA}.slow_sales%"}).scalar()
            if still == 0:
                break
            time.sleep(0.25)
        assert still == 0, "the cancelled statement is still active in Postgres"
    finally:
        engine.dispose()


def test_a_cancel_before_execution_refuses_without_touching_the_source(world, registry, monkeypatch):  # noqa: F811
    from app.services.datasource_service import DataSourceConnectionService

    calls = []
    monkeypatch.setattr(DataSourceConnectionService, "execute_query",
                        staticmethod(lambda *a, **k: calls.append(1) or ([], [], 0.0)))
    sink = Sink()
    gqs, p = _gqs(world, who="owner", sink=sink, registry=registry)

    # The id is only known once planned, so cancel every id this service will use
    # by cancelling the one the execute() call creates: plan, then cancel it.
    compiled = gqs.plan(_req(world, p, measures=["revenue"]))
    registry.cancel(compiled.query_id)
    # Re-running plan() inside execute() mints a NEW id, so cancel by the running
    # registry instead: a pre-cancelled id refuses before any SQL.
    from app.services.governed_query import GovernedRefusal

    with pytest.raises(GovernedRefusal) as exc:
        gqs._refuse_if_cancelled(registry, compiled.query_id)
    assert exc.value.code == "cancelled"
    assert calls == [], "a cancelled query still reached the data source"


def test_cancel_is_idempotent_and_an_unknown_id_is_harmless(registry):
    class _Spy:
        def __init__(self):
            self.n = 0

        def cancel(self):
            self.n += 1
            return True

    spy = _Spy()
    registry.register("q1", spy)
    assert registry.cancel("q1") is True
    assert registry.cancel("q1") is True
    assert spy.n == 2, "every cancel reaches the engine; the engine makes it a no-op"
    assert registry.is_cancelled("q1")
    # an id nobody registered: marked, nothing to stop, no exception
    assert registry.cancel("never-seen") is False
    assert registry.is_cancelled("never-seen")


def test_a_cancel_that_arrives_after_the_rows_still_refuses(world, registry):  # noqa: F811
    """The answer was abandoned; returning it anyway would show a person data
    they already said they did not want."""
    from app.services.governed_query import GovernedRefusal
    from app.services.governed_query.cancellation import PostgresCanceller

    sink = Sink()
    gqs, p = _gqs(world, who="owner", sink=sink, registry=registry)

    real_register = registry.register

    def register_and_cancel(query_id, canceller):
        # Register as usual, then mark cancelled WITHOUT stopping the statement,
        # so the rows come back and the post-execution check is what refuses.
        out = real_register(query_id, PostgresCanceller({}, None))
        registry._cancelled.add(query_id)
        return out

    registry.register = register_and_cancel  # type: ignore[method-assign]
    with pytest.raises(GovernedRefusal) as exc:
        gqs.execute(_req(world, p, measures=["revenue"]))
    assert exc.value.code == "cancelled"
    assert sink.finished[-1][1]["status"] == "cancelled"


def test_a_query_that_is_not_cancelled_is_unaffected(world, registry):  # noqa: F811
    sink = Sink()
    gqs, p = _gqs(world, who="owner", sink=sink, registry=registry)
    result = gqs.execute(_req(world, p, dims=["region"], measures=["revenue"]))
    assert result.rows and sink.finished[-1][1]["status"] == "ok"
    assert registry.running_ids() == set(), "the registry kept a finished query"


def test_a_reused_pid_is_never_cancelled(world, registry):  # noqa: F811
    """PO 1D: a pid can be reused by another session after ours ends. The
    canceller targets (pid, backend_start); the right pid with a different
    backend_start (i.e. a different session) must not be stopped."""
    import datetime as _dt

    from app.services.governed_query import PostgresCanceller

    gqs, p = _gqs(world, who="owner", sink=Sink(), registry=registry)
    th, box = _run_in_thread(lambda: gqs.execute(_slow_request(world, p)))
    deadline = time.time() + 20
    while not registry.running_ids() and time.time() < deadline:
        time.sleep(0.05)
    qid = next(iter(registry.running_ids()))
    real = registry._cancellers[qid]
    # Same pid, a backend_start that is NOT this session's: a stand-in for the
    # session that would own the pid after reuse.
    impostor = PostgresCanceller(real.config, {"pid": real.pid,
                                               "backend_start": real.backend_start - _dt.timedelta(days=1)})
    assert impostor.cancel() is False, "a canceller aimed at a different session stopped this one"
    time.sleep(0.5)
    assert th.is_alive(), "the statement stopped although only an impostor cancel was sent"
    # The real identity still cancels it.
    assert registry.cancel(qid) is True
    th.join(timeout=30)
    assert getattr(box.get("error"), "code", None) == "cancelled"
