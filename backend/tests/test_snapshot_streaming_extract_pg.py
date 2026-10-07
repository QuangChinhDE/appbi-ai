"""Snapshot extraction from PostgreSQL / MySQL is bounded-memory and stoppable.

``stream_extract_load_snapshot`` sent every non-BigQuery source through
``extract_generic_for_snapshot``: ``execute_query`` fetched the WHOLE table, then
``safe_rows`` and ``typed_rows`` copied it twice more — a large Postgres table
held three times in process memory, and Stop could only act after the extract
had finished (it was checked between LOAD chunks).

PostgreSQL / MySQL now read through the server-side cursor into an on-disk spool:
one consistent read, type verification done incrementally (same rule as
``verified_bq_type``), ``progress_cb`` per fetched batch (which raises
``SyncCancelled`` on Stop), cursor + connection released on any exit.

Real databases: Postgres from ``DATABASE_URL`` (the CI Postgres job), MySQL from
``APPBI_TEST_MYSQL_URL`` (the CI job's MySQL service).
"""
from __future__ import annotations

import os
import tracemalloc
from urllib.parse import urlparse

import pytest
import sqlalchemy as sa

from app.services import sync_control
from app.services.datasource_service import DataSourceConnectionService as DSC

ROWS = 120_000
BATCH = 5_000
COLUMNS = [
    {"name": "id", "type": "integer"},
    {"name": "amount", "type": "number", "source_type": "numeric"},
    {"name": "code", "type": "integer"},          # holds "007" → must verify to STRING
    {"name": "note", "type": "string"},
]


def _pg_url():
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        pytest.skip("needs the Postgres CI job (DATABASE_URL=postgresql://…)")
    return url


def _cfg(url: str, kind: str) -> dict:
    u = urlparse(url)
    return {"host": u.hostname, "port": u.port or (5432 if kind == "postgresql" else 3306),
            "database": u.path.lstrip("/"), "username": u.username, "password": u.password}


def _seed(engine, kind: str):
    with engine.begin() as c:
        c.execute(sa.text("DROP TABLE IF EXISTS snap_stream_src"))
        c.execute(sa.text("CREATE TABLE snap_stream_src (id int, amount numeric(30,12), code varchar(10), "
                          "note varchar(200))"))
        if kind == "postgresql":
            c.execute(sa.text(
                "INSERT INTO snap_stream_src SELECT g, g / 7.0, CASE WHEN g = 9 THEN '007' ELSE g::text END, "
                f"repeat('x', 120) FROM generate_series(1, {ROWS}) g"))
        else:
            c.execute(sa.text("SET SESSION cte_max_recursion_depth = 1000000"))
            c.execute(sa.text(
                "INSERT INTO snap_stream_src WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g "
                f"WHERE n < {ROWS}) SELECT n, n / 7.0, CASE WHEN n = 9 THEN '007' ELSE CAST(n AS CHAR) END, "
                "REPEAT('x', 120) FROM g"))


@pytest.fixture(params=["postgresql", "mysql"])
def source(request, monkeypatch):
    monkeypatch.setattr(DSC, "STREAM_BATCH_SIZE", BATCH)
    monkeypatch.setattr("app.core.crypto.decrypt_config", lambda c: dict(c or {}))
    kind = request.param
    if kind == "postgresql":
        url = _pg_url()
    else:
        url = os.environ.get("APPBI_TEST_MYSQL_URL", "")
        if not url:
            pytest.skip("needs APPBI_TEST_MYSQL_URL (the CI Postgres job's MySQL service)")
    engine = sa.create_engine(url.replace("mysql://", "mysql+pymysql://", 1))
    _seed(engine, kind)
    try:
        yield kind, _cfg(url, kind), engine
    finally:
        with engine.begin() as c:
            c.execute(sa.text("DROP TABLE IF EXISTS snap_stream_src"))
        engine.dispose()


SQL = "SELECT id, amount, code, note FROM snap_stream_src ORDER BY id"


def test_the_spool_types_rows_exactly_like_the_in_memory_extract(source):
    kind, cfg, _e = source
    eff_mem, eff_spool = {}, {}
    schema_mem, rows_mem = DSC.extract_generic_for_snapshot(kind, cfg, SQL, columns_meta=COLUMNS,
                                                            timeout_seconds=120, effective_types_out=eff_mem)
    spool = DSC.spool_extract_for_snapshot(kind, cfg, SQL, columns_meta=COLUMNS, timeout_seconds=120,
                                           effective_types_out=eff_spool)
    try:
        assert eff_spool == eff_mem and eff_spool["code"] == "STRING"
        assert [(f.name, f.field_type) for f in spool.bq_schema] == [(f.name, f.field_type) for f in schema_mem]
        assert spool.row_count == ROWS
        assert list(spool.rows()) == rows_mem
    finally:
        spool.close()


