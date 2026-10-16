"""Semantic Kernel v2 — cross-view derived measures EXECUTED on a real MySQL.

The formula is computed over its dependencies' result with the kernel's
dialect-aware arithmetic (MySQL: ``a * 1e0 / b`` — DOUBLE division, x / 0 is
NULL), and the dependencies run through MySQL's own multi-fact shapes (scalar
subqueries, the stitch's CTEs inside a derived table, ``WITH RECURSIVE``
calendar). Metadata lives in Postgres (DATABASE_URL); the fixture rows of
tests/pair2_topology.py live in MySQL (APPBI_TEST_MYSQL_URL — the CI
integration job's MySQL 8.4 service), as ``<database>.p2g_<table>`` (the CI
user owns one database). Hand oracles: tests/foundation_corpus.py (F7).

In CI this suite FAILS (does not skip) without both databases: a dialect check
that skipped would read as coverage.
"""
from __future__ import annotations

import os

import pytest
import sqlalchemy as sa

from tests import foundation_corpus as F
from tests import pair2_topology as T
from tests.test_pair2_golden_topology_pg import expect, make_world, pg, run  # noqa: F401 — fixtures

# Hand oracles shared with Postgres / DuckDB (foundation_corpus F7)
CASE_IDS = [
    "F7.dependencies_asked_separately",
    "F7.cross_view_formula.kpi",
    "F7.cross_view_formula.kpi_base_customers",
    "F7.cross_view_formula.with_dependencies",
    "F7.cross_fact_formula.kpi",
    "F7.cross_fact_formula.with_dependencies",
    "F7.nested_cross_view_formula.kpi",
    "F7.zero_denominator_other_fact.kpi",
    "F7.null_dependency_other_fact.kpi",
    "F7.cross_fact_formula.by_owner",
    "F7.cross_fact_formula.by_year",
    "F7.cross_view_formula.by_customer",
    "F7.cross_fact_formula.deal_filter",
    "F7.cross_fact_formula.formula_filter_by_owner",
    # unsafe grains / contexts: refused, never a number
    "F7.cross_view_formula.by_product",
    "F7.cross_fact_formula.by_deal_stage",
    "F7.cross_fact_formula.authoritative_deal_filter",
]
CASES = {c[0]: c for c in F.XVIEW_CASES}


def _need(var: str, prefix: str) -> str:
    url = os.environ.get(var, "")
    if not url.startswith(prefix):
        if os.environ.get("CI"):
            pytest.fail(f"{var} must point at {prefix}... in CI (got {url.split('@')[-1] or '<unset>'})")
        pytest.skip(f"needs {var}")
    return url


@pytest.fixture(scope="module")
def mysql_engine():
    _need("DATABASE_URL", "postgresql")
    url = _need("APPBI_TEST_MYSQL_URL", "mysql://")
    eng = sa.create_engine(url.replace("mysql://", "mysql+pymysql://", 1))
    database = sa.engine.make_url(url.replace("mysql://", "mysql+pymysql://", 1)).database
    prefix = f"{database}.{T.S}_"

    def _ddl():
        return [s.replace(f"TABLE {T.S}.", f"TABLE {prefix}").replace(f"INTO {T.S}.", f"INTO {prefix}")
                for s in T.physical_sql("mysql")]

    tables = list(T.TABLES)
    with eng.begin() as c:
        for t in tables:
            c.execute(sa.text(f"DROP TABLE IF EXISTS {prefix}{t}"))
        c.execute(sa.text("SET SESSION cte_max_recursion_depth = 100000"))
        for stmt in _ddl():
            c.execute(sa.text(stmt))
    try:
        yield eng, prefix
    finally:
        with eng.begin() as c:
            for t in tables:
                c.execute(sa.text(f"DROP TABLE IF EXISTS {prefix}{t}"))
        eng.dispose()


@pytest.fixture()
def world_mysql(pg, mysql_engine, monkeypatch):
    eng, prefix = mysql_engine
    original = T.view_relation

    def relation(spec, dialect):
        if dialect == "mysql" and spec.startswith("T:"):
            return f"{prefix}{spec.split(':', 1)[1]}"
        return original(spec, dialect)

    monkeypatch.setattr(T, "view_relation", relation)

    def _execute(sql):
        with eng.connect() as c:
            c.execute(sa.text("SET SESSION cte_max_recursion_depth = 100000"))
            res = c.execute(sa.text(sql))
            return list(res.keys()), res.fetchall()

    with make_world(pg, "mysql", _execute) as w:
        yield w


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_a_cross_view_formula_means_the_same_number_on_mysql(world_mysql, case_id):
    _id, model, base, req, expected = CASES[case_id]
    expect(run(world_mysql, model, base, req), expected)


def test_the_join_before_aggregate_number_is_not_the_formula_on_mysql(world_mysql, mysql_engine):
    eng, prefix = mysql_engine
    with eng.connect() as c:
        joined = float(c.execute(sa.text(
            f"SELECT SUM(s.amount) * 1e0 / COUNT(*) FROM {prefix}sales s "
            f"LEFT JOIN {prefix}customers c ON s.customer_id = c.id")).scalar())
    assert joined == pytest.approx(39.6)
    kind, rows, _ = run(world_mysql, "G1_star", "p2_sales", {"dims": [], "measures": ["p2_sales.rev_per_cust"]})
    assert kind == "rows" and float(rows[0]["p2_sales.rev_per_cust"]) == pytest.approx(49.5)
