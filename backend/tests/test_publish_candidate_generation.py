"""Publish validates the artifact it is about to make visible.

Sync & Publish builds candidate generation N, validates it, and only then pins
it (``Dataset.published_generation``). The relationship-key gate used to read
the LIVE source instead of N — so a candidate built from duplicated data (or a
resumed candidate reused after the source was repaired) published as healthy
and every dashboard on it was then refused by the runtime key guard, while a
source that decayed after a clean build blocked nothing it should.

Now the one-side keys are checked on generation N's snapshot tables, on their
host, and every health result says WHAT it checked (``live_source`` /
``candidate_generation`` / ``published_generation`` + the generation id).

  A  candidate duplicated, live repaired      → publish refused, gen stays
  B  candidate unique, live later duplicated  → published snapshot stays valid
  C  failed candidate                          → previous generation stays pinned
  D  mixed sources into one host               → every snapshot judged on the host

The warehouse is a sqlite3 connection standing in for the snapshot host; the
build itself (BigQuery-only) is stubbed to register snapshot rows, exactly as
``snapshot_service.refresh_all_for_dataset`` does.
"""
from __future__ import annotations

import datetime as dt
import sqlite3

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetRefreshRun, DatasetTable, DatasetTableSnapshot
from app.models.models import DataSource
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


