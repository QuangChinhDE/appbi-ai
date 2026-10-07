"""A long Sync & Publish keeps its lease; a lapsed lease is never resurrected.

The publish lease (1h) was claimed once and never renewed. A sync running
longer let a second Sync & Publish claim the dataset and write alongside it,
and made the run-history reconcile read the live run as dead. The running sync
now renews the lease every few minutes (``renew_global``); renewal only extends
a lease that is still held, so a worker that lost it never steals it back.

Real cross-worker store (the sqlite shared store), short TTLs.
"""
from __future__ import annotations

import time

import pytest

from app.services import query_cache as qc


@pytest.fixture()
def store(tmp_path, monkeypatch):
    s = qc._SharedSqliteCache(tmp_path / "shared.sqlite", ttl_seconds=60, max_rows=100)
    monkeypatch.setattr(qc, "_get_shared_store", lambda: s)
    return s


def test_a_renewed_lease_outlives_its_ttl_and_blocks_a_second_writer(store):
    assert qc.try_claim_global("datasetpublish::7", 1.0)
    time.sleep(0.6)
    assert qc.renew_global("datasetpublish::7", 1.0)
    time.sleep(0.6)                                  # past the ORIGINAL expiry
    assert qc.try_claim_global("datasetpublish::7", 1.0) is False, "a second writer must not get in"


def test_without_renewal_the_lease_lapses(store):
    assert qc.try_claim_global("datasetpublish::8", 0.5)
    time.sleep(0.7)
    assert qc.try_claim_global("datasetpublish::8", 0.5) is True  # the dead job's lease freed itself


def test_a_lapsed_lease_is_never_resurrected_by_renewal(store):
    assert qc.try_claim_global("datasetpublish::9", 0.3)
    time.sleep(0.5)
    assert qc.renew_global("datasetpublish::9", 5.0) is False
    assert qc.try_claim_global("datasetpublish::9", 1.0) is True


def test_the_running_sync_heartbeats_its_lease(monkeypatch):
    """start_sync_and_publish renews while the body runs and stops after."""
    import threading

    from app.services import dataset_publish_service as pub

    renewed, release = [], threading.Event()
    monkeypatch.setattr(pub, "_PUBLISH_LEASE_RENEW_SECONDS", 0.05)
    monkeypatch.setattr(pub._qc, "try_claim_global", lambda *_a, **_k: True)
    monkeypatch.setattr(pub._qc, "is_claimed_global", lambda *_a, **_k: False)
    monkeypatch.setattr(pub._qc, "renew_global", lambda key, ttl: renewed.append(key) or True)
    monkeypatch.setattr(pub._qc, "release_global", lambda *_a: None)
    monkeypatch.setattr(pub, "_refresh_run_start", lambda *_a, **_k: 1)
    monkeypatch.setattr(pub, "_sync_and_publish_blocking", lambda *_a, **_k: release.wait(2))
    monkeypatch.setattr("app.core.database.SessionLocal", lambda: type("S", (), {"close": lambda self: None})())
    assert pub.start_sync_and_publish(42)["started"] is True
    time.sleep(0.4)
    release.set()
    assert renewed and set(renewed) == {"datasetpublish::42"}
    time.sleep(0.2)
    n = len(renewed)
    time.sleep(0.3)
    assert len(renewed) == n, "the heartbeat stops with the sync"


def test_a_sync_clicked_as_the_previous_one_finishes_is_not_refused(store, monkeypatch):
    """The previous sync wrote its terminal run, its thread has not released the
    lease yet: a new start waits for the hand-off instead of 'already_syncing'."""
    import threading

    from app.services import dataset_publish_service as pub

    class _NoRunning:
        def query(self, *_a):
            return self

        def filter(self, *_a):
            return self

        def first(self):
            return None  # history: nothing running any more

        def close(self):
            pass

    monkeypatch.setattr("app.core.database.SessionLocal", lambda: _NoRunning())
    assert qc.try_claim_global("datasetpublish::5", 30.0)          # the finishing sync still holds it
    threading.Timer(0.5, lambda: qc.release_global("datasetpublish::5")).start()
    assert pub._claim_publish_lease(5) is True


def test_a_genuinely_running_sync_still_refuses(store, monkeypatch):
    from app.services import dataset_publish_service as pub

    class _Running:
        def query(self, *_a):
            return self

        def filter(self, *_a):
            return self

        def first(self):
            return (1,)

        def close(self):
            pass

    monkeypatch.setattr("app.core.database.SessionLocal", lambda: _Running())
    assert qc.try_claim_global("datasetpublish::6", 30.0)
    assert pub._claim_publish_lease(6) is False