def test_progress_is_reported_while_reading(source):
    kind, cfg, _e = source
    seen = []
    spool = DSC.spool_extract_for_snapshot(kind, cfg, SQL, columns_meta=COLUMNS, timeout_seconds=120,
                                           progress_cb=seen.append)
    spool.close()
    assert seen[0] == BATCH and seen[-1] == ROWS and seen == sorted(seen)
    assert len(seen) == ROWS // BATCH


def test_stop_interrupts_the_extract_and_releases_the_source(source):
    kind, cfg, engine = source
    calls = []

    def stop_after_two_batches(n):
        calls.append(n)
        if len(calls) == 2:
            raise sync_control.SyncCancelled()

    with pytest.raises(sync_control.SyncCancelled):
        DSC.spool_extract_for_snapshot(kind, cfg, SQL, columns_meta=COLUMNS, timeout_seconds=120,
                                       progress_cb=stop_after_two_batches)
    assert calls == [BATCH, 2 * BATCH]  # stopped mid-table, not after reading it all
    # The server-side cursor / connection was released: the table can be dropped
    # at once (an open cursor would hold a lock and block the DROP).
    with engine.begin() as c:
        if kind == "postgresql":
            c.execute(sa.text("SET lock_timeout = '3s'"))
        c.execute(sa.text("DROP TABLE snap_stream_src"))
        c.execute(sa.text("CREATE TABLE snap_stream_src (id int)"))


def test_memory_stays_bounded(source):
    kind, cfg, _e = source

    def peak(fn):
        tracemalloc.start()
        try:
            out = fn()
            return tracemalloc.get_traced_memory()[1], out
        finally:
            tracemalloc.stop()

    mem_peak, _ = peak(lambda: DSC.extract_generic_for_snapshot(kind, cfg, SQL, columns_meta=COLUMNS,
                                                                timeout_seconds=120))
    spool_peak, spool = peak(lambda: DSC.spool_extract_for_snapshot(kind, cfg, SQL, columns_meta=COLUMNS,
                                                                    timeout_seconds=120))
    spool.close()
    # The spool holds about one fetched batch; the old path held the table 3x.
    assert spool_peak * 5 < mem_peak, (spool_peak, mem_peak)


def test_the_loader_streams_the_spool_in_chunks(source, monkeypatch):
    """End to end through stream_extract_load_snapshot with the BigQuery writer
    stubbed: every row reaches the load, in bounded chunks, progress never
    goes backwards, and the declared/verified schema is the one loaded."""
    import app.services.datasource_service as dsmod

    kind, cfg, _e = source
    loads = []

    class _Job:
        def result(self, timeout=None):
            return None

    class _Writer:
        def load_table_from_json(self, rows, ref, job_config=None):
            loads.append((len(rows), [(f.name, f.field_type) for f in (job_config.schema or [])]))
            return _Job()

        def query(self, *_a, **_k):
            return _Job()

        def delete_table(self, *_a, **_k):
            return None

        def close(self):
            return None

    monkeypatch.setattr(dsmod, "_build_bigquery_client", lambda _cfg: _Writer())
    monkeypatch.setattr(dsmod, "_materialization_bq_config", lambda c: {"project_id": "p"})
    progress = []
    n, _warn = DSC.stream_extract_load_snapshot(
        source_ds_type=kind, source_config=cfg, resolved_sql=None, source_select_sql=SQL,
        columns_meta=COLUMNS, host_config={}, dataset_name="d", table_name="t", storage={},
        chunk_size=20_000, timeout_seconds=120, progress_cb=progress.append)
    assert n == ROWS == sum(c for c, _ in loads)
    assert max(c for c, _ in loads) <= 20_000
    assert progress == sorted(progress) and progress[-1] == ROWS
    assert dict(loads[0][1])["code"] == "STRING"


def test_the_loader_never_holds_the_table_in_memory(source, monkeypatch):
    """Fail-first lock on the ENTRY POINT that exists on both sides of the fix:
    the whole stream_extract_load_snapshot stays well under what holding the
    extracted table in memory costs."""
    import app.services.datasource_service as dsmod

    kind, cfg, _e = source

    class _Job:
        def result(self, timeout=None):
            return None

    class _Writer:
        def load_table_from_json(self, rows, ref, job_config=None):
            return _Job()

        def query(self, *_a, **_k):
            return _Job()

        def delete_table(self, *_a, **_k):
            return None

        def close(self):
            return None

    monkeypatch.setattr(dsmod, "_build_bigquery_client", lambda _cfg: _Writer())
    monkeypatch.setattr(dsmod, "_materialization_bq_config", lambda c: {"project_id": "p"})

    tracemalloc.start()
    try:
        DSC.extract_generic_for_snapshot(kind, cfg, SQL, columns_meta=COLUMNS, timeout_seconds=120)
        table_cost = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    tracemalloc.start()
    try:
        DSC.stream_extract_load_snapshot(
            source_ds_type=kind, source_config=cfg, resolved_sql=None, source_select_sql=SQL,
            columns_meta=COLUMNS, host_config={}, dataset_name="d", table_name="t", storage={},
            chunk_size=BATCH, timeout_seconds=120)
        loader_peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert loader_peak * 3 < table_cost, (loader_peak, table_cost)
