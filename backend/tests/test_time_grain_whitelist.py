"""A time grain reaches SQL generation as a SQL fragment, so it must be one of a
fixed set — never a caller-supplied string.

The engine renders a grain into `DATE_TRUNC('<grain>', ...)` (Postgres/DuckDB),
`TIMESTAMP_TRUNC(..., <unit>)` (BigQuery) or `DATE_FORMAT`/`MAKEDATE` (MySQL). If
an arbitrary string reached the Postgres/DuckDB branch it would be SQL syntax,
not data — a value outside the model's scope could be read. And a value silently
mapped to another grain would answer a different question than the one asked.

So the engine validates the grain at the render boundary (`normalize_time_grain`,
called first in `_render_dimension_with_time_grain` and in `_truncate_date_sql`):
one of day/week/month/quarter/year, or a refusal. No dialect falls back to a
default. The API layer (`check_role_config_shape`) enforces the same five, but
the engine never trusts that an input was validated upstream.

These are structural unit tests — no database, no warehouse, no network — so they
run on every push. The payloads here are benign non-grains; the whitelist refuses
by exact match, so a benign invalid value exercises the identical refusal path.
"""
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_time_grain_whitelist.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.semantic_query_engine import (  # noqa: E402
    InvalidTimeGrainError,
    SemanticQueryEngine,
    VALID_TIME_GRAINS,
    normalize_time_grain,
)

DIALECTS = ["postgresql", "duckdb", "bigquery", "mysql"]
# Benign non-grains. None is a working exploit; the whitelist refuses by exact
# match, so any value outside the five is refused through the same code path.
NOT_GRAINS = ["", "   ", "days", "weekly", "hour", "d a y", "DROP", "none", "0", "qtr"]


# ── the shared validator ────────────────────────────────────────────────────
@pytest.mark.parametrize("grain", sorted(VALID_TIME_GRAINS))
def test_the_five_grains_are_accepted_and_canonicalized(grain):
    assert normalize_time_grain(grain) == grain
    assert normalize_time_grain(grain.upper()) == grain
    assert normalize_time_grain(f"  {grain}  ") == grain


def test_the_valid_set_is_exactly_five():
    assert VALID_TIME_GRAINS == {"day", "week", "month", "quarter", "year"}


@pytest.mark.parametrize("grain", NOT_GRAINS + [None])
def test_anything_else_is_refused_not_defaulted(grain):
    with pytest.raises(InvalidTimeGrainError):
        normalize_time_grain(grain)


# ── the render boundary: every dialect refuses, none falls back ─────────────
@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("grain", NOT_GRAINS)
def test_render_refuses_an_invalid_grain_on_every_dialect(dialect, grain):
    engine = SemanticQueryEngine(db=None, database_type=dialect)  # type: ignore[arg-type]
    with pytest.raises(InvalidTimeGrainError):
        engine._render_dimension_with_time_grain("orders.created_at", "orders", grain)


@pytest.mark.parametrize("dialect", DIALECTS)
@pytest.mark.parametrize("grain", NOT_GRAINS)
def test_truncate_date_sql_refuses_an_invalid_grain_on_every_dialect(dialect, grain):
    with pytest.raises(InvalidTimeGrainError):
        SemanticQueryEngine._truncate_date_sql("t.d", grain, dialect)


# ── valid grains still produce the right shape on every dialect ─────────────
@pytest.mark.parametrize("grain", sorted(VALID_TIME_GRAINS))
def test_truncate_date_sql_valid_grain_keeps_its_shape(grain):
    pg = SemanticQueryEngine._truncate_date_sql("t.d", grain, "postgresql")
    assert pg == f"DATE_TRUNC('{grain}', t.d)"
    duck = SemanticQueryEngine._truncate_date_sql("t.d", grain, "duckdb")
    assert duck == f"DATE_TRUNC('{grain}', t.d)"
    bq = SemanticQueryEngine._truncate_date_sql("t.d", grain, "bigquery")
    if grain == "day":
        assert bq == "t.d"
    else:
        assert bq.startswith("DATE_TRUNC(t.d,") and "'" not in bq
    my = SemanticQueryEngine._truncate_date_sql("t.d", grain, "mysql")
    assert "DATE_TRUNC" not in my  # MySQL has no DATE_TRUNC


def test_a_valid_grain_never_contains_a_quote_or_paren_from_the_grain_itself():
    # The grain text, once validated, is one bare lower-case word: it cannot carry
    # a quote, a space, a semicolon or a parenthesis into the SQL fragment.
    for grain in VALID_TIME_GRAINS:
        g = normalize_time_grain(grain)
        assert g.isalpha() and g.islower() and g == g.strip()
