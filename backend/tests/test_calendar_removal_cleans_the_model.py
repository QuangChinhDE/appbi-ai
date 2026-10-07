"""Removing the Calendar removes what the model built on it — nothing else.

Disabling the Calendar deleted only its DatasetTable. Its SemanticView (FK SET
NULL), the per-date role views (``<view>__<column>__date_dim``) and the calendar
auto-joins stayed in the model until a regenerate, so fields of a calendar that
no longer exists kept appearing in pickers. Another dataset's role views and the
author's own joins are untouched.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.services.dataset_calendar_service import CALENDAR_SOURCE_KIND


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    import app.models  # noqa: F401 — the ORM delete cascade loads related collections
    Base.metadata.create_all(engine, tables=[t for n, t in Base.metadata.tables.items()
                                             if n.startswith(("dataset", "semantic"))])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="sales"))
        s.add(DatasetTable(id=11, dataset_id=1, display_name="orders", source_kind="physical_table",
                           source_table_name="orders"))
        s.add(DatasetTable(id=12, dataset_id=1, display_name="Calendar", source_kind=CALENDAR_SOURCE_KIND))
        s.add(SemanticView(id=1, name="dataset_table_11", dataset_table_id=11, sql_table_name="orders"))
        s.add(SemanticView(id=2, name="dataset_table_12", dataset_table_id=12, sql_table_name="cal"))
        s.add(SemanticView(id=3, name="dataset_table_11__order_date__date_dim", sql_table_name="cal"))
        s.add(SemanticView(id=4, name="dataset_table_99__x__date_dim", sql_table_name="cal"))  # another dataset
        s.add(SemanticModel(id=1, name="m", dataset_id=1))
        s.add(SemanticExplore(id=1, name="orders", model_id=1, base_view_id=1, base_view_name="dataset_table_11",
                              joins=[{"name": "dataset_table_11__order_date__date_dim",
                                      "view": "dataset_table_11__order_date__date_dim",
                                      "calendar_role": "dataset_table_11__order_date__date_dim",
                                      "presentation_view": "dataset_table_12"},
                                     {"name": "customers", "view": "customers", "relationship": "many_to_one"}]))
        s.commit()
        yield s


def test_removing_the_calendar_cleans_its_views_and_joins_only(db):
    from app.services.dataset_calendar_service import remove_calendar_table

    assert remove_calendar_table(db, 1) is True
    db.commit()
    names = {v.name for v in db.query(SemanticView).all()}
    assert names == {"dataset_table_11", "dataset_table_99__x__date_dim"}
    assert [j["name"] for j in db.get(SemanticExplore, 1).joins] == ["customers"]
    assert db.get(DatasetTable, 12) is None and db.get(DatasetTable, 11) is not None