@pytest.fixture()
def warehouse(monkeypatch):
    con = sqlite3.connect(":memory:")
    con.executescript(
        # the LIVE source
        "CREATE TABLE orders(id int, customer_id int, amount int);"
        "INSERT INTO orders VALUES (1,1,10),(2,1,20),(3,2,30);"
        "CREATE TABLE customers(id int, region text);"
        "INSERT INTO customers VALUES (1,'N'),(2,'S');"
    )
    from app.services.datasource_service import DataSourceConnectionService

    def _exec(_type, _config, sql, **_kw):
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description]
        return cols, [dict(zip(cols, r)) for r in cur.fetchall()], 0

    monkeypatch.setattr(DataSourceConnectionService, "execute_query", staticmethod(_exec))
    return con


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[
        Dataset.__table__, DatasetTable.__table__, DataSource.__table__, DatasetTableSnapshot.__table__,
        DatasetRefreshRun.__table__, SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    with Session(engine) as s:
        s.add(DataSource(id=1, name="src", type="postgresql", config={}))
        s.add(DataSource(id=2, name="src2", type="postgresql", config={}))
        s.add(DataSource(id=9, name="host", type="postgresql", config={}))  # snapshot host
        s.add(Dataset(id=1, name="Sales", publish_state="published", published_generation=1))
        s.add(DatasetTable(id=11, dataset_id=1, datasource_id=1, display_name="orders", source_table_name="orders",
                           source_kind="physical_table"))
        s.add(DatasetTable(id=12, dataset_id=1, datasource_id=2, display_name="customers",
                           source_table_name="customers", source_kind="physical_table"))
        s.add(SemanticView(id=101, name="orders", dataset_table_id=11, sql_table_name="orders",
                           dimensions=[{"name": "customer_id", "type": "number", "sql": "${TABLE}.customer_id"}],
                           measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"}]))
        s.add(SemanticView(id=102, name="customers", dataset_table_id=12, sql_table_name="customers",
                           dimensions=[{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                                       {"name": "region", "type": "string", "sql": "${TABLE}.region"}],
                           measures=[]))
        s.add(SemanticModel(id=1, name="m", dataset_id=1))
        s.add(SemanticExplore(id=1, name="orders", model_id=1, base_view_id=101, base_view_name="orders",
                              joins=[{"name": "customers", "view": "customers", "type": "left",
                                      "sql_on": "${TABLE}.customer_id = ${customers}.id",
                                      "from_column": "customer_id", "to_column": "id",
                                      "relationship": "many_to_one", "cardinality": "many_to_one"}]))
        s.commit()
        yield s


def _build(db, warehouse, generation, *, customers_rows):
    """Register generation N's snapshot tables (what the BigQuery build does)."""
    warehouse.execute(f"CREATE TABLE snap_orders_g{generation} AS SELECT * FROM orders")
    warehouse.execute(f"CREATE TABLE snap_customers_g{generation}(id int, region text)")
    warehouse.executemany(f"INSERT INTO snap_customers_g{generation} VALUES (?, ?)", customers_rows)
    for tid, name in ((11, "orders"), (12, "customers")):
        db.add(DatasetTableSnapshot(
            dataset_id=1, dataset_table_id=tid, version=generation, physical_ref=f"snap_{name}_g{generation}",
            fingerprint="f", row_count=0, status="ready", is_current=True, generation=generation,
            host_datasource_id=9, built_at=dt.datetime(2026, 10, 1),
        ))
    db.commit()


def _publish(db, monkeypatch, warehouse, generation, customers_rows):
    from app.services import dataset_publish_service as pub, snapshot_service

    def fake_refresh(_db, _dataset_id, force=False):
        _build(_db, warehouse, generation, customers_rows=customers_rows)
        return {"generation": generation, "built": [11, 12], "skipped": []}

    monkeypatch.setattr(snapshot_service, "refresh_all_for_dataset", fake_refresh)
    return pub._sync_and_publish_blocking(db, 1)


def test_a_candidate_built_from_duplicated_data_does_not_publish_when_the_live_source_is_clean(
        db, warehouse, monkeypatch):
    """Case A — candidate gen 2 has customer 1 twice; the live source is clean
    (repaired after the build). The old gate read the live source and passed."""
    from app.services import semantic_health_service as h

    out = _publish(db, monkeypatch, warehouse, 2, [(1, "N"), (1, "N-dup"), (2, "S")])
    assert out["ok"] is False and "Semantic health" in out["error"], out
    assert db.get(Dataset, 1).published_generation == 1, "the previous generation stays pinned (case C)"
    assert h.publish_blockers(db, 1) == [], "the LIVE check alone passes — the old gate's blind spot"
    (check,) = [c for c in h.uniqueness_checks(db, 1, include_primary_keys=False, generation=2)]
    assert (check.status, check.evidence["checked"], check.evidence["generation"], check.evidence["relation"]) == (
        "fail", "candidate_generation", 2, "snap_customers_g2")


def test_a_clean_candidate_publishes_and_stays_valid_when_the_live_source_decays(db, warehouse, monkeypatch):
    """Case B — candidate gen 3 is clean and publishes; the live source then gains
    a duplicate. The published snapshot still satisfies its relationships: the
    published-generation check passes, the runtime probe on the snapshot table
    passes, while the live source would be refused."""
    from app.services import semantic_health_service as h
    from app.services.relationship_key_guard import key_probe_sql, verify_key_probes

    out = _publish(db, monkeypatch, warehouse, 3, [(1, "N"), (2, "S")])
    assert out["ok"] is True and db.get(Dataset, 1).published_generation == 3, out
    warehouse.execute("INSERT INTO customers VALUES (1, 'N-dup')")  # the LIVE source decays
    snap_checks = [c for c in h.evaluate(db, 1)["layers"]["snapshot_health"]["checks"] if c["kind"] == "key_unique"]
    assert [(c["status"], c["evidence"]["checked"], c["evidence"]["generation"]) for c in snap_checks] == [
        ("pass", "published_generation", 3)]
    live_checks = [c for c in h.evaluate(db, 1)["layers"]["semantic_health"]["checks"] if c["kind"] == "key_unique"]
    assert [(c["status"], c["evidence"]["checked"]) for c in live_checks] == [("fail", "live_source")]
    verify_key_probes([{"sql": key_probe_sql("snap_customers_g3", ["id"]), "label": "orders → customers",
                        "view": "customers", "columns": ["id"], "immutable": True}],
                      ds_type="postgresql", config={})  # the published artifact: unique
    with pytest.raises(ValueError, match="bị lặp"):
        verify_key_probes([{"sql": key_probe_sql("customers", ["id"]), "label": "orders → customers",
                            "view": "customers", "columns": ["id"]}], ds_type="postgresql", config={})


def test_a_failed_candidate_keeps_the_previously_published_generation(db, warehouse, monkeypatch):
    """Case C — gen 4 is good and published; gen 5 is duplicated and refused:
    readers keep gen 4."""
    assert _publish(db, monkeypatch, warehouse, 4, [(1, "N"), (2, "S")])["ok"] is True
    out = _publish(db, monkeypatch, warehouse, 5, [(1, "N"), (1, "again"), (2, "S")])
    ds = db.get(Dataset, 1)
    assert out["ok"] is False and ds.published_generation == 4 and ds.publish_state == "sync_failed"


def test_mixed_source_tables_are_judged_on_the_host_that_serves_them(db, warehouse, monkeypatch):
    """Case D — orders and customers come from two different sources and are
    materialized into ONE host: the key is checked on the host's snapshot
    table (``relation`` names it), never on either source."""
    from app.services import semantic_health_service as h

    _build(db, warehouse, 6, customers_rows=[(1, "N"), (1, "dup"), (2, "S")])
    (check,) = h.uniqueness_checks(db, 1, include_primary_keys=False, generation=6)
    assert check.status == "fail" and check.evidence["relation"] == "snap_customers_g6"
    assert db.get(DatasetTable, 12).datasource_id == 2  # its own source differs from the host (9)


def test_a_candidate_table_without_a_snapshot_is_unknown_never_a_live_pass(db, warehouse, monkeypatch):
    """Review #7: a candidate generation that has no snapshot for the one-side
    table fell back to the LIVE source and reported its verdict as the
    candidate's. It is `unknown` now, naming no relation it did not read."""
    from app.services import semantic_health_service as h

    _build(db, warehouse, 7, customers_rows=[(1, "N"), (2, "S")])
    db.query(DatasetTableSnapshot).filter_by(generation=7, dataset_table_id=12).delete()
    db.commit()
    (check,) = h.uniqueness_checks(db, 1, include_primary_keys=False, generation=7)
    assert (check.status, check.evidence["checked"], check.evidence["relation"]) == (
        "unknown", "candidate_generation", None), check
