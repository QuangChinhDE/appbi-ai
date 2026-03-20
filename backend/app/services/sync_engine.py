"""
Sync engine: pulls data from a DataSource and caches it locally.

Local storage: Parquet files + DuckDB views (OLAP-friendly, no PostgreSQL overhead).
  .data/synced/{ds_id}/{schema}__{table}/data.parquet    ← main data
  .data/synced/{ds_id}/{schema}__{table}/delta/*.parquet ← incremental/append deltas

DuckDB VIEW naming: synced_ds{id}__{schema}__{table}

Strategies per table (from sync_config.tables["{schema}.{table}"].strategy):
  full_refresh  — re-pull everything → data.parquet   (default)
  incremental   — pull WHERE watermark > last → delta/
  append_only   — pull all → delta/ (keep history)
"""
from __future__ import annotations

import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import pyarrow as pa
import pyarrow.parquet as pq

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import DataSource, SyncJob
from app.services.datasource_service import DataSourceConnectionService
from app.services.ingestion_engine import DATA_DIR

logger = get_logger(__name__)

BATCH_SIZE = 10_000


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sanitize(name: str) -> str:
    """Convert arbitrary identifier to a safe lowercase identifier segment."""
    return re.sub(r"[^a-zA-Z0-9]", "_", name).lower()


def _view_name(ds_id: int, schema: str, table: str) -> str:
    return f"synced_ds{ds_id}__{_sanitize(schema)}__{_sanitize(table)}"


def _parquet_dir(ds_id: int, schema: str, table: str) -> Path:
    """Directory holding Parquet files for a synced table."""
    return DATA_DIR / "synced" / str(ds_id) / f"{_sanitize(schema)}__{_sanitize(table)}"


def _parquet_path(ds_id: int, schema: str, table: str) -> Path:
    return _parquet_dir(ds_id, schema, table) / "data.parquet"


def _delta_dir(ds_id: int, schema: str, table: str) -> Path:
    return _parquet_dir(ds_id, schema, table) / "delta"


def _write_parquet(rows: List[Dict[str, Any]], output_path: Path) -> int:
    """Write rows to a Parquet file in batches. Returns row count."""
    if not rows:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        # Write empty file with minimal schema
        table = pa.table({"_empty": pa.array([], type=pa.string())})
        pq.write_table(table, str(output_path), compression="snappy")
        return 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer: Optional[pq.ParquetWriter] = None
    total = 0
    try:
        for start in range(0, len(rows), BATCH_SIZE):
            batch = rows[start : start + BATCH_SIZE]
            arrow_table = pa.Table.from_pylist(batch)
            if writer is None:
                writer = pq.ParquetWriter(
                    str(output_path), arrow_table.schema, compression="snappy"
                )
            writer.write_table(arrow_table)
            total += len(batch)
    finally:
        if writer:
            writer.close()
    return total


def _register_duckdb_view(ds_id: int, schema: str, table: str) -> None:
    """Register or refresh a DuckDB VIEW pointing at the Parquet files."""
    from app.services.duckdb_engine import DuckDBEngine

    vname = _view_name(ds_id, schema, table)
    ppath = _parquet_path(ds_id, schema, table)
    ddir = _delta_dir(ds_id, schema, table)

    if not ppath.exists():
        return

    if ddir.exists() and any(ddir.glob("*.parquet")):
        delta_glob = str(ddir / "*.parquet")
        sql = (
            f"CREATE OR REPLACE VIEW {vname} AS "
            f"SELECT * FROM read_parquet(['{ppath}', '{delta_glob}'])"
        )
    else:
        sql = (
            f"CREATE OR REPLACE VIEW {vname} AS "
            f"SELECT * FROM read_parquet('{ppath}')"
        )

    with DuckDBEngine.write_conn() as conn:
        conn.execute(sql)
    DuckDBEngine._refresh_read_pool()
    logger.info("DuckDB VIEW registered: %s", vname)


def _get_watermark_max(ds_id: int, schema: str, table: str, watermark_col: str) -> Optional[Any]:
    """Read MAX(watermark_col) from DuckDB VIEW for incremental sync."""
    from app.services.duckdb_engine import DuckDBEngine

    vname = _view_name(ds_id, schema, table)
    try:
        rows = DuckDBEngine.query(f'SELECT MAX("{watermark_col}") AS wm FROM {vname}')
        if rows and rows[0]["wm"] is not None:
            return rows[0]["wm"]
    except Exception:
        pass
    return None


# ── Core sync logic ───────────────────────────────────────────────────────────

