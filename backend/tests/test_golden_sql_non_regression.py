"""Every saved chart's generated SQL, on Postgres AND BigQuery, against a
committed baseline.

The golden replay (`regression_filter_matrix.py`) checks numbers; this checks
that the SQL itself does not drift unannounced — including the BigQuery dialect,
which the Postgres fixture can never execute. For each chart of the CI snowflake
fixture (dataset 56) it runs the REAL chart runtime twice:

  * postgresql — executed on the fixture; the emitted SQL is recorded;
  * bigquery   — the same datasource re-typed in-session (never flushed), with
                 execution stubbed to capture the SQL instead of running it.

A chart the engine refuses is recorded as its error type, so a refusal that
starts succeeding (or the reverse) is a diff too.

Re-baseline deliberately, with the reason in the commit message:
    GOLDEN_SQL_CAPTURE=1 pytest tests/test_golden_sql_non_regression.py
"""
from __future__ import annotations

import contextlib
import json
import os
import re
from pathlib import Path

import pytest

DATASET_ID = 56
BASELINE = Path(__file__).parent / "golden_sql" / "snowflake_ci.json"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", str(sql or "")).strip()


@pytest.fixture(scope="module")
def charts():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.fail("test_golden_sql_non_regression needs the seeded Postgres CI fixture (DATABASE_URL).")
    from app.core.database import SessionLocal
    from app.models.dataset import DatasetTable
    from app.models.models import Chart

    db = SessionLocal()
    table_ids = [t.id for t in db.query(DatasetTable).filter(DatasetTable.dataset_id == DATASET_ID)]
    rows = (
        db.query(Chart).filter(Chart.dataset_table_id.in_(table_ids)).order_by(Chart.name).all()
        if table_ids else []
    )
    out = [(c.id, c.name) for c in rows]
    db.close()
    if not out:
        pytest.fail("no charts on dataset 56 — run scripts/seed_snowflake_ci_fixture.py first.")
    return out


@contextlib.contextmanager
def _datasources_read_as_bigquery():
    """Every DataSource LOADED inside the block reads as BigQuery.

    Set as a committed value on load/refresh, so it is not a change: nothing can
    flush it into the shared fixture, and a rollback-and-reload inside the
    runtime gets it again (a one-off in-session edit was lost that way, and the
    "BigQuery" SQL came out with Postgres quoting)."""
    from sqlalchemy import event
    from sqlalchemy.orm.attributes import set_committed_value

    from app.models.models import DataSource

    def _as_bq(target, *_a):
        set_committed_value(target, "type", "bigquery")

    event.listen(DataSource, "load", _as_bq)
    event.listen(DataSource, "refresh", _as_bq)
    try:
        yield
    finally:
        event.remove(DataSource, "load", _as_bq)
        event.remove(DataSource, "refresh", _as_bq)


def _sql_for(chart_id: int, dialect: str, monkeypatch) -> str:
    from app.core.database import SessionLocal
    from app.services import chart_service, live_query_service, query_cache
    from app.services.chart_service import ChartService
    from app.services.datasource_service import DataSourceConnectionService

    monkeypatch.setattr(query_cache, "get_cached", lambda *_a, **_k: None)
    monkeypatch.setattr(query_cache, "set_cached", lambda *_a, **_k: None)
    captured: list[str] = []
    db = SessionLocal()
    try:
        if dialect == "bigquery":
            from app.core import crypto

            monkeypatch.setattr(crypto, "decrypt_config", lambda cfg: cfg)
            monkeypatch.setattr(live_query_service, "_estimate_bigquery_bytes", lambda *_a, **_k: 0)
            monkeypatch.setattr(
                DataSourceConnectionService, "execute_query",
                staticmethod(lambda _t, _c, sql, **_k: (captured.append(sql), ([], [], 0))[1]),
            )
        try:
            with (_datasources_read_as_bigquery() if dialect == "bigquery" else contextlib.nullcontext()):
                res = ChartService.get_chart_data(db, chart_id)
        except Exception as exc:  # noqa: BLE001 — a refusal is part of the baseline
            return f"ERROR: {type(exc).__name__}"
        if dialect == "bigquery":
            return _norm(captured[-1]) if captured else "ERROR: no SQL reached the warehouse"
        sql = (res.get("debug") or {}).get("sql_emitted")
        if isinstance(sql, list):
            sql = " ||| ".join(e.get("sql", "") if isinstance(e, dict) else str(e) for e in sql)
        return _norm(sql)
    finally:
        db.rollback()
        db.close()
        _ = chart_service  # imported for its side effects on registration


def test_every_saved_chart_sql_matches_the_baseline(charts, monkeypatch):
    current = {
        name: {dialect: _sql_for(cid, dialect, monkeypatch) for dialect in ("postgresql", "bigquery")}
        for cid, name in charts
    }
    if os.environ.get("GOLDEN_SQL_CAPTURE") == "1":
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(current, indent=1, ensure_ascii=False, sort_keys=True) + "\n",
                            encoding="utf-8")
        return
    assert BASELINE.exists(), f"no baseline at {BASELINE} — capture one deliberately (see module doc)"
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    assert sorted(current) == sorted(baseline), "the fixture's chart set changed"
    diffs = [
        f"{name} [{d}]\n  baseline: {baseline[name][d][:400]}\n  current : {current[name][d][:400]}"
        for name in current for d in ("postgresql", "bigquery")
        if current[name][d] != baseline[name][d]
    ]
    assert not diffs, "generated SQL drifted:\n" + "\n".join(diffs)
    assert not any(v.startswith("ERROR: no SQL") for c in current.values() for v in c.values())
