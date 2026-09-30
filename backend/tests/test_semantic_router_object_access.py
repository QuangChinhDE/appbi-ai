"""The direct semantic API gates every object on the dataset it belongs to.

WHY THIS FILE EXISTS (SEM-P1-004)
---------------------------------
`routers/semantic.py` checked only the MODULE level (`datasets: view/edit/full`).
Any user of the Datasets module could list every dataset's models, read any view's
measures, rewrite any dataset's joins, delete any explore, and run
`POST /semantic/query` — which returns warehouse rows — against a dataset nobody
shared with them. The dataset-scoped endpoints in `api/datasets.py` ask the
object-level question (`require_*_access` on the Dataset); this router did not.

Each semantic object has exactly one owning dataset (model.dataset_id,
view -> dataset_table -> dataset, explore -> model -> dataset). An object with no
dataset (legacy rows) has no owner to ask, so only `datasets: full` may touch it.

The route functions are called directly on an in-memory SQLite schema. The
permission helpers are NOT stubbed — they are what is under test; only the share
lookup is replaced so each test states the share it means.
"""
from __future__ import annotations

import types
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.routers import semantic as api
from app.schemas.semantic import (
    SemanticExploreUpdate,
    SemanticModelUpdate,
    SemanticQueryRequest,
    SemanticViewUpdate,
)


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


OWNER = uuid.UUID("11111111-1111-1111-1111-111111111111")
STRANGER = uuid.UUID("22222222-2222-2222-2222-222222222222")


def _user(uid: uuid.UUID, level: str = "edit"):
    return types.SimpleNamespace(id=uid, email=f"{str(uid)[:8]}@appbi.io", permissions={"datasets": level})


class _Share:
    def __init__(self, level: str):
        self.permission = types.SimpleNamespace(value=level)


@pytest.fixture()
def shares(monkeypatch):
    """{user_id: level} — who the dataset was shared with, and how far."""
    granted: dict = {}

    def _lookup(_db, user, _rt, _rid):
        level = granted.get(user.id)
        return _Share(level) if level else None

    monkeypatch.setattr("app.core.dependencies.get_highest_share_for_resource", _lookup)
    return granted


