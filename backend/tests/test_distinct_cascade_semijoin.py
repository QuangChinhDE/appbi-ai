"""The slicer's distinct-value cascade: right members on Postgres, a SQL shape
BigQuery accepts.

A dropdown on owner.team cascaded by date.year reaches the date dim only through
the facts that share owner and date (activity, deal, revenue). Two things must
hold:

  * VALUES (executed on Postgres): a member is offered when it has data through
    ANY of those facts — the union, checked against a truth computed from the
    raw tables, not from the engine;
  * SHAPE (BigQuery dialect, execution stubbed): one INNER JOIN semi-join over a
    UNION DISTINCT key set — never a correlated EXISTS, an `IN (SELECT …)` or an
    OR of INs, all of which BigQuery rejects over aggregated/windowed sources.

Needs the CI snowflake fixture (`scripts/seed_snowflake_ci_fixture.py`, dataset
56 on the same Postgres). Runs in `integration-golden`. BigQuery EXECUTION of
the same shape is verified separately against a real warehouse.
"""
from __future__ import annotations

import os
import re

import pytest
import sqlalchemy as sa

DATASET_ID = 56
TEAM = "dataset_table_188.team"
YEAR = "dataset_table_187.year"


@pytest.fixture(scope="module")
def db():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_distinct_cascade_semijoin needs the seeded Postgres CI fixture (DATABASE_URL).")
    from app.core.database import SessionLocal
    from app.models.dataset import Dataset

    s = SessionLocal()
    if s.get(Dataset, DATASET_ID) is None:
        s.close()
        pytest.fail("dataset 56 missing — run scripts/seed_snowflake_ci_fixture.py first.")
    yield s
    s.close()


@pytest.fixture(autouse=True)
def _no_result_cache(monkeypatch):
    from app.services import dataset_model_service as dms

    monkeypatch.setattr(dms.query_cache, "get_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(dms.query_cache, "set_cached", lambda *_a, **_k: None)


def _year_filter(year: int) -> list[dict]:
    return [{"field": YEAR, "semanticField": YEAR, "operator": "eq", "value": year, "datasetId": DATASET_ID}]


def _truth_teams_with_data_in(db, year: int) -> list[str]:
    """Owners with ANY activity, deal or revenue dated in `year`, from the raw
    fixture tables — independent of the semantic engine."""
    rows = db.execute(sa.text(
        """
        SELECT DISTINCT o.team FROM bcfix.bc_owner o
        WHERE o.team IS NOT NULL AND o.bc_key IN (
              SELECT a.bc_key FROM bcfix.bc_activity a WHERE EXTRACT(YEAR FROM a.som_due_datetime::date) = :y
        UNION SELECT d.bc_key FROM bcfix.bc_deal d WHERE EXTRACT(YEAR FROM d.som_deal_add_time::date) = :y
        UNION SELECT r.bc_key FROM bcfix.bc_revenue r WHERE EXTRACT(YEAR FROM r.payment_month::date) = :y)
        ORDER BY 1
        """
    ), {"y": year}).fetchall()
    return [r[0] for r in rows]


@pytest.mark.parametrize("year", [2025, 2026])
def test_cascade_offers_every_member_with_data_through_any_fact(db, year):
    from app.services.dataset_model_service import get_distinct_field_values

    got = get_distinct_field_values(db, DATASET_ID, TEAM, filters=_year_filter(year))
    assert got["dropped_filters"] == []
    assert sorted(got["values"]) == _truth_teams_with_data_in(db, year)


def test_cascade_sql_on_bigquery_is_one_inner_join_semi_join(db, monkeypatch):
    from app.models.models import DataSource
    from app.models.dataset import DatasetTable
    from app.services import dataset_model_service as dms

    captured: list[str] = []
    from app.core import crypto
    from app.services import live_query_service
    from app.services.datasource_service import DataSourceConnectionService

    # The distinct builder imports these inside the function: patch the source.
    monkeypatch.setattr(live_query_service, "_estimate_bigquery_bytes", lambda *_a, **_k: 0)
    monkeypatch.setattr(crypto, "decrypt_config", lambda cfg: cfg)
    monkeypatch.setattr(
        DataSourceConnectionService, "execute_query",
        staticmethod(lambda _t, _c, sql, **_k: (captured.append(sql), ([], [], 0))[1]),
    )
    ds_ids = {t.datasource_id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == DATASET_ID)}
    sources = [db.get(DataSource, i) for i in ds_ids if i]
    from sqlalchemy.orm.attributes import set_committed_value

    # Re-typed IN THIS SESSION ONLY: a committed-value set is not a change, so a
    # commit inside the call cannot flush it into the shared fixture.
    saved = [(s, s.type) for s in sources]
    db.expire_on_commit = False
    try:
        for s in sources:
            set_committed_value(s, "type", "bigquery")
        dms.get_distinct_field_values(db, DATASET_ID, TEAM, filters=_year_filter(2025))
    finally:
        for s, t in saved:
            set_committed_value(s, "type", t)
        db.rollback()
        db.expire_on_commit = True

    assert captured, "no distinct SQL was generated"
    sql = captured[-1]
    assert "INNER JOIN (SELECT" in sql and "UNION DISTINCT" in sql, sql
    assert not re.search(r"\bEXISTS\s*\(", sql), sql
    assert not re.search(r"\bIN\s*\(\s*SELECT", sql, re.I), sql
    # Nothing inside the key-set subqueries refers back to the outer row.
    inner = sql[sql.index("INNER JOIN (SELECT"):sql.rindex(") AS _appbi_semi_")]
    assert "_appbi_base." not in inner, sql
    assert '"' not in sql, "BigQuery identifiers are backticked, never double-quoted"
