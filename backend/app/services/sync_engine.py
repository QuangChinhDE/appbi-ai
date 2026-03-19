"""
Sync engine: pulls data from a DataSource and caches it locally.

Local storage: the app's own PostgreSQL, schema 'synced'.
Table naming: ds{datasource_id}__{san_schema}__{san_table}  (all lowercase, non-alphanum → _)

Strategies per table (from sync_config.tables["{schema}.{table}"].strategy):
  full_refresh  — drop + recreate + insert everything  (default)
  incremental   — append only rows where watermark_col > local max
  append_only   — insert everything without truncating (keep history)
"""
from __future__ import annotations

import re
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import psycopg2
import psycopg2.extras

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import DataSource, SyncJob
from app.services.datasource_service import DataSourceConnectionService

logger = get_logger(__name__)

_SYNCED_SCHEMA = "synced"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sanitize(name: str) -> str:
    """Convert arbitrary identifier to a safe lowercase PG identifier segment."""
    return re.sub(r"[^a-zA-Z0-9]", "_", name).lower()


def _target_table(ds_id: int, schema: str, table: str) -> str:
    return f"ds{ds_id}__{_sanitize(schema)}__{_sanitize(table)}"


def _local_conn() -> psycopg2.extensions.connection:
    """Open a fresh psycopg2 connection to the local (app) PostgreSQL database."""
    url = settings.DATABASE_URL
    parsed = urlparse(url)
    return psycopg2.connect(
        host=parsed.hostname,
        port=parsed.port or 5432,
        dbname=parsed.path.lstrip("/"),
        user=parsed.username,
        password=parsed.password,
        connect_timeout=10,
    )


def _ensure_synced_schema(conn: psycopg2.extensions.connection) -> None:
    with conn.cursor() as cur:
        cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{_SYNCED_SCHEMA}"')
    conn.commit()


def _table_exists(conn: psycopg2.extensions.connection, table_name: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                WHERE table_schema = %s AND table_name = %s
            )
            """,
            (_SYNCED_SCHEMA, table_name),
        )
        return bool(cur.fetchone()[0])


def _source_type_to_local(pg_type: str) -> str:
    """Map a source column type string to a safe local DDL type."""
    t = pg_type.lower()
    if "int" in t:
        return "bigint"
    if t in ("numeric", "decimal", "real", "double precision", "float4", "float8", "money"):
        return "double precision"
    if "bool" in t:
        return "boolean"
    if "timestamp" in t:
        return "timestamp"
    if t == "date":
        return "date"
    if t in ("time", "timetz"):
        return "time"
    if "json" in t:
        return "jsonb"
    return "text"


def _create_or_replace_table(
    conn: psycopg2.extensions.connection,
    target_table: str,
    columns: List[Dict[str, Any]],
) -> None:
    col_defs = ", ".join(
        f'"{c["name"]}" {_source_type_to_local(c.get("type", "text"))}'
        for c in columns
    )
    with conn.cursor() as cur:
        cur.execute(f'DROP TABLE IF EXISTS "{_SYNCED_SCHEMA}"."{target_table}"')
        cur.execute(f'CREATE TABLE "{_SYNCED_SCHEMA}"."{target_table}" ({col_defs})')
    conn.commit()


def _ensure_table_exists(
    conn: psycopg2.extensions.connection,
    target_table: str,
    columns: List[Dict[str, Any]],
) -> None:
    """Create table only if it doesn't exist (used for append_only / incremental)."""
    if not _table_exists(conn, target_table):
        _create_or_replace_table(conn, target_table, columns)


def _bulk_insert(
    conn: psycopg2.extensions.connection,
    target_table: str,
    col_names: List[str],
    rows: List[Dict[str, Any]],
) -> int:
    if not rows:
        return 0
    placeholders = ", ".join(["%s"] * len(col_names))
    col_list = ", ".join(f'"{c}"' for c in col_names)
    sql = f'INSERT INTO "{_SYNCED_SCHEMA}"."{target_table}" ({col_list}) VALUES ({placeholders})'
    data = [[row.get(c) for c in col_names] for row in rows]
    with conn.cursor() as cur:
        psycopg2.extras.execute_batch(cur, sql, data, page_size=500)
    conn.commit()
    return len(data)


