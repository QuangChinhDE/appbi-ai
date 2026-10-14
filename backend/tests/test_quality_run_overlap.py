"""A manual quality run honours the same overlap guard as the scheduler, and a
run orphaned by a restart stops blocking new runs.

``POST /datasets/{id}/quality/runs`` called ``create_run`` directly: every click
(or a second user) started another full rule scan against the source. And a
queued/running row left by a restart was never finalized, so the scheduler's
``has_active_run`` skipped that dataset forever.
"""
from __future__ import annotations

import datetime as dt
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetQualityRun


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def db(monkeypatch):
    import app.api.datasets as api

    monkeypatch.setattr(api, "require_edit_access", lambda *a, **k: None)
    engine = create_engine("sqlite://", future=True)
    tables = [Dataset.__table__, DatasetQualityRun.__table__]
    sched = DatasetQualityRun.__table__.c.schedule_id.foreign_keys
    if sched:
        tables.insert(1, next(iter(sched)).column.table)
    Base.metadata.create_all(engine, tables=tables)
    with Session(engine) as s:
        s.add(Dataset(id=1, name="d"))
        s.commit()
        yield s


def _click(db):
    from app.api.datasets import trigger_quality_run
    tasks = []
    trigger_quality_run(1, SimpleNamespace(add_task=lambda *a: tasks.append(a)), db=db,
                        current_user=SimpleNamespace(id=uuid.uuid4()))
    return tasks


def test_a_second_click_does_not_start_a_second_scan(db):
    assert len(_click(db)) == 1
    with pytest.raises(HTTPException) as e:
        _click(db)
    assert e.value.status_code == 409
    assert db.query(DatasetQualityRun).count() == 1


def test_a_run_orphaned_by_a_restart_no_longer_blocks(db):
    db.add(DatasetQualityRun(dataset_id=1, status="running", trigger_source="schedule",
                             started_at=dt.datetime.utcnow() - dt.timedelta(hours=5)))
    db.commit()
    assert len(_click(db)) == 1
    statuses = sorted(r.status for r in db.query(DatasetQualityRun).all())
    assert statuses == ["failed", "queued"]
