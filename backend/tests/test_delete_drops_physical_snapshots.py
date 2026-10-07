"""Deleting a dataset or a table drops its BigQuery snapshot tables.

The snapshot rows cascade away with a deleted dataset / table, and they were the
only record of where the physical BigQuery tables live — so every delete left
its snapshots as permanent, billed orphans (GC only ever visits datasets that
still exist and refresh). The refs are collected before the delete and dropped
(best effort, after the delete committed).
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
def env(monkeypatch):
    from app.services import snapshot_service as ss

    dropped = []
    monkeypatch.setattr(ss.DataSourceConnectionService, "drop_bigquery_table",
                        staticmethod(lambda cfg, ref: dropped.append((cfg.get("project_id"), ref))))

    class _Now:  # run the background drop inline
        def __init__(self, target, **_k):
            self.target = target

        def start(self):
            self.target()

    monkeypatch.setattr(ss.threading, "Thread", _Now)
    engine = create_engine("sqlite://", future=True)
    import app.models  # noqa: F401 — every mapped table, so the ORM delete cascade can load its collections
    Base.metadata.create_all(engine, tables=[t for n, t in Base.metadata.tables.items()
                                             if n.startswith("dataset") or n == "data_sources"])
    with Session(engine) as s:
        s.add(DataSource(id=9, name="host", type="bigquery", config={"project_id": "sandbox"}))
        s.add(Dataset(id=1, name="d"))
        for tid in (11, 12):
            s.add(DatasetTable(id=tid, dataset_id=1, datasource_id=9, display_name=f"t{tid}",
                               source_table_name=f"t{tid}", source_kind="physical_table"))
            for gen in (1, 2):
                s.add(DatasetTableSnapshot(dataset_id=1, dataset_table_id=tid, version=gen,
                                           physical_ref=f"sandbox.snap.t{tid}_g{gen}", fingerprint="f",
                                           status="ready", is_current=gen == 2, generation=gen,
                                           host_datasource_id=9, built_at=dt.datetime(2026, 10, 1)))
        s.commit()
        yield s, dropped


def test_deleting_a_table_drops_only_its_snapshots(env):
    from app.services.dataset_crud import DatasetCRUDService

    db, dropped = env
    assert DatasetCRUDService.delete_table(db, 11)
    assert sorted(dropped) == [("sandbox", "sandbox.snap.t11_g1"), ("sandbox", "sandbox.snap.t11_g2")]
    assert db.query(DatasetTableSnapshot).filter_by(dataset_table_id=12).count() == 2


def test_deleting_a_dataset_drops_all_its_snapshots(env):
    from app.services.dataset_crud import DatasetCRUDService

    db, dropped = env
    assert DatasetCRUDService.delete_dataset(db, 1)
    assert len(dropped) == 4 and {r for _p, r in dropped} == {
        "sandbox.snap.t11_g1", "sandbox.snap.t11_g2", "sandbox.snap.t12_g1", "sandbox.snap.t12_g2"}


def test_a_delete_that_does_not_happen_drops_nothing(env):
    from app.services.dataset_crud import DatasetCRUDService

    db, dropped = env
    assert DatasetCRUDService.delete_dataset(db, 999) is False
    assert dropped == []
