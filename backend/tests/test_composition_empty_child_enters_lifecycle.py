"""A new, empty dataset can reference a parent without a failing publish first.

Composition is a publish-lifecycle feature (the child pins the parent's
generation), so a LEGACY child (publish_state NULL) is refused — rightly for a
dataset already serving live tables. But a brand-new dataset is legacy too, and
the only way in was to press Sync & Publish on an empty dataset (which fails) and
then add the reference. An EMPTY dataset has no live reads to break: the first
parent reference now opts it in as a draft. A legacy dataset with live tables is
still refused.
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetDependency, DatasetTable
from app.models.models import DataSource


@compiles(UUID, "sqlite")
def _u(_t, _c, **_k):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _j(_t, _c, **_k):
    return "JSON"


@pytest.fixture()
def db(monkeypatch):
    from app.services import dataset_composition_service as comp

    monkeypatch.setattr(comp, "assert_composable", lambda *_a, **_k: None)  # host guards: not under test
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, DataSource.__table__,
                                             DatasetDependency.__table__])
    with Session(engine) as s:
        s.add(DataSource(id=1, name="pg", type="postgresql", config={}))
        s.add(Dataset(id=1, name="parent", publish_state="published", published_generation=5))
        s.add(DatasetTable(id=11, dataset_id=1, datasource_id=1, display_name="orders", source_table_name="orders",
                           source_kind="physical_table", columns_cache={"columns": [{"name": "id", "type": "integer"}]}))
        s.add(Dataset(id=2, name="new child"))
        s.add(Dataset(id=3, name="live legacy"))
        s.add(DatasetTable(id=31, dataset_id=3, datasource_id=1, display_name="t", source_table_name="t",
                           source_kind="physical_table"))
        s.commit()
        yield s


def test_an_empty_dataset_enters_the_lifecycle_on_its_first_parent_reference(db):
    from app.services.dataset_composition_service import add_parent_ref_table

    t = add_parent_ref_table(db, 2, 1, 11, "orders")
    assert t.parent_dataset_id == 1
    assert db.get(Dataset, 2).publish_state == "draft"


def test_a_legacy_dataset_with_live_tables_is_still_refused(db):
    from app.services.dataset_composition_service import add_parent_ref_table

    with pytest.raises(ValueError, match="vòng đời"):
        add_parent_ref_table(db, 3, 1, 11, "orders")
    assert db.get(Dataset, 3).publish_state is None
