"""Source status never reports an unreachable or changed source as healthy.

`GET /datasets/{id}/tables/source-status` answered ``status: "ok"`` (code
SOURCE_STATUS_UNVERIFIED) when the source could not be reached, and the page only
reacts to ``missing`` — an unreachable source looked healthy. A source that gained
columns (``columns_cache.source_added_columns``, set by Sync's schema reconcile) was not
reported at all. Now: unreachable ⇒ ``unknown``; changed ⇒ SOURCE_SCHEMA_CHANGED;
and an editor's explicit schema refresh is the one preview that rewrites the cache.
"""
from __future__ import annotations

import inspect
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def db(monkeypatch):
    import app.api.datasets as api

    monkeypatch.setattr(api, "get_effective_permission", lambda *a, **k: "view")
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, DataSource.__table__])
    with Session(engine) as s:
        s.add(DataSource(id=1, name="pg", type="postgresql", config={}))
        s.add(Dataset(id=1, name="d"))
        s.add(DatasetTable(id=11, dataset_id=1, datasource_id=1, display_name="orders",
                           source_table_name="public.orders", source_kind="physical_table"))
        s.commit()
        yield s


def _status(db):
    from app.api.datasets import get_dataset_table_source_status
    out = get_dataset_table_source_status(1, db=db, current_user=SimpleNamespace(id=uuid.uuid4()))
    return out["tables"][0]


def test_an_unreachable_source_is_unknown_not_ok(db, monkeypatch):
    from app.api import datasets

    def boom(*_a, **_k):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(datasets.DataSourceConnectionService, "list_tables", staticmethod(boom))
    st = _status(db)
    assert (st["status"], st["code"]) == ("unknown", "SOURCE_STATUS_UNVERIFIED")


def test_a_source_with_new_columns_is_reported(db, monkeypatch):
    from app.api import datasets

    monkeypatch.setattr(datasets.DataSourceConnectionService, "list_tables",
                        staticmethod(lambda *_a, **_k: [{"name": "public.orders"}]))
    assert _status(db)["code"] is None
    t = db.get(DatasetTable, 11)
    t.schema_change_pending = True  # "AI description stale" — never a source-drift signal
    db.commit()
    assert _status(db)["code"] is None
    t.columns_cache = {"columns": [{"name": "id"}], "source_added_columns": ["channel"]}
    db.commit()
    st = _status(db)
    assert (st["code"], st["added_columns"]) == ("SOURCE_SCHEMA_CHANGED", ["channel"])


def test_only_an_editors_explicit_refresh_rewrites_the_schema():
    from app.api import datasets

    src = inspect.getsource(datasets.preview_dataset_table)
    assert 'refresh and perm not in ("edit", "full")' in src
