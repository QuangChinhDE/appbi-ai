"""Phase-4 unit tests — symmetric aggregate renderer (Looker MD5 trick).

These tests poke ``SemanticQueryEngine._render_symmetric_aggregate`` directly
with hand-constructed views to verify SQL shape per dialect and the safe
fallback paths. The full SQL is exercised by the golden-harness regression
fixture against Postgres dataset 56 (Phase 0 ground truth).
"""
import os
os.environ.setdefault("DATABASE_URL", "postgresql://stub@localhost/stub")

from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.services.semantic_query_engine import SemanticQueryEngine


@pytest.fixture(autouse=True)
def _allow_all_dialects(monkeypatch):
    """Phase 4.3 — default allow-list is bigquery-only (Postgres is slow).
    Most renderer tests assert shape regardless of perf, so opt every dialect
    into the list here. Tests that EXPLICITLY exercise the allow-list set
    their own narrower value and override this fixture's settings.
    """
    monkeypatch.setattr(
        settings,
        "FEATURE_SYMMETRIC_AGGREGATES_DIALECTS",
        "bigquery,postgresql,mysql,duckdb,oracle",
        raising=False,
    )


def _make_engine(dialect: str, sym_views: set[str], views: dict[str, dict]):
    """Build an engine with stubbed views_cache + symmetric set."""
    eng = SemanticQueryEngine(db=None, database_type=dialect)
    eng.views_cache = {
        name: SimpleNamespace(
            name=name,
            primary_key=spec.get("primary_key"),
            measures=spec.get("measures", []),
            dimensions=spec.get("dimensions", []),
        )
        for name, spec in views.items()
    }
    eng._symmetric_aggregate_views = set(sym_views)
    return eng


# ──────────────────────────────────────────────────────────────────────────
# Disable conditions
# ──────────────────────────────────────────────────────────────────────────


