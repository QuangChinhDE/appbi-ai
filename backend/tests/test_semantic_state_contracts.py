"""Semantic state contracts that need no warehouse: drift, cache identity, the
live filter path, filter classification, name scoping.

Each test names the finding it locks. All run on in-memory SQLite (the unit
tier); the value-level engine matrix is `test_semantic_golden_matrix.py`.
"""
from __future__ import annotations

import sqlite3
import types

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


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine, tables=[
        Dataset.__table__, DatasetTable.__table__,
        SemanticView.__table__, SemanticModel.__table__, SemanticExplore.__table__,
    ])
    with Session(engine) as s:
        s.add(Dataset(id=1, name="Sales"))
        # LIST-shaped cache (one of the two shapes writers produce).
        s.add(DatasetTable(id=11, dataset_id=1, display_name="orders", source_table_name="orders",
                           columns_cache=[{"name": "id", "type": "integer"}, {"name": "amount", "type": "float"},
                                          {"name": "customer_id", "type": "integer"}]))
        s.add(DatasetTable(id=12, dataset_id=1, display_name="customers", source_table_name="customers",
                           columns_cache={"columns": [{"name": "id", "type": "integer"},
                                                      {"name": "region", "type": "string"}]}))
        s.add(SemanticView(
            id=101, name="orders", dataset_table_id=11, sql_table_name="orders",
            dimensions=[{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                        {"name": "amount", "type": "number", "sql": "${TABLE}.amount"},
                        {"name": "customer_id", "type": "number", "sql": "${TABLE}.customer_id"}],
            measures=[{"name": "revenue", "type": "sum", "sql": "${TABLE}.amount"}],
            primary_key=["id"],
        ))
        s.add(SemanticView(
            id=102, name="customers", dataset_table_id=12, sql_table_name="customers",
            dimensions=[{"name": "id", "type": "number", "sql": "${TABLE}.id"},
                        {"name": "region", "type": "string", "sql": "${TABLE}.region"}],
            measures=[],
        ))
        s.add(SemanticModel(id=1, name="m", dataset_id=1))
        s.add(SemanticExplore(id=1, name="orders", model_id=1, base_view_id=101, base_view_name="orders",
                              joins=[{"name": "customers", "view": "customers", "type": "left", "sql_on": "",
                                      "from_column": "customer_id", "to_column": "id",
                                      "relationship": "many_to_one", "cardinality": "many_to_one"}]))
        s.commit()
        yield s


# ── SEM-P1-005 drift ────────────────────────────────────────────────────────


def test_drift_sees_a_measure_whose_sql_column_is_gone_on_a_list_shaped_cache(db):
    from app.services.dataset_model_service import _model_views_drifted, dangling_model_references

    assert dangling_model_references(db, 1) == []
    v = db.get(SemanticView, 101)
    v.measures = [{"name": "revenue", "type": "sum", "sql": "${TABLE}.net_amount"}]
    db.commit()
    # Used to read `columns_cache.get("columns")` → AttributeError on a list,
    # swallowed by the background job: this drift was never detected.
    assert _model_views_drifted(db, 1) is True
    assert {"kind": "measure", "view": "orders", "name": "revenue", "column": "net_amount"} in \
        dangling_model_references(db, 1)


def test_dangling_references_cover_filters_primary_key_and_join_keys(db):
    from app.services.dataset_model_service import dangling_model_references

    v = db.get(SemanticView, 101)
    v.measures = [{"name": "paid", "type": "sum", "sql": "${TABLE}.amount",
                   "filters": [{"field": "status", "operator": "eq", "value": "paid"}]}]
    v.primary_key = ["order_uuid"]
    e = db.get(SemanticExplore, 1)
    e.joins = [{**e.joins[0], "to_column": "customer_key"}]
    db.commit()
    found = {(d["kind"], d["column"]) for d in dangling_model_references(db, 1)}
    assert found == {("measure", "status"), ("primary_key", "order_uuid"), ("join", "customer_key")}


# ── SEM-P2-001 cache identity ───────────────────────────────────────────────


def test_cache_identity_changes_with_every_definition_the_sql_reads(db):
    from app.services.chart_service import _semantic_definition_signature as sig

    base = sig(db, 1)
    assert base and sig(db, 1) == base, "content-keyed: same definitions, same key"

    v = db.get(SemanticView, 101)
    v.measures = [{"name": "revenue", "type": "avg", "sql": "${TABLE}.amount"}]  # SUM → AVG
    db.commit()
    after_measure = sig(db, 1)
    assert after_measure != base

    v.primary_key = ["customer_id"]
    db.commit()
    after_pk = sig(db, 1)
    assert after_pk != after_measure

    t = db.get(DatasetTable, 11)
    t.transformations = [{"type": "filter", "expr": "amount > 0"}]
    db.commit()
    assert sig(db, 1) != after_pk


# ── live filter path: operators and fan-out ─────────────────────────────────


@pytest.mark.parametrize("dialect", ["bigquery", "postgresql", "duckdb"])
@pytest.mark.parametrize("op, value", [
    ("ends_with", "a"), ("matches_regex", "a.*"), ("not_between", [1, 2]),
    ("date_eq", "2024-01-01"), ("date_between", ["2024-01-01", "2024-02-01"]),
])
def test_live_where_renders_every_operator_it_accepts(dialect, op, value):
    """These used to render NOTHING on the live path: the chart ran unfiltered."""
    from app.services.live_query_service import _build_where_clause

    assert _build_where_clause([{"field": "f", "operator": op, "value": value}], dialect)


def test_live_where_refuses_an_unknown_operator():
    from app.services.live_query_service import _build_where_clause

    with pytest.raises(ValueError):
        _build_where_clause([{"field": "f", "operator": "sounds_like", "value": "x"}], "postgresql")


def test_regex_is_a_regex_on_every_engine_never_similar_to():
    from app.services.sql_pattern import regex_predicate

    q = lambda s: "'" + s + "'"  # noqa: E731
    assert regex_predicate("c", "a.*", "bigquery", q) == "REGEXP_CONTAINS(c, 'a.*')"
    assert regex_predicate("c", "a.*", "postgresql", q) == "c ~ 'a.*'"
    with pytest.raises(ValueError):
        regex_predicate("c", "a.*", "snowflake", q)


def test_live_filter_through_a_one_to_many_hop_is_a_semi_join_not_a_row_multiplier(monkeypatch):
    """A dim chart (customers) filtered on a fact field (orders.status) walks
    customers → orders, a 1:N hop. A LEFT JOIN there repeats each customer once
    per matching order; the semi-join keeps one row per customer. Executed."""
    from app.services import chart_service as cs
    from app.services.live_query_service import _build_where_clause
    from app.services.semantic_join_resolver import JoinEdge, JoinStep

    edge = JoinEdge(from_node="customers", to_node="orders", to_view="orders", type="left", sql_on="",
                    from_column="id", to_column="customer_id", relationship="one_to_many",
                    cardinality="one_to_many", is_reverse=True)
    assert cs._live_edge_fans_out(edge)
    monkeypatch.setattr(cs, "_build_live_relation_for_semantic_view", lambda *_a: "orders")
    view = types.SimpleNamespace(dimensions=[{"name": "status", "sql": "status"}], measures=[])
    join_sql = cs._build_live_semi_join(
        None, types.SimpleNamespace(type="postgresql"), [JoinStep(edge=edge, alias_sql="")],
        from_alias="_appbi_base", semi_alias="_appbi_sem_semi_0",
        field_def={"name": "status", "sql": "status"}, semantic_name="status",
        filt={"field": "orders.status", "operator": "eq", "value": "ok"},
        get_view=lambda _n: view, target_node="orders",
    )
    sql = (f"SELECT _appbi_base.*, _appbi_sem_semi_0._k AS __sem_filter_0 "
           f"FROM (SELECT * FROM customers) AS _appbi_base {join_sql}")
    where = _build_where_clause([{"field": "__sem_filter_0", "operator": "is_not_null", "value": None}], "duckdb")
    con = sqlite3.connect(":memory:")
    con.executescript(
        "CREATE TABLE customers(id int); INSERT INTO customers VALUES (1),(2),(3);"
        "CREATE TABLE orders(id int, customer_id int, status text);"
        "INSERT INTO orders VALUES (1,1,'ok'),(2,1,'ok'),(3,1,'ok'),(4,2,'ok'),(5,3,'void');"
    )
    rows = con.execute(f"SELECT id FROM ({sql}) AS t WHERE {where} ORDER BY id").fetchall()
    assert rows == [(1,), (2,)], "customer 1 has three ok orders and must appear ONCE"


def test_live_semi_join_refuses_a_key_it_cannot_split():
    from app.services import chart_service as cs
    from app.services.semantic_join_resolver import JoinEdge, JoinStep

    edge = JoinEdge(from_node="a", to_node="b", to_view="b", type="left",
                    sql_on="${TABLE}.x = ${b}.x AND ${TABLE}.y = ${b}.y",
                    from_column="x", to_column="x", relationship="one_to_many", cardinality="one_to_many")
    with pytest.raises(ValueError):
        cs._build_live_semi_join(
            None, types.SimpleNamespace(type="postgresql"), [JoinStep(edge=edge, alias_sql="")],
            from_alias="_appbi_base", semi_alias="s", field_def={"name": "f", "sql": "f"},
            semantic_name="f", filt={"operator": "eq", "value": 1}, get_view=lambda _n: None,
            target_node="b",
        )


# ── SEM-P2-005 filter classification / HAVING ───────────────────────────────


def _engine(db, dialect="postgresql"):
    from app.services.semantic_query_engine import SemanticQueryEngine

    e = SemanticQueryEngine(db, database_type=dialect)
    e._set_model_scope(db.get(SemanticModel, 1))
    return e


def test_a_filter_on_a_model_measure_is_having_even_when_the_chart_omits_it(db):
    e = _engine(db)
    where, having = e._split_filters_by_role(
        {"orders.revenue": {"operator": "gt", "value": 10}, "customers.region": {"operator": "eq", "value": "N"}},
        measures=[],
    )
    assert set(having) == {"orders.revenue"} and set(where) == {"customers.region"}


def test_an_unrenderable_measure_filter_is_refused_not_dropped(db):
    e = _engine(db)
    e._load_views(["orders.revenue"])
    with pytest.raises(ValueError):
        e._build_having_clause({"orders.revenue": {"operator": "contains", "value": "1"}}, {})


# ── SEM-P3-004 name scoping ─────────────────────────────────────────────────


def test_a_bare_explore_name_shared_by_two_models_is_refused(db):
    from app.services.semantic_query_engine import SemanticQueryEngine

    db.add(SemanticModel(id=2, name="other", dataset_id=None))
    db.add(SemanticExplore(id=2, name="orders", model_id=2, base_view_id=101, base_view_name="orders", joins=[]))
    db.commit()
    with pytest.raises(ValueError):
        SemanticQueryEngine(db, database_type="postgresql").generate_sql(
            explore_name="orders", dimensions=[], measures=["orders.revenue"], filters={},
        )


def test_a_tableless_view_is_this_models_only_when_its_explores_name_it(db):
    db.add(SemanticView(id=301, name="stray__date_dim", sql_table_name="x", dimensions=[], measures=[]))
    db.commit()
    e = _engine(db)
    assert e._find_view_by_name("stray__date_dim") is None
    e2 = db.get(SemanticExplore, 1)
    e2.joins = [*e2.joins, {"name": "stray__date_dim", "view": "stray__date_dim", "type": "left",
                            "sql_on": "", "from_column": "id", "to_column": "id",
                            "relationship": "many_to_one", "cardinality": "many_to_one"}]
    db.commit()
    assert _engine(db)._find_view_by_name("stray__date_dim").id == 301


# ── SEM-P2-007 one local-date rule ──────────────────────────────────────────


@pytest.mark.parametrize("dialect", ["bigquery", "postgresql", "duckdb", "mysql"])
def test_calendar_join_and_time_grain_share_one_local_date_expression(dialect):
    from app.services.dataset_calendar_service import expand_local_date_macros, local_date_sql

    assert expand_local_date_macros("${APPBI_LOCAL_DATE(t.ts|Asia/Ho_Chi_Minh)}", dialect) == \
        local_date_sql("t.ts", "Asia/Ho_Chi_Minh", dialect)


# ── SEM-P2-008 an unresolved binding on a modeled table is re-hydrated ──────


def test_a_modeled_table_with_an_empty_binding_is_rehydrated_not_sent_live(db):
    from app.services.chart_service import _rehydrate_binding_for_modeled_table

    binding = _rehydrate_binding_for_modeled_table(db, db.get(DatasetTable, 11), {})
    assert binding and binding["baseViewName"] == "orders"
    db.add(DatasetTable(id=13, dataset_id=1, display_name="raw", source_table_name="raw"))
    db.commit()
    assert _rehydrate_binding_for_modeled_table(db, db.get(DatasetTable, 13), {}) is None,         "a table with no semantic view has nothing to re-hydrate (live is correct there)"
