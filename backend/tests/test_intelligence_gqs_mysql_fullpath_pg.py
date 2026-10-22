"""GQS end to end on a REAL MySQL source: semantic explore -> GQS -> durable
ledger -> warehouse, not just the executor (PR-1C/1D/1E runtime evidence).

Metadata and the ledger live in Postgres (the authz harness, app role for the
ledger); the data lives in a disposable MySQL named by GQS_MYSQL_ROOT_URL.
Without it the module skips; GQS_MYSQL_REQUIRED=1 turns a missing MySQL into a
failure. A skip is NOT coverage.

Locked here, on the real engines:
  * a governed answer over MySQL equals an independent oracle (plain SQL);
  * the ledger row is `ok` with the mysql dialect and the bounds applied;
  * the row bound is enforced on MySQL and reported as truncated;
  * a cancel through GQS stops the running MySQL statement and is recorded
    `cancelled` (the KILL QUERY reaches the warehouse via the registered canceller);
  * a person without `explore` is refused before MySQL is touched.
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from urllib.parse import urlparse

import pytest
import sqlalchemy as sa

from tests.authz_http import db, make_user  # noqa: F401 - fixture

ROOT_URL = os.environ.get("GQS_MYSQL_ROOT_URL", "")
if not ROOT_URL and os.environ.get("GQS_MYSQL_REQUIRED") == "1":
    raise RuntimeError("GQS_MYSQL_REQUIRED=1 but GQS_MYSQL_ROOT_URL is not set: refusing to skip")
pytestmark = [pytest.mark.pg,
              pytest.mark.skipif(not ROOT_URL, reason="GQS_MYSQL_ROOT_URL not set: no MySQL full-path evidence")]

DB = "gqs_fp"
ROWS = [(i, ("Bắc", "Nam", "Trung")[i % 3], float(10 * i), f"2026-{(i % 6) + 1:02d}-15") for i in range(1, 61)]


def _root():
    import pymysql

    u = urlparse(ROOT_URL)
    return pymysql.connect(host=u.hostname, port=u.port or 3306, user=u.username, password=u.password,
                           autocommit=True)


@pytest.fixture(autouse=True)
def _loopback(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "ALLOWED_PRIVATE_SOURCE_CIDRS", "127.0.0.0/8,::1/128")


@pytest.fixture(params=["plain", "encrypted"])
def mysql_world(request, db):  # noqa: F811
    """`encrypted`: the config as the API stores it (secrets encrypted at rest).
    Every path that reaches MySQL, the canceller included, must decrypt it."""
    from app.models.dataset import Dataset, DatasetGrant, DatasetTable
    from app.models.models import DataSource, DataSourceType
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    conn = _root()
    with conn.cursor() as c:
        c.execute(f"DROP DATABASE IF EXISTS {DB}")
        c.execute(f"CREATE DATABASE {DB}")
        c.execute(f"CREATE TABLE {DB}.sales (id INT PRIMARY KEY, region VARCHAR(16), amount DOUBLE, order_date DATE)")
        c.executemany(f"INSERT INTO {DB}.sales VALUES (%s, %s, %s, %s)", ROWS)
        # SLEEP in WHERE runs per row; an unused SLEEP column is optimised away.
        c.execute(f"CREATE VIEW {DB}.slow_sales AS SELECT s.* FROM {DB}.sales s WHERE SLEEP(0.2) = 0")
        c.execute("DROP USER IF EXISTS 'gqs_fp_reader'@'%'")
        c.execute("CREATE USER 'gqs_fp_reader'@'%' IDENTIFIED BY 'readerpw'")
        c.execute(f"GRANT SELECT ON {DB}.* TO 'gqs_fp_reader'@'%'")
    u = urlparse(ROOT_URL)
    tag = uuid.uuid4().hex[:6]
    owner = make_user(db, "fp-owner", datasets="edit", data_sources="edit")
    stranger = make_user(db, "fp-stranger", datasets="edit")
    from app.core.crypto import encrypt_config

    cfg = {"host": u.hostname, "port": u.port or 3306, "database": DB,
           "username": "gqs_fp_reader", "password": "readerpw"}
    src = DataSource(name=f"fp-mysql-{tag}", type=DataSourceType.MYSQL, owner_id=owner.id,
                     config=encrypt_config(cfg) if request.param == "encrypted" else cfg)
    ds = Dataset(name=f"fp-sales-{tag}", owner_id=owner.id, purpose="reporting")
    db.add_all([src, ds])
    db.flush()
    views, explores = {}, {}
    model = SemanticModel(name=f"fp-model-{tag}", dataset_id=ds.id)
    db.add(model)
    db.flush()
    for name, table in (("sales", f"{DB}.sales"), ("slow", f"{DB}.slow_sales")):
        t = DatasetTable(dataset_id=ds.id, datasource_id=src.id, source_kind="physical_table",
                         source_table_name=table, display_name=name, query_mode="live")
        db.add(t)
        db.flush()
        v = SemanticView(name=f"fp_{name}_{tag}", sql_table_name=table, dataset_table_id=t.id,
                         dimensions=[{"name": "region", "type": "string", "sql": "${TABLE}.region"},
                                     {"name": "order_date", "type": "date", "sql": "${TABLE}.order_date"}],
                         measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"}])
        db.add(v)
        db.flush()
        e = SemanticExplore(name=f"fp_x_{name}_{tag}", model_id=model.id, base_view_id=v.id,
                            base_view_name=v.name, joins=[])
        db.add(e)
        db.flush()
        views[name], explores[name] = v, e
    db.commit()
    try:
        yield dict(db=db, owner=owner, stranger=stranger, ds=ds, views=views, explores=explores)
    finally:
        db.rollback()
        with conn.cursor() as c:
            c.execute(f"DROP DATABASE IF EXISTS {DB}")
            c.execute("DROP USER IF EXISTS 'gqs_fp_reader'@'%'")
        conn.close()


def _service(w, who, registry=None):
    from app.models.user import User
    from app.services.governed_query import AuthorizationContext, EffectivePrincipal, GovernedQueryService
    from app.services.governed_query.ledger import PostgresLedger

    user = w["db"].get(User, w[who].id)
    p = EffectivePrincipal.for_user(user, surface="analyst")
    ledger = PostgresLedger(sa.create_engine(os.environ["AUTHZ_PG_APP_URL"]), worker_id="fp-mysql")
    return GovernedQueryService(AuthorizationContext(db=w["db"], principal=p, user=user), audit=ledger,
                                cancel_registry=registry), p


def _req(w, p, name="sales", dims=("region",), bounds=None):
    from app.services.governed_query import GovernedQueryRequest, RelationRef, SemanticAsk

    v = w["views"][name].name
    return GovernedQueryRequest(principal=p, relation=RelationRef(kind="semantic_explore", id=w["explores"][name].id),
                                ask=SemanticAsk(dimensions=tuple(f"{v}.{d}" for d in dims), measures=(f"{v}.revenue",)),
                                requested_bounds=bounds)


def _ledger_row(qid):
    with sa.create_engine(os.environ["AUTHZ_PG_OWNER_URL"]).connect() as c:
        return c.execute(sa.text("SELECT status, dialect, bounds FROM governed_query_executions WHERE query_id = :q"),
                         {"q": qid}).mappings().first()


def test_a_governed_answer_over_mysql_equals_the_oracle(mysql_world):
    gqs, p = _service(mysql_world, "owner")
    res = gqs.execute(_req(mysql_world, p))
    oracle = {}
    for _id, region, amount, _d in ROWS:
        oracle[region] = oracle.get(region, 0.0) + amount
    v = mysql_world["views"]["sales"].name
    got = {r[f"{v}_region"]: float(r[f"{v}_revenue"]) for r in res.rows}
    assert got == oracle
    row = _ledger_row(res.evidence.query_id)
    assert row["status"] == "ok" and row["dialect"] == "mysql"


def test_the_row_bound_is_enforced_on_mysql(mysql_world):
    from app.services.governed_query import QueryBounds

    gqs, p = _service(mysql_world, "owner")
    res = gqs.execute(_req(mysql_world, p, dims=("region", "order_date"),
                           bounds=QueryBounds(max_rows=5, timeout_seconds=30, bq_max_bytes=1)))
    assert len(res.rows) == 5 and res.truncated is True


def test_a_cancel_through_gqs_stops_the_mysql_statement(mysql_world):
    from app.services.governed_query import CancelRegistry, GovernedRefusal

    registry = CancelRegistry()
    gqs, p = _service(mysql_world, "owner", registry=registry)
    box = {}

    def run():
        t0 = time.time()
        try:
            box["res"] = gqs.execute(_req(mysql_world, p, name="slow"))
        except GovernedRefusal as exc:
            box["err"] = exc
        box["elapsed"] = time.time() - t0

    th = threading.Thread(target=run, daemon=True)
    th.start()
    deadline = time.time() + 20
    qid = None
    while qid is None and time.time() < deadline:
        ids = registry.running_ids()
        qid = next(iter(ids)) if ids else None
        time.sleep(0.05)
    assert qid, "the MySQL statement never registered its canceller"
    time.sleep(0.5)
    assert registry.cancel(qid) is True
    th.join(timeout=30)
    assert not th.is_alive() and "res" not in box and box["err"].code == "cancelled"
    assert box["elapsed"] < 8, f"ran {box['elapsed']:.1f}s; the 12s statement was not stopped at MySQL"
    assert _ledger_row(qid)["status"] == "cancelled"


def test_without_explore_mysql_is_never_touched(mysql_world, monkeypatch):
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.governed_query import GovernedRefusal

    touched = []
    monkeypatch.setattr(DataSourceConnectionService, "execute_query", lambda *a, **k: touched.append(1))
    gqs, p = _service(mysql_world, "stranger")
    with pytest.raises(GovernedRefusal) as exc:
        gqs.execute(_req(mysql_world, p))
    assert exc.value.code == "not_authorized" and not touched


def test_a_date_range_on_mysql_includes_from_and_excludes_to(mysql_world):
    """The governed `date_range` on a real MySQL DATE column: [2026-03-01,
    2026-05-15) holds the 03-15 and 04-15 rows and NOT the 05-15 one."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.services.governed_query import GovernedQueryRequest, RelationRef, SemanticAsk

    view = mysql_world["views"]["sales"]
    view.dimensions = [{**d, "source_type": "date"} if d["name"] == "order_date" else d for d in view.dimensions]
    flag_modified(view, "dimensions")
    mysql_world["db"].commit()
    gqs, p = _service(mysql_world, "owner")
    v = view.name
    res = gqs.execute(GovernedQueryRequest(
        principal=p, relation=RelationRef(kind="semantic_explore", id=mysql_world["explores"]["sales"].id),
        ask=SemanticAsk(dimensions=(f"{v}.region",), measures=(f"{v}.revenue",), filters={
            f"{v}.order_date": {"operator": "date_range", "value": {"from": "2026-03-01", "to": "2026-05-15"}}})))
    oracle = {}
    for _id, region, amount, d in ROWS:
        if "2026-03-01" <= d < "2026-05-15":
            oracle[region] = oracle.get(region, 0.0) + amount
    got = {r[f"{v}_region"]: float(r[f"{v}_revenue"]) for r in res.rows}
    assert got == oracle and sum(oracle.values()) > 0
