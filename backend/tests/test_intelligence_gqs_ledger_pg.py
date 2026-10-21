"""PR-1E: the durable audit ledger SERVICE, executed on real Postgres.

The ledger writes as the least-privilege application role (`appbi_app`, which
has no DELETE/TRUNCATE on the table), through GQS's real execute path over the
`gqs_src` world of test_intelligence_gqs_execution_pg.py.

Locked here:
  * a governed read leaves a committed row: running -> ok, with fingerprints,
    bounds and counts, and no SQL text anywhere in the row;
  * no ledger reachable -> `audit_unavailable`, and the warehouse is never touched;
  * a second begin for the same id is a conflict (no rewritten history);
  * the first terminal status wins; repeating it is idempotent, flipping it is not;
  * budgets are reserved atomically: N concurrent begins on separate
    connections against a limit L admit exactly L (COUNT-then-INSERT would not);
  * an over-budget query refuses `budget_exceeded`, is recorded `refused`, and
    refused rows do not consume budget;
  * cross-worker cancel: worker B marks the query, worker A (which owns it)
    cancels it on its own connection; the request refuses `cancelled`, the row
    is `cancelled`, and the statement is gone from Postgres;
  * only the owner may request a cancel;
  * a row whose worker stopped heart-beating is recovered to `abandoned`, and
    cannot be finalized afterwards.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from types import SimpleNamespace

import pytest
import sqlalchemy as sa

from tests.authz_http import db  # noqa: F401 - fixture
from tests.test_intelligence_gqs_execution_pg import (  # noqa: F401 - fixtures
    _gqs, _owner_url, _req, world,
)

pytestmark = pytest.mark.pg


@pytest.fixture(scope="module")
def app_engine():
    url = os.environ.get("AUTHZ_PG_APP_URL") or ""
    if not url.startswith("postgresql"):
        pytest.fail("test_intelligence_gqs_ledger_pg writes as the app role; it needs AUTHZ_PG_APP_URL.")
    eng = sa.create_engine(url, pool_size=20, max_overflow=0)
    yield eng
    eng.dispose()


def _ledger(app_engine, **kw):
    from app.services.governed_query.ledger import PostgresLedger

    return PostgresLedger(app_engine, **kw)


def _row(app_engine, qid):
    with app_engine.connect() as c:
        r = c.execute(sa.text("SELECT * FROM governed_query_executions WHERE query_id = :q"), {"q": qid}).mappings().first()
    return dict(r) if r else None


def _fake(run_id=None, user=None, ds_id=None, ds_type="postgresql"):
    from app.services.governed_query import QueryBounds

    return SimpleNamespace(
        query_id=uuid.uuid4().hex, ds_type=ds_type, dataset_ids=(1,), dialect="postgres",
        sql_fingerprint="f" * 16, policy_fingerprint="p" * 16, datasource=SimpleNamespace(id=ds_id),
        bounds=QueryBounds(max_rows=10, timeout_seconds=5, bq_max_bytes=1000),
        request=SimpleNamespace(run_id=run_id, relation=SimpleNamespace(kind="semantic_explore", id=1),
                                principal=SimpleNamespace(user_id=user or uuid.uuid4(), kind="human",
                                                          surface="analyst")))


def test_a_governed_read_leaves_a_committed_row(world, app_engine):  # noqa: F811
    gqs, p = _gqs(world, who="owner", sink=_ledger(app_engine))
    res = gqs.execute(_req(world, p, dims=["region"], measures=["revenue"]))
    row = _row(app_engine, res.evidence.query_id)
    assert row["status"] == "ok" and row["finished_at"] is not None
    assert row["rows_returned"] == len(res.rows)
    assert row["sql_fingerprint"] == res.evidence.sql_fingerprint
    assert str(row["user_id"]) == str(world["owner"].id) and row["surface"] == "analyst"
    assert row["bounds"]["max_rows"] == res.evidence.bounds.max_rows
    assert not any("select" in str(v).lower() for v in row.values()), "SQL text reached the ledger"


def test_an_unreachable_ledger_refuses_before_the_warehouse(world, monkeypatch):  # noqa: F811
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.governed_query import GovernedRefusal
    from app.services.governed_query.ledger import PostgresLedger

    touched = []
    monkeypatch.setattr(DataSourceConnectionService, "execute_query", lambda *a, **k: touched.append(1))
    dead = sa.create_engine("postgresql://nobody:x@127.0.0.1:1/none", connect_args={"connect_timeout": 2})
    gqs, p = _gqs(world, who="owner", sink=PostgresLedger(dead))
    with pytest.raises(GovernedRefusal) as exc:
        gqs.execute(_req(world, p, dims=["region"], measures=["revenue"]))
    assert exc.value.code == "audit_unavailable" and not touched


def test_a_second_begin_is_a_conflict(app_engine):
    from app.services.governed_query.ledger import LedgerConflict

    led, c = _ledger(app_engine), _fake()
    led.begin(c)
    with pytest.raises(LedgerConflict):
        led.begin(c)


def test_the_first_terminal_status_wins(app_engine):
    from app.services.governed_query.ledger import LedgerConflict

    led, c = _ledger(app_engine), _fake()
    led.begin(c)
    led.finish(c.query_id, status="cancelled", refusal_code="cancelled")
    led.finish(c.query_id, status="cancelled", refusal_code="cancelled")  # idempotent
    with pytest.raises(LedgerConflict):
        led.finish(c.query_id, status="ok", rows_returned=3)
    assert _row(app_engine, c.query_id)["status"] == "cancelled"


def test_concurrent_begins_admit_exactly_the_budget(app_engine):
    from app.services.governed_query.ledger import BudgetExceeded, LedgerBudgets

    led = _ledger(app_engine, budgets=LedgerBudgets(max_queries_per_run=3))
    run = uuid.uuid4().hex
    gate = threading.Barrier(12)
    out = []

    def one():
        c = _fake(run_id=run)
        gate.wait()
        try:
            led.begin(c)
            out.append("ok")
        except BudgetExceeded:
            out.append("refused")

    threads = [threading.Thread(target=one) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert out.count("ok") == 3 and out.count("refused") == 9, out
    with app_engine.connect() as c:
        by = dict(c.execute(sa.text("SELECT status, count(*) FROM governed_query_executions WHERE run_id = :r "
                                    "GROUP BY status"), {"r": run}).all())
    assert by == {"running": 3, "refused": 9}


def test_concurrency_per_datasource_frees_on_finish(app_engine):
    from app.services.governed_query.ledger import BudgetExceeded, LedgerBudgets

    ds = 900000 + int(uuid.uuid4().int % 99999)
    led = _ledger(app_engine, budgets=LedgerBudgets(max_concurrent_per_datasource=1))
    a = _fake(ds_id=ds)
    led.begin(a)
    with pytest.raises(BudgetExceeded) as exc:
        led.begin(_fake(ds_id=ds))
    assert exc.value.code == "budget_exceeded" and exc.value.detail["budget"] == "concurrent_per_datasource"
    led.finish(a.query_id, status="ok", rows_returned=1)
    led.begin(_fake(ds_id=ds))  # the slot is free again; refused rows did not hold it


def test_bigquery_bytes_are_reserved_per_user_day(app_engine):
    from app.services.governed_query.ledger import BudgetExceeded, LedgerBudgets

    user = uuid.uuid4()
    led = _ledger(app_engine, budgets=LedgerBudgets(max_bq_bytes_per_user_day=2500))
    led.begin(_fake(user=user, ds_type="bigquery"))  # reserves 1000
    led.begin(_fake(user=user, ds_type="bigquery"))  # 2000
    with pytest.raises(BudgetExceeded):
        led.begin(_fake(user=user, ds_type="bigquery"))  # would be 3000


def test_a_budget_refusal_through_gqs_is_recorded_refused(world, app_engine):  # noqa: F811
    from app.services.governed_query import GovernedRefusal
    from app.services.governed_query.ledger import LedgerBudgets

    led = _ledger(app_engine, budgets=LedgerBudgets(max_queries_per_run=1))
    gqs, p = _gqs(world, who="owner", sink=led)
    run = uuid.uuid4().hex
    first = _req(world, p, dims=["region"], measures=["revenue"])
    first = type(first)(**{**first.__dict__, "run_id": run})
    gqs.execute(first)
    with pytest.raises(GovernedRefusal) as exc:
        gqs.execute(first)
    assert exc.value.code == "budget_exceeded"
    with app_engine.connect() as c:
        st = sorted(r[0] for r in c.execute(sa.text("SELECT status FROM governed_query_executions WHERE run_id = :r"),
                                            {"r": run}))
    assert st == ["ok", "refused"]


def _slow(world, p):  # noqa: F811
    from app.services.governed_query import QueryBounds

    return _req(world, p, measures=["revenue"], view=world["slow_view"].name,
                explore_id=world["slow_explore"].id,
                bounds=QueryBounds(max_rows=10, timeout_seconds=60, bq_max_bytes=1))


@pytest.mark.parametrize("via_process", [False, True], ids=["thread", "process"])
def test_cross_worker_cancel(world, app_engine, via_process):  # noqa: F811
    """Worker A runs the query; worker B, with its own ledger identity and its
    own connections, only marks it. A's watcher performs the cancel."""
    from app.services.governed_query import CancelRegistry, GovernedRefusal
    from app.services.governed_query.ledger import CancelWatcher, PostgresLedger

    reg_a = CancelRegistry()
    led_a = PostgresLedger(app_engine, worker_id="worker-a")
    led_b = PostgresLedger(sa.create_engine(os.environ["AUTHZ_PG_APP_URL"]), worker_id="worker-b")
    watcher = CancelWatcher(led_a, reg_a, interval_seconds=0.2).start()
    try:
        gqs, p = _gqs(world, who="owner", sink=led_a, registry=reg_a)
        req = _slow(world, p)
        box = {}

        def run():
            try:
                box["res"] = gqs.execute(req)
            except GovernedRefusal as exc:
                box["err"] = exc

        worker_b = None
        if via_process:
            import subprocess
            import sys

            code = "\n".join([
                "import os, sys, sqlalchemy as sa",
                "from app.services.governed_query.ledger import PostgresLedger",
                "l = PostgresLedger(sa.create_engine(os.environ['AUTHZ_PG_APP_URL']), worker_id='worker-b')",
                "print('ready', flush=True)",
                "q, u = sys.stdin.readline().split()",
                "print(l.request_cancel(q, requested_by=u), flush=True)",
            ])
            worker_b = subprocess.Popen([sys.executable, "-W", "ignore", "-c", code], text=True,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            assert worker_b.stdout.readline().strip() == "ready"
        t0 = time.time()
        th = threading.Thread(target=run, daemon=True)
        th.start()
        qid = None
        deadline = time.time() + 20
        while qid is None and time.time() < deadline:
            ids = reg_a.running_ids()
            qid = next(iter(ids)) if ids else None
            time.sleep(0.05)
        assert qid, "the query never registered"
        if via_process:
            # Worker B is a separate OS process (started and warmed up before the
            # query) with its own engine and connections; it only marks the row.
            worker_b.stdin.write(f"{qid} {world['owner'].id}\n")
            worker_b.stdin.flush()
            assert worker_b.stdout.readline().strip() == "True"
        else:
            assert led_b.request_cancel(qid, requested_by=world["owner"].id) is True
        th.join(timeout=30)
        assert not th.is_alive() and time.time() - t0 < 20
        assert "res" not in box and box["err"].code == "cancelled"
        row = _row(app_engine, qid)
        assert row["status"] == "cancelled" and row["worker_id"] == "worker-a"
        assert str(row["cancel_requested_by"]) == str(world["owner"].id)
        with sa.create_engine(_owner_url()).connect() as c:
            left = c.execute(sa.text("SELECT count(*) FROM pg_stat_activity WHERE query ILIKE '%slow_sales%' "
                                     "AND pid <> pg_backend_pid() AND state = 'active'")).scalar()
        assert left == 0
    finally:
        watcher.stop()
        if via_process and worker_b is not None:
            worker_b.wait(timeout=30)


def test_only_the_owner_may_request_a_cancel(app_engine):
    owner, other = uuid.uuid4(), uuid.uuid4()
    led, c = _ledger(app_engine), _fake(user=owner)
    led.begin(c)
    assert led.request_cancel(c.query_id, requested_by=other) is False
    assert _row(app_engine, c.query_id)["cancel_requested_at"] is None
    assert led.request_cancel(c.query_id, requested_by=owner) is True
    led.finish(c.query_id, status="cancelled")
    assert led.request_cancel(c.query_id, requested_by=owner) is False  # no longer running


def test_a_stale_running_row_is_recovered_to_abandoned(app_engine):
    from app.services.governed_query.ledger import LedgerConflict

    led, c = _ledger(app_engine), _fake()
    led.begin(c)
    with app_engine.begin() as conn:
        conn.execute(sa.text("UPDATE governed_query_executions SET heartbeat_at = now() - interval '10 minutes' "
                             "WHERE query_id = :q"), {"q": c.query_id})
    assert c.query_id in led.recover_stale_running(older_than_seconds=120)
    row = _row(app_engine, c.query_id)
    assert row["status"] == "abandoned" and row["refusal_code"] == "worker_lost"
    with pytest.raises(LedgerConflict):
        led.finish(c.query_id, status="ok")


def test_a_live_lease_is_not_recovered(app_engine):
    led, c = _ledger(app_engine), _fake()
    led.begin(c)
    led.heartbeat([c.query_id])
    assert c.query_id not in led.recover_stale_running(older_than_seconds=120)
    led.finish(c.query_id, status="ok")
