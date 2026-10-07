"""A rejected candidate generation is never resumed.

Resume exists for an INTERRUPTED Sync (Stop / crash): the tables already built
in that generation are kept, the rest are built. ``_resumable_generation`` told
the two apart only by age and design fingerprint, so a candidate that was built
in full and then REFUSED by the publish gate (e.g. duplicated one-side keys)
was "resumed" by the next Sync & Publish: the repaired source was never read
again, the same bad snapshots were re-validated, and the retry failed forever
inside the resume window — or, worse, passed against data the user had fixed.

Evidence of a terminal verdict already exists: the refresh run that produced
the generation finished ``failed`` (or ``success``). Only a generation no
terminal run claims is a resume target; a ``stopped`` run stays resumable.
"""
from __future__ import annotations

import time

import pytest

from tests.test_publish_candidate_generation import (  # noqa: F401 — fixtures
    _build, db, warehouse,
)
from app.models.dataset import Dataset, DatasetRefreshRun, DatasetTable
from app.models.models import DataSource


@pytest.fixture()
def resumable(db, monkeypatch):
    from app.services import snapshot_service as ss

    monkeypatch.setattr(ss, "current_fingerprint_for_table", lambda *_a, **_k: "f")

    def _probe():
        ds = db.get(Dataset, 1)
        tables = db.query(DatasetTable).filter_by(dataset_id=1).all()
        by_id = {d.id: d for d in db.query(DataSource).all()}
        return ss._resumable_generation(db, 1, ds, tables, by_id, by_id[9])
    return _probe


def _run(db, gen, status):
    db.add(DatasetRefreshRun(dataset_id=1, status=status, trigger="manual", generation=gen))
    db.commit()


def test_a_generation_refused_by_the_publish_gate_is_not_resumed(db, warehouse, resumable):
    gen = int(time.time() * 1000)
    _build(db, warehouse, gen, customers_rows=[(1, "N"), (1, "dup"), (2, "S")])
    _run(db, gen, "failed")
    assert resumable() is None, "a terminal rejected candidate must be rebuilt from the source"


def test_a_stopped_generation_is_still_resumed(db, warehouse, resumable):
    gen = int(time.time() * 1000)
    import datetime as dt

    for d in db.query(DataSource).all():  # sources last edited BEFORE the build read them
        d.updated_at = dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc)
    _build(db, warehouse, gen, customers_rows=[(1, "N"), (2, "S")])  # built_at 2026-10-01
    _run(db, gen, "stopped")
    assert resumable() == gen


def test_end_to_end_retry_after_the_source_is_repaired_publishes_the_fix(db, warehouse, monkeypatch, resumable):
    """bad source → candidate refused → source repaired → retry reads the source again."""
    from app.services import dataset_publish_service as pub, snapshot_service

    bad = int(time.time() * 1000)

    def refresh_bad(_db, _id, force=False):
        _build(_db, warehouse, bad, customers_rows=[(1, "N"), (1, "dup"), (2, "S")])
        return {"generation": bad, "built": [11, 12], "skipped": []}

    monkeypatch.setattr(snapshot_service, "refresh_all_for_dataset", refresh_bad)
    assert pub._sync_and_publish_blocking(db, 1)["ok"] is False
    assert resumable() is None  # the retry will not reuse `bad`

    good = bad + 1

    def refresh_good(_db, _id, force=False):
        _build(_db, warehouse, good, customers_rows=[(1, "N"), (2, "S")])
        return {"generation": good, "built": [11, 12], "skipped": []}

    monkeypatch.setattr(snapshot_service, "refresh_all_for_dataset", refresh_good)
    assert pub._sync_and_publish_blocking(db, 1)["ok"] is True
    assert db.get(Dataset, 1).published_generation == good


def test_a_generation_read_before_the_source_was_repointed_is_not_resumed(db, warehouse, resumable):
    """Same datasource id re-pointed (Source A → Source B) after a Stop: the
    tables already read came from A and must be read again from B."""
    import datetime as dt

    gen = int(time.time() * 1000)
    _build(db, warehouse, gen, customers_rows=[(1, "N"), (2, "S")])  # built_at 2026-10-01
    _run(db, gen, "stopped")
    db.get(DataSource, 2).updated_at = dt.datetime(2026, 10, 2, tzinfo=dt.timezone.utc)
    db.commit()
    assert resumable() is None


def test_a_build_error_before_any_snapshot_row_reaches_the_refresh_history(db, warehouse, monkeypatch):
    """A6 — the table failed while resolving its SQL (no snapshot row yet): the
    run must record that table and its reason, not the generic message."""
    from app.services import dataset_publish_service as pub, snapshot_service

    gen = int(time.time() * 1000)

    def refresh_partial(_db, _id, force=False):
        return {"generation": gen, "built": [], "skipped": [11, 12],
                "errors": {12: "column \"regionn\" does not exist"}}

    monkeypatch.setattr(snapshot_service, "refresh_all_for_dataset", refresh_partial)
    out = pub._sync_and_publish_blocking(db, 1)
    run = db.query(DatasetRefreshRun).order_by(DatasetRefreshRun.id.desc()).first()
    assert out["ok"] is False and run.status == "failed"
    assert 'customers: column "regionn" does not exist' in run.error
