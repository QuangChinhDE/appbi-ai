""""Refresh data" on a published dataset publishes, or says why it cannot.

Manual Refresh (dataset + dashboard), TTL and source-watermark rebuilds all
called ``refresh_all_for_dataset`` directly: they built a generation, never ran
the publish gate, never wrote a refresh-run row, and never moved
``published_generation`` — so a lifecycle-managed dataset reported "refreshed"
while every Dashboard kept serving the old generation (readers are pinned), and
the orphan build then became a "resume" target for the next Sync & Publish.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
from app.models.dataset import Dataset


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def env(monkeypatch):
    import app.core.database as dbmod
    from app.services import dataset_publish_service as pub, snapshot_service as ss

    engine = create_engine("sqlite://", future=True, poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=[Dataset.__table__])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="published", publish_state="published", published_generation=5,
                      published_design_fingerprint="fp-live"))
        s.add(Dataset(id=2, name="pending", publish_state="changes_pending", published_generation=5,
                      published_design_fingerprint="fp-old"))
        s.add(Dataset(id=3, name="legacy", publish_state=None))
        s.commit()
    monkeypatch.setattr(dbmod, "SessionLocal", sessionmaker(bind=engine))
    monkeypatch.setattr(pub, "design_fingerprint", lambda _db, _id, **_k: "fp-live")
    published, rebuilt = [], []
    monkeypatch.setattr(pub, "start_sync_and_publish",
                        lambda d, **k: published.append((d, k.get("trigger"))) or {"started": True})
    monkeypatch.setattr(ss, "refresh_all_for_dataset", lambda _db, d, **_k: rebuilt.append(d) or {})
    return ss, published, rebuilt, engine


def test_manual_refresh_of_a_published_dataset_runs_sync_and_publish(env):
    ss, published, _rebuilt, _e = env
    assert ss.route_lifecycle_refresh([1]) == {1: "started"}
    assert published == [(1, "manual_refresh")]


def test_manual_refresh_never_publishes_pending_design_changes(env):
    ss, published, _rebuilt, _e = env
    assert ss.route_lifecycle_refresh([2]) == {2: "changes_pending"}
    assert published == []


def test_a_legacy_dataset_keeps_the_plain_rebuild(env):
    ss, published, _rebuilt, _e = env
    assert ss.route_lifecycle_refresh([3]) == {}
    assert published == []


def test_background_rebuilds_skip_lifecycle_managed_datasets(env):
    ss, _published, _rebuilt, engine = env
    with Session(engine) as s:
        assert ss._is_lifecycle_managed(s, 1) is True
        assert ss._is_lifecycle_managed(s, 3) is False
