"""Dialect-structural contract — the class of bug Postgres-only CI cannot catch.

WHY THIS FILE EXISTS
--------------------
Every automated gate in this repository executes against Postgres. Customers run
on BigQuery too, and the two dialects do not fail in the same places: Postgres
accepts implicit casts and correlated shapes that BigQuery rejects outright with
a 400. So an entire class of defect ships green — it reaches a BigQuery customer
as a broken chart and reaches CI as nothing at all.

`guardrail_rules.yaml` named `distinct_cascade_bq` for exactly this reason
("DIALECT-STRUCTURAL ... the ONLY way to catch this class, since PG runs all
shapes"). The audit found that harness was never committed.

This suite is the part of that idea that needs no warehouse: drive the generator
with `database_type="bigquery"` and assert the SHAPE of the SQL it emits. No
BigQuery credentials, no network, no fixture — so it runs in the unit tier on
every push, which is the only way a guard like this survives.

WHAT IT CANNOT DO
-----------------
It proves the emitted SQL has the right shape, not that BigQuery accepts it.
Executing against a real warehouse is still the only full proof. Treat a pass
here as "the known-bad shapes are absent", not as "verified on BigQuery".
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_dialect_structural.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.semantic_query_engine import SemanticQueryEngine  # noqa: E402
from app.services.type_override_service import build_safe_cast_sql  # noqa: E402


DIMENSIONS = [
    {"name": "status", "type": "string"},
    {"name": "amount", "type": "number"},
    {"name": "qty", "type": "number"},
]


def _engine(measures, dialect):
    engine = SemanticQueryEngine(db=None, database_type=dialect)  # type: ignore[arg-type]
    engine.views_cache = {
        "revenue": SimpleNamespace(
            measures=measures, dimensions=DIMENSIONS,
            table_name="public.rev", name="revenue",
        )
    }
    return engine


def _numeric_filter_sql(dialect):
    measure = {
        "name": "a", "type": "sum", "sql": "amount",
        "filters": [{"field": "qty", "operator": "gte", "value": "1"}],
    }
    return _engine([measure], dialect)._render_measure("revenue.a")


# ── SAFE_CAST is BigQuery's, and it is not optional ───────────────────────
def test_bigquery_numeric_coercion_uses_safe_cast_to_float64():
    sql = _numeric_filter_sql("bigquery")
    assert "SAFE_CAST(" in sql
    assert "FLOAT64" in sql
    # A plain CAST fails the whole query on one unparseable row; SAFE_CAST
    # yields NULL. On a warehouse of customer data that difference is an outage.
    assert "CAST(NULLIF(TRIM(CAST(revenue.qty AS STRING)), '') AS FLOAT64)" in sql


def test_postgres_numeric_coercion_does_not_emit_bigquery_syntax():
    sql = _numeric_filter_sql("postgresql")
    assert "SAFE_CAST" not in sql
    assert "FLOAT64" not in sql
    # Postgres has no SAFE_CAST, so the guard is a regex test before the cast.
    assert "REGEXP_REPLACE" in sql
    assert "DOUBLE PRECISION" in sql


def test_the_two_dialects_actually_diverge():
    # If a refactor made the generator dialect-blind, both branches would return
    # the same string and every other test here could still pass.
    assert _numeric_filter_sql("bigquery") != _numeric_filter_sql("postgresql")


# ── BUG-018: never compare a number against a quoted string ───────────────
@pytest.mark.parametrize("dialect", ["bigquery", "postgresql"])
def test_numeric_literal_is_never_quoted(dialect):
    """`INT64 >= '1'` is a hard BigQuery 400 ("No matching signature").

    The FE sends every filter value as text, so this is the default failure
    unless the engine coerces. Locked on both dialects: Postgres silently
    tolerates the quoted form, which is precisely why it must be asserted here
    rather than discovered in production.
    """
    sql = _numeric_filter_sql(dialect)
    assert ">= 1" in sql
    assert ">= '1'" not in sql


@pytest.mark.parametrize("dialect", ["bigquery", "postgresql"])
def test_string_literal_stays_quoted(dialect):
    measure = {
        "name": "a", "type": "sum", "sql": "amount",
        "filters": [{"field": "status", "operator": "eq", "value": "won"}],
    }
    sql = _engine([measure], dialect)._render_measure("revenue.a")
    assert "= 'won'" in sql


@pytest.mark.parametrize("dialect", ["bigquery", "postgresql"])
def test_quote_escaping_is_dialect_independent(dialect):
    measure = {
        "name": "a", "type": "sum", "sql": "amount",
        "filters": [{"field": "status", "operator": "eq", "value": "O'Brien"}],
    }
    sql = _engine([measure], dialect)._render_measure("revenue.a")
    assert "'O''Brien'" in sql


# ── The cast builder itself ───────────────────────────────────────────────
def test_safe_cast_builder_float_per_dialect():
    bq = build_safe_cast_sql("t.col", "float", "bigquery")
    pg = build_safe_cast_sql("t.col", "float", "postgresql")
    assert bq.startswith("SAFE_CAST(") and "FLOAT64" in bq
    assert "SAFE_CAST" not in pg and "DOUBLE PRECISION" in pg


def test_safe_cast_builder_date_is_null_safe_on_bigquery():
    bq = build_safe_cast_sql("t.col", "date", "bigquery")
    # A row whose text is not a date must become NULL, not abort the query.
    assert "SAFE_CAST" in bq
    assert "AS DATE" in bq


def test_safe_cast_builder_date_guards_before_casting_on_postgres():
    pg = build_safe_cast_sql("t.col", "date", "postgresql")
    assert "SAFE_CAST" not in pg
    # Postgres CAST raises on bad input, so the shape must test first.
    assert "CASE WHEN" in pg


# ── Symmetric aggregates are allow-listed by dialect, on purpose ──────────
def test_symmetric_aggregate_dialect_allowlist_excludes_postgres():
    """Looker-style symmetric aggregates are BigQuery-only here.

    An empirical bench found the symmetric form ~53x SLOWER than the EXISTS
    rewrite on Postgres at 1M rows. Widening this list to Postgres would be a
    performance regression that no correctness test would notice.
    """
    from app.core.config import settings
    allowed = [d.strip().lower() for d in settings.FEATURE_SYMMETRIC_AGGREGATES_DIALECTS.split(",")]
    assert "bigquery" in allowed
    assert "postgresql" not in allowed and "postgres" not in allowed


def test_superseded_engine_flags_stay_off():
    """Two Phase-2/3 engines were superseded by the in-SQL isolation/stitch path.

    `config.py` documents both as "SUPERSEDED ... Keep OFF". Flipping one on
    would route queries through a code path that the golden baselines were never
    captured against, so it must not happen by accident.
    """
    from app.core.config import settings
    assert settings.FEATURE_PROPAGATION_ENGINE_V2 is False
    assert settings.FEATURE_PER_MEASURE_ISOLATION is False
