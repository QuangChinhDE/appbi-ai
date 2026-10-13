"""A semantic-view save that quotes the version it read cannot silently replace a
newer edit (finding F4, docs/features/mcp-integration-layer/spec.md §13).

`PUT /datasets/{id}/model/views/{vid}` replaces the whole measure list. Two writers
— the Visual Model editor and the MCP integration, or two editors — that read the
same view and both save lost the first save without any error. The view now has
the same optimistic-concurrency contract as an explore's joins: an optional
`expected_view_version`; a stale one is a 409 and nothing is written.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.semantic import SemanticModel, SemanticView, view_version_of


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


DIMS = [{"name": "amount", "type": "number", "sql": "amount"}, {"name": "status", "type": "string", "sql": "status"}]


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", future=True)
    import app.models  # noqa: F401
    Base.metadata.create_all(engine, tables=[t for n, t in Base.metadata.tables.items()
                                             if n.startswith(("dataset", "semantic"))])
    import app.api.datasets as api
    monkeypatch.setattr(api, "require_edit_access", lambda *a, **k: None)
    with Session(engine) as s:
        s.add(Dataset(id=1, name="sales"))
        s.add(DatasetTable(id=11, dataset_id=1, display_name="orders", source_kind="physical_table", source_table_name="orders"))
        s.add(SemanticModel(id=1, name="m", dataset_id=1))
        s.add(SemanticView(id=1, name="dataset_table_11", dataset_table_id=11, sql_table_name="orders", dimensions=DIMS, measures=[]))
        s.commit()
        yield s


def _put(db, body):
    from app.api.datasets import update_dataset_view

    return update_dataset_view(dataset_id=1, view_id=1, update_data=dict(body), force=False, db=db, current_user=object())


def _measure(name, col="amount", typ="sum"):
    return {"name": name, "type": typ, "sql": col}


def test_stale_version_is_refused_and_the_newer_edit_survives(db):
    read_by_writer_a = view_version_of(DIMS, [], None)
    # Writer B saves first (e.g. the user in the Visual Model editor).
    b = _put(db, {"dimensions": DIMS, "measures": [_measure("revenue")]})
    assert b["view_version"] != read_by_writer_a
    # Writer A saves from its stale read: refused, nothing written.
    with pytest.raises(HTTPException) as err:
        _put(db, {"dimensions": DIMS, "measures": [_measure("orders", "order_id", "count")], "expected_view_version": read_by_writer_a})
    assert err.value.status_code == 409 and err.value.detail["code"] == "view_stale"
    assert err.value.detail["view_version"] == b["view_version"]
    db.expire_all()
    assert [m["name"] for m in db.get(SemanticView, 1).measures] == ["revenue"]


def test_current_version_writes_and_returns_the_next_version(db):
    v0 = view_version_of(DIMS, [], None)
    res = _put(db, {"dimensions": DIMS, "measures": [_measure("revenue")], "expected_view_version": v0})
    assert [m["name"] for m in res["measures"]] == ["revenue"]
    stored = db.get(SemanticView, 1)
    assert res["view_version"] == view_version_of(stored.dimensions, stored.measures, stored.description)


def test_without_a_version_the_previous_behaviour_is_unchanged(db):
    _put(db, {"dimensions": DIMS, "measures": [_measure("revenue")]})
    res = _put(db, {"dimensions": DIMS, "measures": [_measure("revenue"), _measure("units", "amount", "count")]})
    assert [m["name"] for m in res["measures"]] == ["revenue", "units"]


def test_model_read_exposes_the_version_a_writer_must_quote(db):
    from app.services.dataset_model_service import get_dataset_model

    model = get_dataset_model(db, 1)
    view = next(v for v in model["views"] if v["id"] == 1)
    assert view["view_version"] == view_version_of(DIMS, [], None)


def test_a_foreign_view_is_refused_before_any_version_is_revealed(db):
    """Review finding: a view of ANOTHER dataset must answer 403, never 409 with its version."""
    db.add(Dataset(id=2, name="other"))
    db.add(DatasetTable(id=22, dataset_id=2, display_name="secret", source_kind="physical_table", source_table_name="s"))
    db.add(SemanticView(id=2, name="dataset_table_22", dataset_table_id=22, sql_table_name="s", dimensions=DIMS, measures=[]))
    db.commit()
    from app.api.datasets import update_dataset_view

    with pytest.raises(HTTPException) as err:
        update_dataset_view(dataset_id=1, view_id=2, update_data={"measures": [], "expected_view_version": "wrong"},
                            force=False, db=db, current_user=object())
    assert err.value.status_code == 403
    assert "view_version" not in str(err.value.detail)


def test_an_empty_version_means_no_version(db):
    res = _put(db, {"dimensions": DIMS, "measures": [_measure("revenue")], "expected_view_version": ""})
    assert [m["name"] for m in res["measures"]] == ["revenue"]
