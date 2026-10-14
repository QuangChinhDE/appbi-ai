"""Snapshot GC never runs without its protections.

GC keeps the PUBLISHED generation and every generation a child dataset has
PINNED. Both lookups were wrapped in ``except: pass``: if either failed, GC went
on without that protection and could drop the generation Dashboards (or a
composed child) were reading. A protection that cannot be read now aborts the
pass — nothing retired, nothing dropped.
"""
from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable, DatasetTableSnapshot
from app.models.models import DataSource


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def db(monkeypatch):
    from app.services import snapshot_service as ss

    monkeypatch.setattr(ss, "_notify_snapshot_gc_failed", lambda *a, **k: None)
    monkeypatch.setattr(ss, "is_federated_materializable", lambda _t: True)
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, DataSource.__table__,
                                             DatasetTableSnapshot.__table__])
    with Session(engine) as s:
        s.add(DataSource(id=9, name="host", type="bigquery", config={}))
        s.add(Dataset(id=1, name="d", published_generation=1))
        s.add(DatasetTable(id=11, dataset_id=1, datasource_id=9, display_name="t", source_table_name="t",
                           source_kind="physical_table"))
        old = dt.datetime(2026, 1, 1)
        for gen in (1, 2, 3, 4):  # gen 1 is PUBLISHED and older than the retained window
            s.add(DatasetTableSnapshot(dataset_id=1, dataset_table_id=11, version=gen, physical_ref=f"snap_g{gen}",
                                       fingerprint="f", status="ready", is_current=gen == 4, generation=gen,
                                       host_datasource_id=9, built_at=old, created_at=old))
        s.commit()
        yield s


def test_a_failed_pin_lookup_aborts_gc(db, monkeypatch):
    from app.services import dataset_composition_service as comp, snapshot_service as ss

    dropped = []
    monkeypatch.setattr(ss.DataSourceConnectionService, "drop_bigquery_table",
                        staticmethod(lambda _cfg, ref: dropped.append(ref)))

    def boom(*_a, **_k):
        raise RuntimeError("dependencies table unreadable")

    monkeypatch.setattr(comp, "pinned_parent_generations", boom)
    assert ss.gc_dataset_snapshots(db, 1, db.get(DataSource, 9)) == 0
    assert dropped == []
    assert db.query(DatasetTableSnapshot).filter(DatasetTableSnapshot.retired_at.isnot(None)).count() == 0


def test_with_its_protections_gc_keeps_the_published_generation(db, monkeypatch):
    from app.services import dataset_composition_service as comp, snapshot_service as ss

    dropped = []
    monkeypatch.setattr(ss.DataSourceConnectionService, "drop_bigquery_table",
                        staticmethod(lambda _cfg, ref: dropped.append(ref)))
    monkeypatch.setattr(comp, "pinned_parent_generations", lambda *_a, **_k: [])
    ss.gc_dataset_snapshots(db, 1, db.get(DataSource, 9))
    assert "snap_g1" not in dropped                      # published: kept
