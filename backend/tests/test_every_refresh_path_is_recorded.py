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


def _fake_build(result):
    """A build that publishes per-table progress the way refresh_all_for_dataset does."""
    from app.services import sync_progress as sp

    def _build(_db, dataset_id, **_k):
        sp.begin(dataset_id, [{"table_id": 11, "name": "orders", "rows_total_est": 3}])
        sp.finish_table(dataset_id, 11, rows=3)
        if isinstance(result, Exception):
            raise result
        return dict(result)
    return _build


@pytest.mark.parametrize("result,phase", [
    ({"built": [{"table_id": 11, "row_count": 3, "build_ms": 5}], "generation": 7}, "done"),
    ({"built": [], "stopped": True, "generation": 7}, "stopped"),
    ({"built": [], "generation": 7, "errors": {11: "boom"}}, "failed"),
])
def test_a_background_build_never_leaves_the_dataset_looking_busy(db, monkeypatch, result, phase):
    """A TTL / source-change rebuild left the live progress at phase 'syncing' (all
    tables done, labelled 'manual') forever: the progress popup said "Syncing…" after
    the build had finished, and nothing in publish-status ever reported idle. The
    progress now ends with the run, under the run's own trigger."""
    from app.services import snapshot_service as ss
    from app.services import sync_progress as sp

    sp.clear(1)
    monkeypatch.setattr(ss, "refresh_all_for_dataset", _fake_build(result))
    ss.refresh_with_history(db, 1, "ttl")
    prog = sp.get(1)
    assert prog is not None and prog["phase"] == phase
    assert prog["trigger"] == "ttl"
    sp.clear(1)


def test_a_crashing_background_build_ends_its_progress_as_failed(db, monkeypatch):
    from app.services import snapshot_service as ss
    from app.services import sync_progress as sp

    sp.clear(1)
    monkeypatch.setattr(ss, "refresh_all_for_dataset", _fake_build(RuntimeError("host unreachable")))
    with pytest.raises(RuntimeError):
        ss.refresh_with_history(db, 1, "source_change")
    prog = sp.get(1)
    assert prog is not None and (prog["phase"], prog["trigger"]) == ("failed", "source_change")
    sp.clear(1)
