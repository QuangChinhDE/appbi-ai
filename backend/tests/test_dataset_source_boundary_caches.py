"""Dataset-side state keyed by a datasource id follows that source's CONFIG.

* BigQuery location: ``_location_cache`` was keyed by id only and never evicted,
  so re-pointing a datasource at another project/location kept CTAS-ing into the
  OLD location until a backend restart (on every worker).
* Auto type detection: the enqueue read ``DatasetTable.datasource`` — a
  relationship the model does not define — so Google Sheets / Manual tables were
  never queued for the full-scan type check they were designed for.
"""
from __future__ import annotations

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


def test_location_is_re_resolved_when_the_same_datasource_is_re_pointed(monkeypatch):
    from app.services import snapshot_service as ss

    monkeypatch.setattr(ss, "_location_cache", {})
    monkeypatch.setattr(ss.DataSourceConnectionService, "get_bigquery_location",
                        staticmethod(lambda cfg: {"proj-us": "US", "proj-eu": "EU"}[cfg["project_id"]]))
    src = SimpleNamespace(id=7, config={"project_id": "proj-us"})
    assert ss._source_location(src) == "US"
    src.config = {"project_id": "proj-eu"}  # same id, new connection
    assert ss._source_location(src) == "EU"


@pytest.mark.parametrize("kind,queued", [("google_sheets", True), ("manual", True), ("postgresql", False)])
def test_sheets_and_manual_tables_are_queued_for_full_type_detection(kind, queued):
    from app.api.datasets import _enqueue_auto_type_detection_if_needed

    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, DataSource.__table__])
    with Session(engine) as s:
        s.add(DataSource(id=1, name="src", type=kind, config={}))
        s.add(Dataset(id=1, name="d"))
        s.add(DatasetTable(id=11, dataset_id=1, datasource_id=1, display_name="t",
                           source_table_name="t", source_kind="physical_table"))
        s.commit()
        tasks = []
        _enqueue_auto_type_detection_if_needed(SimpleNamespace(add_task=lambda *a: tasks.append(a)),
                                               s.get(DatasetTable, 11))
        assert bool(tasks) is queued