def _sync_one_table(
    ds: DataSource,
    schema_name: str,
    table_name: str,
    tbl_cfg: Dict[str, Any],
) -> int:
    """
    Sync a single table from the datasource into Parquet + DuckDB.
    Returns the number of rows synced.
    """
    strategy = tbl_cfg.get("strategy", "full_refresh")
    watermark_col: Optional[str] = tbl_cfg.get("watermark_column")

    if strategy == "incremental" and watermark_col:
        last_max = _get_watermark_max(ds.id, schema_name, table_name, watermark_col)
        if last_max is not None:
            if isinstance(last_max, datetime):
                wm_literal = f"'{last_max.isoformat()}'"
            else:
                wm_literal = str(last_max)
            sql = (
                f'SELECT * FROM "{schema_name}"."{table_name}"'
                f' WHERE "{watermark_col}" > {wm_literal}'
            )
            _, rows, _ = DataSourceConnectionService.execute_query(
                ds.type, ds.config, sql, limit=None, timeout_seconds=300
            )
            if not rows:
                return 0
            # Write to delta directory
            ddir = _delta_dir(ds.id, schema_name, table_name)
            ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            delta_path = ddir / f"{ts}.parquet"
            count = _write_parquet(rows, delta_path)
            _register_duckdb_view(ds.id, schema_name, table_name)
            return count
        else:
            # First run — fall through to full_refresh
            strategy = "full_refresh"

    if strategy == "append_only":
        sql = f'SELECT * FROM "{schema_name}"."{table_name}"'
        _, rows, _ = DataSourceConnectionService.execute_query(
            ds.type, ds.config, sql, limit=None, timeout_seconds=300
        )
        ddir = _delta_dir(ds.id, schema_name, table_name)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        delta_path = ddir / f"{ts}.parquet"
        count = _write_parquet(rows, delta_path)
        _register_duckdb_view(ds.id, schema_name, table_name)
        return count

    # full_refresh (default)
    sql = f'SELECT * FROM "{schema_name}"."{table_name}"'
    _, rows, _ = DataSourceConnectionService.execute_query(
        ds.type, ds.config, sql, limit=None, timeout_seconds=300
    )
    ppath = _parquet_path(ds.id, schema_name, table_name)
    # Clear delta directory on full refresh
    ddir = _delta_dir(ds.id, schema_name, table_name)
    if ddir.exists():
        shutil.rmtree(ddir)
    count = _write_parquet(rows, ppath)
    _register_duckdb_view(ds.id, schema_name, table_name)
    return count


def _run_sync_job(data_source_id: int, job_id: int) -> None:
    """
    Core sync execution — runs in a background thread.
    Opens its own DB session so it is safe to call from any thread.
    """
    db = SessionLocal()
    total_rows = 0
    total_failed = 0
    errors: List[str] = []

    try:
        ds: Optional[DataSource] = (
            db.query(DataSource).filter(DataSource.id == data_source_id).first()
        )
        if not ds:
            raise ValueError(f"DataSource {data_source_id} not found")

        job: Optional[SyncJob] = (
            db.query(SyncJob).filter(SyncJob.id == job_id).first()
        )
        if not job:
            raise ValueError(f"SyncJob {job_id} not found")

        sync_config = ds.sync_config or {}
        table_configs: Dict[str, Dict] = sync_config.get("tables", {})

        schema_list = DataSourceConnectionService.get_schema_browser(ds.type, ds.config)
        if not schema_list:
            raise ValueError("No schemas/tables found in datasource")

        for schema_entry in schema_list:
            schema_name: str = schema_entry["schema"]
            for table_entry in schema_entry.get("tables", []):
                table_name: str = table_entry["name"]
                table_key = f"{schema_name}.{table_name}"
                tbl_cfg = table_configs.get(table_key, {})

                # Skip disabled tables
                if not tbl_cfg.get("enabled", True):
                    logger.info(f"[sync ds={data_source_id}] {table_key} → skipped (disabled)")
                    continue

                try:
                    count = _sync_one_table(ds, schema_name, table_name, tbl_cfg)
                    total_rows += count
                    logger.info(f"[sync ds={data_source_id}] {table_key} → {count} rows → Parquet")
                except Exception as e:
                    errors.append(f"{table_key}: {e}")
                    total_failed += 1
                    logger.error(f"[sync ds={data_source_id}] {table_key} error: {e}", exc_info=True)

        # Mark job finished
        job.status = "success" if not errors else "failed"
        job.finished_at = datetime.now(timezone.utc)
        job.rows_synced = total_rows
        job.rows_failed = total_failed
        job.error_message = "\n".join(errors) if errors else None
        db.commit()
        logger.info(
            f"[sync ds={data_source_id}] job={job_id} finished: "
            f"status={job.status} rows={total_rows} failed={total_failed}"
        )

    except Exception as e:
        logger.error(f"[sync ds={data_source_id}] job={job_id} fatal: {e}", exc_info=True)
        try:
            job = db.query(SyncJob).filter(SyncJob.id == job_id).first()
            if job:
                job.status = "failed"
                job.finished_at = datetime.now(timezone.utc)
                job.error_message = str(e)
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


# ── Public API ────────────────────────────────────────────────────────────────

def trigger_sync(data_source_id: int, job_id: int) -> threading.Thread:
    """
    Start a sync job in a daemon background thread (non-blocking).
    Returns the thread so callers can join() if needed.
    """
    t = threading.Thread(
        target=_run_sync_job,
        args=(data_source_id, job_id),
        daemon=True,
        name=f"sync-ds{data_source_id}-job{job_id}",
    )
    t.start()
    return t
