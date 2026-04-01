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
from datetime import date, datetime, timezone
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

    # Google Sheets and Manual datasources don't support incremental sync;
    # force full_refresh so users aren't silently stuck with stale data.
    ds_type_val = ds.type if isinstance(ds.type, str) else ds.type.value
    if strategy == "incremental" and ds_type_val in ("google_sheets", "manual"):
        logger.info(
            "[sync ds=%d] %s.%s: incremental not supported for %s — falling back to full_refresh",
            ds.id, schema_name, table_name, ds_type_val,
        )
        strategy = "full_refresh"

    if strategy == "incremental" and watermark_col:
        last_max = _get_watermark_max(ds.id, schema_name, table_name, watermark_col)
        if last_max is not None:
            if isinstance(last_max, datetime):
                wm_literal = f"'{last_max.isoformat()}'"
            elif isinstance(last_max, date):
                # date objects must also be quoted (otherwise 2024-01-01 is
                # interpreted as arithmetic 2024 - 1 - 1 = 2022 in BigQuery)
                wm_literal = f"'{last_max.isoformat()}'"
            else:
                wm_literal = str(last_max)

            # Build incremental SQL with correct quoting per datasource type
            if ds_type_val == "bigquery":
                from app.core.crypto import decrypt_config as _dec
                _cfg = _dec(ds.config)
                project_id = _cfg.get("project_id", "")
                sql = (
                    f"SELECT * FROM `{project_id}.{schema_name}.{table_name}`"
                    f" WHERE `{watermark_col}` > {wm_literal}"
                )
            elif ds_type_val == "mysql":
                sql = (
                    f"SELECT * FROM `{schema_name}`.`{table_name}`"
                    f" WHERE `{watermark_col}` > {wm_literal}"
                )
            else:
                # PostgreSQL (and any other SQL datasource)
                sql = (
                    f'SELECT * FROM "{schema_name}"."{table_name}"'
                    f' WHERE "{watermark_col}" > {wm_literal}'
                )

            _, rows, _ = DataSourceConnectionService.execute_query(
                ds.type, ds.config, sql, limit=None, timeout_seconds=300
            )
            if not rows:
                return 0
            ddir = _delta_dir(ds.id, schema_name, table_name)
            ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            delta_path = ddir / f"{ts}.parquet"
            count = _write_parquet(rows, delta_path)
            _register_duckdb_view(ds.id, schema_name, table_name)
            return count
        else:
            # First run — fall through to full_refresh
            strategy = "full_refresh"

    # full_refresh and append_only both fetch all rows from the source.
    # Use fetch_table_data() so each connector uses its native API directly
    # (no fake SQL generation + re-parsing inside GSheets / Manual connectors).
    _, rows = DataSourceConnectionService.fetch_table_data(
        ds.type, ds.config, schema_name, table_name
    )

    if strategy == "append_only":
        ddir = _delta_dir(ds.id, schema_name, table_name)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        delta_path = ddir / f"{ts}.parquet"
        count = _write_parquet(rows, delta_path)
    else:
        # full_refresh (default)
        ppath = _parquet_path(ds.id, schema_name, table_name)
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
        if not isinstance(table_configs, dict):
            # Guard: sync_config.tables must be a dict {table_key: config}.
            # If it's a list (malformed config), treat as empty — sync all tables with defaults.
            table_configs = {}

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

def get_synced_view(ds_id: int, source_table_name: str) -> Optional[str]:
    """
    Return the DuckDB view name if this physical table has been synced, else None.

    source_table_name: "public.orders", "manual.sheet1", or bare "orders".

    When a schema prefix is present → check that exact view.
    When no schema prefix → search all synced views for this datasource that
    match the table name in any schema (handles manual/sheets where schema="manual"
    or Google Sheets where schema=spreadsheet_id).
    """
    from app.services.duckdb_engine import DuckDBEngine

    name = source_table_name.strip('"').strip("'").strip()
    if "." in name:
        parts = name.split(".", 1)
        schema = parts[0].strip('"').strip("'")
        table = parts[1].strip('"').strip("'")
        vname = _view_name(ds_id, schema, table)
        try:
            with DuckDBEngine.read_conn() as conn:
                result = conn.execute(
                    "SELECT COUNT(*) FROM duckdb_views() WHERE view_name = ?",
                    [vname],
                ).fetchone()
                if result and result[0] > 0:
                    # Probe: verify underlying parquet is accessible (not stale)
                    try:
                        conn.execute(f"SELECT 1 FROM {vname} LIMIT 0")
                        return vname
                    except Exception:
                        return None
        except Exception:
            pass
        return None
    else:
        # No schema prefix — search all synced views for this datasource
        # whose name ends with __{sanitized_table}
        sanitized = _sanitize(name)
        prefix = f"synced_ds{ds_id}__"
        suffix = f"__{sanitized}"
        try:
            with DuckDBEngine.read_conn() as conn:
                rows = conn.execute(
                    "SELECT view_name FROM duckdb_views() WHERE view_name LIKE ?",
                    [f"{prefix}%{suffix}"],
                ).fetchall()
            if rows:
                vname = rows[0][0]
                # Probe: verify underlying parquet is accessible (not stale)
                try:
                    with DuckDBEngine.read_conn() as conn2:
                        conn2.execute(f"SELECT 1 FROM {vname} LIMIT 0")
                    return vname
                except Exception:
                    return None
        except Exception:
            pass
        return None


