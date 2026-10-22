"""Semantic model sync keeps what the owner authored on a dimension.

Regression (P1): `_upsert_semantic_view` replaced every view's dimensions with
the ones regenerated from columns_cache, so any model sync — Generate model,
a dataset edit, the background drift self-heal on a chart read — reset the
labels, descriptions, drill parents and declared types an owner had written.
Every consumer reads the same stored list (Dataset model UI, chart/dashboard
semantic runtime, the analyst catalog), so they all lost it at once.

Locked here, through the real sync entry points and the real write path:
  * an edited dimension survives sync (label, description, type, parent);
  * an unedited dimension still follows the source (issue #11 type refresh);
  * column visibility still follows the dataset table;
  * a dimension whose column is gone is dropped, edited or not;
  * drift detection converges: an authored type is not "drift" forever;
  * `user_edited` is decided by the server, never taken from the client.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.models import DataSource
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.schemas.semantic import DimensionDefinition
from app.services import dataset_model_service as dms


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


OWNER = uuid.UUID(int=1)
COLS = [
    {"name": "order_id", "type": "string", "source_type": "STRING"},
    {"name": "order_date", "type": "string", "source_type": "STRING"},  # a date stored as text (BigQuery)
    {"name": "category", "type": "string", "source_type": "STRING"},
    {"name": "revenue", "type": "number", "source_type": "NUMERIC"},
]


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[
        DataSource.__table__, Dataset.__table__, DatasetTable.__table__,
        SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    monkeypatch.setattr(dms, "lock_dataset_model_for_write", lambda *_a, **_k: None)
    with Session(engine) as s:
        s.add(Dataset(id=1, name="sales", owner_id=OWNER))
        s.add(DatasetTable(id=11, dataset_id=1, display_name="orders", source_table_name="orders",
                           columns_cache=[dict(c) for c in COLS]))
        s.commit()
        dms.sync_dataset_model_structure(s, 1, create_model=True)
        s.commit()
        yield s


def _view(db) -> SemanticView:
    db.expire_all()
    return db.query(SemanticView).filter(SemanticView.dataset_table_id == 11).one()


def _dims(db) -> dict:
    return {d["name"]: d for d in _view(db).dimensions}


def _author(db, **changes):
    """The owner edits dimensions through the same stamping the PUT routes use."""
    view = _view(db)
    incoming = []
    for d in view.dimensions:
        d = {**d, **changes.get(d["name"], {})}
        # exactly what the PUT routes store: re-dumped through the schema
        incoming.append(DimensionDefinition(**d).model_dump())
    view.dimensions = dms.stamp_authored_dimensions(incoming, view.dimensions)
    db.commit()


def _set_columns(db, cols):
    db.get(DatasetTable, 11).columns_cache = [dict(c) for c in cols]
    db.commit()


def _resync(db):
    dms.sync_dataset_model_structure(db, 1)
    db.commit()


def test_an_authored_dimension_survives_every_sync(db):
    _author(db, order_date={"type": "date", "label": "Ngày đặt"},
            category={"label": "Nhóm sản phẩm", "description": "Nhóm hàng", "parent": None})
    _resync(db)
    dms.generate_dataset_model(db, 1, force=True)  # the "Generate model" button
    db.commit()
    dims = _dims(db)
    assert dims["order_date"]["type"] == "date"
    assert dims["order_date"]["label"] == "Ngày đặt"
    assert dims["category"]["label"] == "Nhóm sản phẩm"
    assert dims["category"]["description"] == "Nhóm hàng"


def test_an_unedited_dimension_still_follows_the_source_type(db):
    _author(db, category={"label": "Nhóm"})
    _set_columns(db, [{**c, "type": "number"} if c["name"] == "order_id" else c for c in COLS])
    _resync(db)
    dims = _dims(db)
    assert dims["order_id"]["type"] == "number"  # issue #11 still holds
    assert dims["category"]["label"] == "Nhóm"


def test_a_dimension_whose_column_is_gone_is_dropped_even_if_edited(db):
    _author(db, category={"label": "Nhóm"})
    _set_columns(db, [c for c in COLS if c["name"] != "category"])
    _resync(db)
    assert "category" not in _dims(db)


def test_a_new_column_appears_after_sync(db):
    _author(db, category={"label": "Nhóm"})
    _set_columns(db, COLS + [{"name": "province", "type": "string"}])
    _resync(db)
    dims = _dims(db)
    assert "province" in dims and dims["category"]["label"] == "Nhóm"


def test_drift_converges_with_an_authored_type(db):
    _author(db, order_date={"type": "date"})
    assert dms._model_views_drifted(db, 1) is False
    _set_columns(db, COLS + [{"name": "province", "type": "string"}])
    assert dms._model_views_drifted(db, 1) is True
    _resync(db)
    assert dms._model_views_drifted(db, 1) is False
    assert _dims(db)["order_date"]["type"] == "date"


def test_visibility_follows_the_table_not_the_stored_dimension(db):
    stored = [{"name": "category", "type": "string", "sql": "category", "label": "Nhóm",
               "hidden": True, "user_edited": True}]
    generated = [{"name": "category", "type": "string", "sql": "category", "label": "Category",
                  "hidden": False}]
    merged = dms.merge_synced_dimensions(generated, stored)
    assert merged == [{**stored[0], "hidden": False}]


def test_user_edited_is_decided_by_the_server():
    stored = [{"name": "a", "type": "string", "label": "A"},
              {"name": "b", "type": "string", "label": "B", "user_edited": True}]
    # A client claiming user_edited on an unchanged dimension is ignored...
    out = dms.stamp_authored_dimensions(
        [{"name": "a", "type": "string", "label": "A", "user_edited": True},
         {"name": "b", "type": "string", "label": "B"}], stored)
    assert "user_edited" not in out[0]
    # ...a flag set earlier is kept when the client round-trips without it.
    assert out[1]["user_edited"] is True
    # Toggling visibility alone is not authoring the dimension.
    out = dms.stamp_authored_dimensions([{"name": "a", "type": "string", "label": "A", "hidden": True}], stored)
    assert "user_edited" not in out[0]


def test_a_schema_round_trip_is_not_an_edit():
    """The PUT route re-dumps every dimension through DimensionDefinition, which
    fills in defaults; that alone must not mark the whole view as authored
    (found on the real route: every dimension came back user_edited)."""
    from app.schemas.semantic import DimensionDefinition

    stored = [{"name": "store_id", "type": "string", "sql": "${TABLE}.store_id"}]
    dumped = [DimensionDefinition(**d).model_dump() for d in stored]
    assert "user_edited" not in dms.stamp_authored_dimensions(dumped, stored)[0]


# ── a declared DATE over a physically STRING column (PO: fail closed) ─────────

def _engine_over(dims, dialect):
    from types import SimpleNamespace

    from app.services.semantic_query_engine import SemanticQueryEngine

    engine = SemanticQueryEngine(db=None, database_type=dialect)  # type: ignore[arg-type]
    engine.views_cache = {"orders": SimpleNamespace(measures=[], dimensions=dims, table_name="orders", name="orders")}
    return engine


def test_a_declared_date_on_a_text_column_keeps_its_physical_type_through_put_and_sync(db):
    before = _dims(db)["order_date"].get("source_type")
    assert before, "the generator records the physical type"
    _author(db, order_date={"type": "date", "label": "Ngày đặt"})
    assert _dims(db)["order_date"]["source_type"] == before  # the PUT schema dropped it; carried over
    _resync(db)
    d = _dims(db)["order_date"]
    assert d["type"] == "date" and d["source_type"] == before and d.get("user_edited") is True


@pytest.mark.parametrize("grain", ["day", "week", "month", "quarter", "year"])
def test_bigquery_never_truncates_a_text_column_without_the_safe_conversion(db, grain):
    _author(db, order_date={"type": "date"})
    for moment in ("right after the edit", "after the next sync"):
        if moment == "after the next sync":
            _resync(db)
        sql = _engine_over(_view(db).dimensions, "bigquery")._render_dimension_with_time_grain(
            "orders.order_date", "orders", grain)
        inner = sql.split("TIMESTAMP_TRUNC(", 1)[1]
        assert "SAFE" in inner and not inner.startswith("orders.order_date"), (moment, sql)


def test_the_physical_type_follows_the_source_even_for_an_edited_dimension(db):
    _author(db, order_date={"type": "date"})
    _set_columns(db, [{**c, "type": "date", "source_type": "DATE"} if c["name"] == "order_date" else c for c in COLS])
    _resync(db)
    d = _dims(db)["order_date"]
    gen = {x["name"]: x for x in dms._classify_columns(db.get(DatasetTable, 11).columns_cache)[0]}["order_date"]
    assert d.get("source_type") == gen.get("source_type")


def test_legacy_unflagged_metadata_is_kept_but_its_type_follows_the_source():
    generated = [{"name": "c", "type": "string", "sql": "c", "label": "C", "source_type": "string"}]
    legacy = [{"name": "c", "type": "date", "sql": "c", "label": "Nhóm", "description": "do người viết"}]
    [m] = dms.merge_synced_dimensions(generated, legacy)
    assert m["label"] == "Nhóm" and m["description"] == "do người viết"
    assert m["type"] == "string" and m["source_type"] == "string" and "user_edited" not in m


def test_a_renamed_column_is_a_removed_and_a_new_column_without_a_mapping(db):
    """No evidence links an old column to a new name, so an edited dimension on the
    old name is not carried over to the new one (PO, Track C)."""
    _author(db, category={"label": "Nhóm"})
    _set_columns(db, [{**c, "name": "product_group"} if c["name"] == "category" else c for c in COLS])
    _resync(db)
    dims = _dims(db)
    assert "category" not in dims and "product_group" in dims
    assert dims["product_group"].get("label") != "Nhóm" and "user_edited" not in dims["product_group"]


def test_a_template_import_does_not_carry_user_edited_in(db):
    """`user_edited` is decided by the server on its write paths; a template file
    (exported, or written by hand) cannot set it."""
    from app.modules.workboards.services.template_service import _rebuild_semantic_from_bundle

    db.add(Dataset(id=2, name="imported", owner_id=OWNER))
    db.add(DatasetTable(id=21, dataset_id=2, display_name="o2", source_table_name="o2", columns_cache=[]))
    db.commit()
    bundle = {"views": [{"old_table_id": 11, "name": "o2", "measures": [], "dimensions": [
        {"name": "region", "type": "string", "sql": "region", "label": "Vùng", "user_edited": True}]}],
        "explores": [{"base_view_old_table_id": 11, "base_view_name": "o2", "joins": []}]}
    _rebuild_semantic_from_bundle(db, 2, {11: 21}, bundle)
    db.commit()
    view = db.query(SemanticView).filter(SemanticView.dataset_table_id == 21).one()
    assert view.dimensions == [{"name": "region", "type": "string", "sql": "region", "label": "Vùng"}]


def test_a_glossary_link_is_authoring_and_survives_sync():
    """PO 2026-10-22: the Analyst reads a dimension's governed vocabulary from its
    glossary-term link; a Generate/Sync must not drop the link the owner added."""
    stored = [{"name": "region", "type": "string", "label": "Vùng"}]
    link = [{"fqn": "sales.region", "label": "Vùng"}]
    out = dms.stamp_authored_dimensions([{"name": "region", "type": "string", "label": "Vùng",
                                          "glossary_terms": link}], stored)
    assert out[0]["user_edited"] is True
    merged = dms.merge_synced_dimensions([{"name": "region", "type": "string", "label": "region"}], out)
    assert merged[0]["glossary_terms"] == link and merged[0]["label"] == "Vùng"