def test_returns_none_when_flag_off(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", False, raising=False)
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    assert eng._render_symmetric_aggregate("deal", "deal.value", "sum") is None


def test_returns_none_when_view_not_in_symmetric_set(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("postgresql", set(), {
        "deal": {"primary_key": ["id"]},
    })
    assert eng._render_symmetric_aggregate("deal", "deal.value", "sum") is None


def test_returns_none_when_no_primary_key(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": None},
    })
    assert eng._render_symmetric_aggregate("deal", "deal.value", "sum") is None


def test_returns_none_for_unsupported_measure_type(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    # MIN / MAX / COUNT_DISTINCT fall back to legacy path.
    assert eng._render_symmetric_aggregate("deal", "deal.value", "min") is None
    assert eng._render_symmetric_aggregate("deal", "deal.value", "max") is None
    assert eng._render_symmetric_aggregate("deal", "deal.value", "count_distinct") is None
    assert eng._render_symmetric_aggregate("deal", "deal.value", "percent_of_total") is None


def test_returns_none_for_unknown_dialect(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    # Allow Oracle through the allow-list so this test exercises the
    # dialect-recipe branch (returns None because no hash recipe defined).
    monkeypatch.setattr(
        settings, "FEATURE_SYMMETRIC_AGGREGATES_DIALECTS", "bigquery,oracle",
        raising=False,
    )
    eng = _make_engine("oracle", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    assert eng._render_symmetric_aggregate("deal", "deal.value", "sum") is None


def test_dialect_allow_list_blocks_postgres_by_default(monkeypatch):
    """Phase 4.3 — Postgres is empirically 53× slower than EXISTS so the
    default allow-list omits it. The renderer should return None for
    Postgres dialect even when flag is ON.
    """
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    monkeypatch.setattr(
        settings, "FEATURE_SYMMETRIC_AGGREGATES_DIALECTS", "bigquery",
        raising=False,
    )
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    assert eng._render_symmetric_aggregate("deal", "deal.value", "sum") is None


def test_dialect_allow_list_lets_postgres_through_when_opted_in(monkeypatch):
    """When the operator opts Postgres into the allow-list, the symmetric
    form is emitted (used by the correctness bench).
    """
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    monkeypatch.setattr(
        settings, "FEATURE_SYMMETRIC_AGGREGATES_DIALECTS", "bigquery,postgresql",
        raising=False,
    )
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    sql = eng._render_symmetric_aggregate("deal", "deal.value", "sum")
    assert sql is not None
    assert "MD5(" in sql
    assert "* 1e15" in sql


# ──────────────────────────────────────────────────────────────────────────
# Symmetric COUNT — portable across dialects (just COUNT DISTINCT pk)
# ──────────────────────────────────────────────────────────────────────────


def test_symmetric_count_star_postgres(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    sql = eng._render_symmetric_aggregate("deal", "*", "count")
    assert sql == "COUNT(DISTINCT CAST(deal.id AS VARCHAR))"


def test_symmetric_count_filtered_postgres(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    sql = eng._render_symmetric_aggregate(
        "deal", "CASE WHEN deal.stage = 'won' THEN 1 END", "count",
    )
    # Filtered count gates on the pre-built CASE expression so the deduped key
    # only counts rows that the filter let through.
    assert "COUNT(DISTINCT CASE WHEN CASE WHEN deal.stage = 'won' THEN 1 END" in sql
    assert "IS NOT NULL THEN CAST(deal.id AS VARCHAR)" in sql


def test_symmetric_count_composite_pk(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["customer_id", "date"]},
    })
    sql = eng._render_symmetric_aggregate("deal", "*", "count")
    # Composite PK joined by literal '|' separator
    assert "CAST(deal.customer_id AS VARCHAR) || '|' || CAST(deal.date AS VARCHAR)" in sql
    assert sql.startswith("COUNT(DISTINCT (")


# ──────────────────────────────────────────────────────────────────────────
# Symmetric SUM — Looker MD5 trick, dialect-specific hash
# ──────────────────────────────────────────────────────────────────────────


def test_symmetric_sum_postgres_shape(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    sql = eng._render_symmetric_aggregate("deal", "deal.value", "sum")
    # Looker dedup-by-hash form: SUM(DISTINCT value + hash*MULT) - SUM(DISTINCT hash*MULT)
    assert "SUM(DISTINCT (COALESCE(CAST(deal.value AS NUMERIC), 0) + (CAST(" in sql
    assert "- SUM(DISTINCT (CAST(" in sql
    # Postgres hash recipe uses MD5 + bit cast → bigint
    assert "MD5(CAST(deal.id AS VARCHAR))" in sql
    assert "::bit(60)::bigint" in sql
    # 1e15 multiplier keeps value and hash in disjoint decimal positions
    assert "* 1e15" in sql


def test_symmetric_sum_bigquery_uses_farm_fingerprint_with_1e18(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("bigquery", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    sql = eng._render_symmetric_aggregate("deal", "deal.value", "sum")
    assert "FARM_FINGERPRINT(CAST(deal.id AS VARCHAR))" in sql
    assert "MD5(" not in sql
    # BQ FARM_FINGERPRINT is INT64-wide → multiplier 1e18 (vs 1e15 for shorter hashes)
    assert "* 1e18" in sql


def test_symmetric_sum_mysql_uses_conv(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("mysql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    sql = eng._render_symmetric_aggregate("deal", "deal.value", "sum")
    assert "CONV(SUBSTRING(MD5(CAST(deal.id AS VARCHAR)), 1, 15), 16, 10)" in sql
    assert "* 1e15" in sql


def test_symmetric_sum_duckdb_uses_hash(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("duckdb", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    sql = eng._render_symmetric_aggregate("deal", "deal.value", "sum")
    assert "hash(CAST(deal.id AS VARCHAR))" in sql
    assert "* 1e15" in sql


def test_symmetric_sum_subtraction_recovers_value():
    """Mathematical sanity check on the chosen formula, in Python.

    Given two rows with distinct pks p1≠p2 and values v1, v2 that get duplicated
    by a fan-out factor, the formula SUM(DISTINCT v + h*MULT) - SUM(DISTINCT h*MULT)
    should still equal v1 + v2 because DISTINCT collapses the duplicated encoded
    values back to one per source row.
    """
    from hashlib import md5
    MULT = 10 ** 15
    def hash_of(pk):
        # Mirror Postgres recipe: 60 bits of MD5 → bigint
        return int(md5(str(pk).encode()).hexdigest()[:15], 16)
    rows = [("p1", 100), ("p2", 250), ("p1", 100), ("p2", 250)]  # fan-out ×2
    encoded = {v + hash_of(pk) * MULT for pk, v in rows}  # DISTINCT
    hashes = {hash_of(pk) * MULT for pk, _ in rows}        # DISTINCT
    sym_sum = sum(encoded) - sum(hashes)
    direct = 100 + 250  # pre-fan-out
    assert sym_sum == direct


# ──────────────────────────────────────────────────────────────────────────
# Symmetric AVG — sum / count
# ──────────────────────────────────────────────────────────────────────────


def test_symmetric_avg_shape(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = _make_engine("postgresql", {"deal"}, {
        "deal": {"primary_key": ["id"]},
    })
    sql = eng._render_symmetric_aggregate("deal", "deal.value", "avg")
    # sum / NULLIF(count, 0) — zero-protected division
    assert "/ NULLIF(" in sql
    assert "COUNT(DISTINCT CASE WHEN deal.value IS NOT NULL THEN CAST(deal.id AS VARCHAR) END)" in sql
    # numerator is the symmetric SUM form (value + hash*MULT distinction)
    assert "SUM(DISTINCT (COALESCE(CAST(deal.value AS NUMERIC), 0) +" in sql
    assert "- SUM(DISTINCT (CAST(" in sql


# ──────────────────────────────────────────────────────────────────────────
# Integration sanity — _render_measure falls through to legacy when symmetric
# returns None.
# ──────────────────────────────────────────────────────────────────────────


def test_render_measure_falls_back_to_legacy_when_flag_off(monkeypatch):
    """End-to-end: flag OFF + view in symmetric set ⇒ legacy SUM emitted."""
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", False, raising=False)
    eng = SemanticQueryEngine(db=None, database_type="postgresql")
    eng._symmetric_aggregate_views = {"deal"}
    eng.views_cache = {
        "deal": SimpleNamespace(
            name="deal",
            primary_key=["id"],
            measures=[{"name": "total_value", "type": "sum", "sql": "${TABLE}.value"}],
            dimensions=[],
        ),
    }
    rendered = eng._render_measure("deal.total_value")
    # Plain SUM, not symmetric
    assert rendered == "SUM(deal.value)"
    assert "DISTINCT" not in rendered


def test_render_measure_uses_symmetric_when_flag_on(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_SYMMETRIC_AGGREGATES", True, raising=False)
    eng = SemanticQueryEngine(db=None, database_type="postgresql")
    eng._symmetric_aggregate_views = {"deal"}
    eng.views_cache = {
        "deal": SimpleNamespace(
            name="deal",
            primary_key=["id"],
            measures=[{"name": "total_value", "type": "sum", "sql": "${TABLE}.value"}],
            dimensions=[],
        ),
    }
    rendered = eng._render_measure("deal.total_value")
    assert "SUM(DISTINCT (COALESCE(CAST(deal.value AS NUMERIC), 0) +" in rendered
    assert "MD5(CAST(deal.id AS VARCHAR))" in rendered
    assert "* 1e15" in rendered