def _get_synced_view_set(ds_id: int) -> set:
    """Return the set of all DuckDB view names that have been synced for ds_id.

    Probes each candidate view with SELECT 1 LIMIT 0 to filter out stale views
    whose underlying parquet files have been deleted.
    """
    from app.services.duckdb_engine import DuckDBEngine

    prefix = f"synced_ds{ds_id}__"
    try:
        with DuckDBEngine.read_conn() as conn:
            rows = conn.execute(
                "SELECT view_name FROM duckdb_views() WHERE view_name LIKE ?",
                [f"{prefix}%"],
            ).fetchall()
        valid = set()
        for (vname,) in rows:
            try:
                with DuckDBEngine.read_conn() as probe:
                    probe.execute(f"SELECT 1 FROM {vname} LIMIT 0")
                valid.add(vname)
            except Exception:
                pass  # stale view — parquet missing or corrupt
        return valid
    except Exception:
        return set()


def rewrite_sql_for_duckdb(ds_id: int, sql: str) -> Optional[str]:
    """
    Rewrite arbitrary SQL to reference DuckDB synced views instead of source tables.

    Strategy (two passes):
      1. Replace schema-qualified refs: "schema"."table" or schema.table
         → alias.column refs (e.g. o.id) won't match any view → left unchanged, safe.
      2. Replace bare table names after FROM/JOIN keywords (assumes default schema "public").
         → CTE names, subquery aliases won't have views → left unchanged, safe.

    Returns rewritten SQL if at least one table was substituted, else None.
    Caller must execute in DuckDB and fall back to live query on any exception
    (handles CTEs, unresolved aliases, or other edge cases).
    """
    import re

    synced = _get_synced_view_set(ds_id)
    if not synced:
        return None

    any_replaced = False

    def resolve(schema: str, table: str) -> Optional[str]:
        vn = _view_name(ds_id, schema, table)
        return vn if vn in synced else None

    # --- Pass 1: schema-qualified refs ----------------------------------------
    def _sub_qualified(m: re.Match) -> str:
        nonlocal any_replaced
        if m.group(1) is not None:       # "schema"."table"
            schema, table = m.group(1), m.group(2)
        else:                             # schema.table
            schema, table = m.group(3), m.group(4)
        vn = resolve(schema, table)
        if vn:
            any_replaced = True
            return vn
        return m.group(0)

    rewritten = re.sub(
        r'"([^"]+)"\s*\.\s*"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)',
        _sub_qualified,
        sql,
        flags=re.IGNORECASE,
    )

    # --- Pass 2: bare table names after FROM / JOIN variants ------------------
    # Scan all synced views using an endswith() check on the sanitized table
    # name suffix.  This is robust even when the sanitized schema name itself
    # contains "__" (e.g. spreadsheet IDs with adjacent hyphens "a--b" →
    # "a__b"), which breaks the old split("__")[0] schema-extraction approach.

    def _sub_bare(m: re.Match) -> str:
        nonlocal any_replaced
        keyword = m.group(1)
        # group 2 = double-quoted "Table Name", group 3 = unquoted bare_name
        raw_table = m.group(2) if m.group(2) is not None else m.group(3)
        if not raw_table:
            return m.group(0)
        suffix = f"__{_sanitize(raw_table)}"
        candidates = [v for v in synced if v.endswith(suffix)]
        if candidates:
            any_replaced = True
            # Add AS alias so column qualifiers like "Workload"."col" still resolve
            return f'{keyword} {candidates[0]} AS "{raw_table}"'
        return m.group(0)

    rewritten = re.sub(
        r'(?i)\b((?:(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+)?(?:OUTER\s+)?JOIN|FROM)\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*)\b)',
        _sub_bare,
        rewritten,
    )

    return rewritten if any_replaced else None


