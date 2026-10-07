"""A composed dataset's raw-row routes enforce View on every parent.

A Dataset-on-Dataset table's rows ARE the parent's rows. Charts check
``require_view_lineage`` (View on the child AND on every parent), but table
preview / execute / export / distinct values / column summary / profile checked
only the child — a user with View on child C and nothing on parent P read P's
published rows through C. Each route now applies the same lineage check before
it reads anything.
"""
from __future__ import annotations

import inspect
import uuid
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetDependency, DatasetGrant, DatasetTable

ROUTES = ["preview_dataset_table", "execute_dataset_table_query", "export_dataset_table_excel",
          "get_dataset_model_distinct_values", "get_column_summary_endpoint", "get_table_profile"]
USER = uuid.uuid4()


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def db(monkeypatch):
    import app.core.permissions as perms

    monkeypatch.setattr(perms, "get_user_module_permission", lambda _u, _m: "view")
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, DatasetGrant.__table__,
                                             DatasetDependency.__table__])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="parent"))
        s.add(Dataset(id=2, name="child"))
        s.add(DatasetTable(id=21, dataset_id=2, datasource_id=None, display_name="orders",
                           source_kind="dataset", parent_dataset_id=1))
        s.add(DatasetGrant(dataset_id=2, user_id=USER, verb="view"))  # View on the child only
        s.commit()
        yield s


def test_view_on_the_child_alone_does_not_reach_the_parents_rows(db):
    from app.services.dataset_grants_service import require_view_lineage

    with pytest.raises(HTTPException) as e:
        require_view_lineage(db, SimpleNamespace(id=USER, permissions={}), 2)
    assert e.value.status_code == 403
    db.add(DatasetGrant(dataset_id=1, user_id=USER, verb="view"))
    db.commit()
    require_view_lineage(db, SimpleNamespace(id=USER, permissions={}), 2)  # now allowed


@pytest.mark.parametrize("route", ROUTES)
def test_every_raw_row_route_checks_lineage_before_reading(route):
    from app.api import datasets

    src = inspect.getsource(getattr(datasets, route))
    gate = src.find("require_view_lineage(db, current_user, dataset_id)")
    assert gate != -1, f"{route} reads composed rows without the lineage check"
    first_read = min(i for i in (src.find("get_table_by_id("), src.find("execute_query("),
                                 src.find("_execute_semantic"), src.find("DatasetTable"),
                                 src.find("SemanticView"), src.find("get_distinct_field_values(")) if i != -1)
    assert gate < first_read, route