def _view(vid, name, table_id, dims):
    return SemanticView(
        id=vid, name=name, dataset_table_id=table_id, sql_table_name=name,
        dimensions=[{"name": d, "type": "number" if d.endswith("id") else "string", "sql": d} for d in dims],
        measures=[],
    )


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    from app.models.models import Chart

    Base.metadata.create_all(engine, tables=[
        Dataset.__table__, DatasetTable.__table__, Chart.__table__,
        SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    with Session(engine) as s:
        # Dataset 1 (owned by OWNER): orders -> customers.
        s.add(Dataset(id=1, name="Sales", owner_id=OWNER))
        s.add(DatasetTable(id=11, dataset_id=1, display_name="orders", source_table_name="orders"))
        s.add(DatasetTable(id=12, dataset_id=1, display_name="customers", source_table_name="customers"))
        s.add(_view(101, "orders", 11, ["id", "customer_id", "status"]))
        s.add(_view(102, "customers", 12, ["id", "region"]))
        s.add(SemanticModel(id=1, name="sales_model", dataset_id=1))
        s.add(SemanticExplore(
            id=1, name="orders", model_id=1, base_view_id=101, base_view_name="orders",
            joins=[{"name": "customers", "view": "customers", "type": "left", "sql_on": "",
                    "from_column": "customer_id", "to_column": "id",
                    "relationship": "many_to_one", "cardinality": "many_to_one"}],
        ))
        # Dataset 2 (owned by STRANGER): a view that must not be joinable from 1.
        s.add(Dataset(id=2, name="HR", owner_id=STRANGER))
        s.add(DatasetTable(id=21, dataset_id=2, display_name="salaries", source_table_name="salaries"))
        s.add(_view(201, "salaries", 21, ["id", "amount"]))
        # A legacy view with no dataset at all.
        s.add(SemanticView(id=301, name="legacy", sql_table_name="legacy", dimensions=[], measures=[]))
        s.commit()
        yield s


def _status(fn, *a, **k):
    try:
        fn(*a, **k)
    except HTTPException as exc:
        return exc.status_code
    return 200


# ── denied ─────────────────────────────────────────────────────────────────


def test_a_stranger_cannot_read_or_list_another_datasets_objects(db, shares):
    user = _user(STRANGER, "edit")
    assert _status(api.get_view, 101, db, user) == 403
    assert _status(api.get_model, 1, db, user) == 403
    assert _status(api.get_explore, 1, db, user) == 403
    assert _status(api.get_explore_by_name, "orders", db, user) == 404
    assert {v.name for v in api.list_views(0, 100, db, user)} == {"salaries"}
    assert [m.id for m in api.list_models(0, 100, db, user)] == []
    assert [e.id for e in api.list_explores(0, 100, db, user)] == []


def test_a_stranger_cannot_write_or_delete_another_datasets_objects(db, shares):
    user = _user(STRANGER, "edit")
    assert _status(api.update_view, 101, SemanticViewUpdate(description="x"), db, user) == 403
    assert _status(api.update_model, 1, SemanticModelUpdate(description="x"), db, user) == 403
    assert _status(api.update_explore, 1, SemanticExploreUpdate(description="x"), db, user) == 403
    assert _status(api.delete_explore, 1, db, user) == 403
    assert _status(api.delete_view, 101, db, user) == 403
    assert _status(api.delete_model, 1, db, user) == 403
    assert db.query(SemanticExplore).filter_by(id=1).count() == 1


def test_a_stranger_cannot_query_another_datasets_explore(db, shares):
    """The query returns warehouse rows: an unreadable explore does not exist."""
    req = SemanticQueryRequest(explore="orders", dimensions=["orders.status"], measures=[])
    assert _status(api.execute_semantic_query, req, db, _user(STRANGER, "edit")) == 404


def test_a_view_share_reads_but_does_not_write(db, shares):
    shares[STRANGER] = "view"
    user = _user(STRANGER, "edit")
    assert _status(api.get_view, 101, db, user) == 200
    assert _status(api.get_explore, 1, db, user) == 200
    assert _status(api.update_view, 101, SemanticViewUpdate(description="x"), db, user) == 403
    assert _status(api.update_explore, 1, SemanticExploreUpdate(description="x"), db, user) == 403


def test_module_view_caps_an_owner_to_read_only(db, shares):
    owner = _user(OWNER, "view")
    assert _status(api.get_view, 101, db, owner) == 200
    assert _status(api.update_view, 101, SemanticViewUpdate(description="x"), db, owner) == 403


def test_an_object_without_a_dataset_needs_module_full(db, shares):
    assert _status(api.get_view, 301, db, _user(STRANGER, "edit")) == 403
    assert _status(api.get_view, 301, db, _user(STRANGER, "full")) == 200


# ── allowed, and the writes are validated ───────────────────────────────────


def test_the_owner_reads_lists_and_edits(db, shares):
    owner = _user(OWNER, "edit")
    assert _status(api.get_view, 101, db, owner) == 200
    assert {v.name for v in api.list_views(0, 100, db, owner)} == {"orders", "customers"}
    assert [e.id for e in api.list_explores(0, 100, db, owner)] == [1]
    assert api.get_explore_by_name("orders", db, owner).id == 1
    api.update_view(101, SemanticViewUpdate(description="orders fact"), db, owner)
    assert db.get(SemanticView, 101).description == "orders fact"


def _join(**over):
    j = {"name": "customers", "view": "customers", "type": "left", "sql_on": "",
         "from_column": "customer_id", "to_column": "id", "relationship": "many_to_one"}
    j.update(over)
    return j


def test_explore_joins_are_validated_like_add_join(db, shares):
    owner = _user(OWNER, "edit")
    upd = lambda **o: SemanticExploreUpdate(joins=[_join(**o)])  # noqa: E731

    # A view of ANOTHER dataset cannot be joined in.
    assert _status(api.update_explore, 1, upd(name="s", view="salaries", to_column="id"), db, owner) == 400
    # A column that does not exist.
    assert _status(api.update_explore, 1, upd(from_column="nope"), db, owner) == 400
    # No cardinality at all is refused — it is not defaulted to many-to-one.
    assert _status(api.update_explore, 1, upd(relationship=None), db, owner) == 400
    # Contradictory cardinality / relationship.
    assert _status(api.update_explore, 1, upd(cardinality="one_to_many"), db, owner) == 400

    # A valid join is stored with ONE canonical cardinality on both keys.
    api.update_explore(1, upd(), db, owner)
    stored = db.get(SemanticExplore, 1).joins[0]
    assert stored["cardinality"] == stored["relationship"] == "many_to_one"


def test_objects_cannot_be_moved_to_another_dataset(db, shares):
    owner = _user(OWNER, "edit")
    assert _status(api.update_model, 1, SemanticModelUpdate(dataset_id=2), db, owner) == 400
    assert _status(api.update_view, 101, SemanticViewUpdate(dataset_table_id=21), db, owner) == 400
    assert _status(api.update_explore, 1, SemanticExploreUpdate(base_view_id=201), db, owner) == 400


# ── context modifiers are not an authoring surface any more ─────────────────


def _measure(**over):
    from app.schemas.semantic import MeasureDefinition

    base = {"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"}
    base.update(over)
    return MeasureDefinition(**base)


def test_a_new_context_modifier_is_refused_on_save_but_a_legacy_one_can_stay_or_go(db, shares):
    owner = _user(OWNER, "edit")
    # adding one: refused (the engine would refuse every chart on it)
    assert _status(api.update_view, 101, SemanticViewUpdate(
        measures=[_measure(context_modifiers=[{"type": "all"}])]), db, owner) == 400

    # a legacy measure that already has one (written before this rule)
    v = db.get(SemanticView, 101)
    v.measures = [{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount",
                   "context_modifiers": [{"type": "all"}]}]
    db.commit()
    # saving it UNCHANGED (editing another field) is allowed …
    assert _status(api.update_view, 101, SemanticViewUpdate(
        measures=[_measure(label="Revenue", context_modifiers=[{"type": "all"}])]), db, owner) == 200
    # … changing it is not …
    assert _status(api.update_view, 101, SemanticViewUpdate(
        measures=[_measure(context_modifiers=[{"type": "all_except", "keep_fields": ["status"]}])]),
        db, owner) == 400
    # … and removing it is.
    assert _status(api.update_view, 101, SemanticViewUpdate(measures=[_measure()]), db, owner) == 200
    assert not (db.get(SemanticView, 101).measures[0].get("context_modifiers") or [])


# ── SEM-P1-002 / P1-003: the relationship write path is strict ──────────────


def test_add_model_join_is_strict_and_persists_the_primary_key_before_the_join(db, shares):
    import json

    from app.api import datasets as dapi

    owner = _user(OWNER, "edit")
    base = {"from_view_id": 101, "to_view_id": 102, "from_column": "customer_id", "to_column": "id"}
    for bad in ({"cardinality": "garbage"}, {"relationship": "sideways"}, {"is_active": "maybe"},
                {"force": "yes"}, {"cross_filter": "diagonal"}, {"primary_key_on_to_view": "id"}):
        with pytest.raises(HTTPException) as exc:
            dapi.add_model_join(1, {**base, **bad}, db, owner)
        assert exc.value.status_code == 400, bad  # used to default to many_to_one / True / single

    # A primary key naming a missing column is refused and the join is NOT
    # written half-way (the PK used to be applied after the join, its failure
    # swallowed into a warning).
    before = json.dumps(db.get(SemanticExplore, 1).joins, sort_keys=True)
    with pytest.raises(HTTPException):
        dapi.add_model_join(1, {**base, "primary_key_on_to_view": ["no_such_col"]}, db, owner)
    db.expire_all()
    assert json.dumps(db.get(SemanticExplore, 1).joins, sort_keys=True) == before

    dapi.add_model_join(1, {**base, "cardinality": "many_to_one", "is_active": "false",
                            "primary_key_on_to_view": ["id"]}, db, owner)
    db.expire_all()
    assert db.get(SemanticView, 102).primary_key == ["id"]
    (j,) = [j for j in db.get(SemanticExplore, 1).joins if j.get("view") == "customers"]
    assert j["is_active"] is False and j["cardinality"] == j["relationship"] == "many_to_one"