def cleanup_datasource_data(ds_id: int) -> None:
    """
    Remove all local data for a deleted datasource:
      - Drop DuckDB views (synced_ds{id}__*)
      - Delete Parquet directory (.data/synced/{id}/)

    Safe to call even when data doesn't exist. Errors are logged, not raised.
    """
    from app.services.duckdb_engine import DuckDBEngine

    prefix = f"synced_ds{ds_id}__"

    # Drop all DuckDB views for this datasource
    try:
        with DuckDBEngine.write_conn() as conn:
            rows = conn.execute(
                "SELECT view_name FROM duckdb_views() WHERE view_name LIKE ?",
                [f"{prefix}%"],
            ).fetchall()
            for (vname,) in rows:
                try:
                    conn.execute(f"DROP VIEW IF EXISTS {vname}")
                    logger.info("Dropped DuckDB view %s (datasource %d deleted)", vname, ds_id)
                except Exception as e:
                    logger.warning("Failed to drop view %s: %s", vname, e)
    except Exception as e:
        logger.warning("cleanup_datasource_data: DuckDB cleanup failed for ds %d: %s", ds_id, e)

    # Delete parquet directory
    parquet_dir = DATA_DIR / "synced" / str(ds_id)
    if parquet_dir.exists():
        try:
            shutil.rmtree(parquet_dir)
            logger.info("Deleted parquet dir %s (datasource %d deleted)", parquet_dir, ds_id)
        except Exception as e:
            logger.warning("cleanup_datasource_data: parquet delete failed for ds %d: %s", ds_id, e)

    # Refresh read pool so dropped views are gone
    try:
        DuckDBEngine._refresh_read_pool()
    except Exception:
        pass


def restore_synced_views() -> int:
    """
    Scan .data/synced/ on startup and re-register all existing Parquet files
    as DuckDB views.  Called once during app lifespan so views survive container
    restarts without requiring a re-sync.

    Zombie directories (datasource deleted from Postgres) are cleaned up here.

    Returns the number of views restored.
    """
    from app.services.duckdb_engine import DuckDBEngine

    synced_root = DATA_DIR / "synced"
    if not synced_root.exists():
        return 0

    # Build the set of valid datasource IDs from Postgres once
    valid_ds_ids: set | None = None
    try:
        db = SessionLocal()
        try:
            valid_ds_ids = {row[0] for row in db.query(DataSource.id).all()}
        finally:
            db.close()
    except Exception as e:
        logger.warning("Startup: could not query datasources — zombie cleanup skipped: %s", e)

    restored = 0
    errors = 0

    for ds_dir in sorted(synced_root.iterdir()):
        if not ds_dir.is_dir():
            continue
        try:
            ds_id = int(ds_dir.name)
        except ValueError:
            continue

        # Remove zombie directories for datasources deleted from Postgres
        if valid_ds_ids is not None and ds_id not in valid_ds_ids:
            logger.warning(
                "Startup: datasource %d no longer exists — removing zombie parquet dir %s",
                ds_id, ds_dir,
            )
            shutil.rmtree(ds_dir, ignore_errors=True)
            continue

        for table_dir in sorted(ds_dir.iterdir()):
            if not table_dir.is_dir():
                continue

            ppath = table_dir / "data.parquet"
            if not ppath.exists():
                continue

            # dir_name is already "{_sanitize(schema)}__{_sanitize(table)}"
            # so view name = f"synced_ds{ds_id}__{dir_name}" matches _view_name() exactly
            dir_name = table_dir.name
            vname = f"synced_ds{ds_id}__{dir_name}"
            ddir = table_dir / "delta"

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

            try:
                with DuckDBEngine.write_conn() as conn:
                    conn.execute(sql)
                restored += 1
                logger.info("Startup: restored DuckDB VIEW %s", vname)
            except Exception as e:
                errors += 1
                logger.warning("Startup: failed to restore VIEW %s: %s", vname, e)

    if restored or errors:
        try:
            DuckDBEngine._refresh_read_pool()
        except Exception:
            pass

    logger.info("Startup view restore: %d restored, %d errors", restored, errors)
    return restored


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
