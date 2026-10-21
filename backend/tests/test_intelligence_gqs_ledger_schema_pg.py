"""PR-1E: the `governed_query_executions` table holds its contract on real Postgres.

The migration was also rehearsed by hand on a fresh database (full chain
upgrade, downgrade on an empty table, re-upgrade, downgrade REFUSED with one row
present). This file locks what CI can check on the shared test database:

  * the table exists at head with its status and terminal/finished constraints;
  * `query_id` is the primary key: a second row for the same id is a conflict;
  * a `running` row cannot carry `finished_at`, a terminal row must;
  * the least-privilege `appbi_app` role can SELECT/INSERT/UPDATE but cannot
    DELETE or TRUNCATE (the ledger is append-only for the application).
"""
from __future__ import annotations

import os
import uuid

import pytest
import sqlalchemy as sa

pytestmark = pytest.mark.pg

TABLE = "governed_query_executions"


@pytest.fixture()
def engine():
    url = os.environ.get("AUTHZ_PG_OWNER_URL") or os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_intelligence_gqs_ledger_schema_pg needs Postgres.")
    eng = sa.create_engine(url)
    try:
        yield eng
    finally:
        eng.dispose()


def _insert(conn, qid, status="running", finished=False):
    conn.execute(sa.text(
        f"INSERT INTO {TABLE} (query_id, principal_kind, surface, status, finished_at) "
        f"VALUES (:q, 'human', 'analyst', :s, {'now()' if finished else 'NULL'})"), {"q": qid, "s": status})


def test_the_table_exists_with_its_constraints(engine):
    insp = sa.inspect(engine)
    assert TABLE in insp.get_table_names()
    checks = {c["name"] for c in insp.get_check_constraints(TABLE)}
    assert {"ck_gqe_status", "ck_gqe_terminal_has_finish"} <= checks
    assert insp.get_pk_constraint(TABLE)["constrained_columns"] == ["query_id"]


def test_query_id_is_unique(engine):
    qid = f"t-{uuid.uuid4().hex}"
    with engine.connect() as c:
        tx = c.begin()
        try:
            _insert(c, qid)
            with pytest.raises(sa.exc.IntegrityError):
                with c.begin_nested():
                    _insert(c, qid)
        finally:
            tx.rollback()


@pytest.mark.parametrize("status,finished,ok", [
    ("running", False, True), ("running", True, False),
    ("ok", True, True), ("ok", False, False),
    ("cancelled", True, True), ("abandoned", True, True),
    ("bogus", True, False),
])
def test_status_and_finish_are_consistent(engine, status, finished, ok):
    with engine.connect() as c:
        tx = c.begin()
        try:
            if ok:
                _insert(c, f"t-{uuid.uuid4().hex}", status, finished)
            else:
                with pytest.raises(sa.exc.IntegrityError):
                    _insert(c, f"t-{uuid.uuid4().hex}", status, finished)
        finally:
            tx.rollback()


def test_the_app_role_cannot_delete_or_truncate(engine):
    with engine.connect() as c:
        role = c.execute(sa.text("SELECT 1 FROM pg_roles WHERE rolname = 'appbi_app'")).scalar()
        if not role:
            pytest.fail("appbi_app role is not provisioned on this database")
        privs = dict(c.execute(sa.text(
            "SELECT p, has_table_privilege('appbi_app', :t, p) "
            "FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p"), {"t": TABLE}).fetchall())
    assert privs == {"SELECT": True, "INSERT": True, "UPDATE": True, "DELETE": False, "TRUNCATE": False}
