"""Semantic health (SEM-P1-006): the model's assumptions checked on the data.

Locks:
  * a many-to-one relationship whose one-side key has duplicates FAILS, is
    BLOCKING, and makes the publish gate refuse (that is the silent fan-out:
    every total joined through it grows);
  * the check runs on the TRANSFORMED relation the engine reads, derived from
    the model — nobody authors it;
  * a check that cannot run is `unknown`, never `pass`, and never blocks;
  * source quality, semantic health and snapshot health are separate layers;
  * snapshot/live row mismatch is reported on the snapshot layer.

Metadata on in-memory SQLite; the "warehouse" is a second SQLite connection the
datasource execution is routed to.
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
from app.models.dataset import Dataset, DatasetTable, DatasetTableSnapshot
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
        SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    with Session(engine) as s:
        s.add(DataSource(id=1, name="wh", type="postgresql", config={}))
        s.add(Dataset(id=1, name="Sales"))
        s.add(DatasetTable(id=11, dataset_id=1, datasource_id=1, display_name="orders", source_table_name="orders"))
        s.add(DatasetTable(id=12, dataset_id=1, datasource_id=1, display_name="customers",
                           source_table_name="customers"))
        s.add(SemanticView(id=101, name="orders", dataset_table_id=11, sql_table_name="orders",
                           dimensions=[{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                                       {"name": "customer_id", "type": "number", "sql": "${TABLE}.customer_id"}],
                           measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"}]))
        s.add(SemanticView(id=102, name="customers", dataset_table_id=12, sql_table_name="customers",
                           dimensions=[{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                                       {"name": "region", "type": "string", "sql": "${TABLE}.region"}],
                           measures=[]))
        s.add(SemanticModel(id=1, name="m", dataset_id=1))
        s.add(SemanticExplore(id=1, name="orders", model_id=1, base_view_id=101, base_view_name="orders",
                              joins=[{"name": "customers", "view": "customers", "type": "left", "sql_on": "",
                                      "from_column": "customer_id", "to_column": "id",
                                      "relationship": "many_to_one", "cardinality": "many_to_one"}]))
        s.commit()
        yield s


def _checks(result, layer):
    return result["layers"][layer]["checks"]


def test_a_unique_one_side_key_passes_and_the_layers_stay_separate(db, warehouse):
    from app.services import semantic_health_service as h

    r = h.evaluate(db, 1)
    assert set(r["layers"]) == {"source_quality", "semantic_health", "snapshot_health"}
    assert r["layers"]["source_quality"]["system_of_record"] == "dataset_quality_service"
    keys = [c for c in _checks(r, "semantic_health") if c["kind"] == "key_unique"]
    assert [(c["subject"], c["status"]) for c in keys] == [("customers(id)", "pass")]
    assert r["blocking"] == [] and h.publish_blockers(db, 1) == []
    assert r["layers"]["snapshot_health"]["status"] == "not_published"


def test_uniqueness_decay_on_the_one_side_fails_blocks_and_stops_publishing(db, warehouse):
    from app.services import dataset_publish_service, semantic_health_service as h

    warehouse.execute("INSERT INTO customers VALUES (1, 'N-dup')")  # customer 1 twice
    r = h.evaluate(db, 1)
    (check,) = [c for c in _checks(r, "semantic_health") if c["kind"] == "key_unique"]
    assert check["status"] == "fail" and check["blocking"] and check["evidence"]["duplicate_keys"] == 1
    assert r["blocking"] and "customers(id)" in r["blocking"][0]["subject"]

    # The publish gate refuses (after its own coverage checks, stubbed here).
    import app.services.snapshot_service as snap
    snap_ok = lambda *_a, **_k: ({11: "x", 12: "y"}, {}, None)  # noqa: E731
    orig = snap.resolve_specific_generation_refs
    snap.resolve_specific_generation_refs = snap_ok
    try:
        ok, reason = dataset_publish_service._validate_generation(db, 1, generation=7)
    finally:
        snap.resolve_specific_generation_refs = orig
    assert ok is False and "Semantic health" in reason and "customers" in reason


def test_the_check_reads_the_transformed_relation_not_the_raw_table(db, warehouse):
    """A transformation that removes the duplicate makes the key unique again —
    the check follows what the engine FROMs."""
    from app.services import semantic_health_service as h

    warehouse.execute("INSERT INTO customers VALUES (1, 'N-dup')")
    seen = []
    import app.services.semantic_health_service as mod
    real = mod._relation_for_table

    def _spy(db_, table):
        out = real(db_, table)
        seen.append(out[2] if out else None)
        return out

    mod._relation_for_table = _spy
    try:
        h.uniqueness_checks(db, 1)
    finally:
        mod._relation_for_table = real
    from app.services.dataset_relation_service import resolve_dataset_table_relation

    assert seen and seen[0] == resolve_dataset_table_relation(db.get(DataSource, 1), db.get(DatasetTable, 12)).sql


def test_a_check_that_cannot_run_is_unknown_and_does_not_block(db, monkeypatch):
    from app.services import semantic_health_service as h
    from app.services.datasource_service import DataSourceConnectionService

    def _boom(*_a, **_k):
        raise RuntimeError("warehouse unavailable")

    monkeypatch.setattr(DataSourceConnectionService, "execute_query", staticmethod(_boom))
    (check,) = [c for c in h.uniqueness_checks(db, 1)]
    assert check.status == "unknown" and not check.blocking and "warehouse unavailable" in check.detail
    assert h.publish_blockers(db, 1) == []


def test_dangling_references_are_reported_on_the_semantic_layer(db, warehouse):
    from app.services import semantic_health_service as h

    t = db.get(DatasetTable, 11)
    t.columns_cache = [{"name": "id"}, {"name": "customer_id"}]  # `amount` is gone
    db.commit()
    dang = [c for c in _checks(h.evaluate(db, 1), "semantic_health") if c["kind"] == "dangling_reference"]
    assert [(c["subject"], c["evidence"]["column"], c["blocking"]) for c in dang] == [("orders.revenue", "amount", False)]


def test_snapshot_row_mismatch_is_reported_on_the_snapshot_layer(db, warehouse):
    from app.services import semantic_health_service as h

    ds = db.get(Dataset, 1)
    ds.published_generation = 5
    db.add(DatasetTableSnapshot(dataset_id=1, dataset_table_id=11, version=1, physical_ref="p.s.t11",
                                fingerprint="f", row_count=2, status="ready", generation=5,
                                built_at=dt.datetime(2026, 9, 1)))
    db.commit()
    snap = h.evaluate(db, 1)["layers"]["snapshot_health"]
    assert snap["status"] == "fail"
    (c,) = snap["checks"]
    assert c["evidence"]["snapshot_rows"] == 2 and c["evidence"]["live_rows"] == 3
