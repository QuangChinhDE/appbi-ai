"""The Analyst catalog offers every field the query engine can reach from an
explore's base — multi-hop, through the model's relationships — not only the
explore's own direct joins.

Holdout run (2026-10-21): an order-lines explore (order_lines -> orders ->
customers) did not list customers.region, so "doanh số theo vùng" was answered
"not in the data" although the engine answers it (checked against SQL)."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.core.database import Base
from app.models.dataset import Dataset, DatasetTable
from app.models.semantic import SemanticExplore, SemanticModel, SemanticView


@compiles(UUID, "sqlite")
def _uuid_on_sqlite(_type, _compiler, **_kw):
    return "CHAR(36)"


@compiles(JSONB, "sqlite")
def _jsonb_on_sqlite(_type, _compiler, **_kw):
    return "JSON"


def _join(src, dst, col):
    return {"name": dst, "view": dst, "from_view": src, "from_column": col, "to_column": col,
            "from_columns": [col], "to_columns": [col], "relationship": "many_to_one",
            "cardinality": "many_to_one", "type": "left", "is_active": True}


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__, SemanticView.__table__,
                                             SemanticModel.__table__, SemanticExplore.__table__])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="Commerce", owner_id=uuid.UUID(int=1)))
        s.add(Dataset(id=2, name="Other", owner_id=uuid.UUID(int=1)))
        for i, (name, ds) in enumerate([("lines", 1), ("orders", 1), ("customers", 1), ("customers_x", 2)], start=11):
            s.add(DatasetTable(id=i, dataset_id=ds, display_name=name, source_table_name=name))
            s.add(SemanticView(id=i, name=name, dataset_table_id=i, sql_table_name=name,
                               dimensions=[{"name": "k", "type": "string"}], measures=[]))
        s.add(SemanticModel(id=1, name="m", dataset_id=1))
        s.add(SemanticExplore(id=1, name="lines", model_id=1, base_view_id=11, base_view_name="lines",
                              joins=[_join("lines", "orders", "order_id")]))
        s.add(SemanticExplore(id=2, name="orders", model_id=1, base_view_id=12, base_view_name="orders",
                              joins=[_join("orders", "customers", "customer_id")]))
        s.commit()
        yield s


def test_a_view_two_hops_away_is_offered(db):
    from app.services.analyst.catalog import _joined_views

    names = {v.name for v in _joined_views(db, db.get(SemanticExplore, 1), [1])}
    assert names == {"orders", "customers"}


def test_reach_stays_inside_the_dataset_lineage(db):
    from app.services.analyst.catalog import _joined_views

    assert "customers_x" not in {v.name for v in _joined_views(db, db.get(SemanticExplore, 1), [1])}
    assert {v.name for v in _joined_views(db, db.get(SemanticExplore, 1), [2])} == set()


def test_governed_metric_names_are_the_measures_synonyms_only_when_approved():
    """Semantic views carry no synonyms of their own (the PUT schema drops the
    key); the words people use for a metric are governed in the Registry. Only an
    APPROVED metric bound to this Dataset adds them."""
    from app.models.governance import GovernMetric, GovernMetricBinding
    from app.services.analyst.catalog import governed_aliases

    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Dataset.__table__, DatasetTable.__table__,
                                             GovernMetric.__table__, GovernMetricBinding.__table__])
    with Session(engine) as s:
        s.add_all([Dataset(id=1, name="Sales", owner_id=uuid.UUID(int=1)),
                   Dataset(id=2, name="Other", owner_id=uuid.UUID(int=1))])
        ok = GovernMetric(name="revenue", display_name="Doanh thu", synonyms=["doanh thu thuần"], status="Approved")
        draft = GovernMetric(name="orders", display_name="Số đơn", synonyms=["đơn"], status="Draft")
        other = GovernMetric(name="x", display_name="Khác", synonyms=[], status="Approved")
        legacy = GovernMetric(name="units", display_name="Số lượng", synonyms=["sản lượng"], status="Approved",
                              dataset_id=1, measure_ref="units")
        s.add_all([ok, draft, other, legacy])
        s.flush()
        s.add_all([GovernMetricBinding(metric_id=ok.id, dataset_id=1, measure_ref="order_items.revenue"),
                   GovernMetricBinding(metric_id=draft.id, dataset_id=1, measure_ref="order_items.orders"),
                   GovernMetricBinding(metric_id=other.id, dataset_id=2, measure_ref="order_items.revenue")])
        s.commit()
        got = governed_aliases(s, [1])
    assert got["order_items.revenue"] == ("Doanh thu", "doanh thu thuần") == got["revenue"]
    assert "order_items.orders" not in got and "orders" not in got     # Draft: not official
    assert got["units"] == ("Số lượng", "sản lượng")                     # scalar fallback
    assert "Khác" not in got.get("revenue", ())                          # another Dataset's metric


def test_only_approved_glossary_terms_are_a_fields_vocabulary():
    """PO 2026-10-22: "miền" must come from GOVERNED business metadata, not from a
    guess that every region means the same. A dimension or measure links glossary
    terms; only Approved terms add words."""
    from app.models.governance import Glossary, GlossaryTerm
    from app.services.analyst.catalog import glossary_words

    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[Glossary.__table__, GlossaryTerm.__table__])
    with Session(engine) as s:
        g = Glossary(name="sales", display_name="Sales")
        s.add(g)
        s.flush()
        s.add_all([GlossaryTerm(glossary_id=g.id, name="region", display_name="Vùng", synonyms=["miền", "khu vực"],
                                status="Approved"),
                   GlossaryTerm(glossary_id=g.id, name="draft", display_name="Nháp", synonyms=["thử"], status="Draft"),
                   GlossaryTerm(glossary_id=g.id, name="old", display_name="Cũ", synonyms=["xưa"], status="Deprecated")])
        s.commit()
        got = glossary_words(s, {"sales.region", "sales.draft", "sales.old", "sales.missing"})
    assert got == {"sales.region": ("Vùng", "miền", "khu vực")}


def test_a_dimension_keeps_its_glossary_link_and_others_stay_unchanged():
    from app.schemas.semantic import SemanticViewUpdate

    u = SemanticViewUpdate(dimensions=[{"name": "region", "type": "string",
                                        "glossary_terms": [{"fqn": "sales.region", "label": "Vùng"}]},
                                       {"name": "channel", "type": "string"}])
    dumped = u.model_dump(exclude_unset=True)["dimensions"]
    assert dumped[0]["glossary_terms"] == [{"fqn": "sales.region", "label": "Vùng"}]
    assert "glossary_terms" not in dumped[1]     # an unlinked dimension's stored shape is unchanged


def test_the_planner_is_offered_only_the_datasets_the_question_names():
    """Set 9 root cause: "doanh số" questions were planned on another Dataset's English
    "Revenue" (and mixed two Datasets' fields). A Dataset whose metric (label or governed
    synonym, whole phrase) or whose name the question says is what the planner sees."""
    from app.services.analyst.catalog import CatalogExplore, CatalogField, datasets_named

    def ex(i, ds, name, label, syn=()):
        return CatalogExplore(explore_id=i, model_id=i, dataset_id=ds, dataset_name=name, dataset_table_id=i,
                              base_view="v", source_type="postgresql", label=name,
                              fields=[CatalogField(f"v{i}.m", "measure", "sum", label, synonyms=syn)])
    cat = [ex(1, 1, "Rig Sales", "Revenue"), ex(2, 2, "Rig Commerce", "Doanh số"),
           ex(3, 3, "Rig Marketing", "Chi phí marketing", ("ngân sách quảng cáo",))]
    assert datasets_named(cat, "Doanh số theo vùng năm 2025") == {2}
    assert datasets_named(cat, "Revenue Rig Sales theo quý") == {1}
    assert datasets_named(cat, "Ngân sách quảng cáo theo tháng") == {3}          # a governed synonym
    assert datasets_named(cat, "Doanh thu theo tháng") == set()                   # names none: all offered
    assert datasets_named(cat, "Doanh số và chi phí marketing") == {2, 3}         # several: the planner/clarify decide
