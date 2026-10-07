"""Every snapshot build path writes the refresh-run ledger.

Only Sync & Publish recorded a run. A legacy (non-lifecycle) manual Refresh, a
background TTL warm and a source-change rebuild called refresh_all_for_dataset
directly: a failure there was a log line, never in Refresh history.
``refresh_with_history`` records them all with the real terminal status and error.
"""
from __future__ import annotations

import inspect

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetRefreshRun, DatasetTable


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, DatasetRefreshRun.__table__])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="legacy"))
        s.commit()
        yield s


@pytest.mark.parametrize("result,status,error", [
    ({"built": [{"table_id": 11, "row_count": 3, "build_ms": 5}], "generation": 7}, "success", None),
    ({"built": [], "stopped": True, "generation": 7}, "stopped", None),
    ({"built": [], "generation": 7, "errors": {11: 'column "b" does not exist'}}, "failed", 'column "b" does not exist'),
])
def test_a_background_build_leaves_a_run_with_its_outcome(db, monkeypatch, result, status, error):
    from app.services import snapshot_service as ss

    monkeypatch.setattr(ss, "refresh_all_for_dataset", lambda *_a, **_k: dict(result))
    ss.refresh_with_history(db, 1, "ttl")
    run = db.query(DatasetRefreshRun).one()
    assert (run.trigger, run.status) == ("ttl", status)
    assert (error is None and not run.error) or error in run.error


def test_a_crashing_build_is_recorded_then_raised(db, monkeypatch):
    from app.services import snapshot_service as ss

    def boom(*_a, **_k):
        raise RuntimeError("host unreachable")

    monkeypatch.setattr(ss, "refresh_all_for_dataset", boom)
    with pytest.raises(RuntimeError):
        ss.refresh_with_history(db, 1, "source_change")
    run = db.query(DatasetRefreshRun).one()
    assert (run.status, run.error) == ("failed", "host unreachable")


@pytest.mark.parametrize("fn", ["trigger_async_refresh", "schedule_source_change_check", "start_manual_refresh"])
def test_no_build_path_bypasses_the_ledger(fn):
    from app.services import snapshot_service as ss

    src = inspect.getsource(getattr(ss, fn))
    assert "refresh_all_for_dataset(" not in src, f"{fn} builds without recording a run"