def _get_watermark_max(
    conn: psycopg2.extensions.connection,
    target_table: str,
    watermark_col: str,
) -> Optional[Any]:
    if not _table_exists(conn, target_table):
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                f'SELECT MAX("{watermark_col}") FROM "{_SYNCED_SCHEMA}"."{target_table}"'
            )
            row = cur.fetchone()
            return row[0] if row else None
    except Exception:
        return None


# ── Core sync logic ───────────────────────────────────────────────────────────

def _sync_one_table(
    ds: DataSource,
    schema_name: str,
    table_name: str,
    tbl_cfg: Dict[str, Any],
    local_conn: psycopg2.extensions.connection,
) -> int:
    """
    Sync a single table from the datasource into the local synced schema.
    Returns the number of rows synced.
    """
    strategy = tbl_cfg.get("strategy", "full_refresh")
    watermark_col: Optional[str] = tbl_cfg.get("watermark_column")
    target = _target_table(ds.id, schema_name, table_name)

    # Get column schema from source
    detail = DataSourceConnectionService.get_table_detail(
        ds.type, ds.config, schema_name, table_name, preview_rows=0
    )
    columns = detail["columns"]
    col_names = [c["name"] for c in columns]

    if strategy == "incremental" and watermark_col:
        last_max = _get_watermark_max(local_conn, target, watermark_col)
        if last_max is not None:
            # Pull only new/updated rows
            if isinstance(last_max, datetime):
                wm_literal = f"'{last_max.isoformat()}'"
            else:
                wm_literal = str(last_max)
            sql = (
                f'SELECT * FROM "{schema_name}"."{table_name}"'
                f' WHERE "{watermark_col}" > {wm_literal}'
            )
            _, rows, _ = DataSourceConnectionService.execute_query(
                ds.type, ds.config, sql, limit=None, timeout_seconds=120
            )
            _ensure_table_exists(local_conn, target, columns)
            return _bulk_insert(local_conn, target, col_names, rows)
        else:
            # First run — fall through to full_refresh behaviour
            strategy = "full_refresh"

    if strategy == "append_only":
        sql = f'SELECT * FROM "{schema_name}"."{table_name}"'
        _, rows, _ = DataSourceConnectionService.execute_query(
            ds.type, ds.config, sql, limit=None, timeout_seconds=120
        )
        _ensure_table_exists(local_conn, target, columns)
        return _bulk_insert(local_conn, target, col_names, rows)

    # full_refresh (default)
    sql = f'SELECT * FROM "{schema_name}"."{table_name}"'
    _, rows, _ = DataSourceConnectionService.execute_query(
        ds.type, ds.config, sql, limit=None, timeout_seconds=120
    )
    _create_or_replace_table(local_conn, target, columns)
    return _bulk_insert(local_conn, target, col_names, rows)


def _run_sync_job(data_source_id: int, job_id: int) -> None:
    """
    Core sync execution — runs in a background thread.
    Opens its own DB session and local connection so it is safe to call from any thread.
    """
    db = SessionLocal()
    local_conn = None
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

        local_conn = _local_conn()
        _ensure_synced_schema(local_conn)

        for schema_entry in schema_list:
            schema_name: str = schema_entry["schema"]
            for table_entry in schema_entry.get("tables", []):
                table_name: str = table_entry["name"]
                table_key = f"{schema_name}.{table_name}"
                tbl_cfg = table_configs.get(table_key, {})
                try:
                    count = _sync_one_table(ds, schema_name, table_name, tbl_cfg, local_conn)
                    total_rows += count
                    logger.info(f"[sync ds={data_source_id}] {table_key} → {count} rows")
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
        if local_conn:
            try:
                local_conn.close()
            except Exception:
                pass


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
