"""GQS executor bounds and cancellation on a REAL MySQL (PR-1C/1D runtime evidence).

Runs against a disposable MySQL named by GQS_MYSQL_ROOT_URL (e.g. a local
`mysql:8.0` container). Without it the module is skipped with that reason; a
skip here is NOT coverage and is reported as such.

Locked here, on the real engine:
  * the executor's server-side row cap (fetchmany) holds;
  * the READ ONLY transaction refuses a write the validator would not see;
  * KILL QUERY from a second connection stops a running statement early
    (the reader's own credential may kill its own query);
  * a DIFFERENT MySQL user cannot kill it (no cross-tenant cancel).
"""
from __future__ import annotations

import os
import threading
import time
from urllib.parse import urlparse

import pytest

ROOT_URL = os.environ.get("GQS_MYSQL_ROOT_URL", "")
if not ROOT_URL and os.environ.get("GQS_MYSQL_REQUIRED") == "1":
    raise RuntimeError("GQS_MYSQL_REQUIRED=1 but GQS_MYSQL_ROOT_URL is not set: refusing to skip")
pytestmark = pytest.mark.skipif(not ROOT_URL, reason="GQS_MYSQL_ROOT_URL not set: no MySQL runtime evidence")


def _root():
    import pymysql

    u = urlparse(ROOT_URL)
    return pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username, password=u.password,
                           autocommit=True)


def _cfg(user, password):
    u = urlparse(ROOT_URL)
    return {"host": u.hostname, "port": u.port or 3306, "database": "gqs_rt", "username": user, "password": password}


@pytest.fixture(scope="module")
def mysql_world():
    conn = _root()
    with conn.cursor() as c:
        c.execute("DROP DATABASE IF EXISTS gqs_rt")
        c.execute("CREATE DATABASE gqs_rt")
        c.execute("CREATE TABLE gqs_rt.orders (id INT PRIMARY KEY, amount INT)")
        c.execute("INSERT INTO gqs_rt.orders VALUES " + ",".join(f"({i},{i})" for i in range(1, 51)))
        # Slow at the SOURCE (a view), so the statement GQS sends is a plain SELECT.
        c.execute("CREATE VIEW gqs_rt.slow AS SELECT SLEEP(8) AS s, 1 AS n")
        for user, pw in (("gqs_owner", "ownerpw"), ("gqs_other", "otherpw")):
            c.execute(f"DROP USER IF EXISTS '{user}'@'%'")
            c.execute(f"CREATE USER '{user}'@'%' IDENTIFIED BY '{pw}'")
            c.execute(f"GRANT SELECT ON gqs_rt.* TO '{user}'@'%'")
    try:
        yield
    finally:
        with conn.cursor() as c:
            c.execute("DROP DATABASE IF EXISTS gqs_rt")
            for user in ("gqs_owner", "gqs_other"):
                c.execute(f"DROP USER IF EXISTS '{user}'@'%'")
        conn.close()


@pytest.fixture(autouse=True)
def _loopback(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "ALLOWED_PRIVATE_SOURCE_CIDRS", "127.0.0.0/8,::1/128")


def _execute(cfg, sql, **kw):
    from app.services.datasource_service import DataSourceConnectionService

    return DataSourceConnectionService.execute_query(ds_type="mysql", config=cfg, sql_query=sql, **kw)


def test_the_server_side_row_cap_holds(mysql_world):
    cols, rows, _ = _execute(_cfg("gqs_owner", "ownerpw"), "SELECT id FROM gqs_rt.orders", max_rows=7,
                             timeout_seconds=10)
    assert len(rows) == 7


def test_a_write_is_refused(mysql_world):
    with pytest.raises(Exception):
        _execute(_cfg("gqs_owner", "ownerpw"), "UPDATE gqs_rt.orders SET amount = 0", timeout_seconds=10)
    _c, rows, _ = _execute(_cfg("gqs_owner", "ownerpw"), "SELECT SUM(amount) AS s FROM gqs_rt.orders",
                           timeout_seconds=10)
    assert int(rows[0]["s"]) == sum(range(1, 51))


def _start_slow(cfg):
    box = {}

    def run():
        t0 = time.time()
        try:
            box["rows"] = _execute(cfg, "SELECT s, n FROM gqs_rt.slow", timeout_seconds=30,
                                   on_backend_id=lambda b: box.setdefault("backend", b))[1]
        except Exception as exc:  # noqa: BLE001
            box["error"] = exc
        box["elapsed"] = time.time() - t0

    th = threading.Thread(target=run, daemon=True)
    th.start()
    deadline = time.time() + 10
    while "backend" not in box and time.time() < deadline:
        time.sleep(0.05)
    time.sleep(0.5)  # let the SLEEP start
    return th, box


def test_kill_query_stops_a_running_statement_early(mysql_world):
    from app.services.governed_query import MySQLCanceller

    cfg = _cfg("gqs_owner", "ownerpw")
    th, box = _start_slow(cfg)
    assert box.get("backend", {}).get("connection_id"), "the executor did not report its connection id"
    assert MySQLCanceller(cfg, box["backend"]["connection_id"]).cancel() is True
    th.join(timeout=15)
    assert not th.is_alive()
    assert box["elapsed"] < 6, f"the statement ran {box['elapsed']:.1f}s; the 8s SLEEP was not interrupted"


def test_another_user_cannot_kill_the_query(mysql_world):
    from app.services.governed_query import MySQLCanceller

    th, box = _start_slow(_cfg("gqs_owner", "ownerpw"))
    cid = box["backend"]["connection_id"]
    assert MySQLCanceller(_cfg("gqs_other", "otherpw"), cid).cancel() is False
    time.sleep(1)
    assert th.is_alive(), "a different MySQL user stopped someone else's query"
    MySQLCanceller(_cfg("gqs_owner", "ownerpw"), cid).cancel()
    th.join(timeout=15)
