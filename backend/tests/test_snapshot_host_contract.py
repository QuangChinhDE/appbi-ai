"""A dataset with no BigQuery source never materializes into a stranger's project.

``_default_snapshot_host`` fell back to the lowest-id materialization-enabled
BigQuery datasource in the WHOLE system: user A's Sheets-only dataset was
CTAS'd into user B's project with B's credential. A shared host is now only the
one declared as platform infrastructure (``MATERIALIZATION_HOST_DATASOURCE_ID``);
otherwise only the dataset owner's own BigQuery datasource may host. A host
already recorded on live snapshots keeps winning (published data never moves).
"""
from __future__ import annotations

import datetime as dt
import uuid

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


ALICE, BOB = uuid.uuid4(), uuid.uuid4()
BQ = {"materialization_enabled": True, "project_id": "p"}


@pytest.fixture()
def db(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "MATERIALIZATION_HOST_DATASOURCE_ID", None, raising=False)
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__,
                                             DataSource.__table__, DatasetTableSnapshot.__table__])
    with Session(engine) as s:
        s.add(DataSource(id=1, name="bob-bq", type="bigquery", config=BQ, owner_id=BOB))      # lowest id, Bob's
        s.add(DataSource(id=5, name="alice-sheet", type="google_sheets", config={}, owner_id=ALICE))
        s.add(Dataset(id=1, name="alice-ds", owner_id=ALICE))
        s.add(DatasetTable(id=11, dataset_id=1, datasource_id=5, display_name="t",
                           source_table_name="t", source_kind="physical_table"))
        s.commit()
        yield s


def _host(db):
    from app.services.snapshot_service import resolve_host
    h = resolve_host(db, 1)
    return h.id if h else None


def test_another_users_bigquery_is_never_picked(db):
    assert _host(db) is None


def test_the_owners_own_bigquery_hosts(db):
    db.add(DataSource(id=7, name="alice-bq", type="bigquery", config=BQ, owner_id=ALICE))
    db.commit()
    assert _host(db) == 7


def test_a_declared_platform_host_is_shared(db, monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "MATERIALIZATION_HOST_DATASOURCE_ID", 1, raising=False)
    assert _host(db) == 1


def test_a_recorded_host_keeps_serving_what_it_built(db):
    db.add(DatasetTableSnapshot(dataset_id=1, dataset_table_id=11, version=1, physical_ref="x", fingerprint="f",
                                status="ready", is_current=True, generation=1, host_datasource_id=1,
                                built_at=dt.datetime(2026, 10, 1)))
    db.commit()
    assert _host(db) == 1


def test_a_pure_composition_child_executes_on_its_parents_host(db):
    """D6 — a child whose only tables reference a parent dataset has no
    datasource of its own; resolve_host returned None, so it published but none
    of its charts could be read ("Chart requires a datasource-backed table")."""
    from app.services.snapshot_service import resolve_host

    db.add(DataSource(id=7, name="alice-bq", type="bigquery", config=BQ, owner_id=ALICE))
    db.add(Dataset(id=2, name="child", owner_id=ALICE))
    db.add(DatasetTable(id=21, dataset_id=2, datasource_id=None, display_name="orders",
                        source_kind="dataset", parent_dataset_id=1))
    db.commit()
    assert resolve_host(db, 1).id == 7          # the parent's own host…
    assert resolve_host(db, 2).id == 7          # …is where the child executes
