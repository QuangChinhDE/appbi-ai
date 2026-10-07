"""A restarting worker never fails another worker's live refresh run.

``reap_stuck_syncs`` correctly skipped a dataset whose sync progress was still
moving, then called ``reconcile_stuck_runs(force=True)``, which ignored liveness:
it freed every publish lease and flipped every ``running`` run to ``failed`` —
including the one another worker was executing. The lazy (non-forced) path had
the same hole once a long sync outlived its lease TTL. Liveness now decides.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetRefreshRun


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetRefreshRun.__table__])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="live", publish_state="syncing", published_generation=5))
        s.add(Dataset(id=2, name="dead", publish_state="syncing", published_generation=5))
        s.add(DatasetRefreshRun(id=1, dataset_id=1, status="running", trigger="manual"))
        s.add(DatasetRefreshRun(id=2, dataset_id=2, status="running", trigger="manual"))
        s.commit()
        yield s


@pytest.mark.parametrize("force", [True, False])
def test_only_the_dead_run_is_reconciled(db, monkeypatch, force):
    from app.services import dataset_publish_service as pub

    released = []
    monkeypatch.setattr(pub, "_sync_looks_alive", lambda ds_id, now=None: ds_id == 1)
    monkeypatch.setattr(pub._qc, "is_claimed_global", lambda _k: False)  # lease lapsed / restart
    monkeypatch.setattr(pub._qc, "release_global", released.append)
    assert pub.reconcile_stuck_runs(db, force=force) == 1
    assert db.get(DatasetRefreshRun, 1).status == "running"
    assert db.get(Dataset, 1).publish_state == "syncing"
    assert db.get(DatasetRefreshRun, 2).status == "failed"
    assert pub._lease_key(1) not in released
