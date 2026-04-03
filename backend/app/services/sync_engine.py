"""
Sync engine: pulls data from a DataSource and caches it locally.

Local storage: Parquet files + DuckDB views (OLAP-friendly, no PostgreSQL overhead).
  .data/synced/{ds_id}/{schema}__{table}/data.parquet    ← main data (or data_*.parquet shards)
  .data/synced/{ds_id}/{schema}__{table}/delta/*.parquet ← incremental/append deltas

DuckDB VIEW naming: synced_ds{id}__{schema}__{table}

Strategies per table (from sync_config.tables["{schema}.{table}"].strategy):
  full_refresh  — re-pull everything → data.parquet   (default)
  incremental   — pull WHERE watermark > last → delta/
  append_only   — pull all → delta/ (keep history)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor, Future
from datetime import date, datetime, timezone
from pathlib import Path
from queue import Queue, Empty
from typing import Any, Callable, Dict, Generator, List, Optional

import pyarrow as pa
import pyarrow.parquet as pq

from collections import deque
from typing import Deque

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import DataSource, SyncJob
from app.services.datasource_service import DataSourceConnectionService
from app.services.ingestion_engine import DATA_DIR

logger = get_logger(__name__)

# Batch size for writing already-fetched rows into Parquet (legacy path).
# Each write_table() call creates one Parquet row group; 50K rows per group
# balances DuckDB zone-map granularity against metadata overhead.
BATCH_SIZE = int(os.environ.get("SYNC_STREAM_BATCH_SIZE", "50000"))
_MAX_LOG_LINES = 2_000  # ring-buffer size per job

# Number of parallel writer threads for sharded Parquet write.
# Each writer owns one output shard and receives batches via a Queue.
# Set via env var SYNC_WRITER_THREADS (default 4, max 16).
SYNC_WRITER_THREADS = min(int(os.environ.get("SYNC_WRITER_THREADS", "4")), 16)

# Delta compaction: merge base + deltas into new sharded base when thresholds
# are exceeded.  Runs automatically after each successful incremental sync.
COMPACT_DELTA_FILE_THRESHOLD = 10     # compact when > N delta files
COMPACT_DELTA_SIZE_RATIO = 1.0        # compact when delta_total_bytes > ratio * base_bytes

# Checkpoint: rows between periodic checkpoint saves during a sync.
# Lower = more frequent checkpoints but slightly more I/O overhead.
CHECKPOINT_INTERVAL = 500_000

# ── Live log + cancel infrastructure ──────────────────────────────────────
# Keyed by job_id so multiple concurrent syncs are isolated.

_sync_logs: Dict[int, Deque[Dict[str, Any]]] = {}
_sync_cancel_flags: Dict[int, threading.Event] = {}
_sync_table_progress: Dict[int, Dict[str, str]] = {}  # job_id → {table_key: status}


class SyncCancelled(Exception):
    """Raised when a running sync is cancelled by the user."""


def _emit_log(
    job_id: int,
    level: str,
    message: str,
    *,
    table_key: str | None = None,
) -> None:
    """Append a structured log entry to the in-memory buffer for *job_id*."""
    buf = _sync_logs.get(job_id)
    if buf is None:
        buf = deque(maxlen=_MAX_LOG_LINES)
        _sync_logs[job_id] = buf
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
    }
    if table_key:
        entry["table"] = table_key
    buf.append(entry)


def _log_sync_message(
    level: str,
    message: str,
    *,
    job_id: int | None = None,
    table_key: str | None = None,
) -> None:
    """Write a sync message to logger and optionally to the SSE in-memory buffer."""
    log_fn = getattr(logger, level.lower(), logger.info)
    log_fn(message)
    if job_id is not None:
        _emit_log(job_id, level, message, table_key=table_key)


def _check_cancel(job_id: int) -> None:
    """Raise SyncCancelled if the cancel flag is set."""
    flag = _sync_cancel_flags.get(job_id)
    if flag and flag.is_set():
        raise SyncCancelled("Sync cancelled by user")


def cancel_sync(job_id: int) -> bool:
    """Request cancellation for a running sync job. Returns True if flag existed."""
    flag = _sync_cancel_flags.get(job_id)
    if flag:
        flag.set()
        _emit_log(job_id, "WARN", "Cancel requested by user")
        return True
    return False


def get_sync_logs(job_id: int, after: int = 0) -> List[Dict[str, Any]]:
    """Return log entries for *job_id* starting from index *after*."""
    buf = _sync_logs.get(job_id)
    if not buf:
        return []
    items = list(buf)
    return items[after:]


def get_table_progress(job_id: int) -> Dict[str, str]:
    """Return per-table status map for a running job."""
    return dict(_sync_table_progress.get(job_id, {}))


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


def _staging_dir(ds_id: int, schema: str, table: str) -> Path:
    """Staging directory for full_refresh: write here first, swap on success."""
    return _parquet_dir(ds_id, schema, table) / ".staging"


def _checkpoint_path(ds_id: int, schema: str, table: str) -> Path:
    return _parquet_dir(ds_id, schema, table) / ".checkpoint.json"


def _save_checkpoint(
    ds_id: int, schema: str, table: str, data: Dict[str, Any],
) -> None:
    """Persist checkpoint state to disk (atomic write)."""
    cp = _checkpoint_path(ds_id, schema, table)
    cp.parent.mkdir(parents=True, exist_ok=True)
    tmp = cp.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, default=str), encoding="utf-8")
    tmp.rename(cp)


def _load_checkpoint(ds_id: int, schema: str, table: str) -> Optional[Dict[str, Any]]:
    """Load checkpoint from disk if it exists."""
    cp = _checkpoint_path(ds_id, schema, table)
    if cp.exists():
        try:
            return json.loads(cp.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            cp.unlink(missing_ok=True)
    return None


def _clear_checkpoint(ds_id: int, schema: str, table: str) -> None:
    _checkpoint_path(ds_id, schema, table).unlink(missing_ok=True)


def _skip_rows_arrow(
    record_batches: Generator["pa.RecordBatch", None, None],
    rows_to_skip: int,
) -> Generator["pa.RecordBatch", None, None]:
    """Skip the first *rows_to_skip* rows from an Arrow RecordBatch stream."""
    remaining = rows_to_skip
    for rb in record_batches:
        if remaining <= 0:
            yield rb
            continue
        if rb.num_rows <= remaining:
            remaining -= rb.num_rows
            continue
        yield rb.slice(remaining)
        remaining = 0


def _skip_rows_dicts(
    batches: Generator[List[Dict[str, Any]], None, None],
    rows_to_skip: int,
) -> Generator[List[Dict[str, Any]], None, None]:
    """Skip the first *rows_to_skip* rows from a dict-batch stream."""
    remaining = rows_to_skip
    for batch in batches:
        if remaining <= 0:
            yield batch
            continue
        if len(batch) <= remaining:
            remaining -= len(batch)
            continue
        yield batch[remaining:]
        remaining = 0


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
                    str(output_path), arrow_table.schema,
                    compression="snappy",
                    write_statistics=True,
                )
            writer.write_table(arrow_table)
            total += len(batch)
    finally:
        if writer:
            writer.close()
    return total


def _write_parquet_from_stream(
    batches: Generator[List[Dict[str, Any]], None, None],
    output_path: Path,
    *,
    job_id: int | None = None,
    table_key: str | None = None,
    checkpoint_fn: Callable[[int], None] | None = None,
) -> int:
    """
    Write rows from a streaming generator to a Parquet file.

    Each yielded item is a list of dicts (one batch).  Memory usage stays at
    O(batch_size) regardless of total row count.

    Returns the total number of rows written.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer: Optional[pq.ParquetWriter] = None
    total = 0
    last_cp = 0

    try:
        for batch in batches:
            if not batch:
                continue
            # Check cancel between batches
            if job_id is not None:
                _check_cancel(job_id)
            arrow_table = pa.Table.from_pylist(batch)
            if writer is None:
                writer = pq.ParquetWriter(
                    str(output_path), arrow_table.schema,
                    compression="snappy",
                    write_statistics=True,
                )
            writer.write_table(arrow_table)
            total += len(batch)
            if total % 100_000 == 0:
                msg = f"[WRITE] streamed {total:,} rows to {output_path.name}"
                _log_sync_message("INFO", msg, job_id=job_id, table_key=table_key)
            # Periodic checkpoint
            if checkpoint_fn and total - last_cp >= CHECKPOINT_INTERVAL:
                checkpoint_fn(total)
                last_cp = total
    finally:
        if writer:
            writer.close()

    if total == 0:
        # No rows received — write empty parquet
        table = pa.table({"_empty": pa.array([], type=pa.string())})
        pq.write_table(table, str(output_path), compression="snappy")

    return total


# ── Sharded parallel writer ──────────────────────────────────────────────────

_SENTINEL = object()  # poison pill for writer threads


def _shard_writer(
    shard_queue: "Queue[Any]",
    output_path: Path,
    shard_idx: int,
) -> int:
    """
    Worker: pulls batches from *shard_queue* and writes them to a single
    Parquet shard file.  Returns the total number of rows written.

    Reads from the queue until it receives _SENTINEL.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer: Optional[pq.ParquetWriter] = None
    total = 0

    try:
        while True:
            try:
                item = shard_queue.get(timeout=2)
            except Empty:
                continue
            if item is _SENTINEL:
                break
            arrow_table: pa.Table = item
            if writer is None:
                writer = pq.ParquetWriter(
                    str(output_path), arrow_table.schema,
                    compression="snappy",
                    write_statistics=True,
                )
            writer.write_table(arrow_table)
            total += arrow_table.num_rows
    finally:
        if writer:
            writer.close()
    return total


def _write_parquet_sharded(
    batches: Generator[List[Dict[str, Any]], None, None],
    output_dir: Path,
    *,
    num_shards: int = SYNC_WRITER_THREADS,
    start_shard_idx: int = 0,
    job_id: int | None = None,
    table_key: str | None = None,
    checkpoint_fn: Callable[[int], None] | None = None,
) -> int:
    """
    Parallel sharded Parquet writer.

    Distributes incoming batches round-robin across *num_shards* writer
    threads.  Each thread writes its own shard file:
        output_dir / data_{start_shard_idx:03d}.parquet
        output_dir / data_{start_shard_idx+1:03d}.parquet
        ...

    Returns the total number of rows written across all shards.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # One queue per shard writer (bounded to limit memory if writers lag)
    queues: List[Queue] = [Queue(maxsize=8) for _ in range(num_shards)]
    shard_paths = [
        output_dir / f"data_{start_shard_idx + i:03d}.parquet" for i in range(num_shards)
    ]

    total = 0
    shard_cursor = 0
    last_cp = 0

    with ThreadPoolExecutor(max_workers=num_shards, thread_name_prefix="parquet-shard") as pool:
        # Launch writer threads
        futures: List[Future] = [
            pool.submit(_shard_writer, queues[i], shard_paths[i], i)
            for i in range(num_shards)
        ]

        try:
            for batch in batches:
                if not batch:
                    continue
                # Cancel check
                if job_id is not None:
                    _check_cancel(job_id)

                arrow_table = pa.Table.from_pylist(batch)
                # Round-robin distribute to shard writers
                queues[shard_cursor % num_shards].put(arrow_table)
                shard_cursor += 1
                total += len(batch)

                if total % 100_000 == 0:
                    msg = (
                        f"[WRITE] streamed {total:,} rows to data_*.parquet "
                        f"({num_shards} shards)"
                    )
                    _log_sync_message("INFO", msg, job_id=job_id, table_key=table_key)
                # Periodic checkpoint
                if checkpoint_fn and total - last_cp >= CHECKPOINT_INTERVAL:
                    checkpoint_fn(total)
                    last_cp = total
        finally:
            # Signal all writers to stop
            for q in queues:
                q.put(_SENTINEL)

        # Wait for all writers and collect row counts
        shard_total = 0
        for fut in futures:
            shard_total += fut.result(timeout=300)

    if total == 0:
        # No rows received — write single empty shard
        tbl = pa.table({"_empty": pa.array([], type=pa.string())})
        pq.write_table(tbl, str(shard_paths[0]), compression="snappy")

    return total


def _write_parquet_from_arrow_stream(
    record_batches: Generator["pa.RecordBatch", None, None],
    output_dir: Path,
    *,
    num_shards: int = SYNC_WRITER_THREADS,
    start_shard_idx: int = 0,
    job_id: int | None = None,
    table_key: str | None = None,
    checkpoint_fn: Callable[[int], None] | None = None,
) -> int:
    """
    Write Arrow RecordBatches directly to sharded Parquet files.

    This is the **fastest path** for BigQuery sync because:
    - RecordBatches come from BigQuery in Arrow wire format (zero Python-dict overhead)
    - Multiple writer threads compress + write in parallel

    Falls back to single-file write if num_shards <= 1.
    Returns total row count.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    if num_shards <= 1:
        # Simple single-file path
        output_path = output_dir / "data.parquet"
        writer: Optional[pq.ParquetWriter] = None
        total = 0
        last_cp = 0
        try:
            for rb in record_batches:
                if job_id is not None:
                    _check_cancel(job_id)
                tbl = pa.Table.from_batches([rb])
                if writer is None:
                    writer = pq.ParquetWriter(
                        str(output_path), tbl.schema,
                        compression="snappy", write_statistics=True,
                    )
                writer.write_table(tbl)
                total += rb.num_rows
                if total % 100_000 == 0:
                    msg = f"[WRITE] streamed {total:,} rows to data.parquet"
                    _log_sync_message("INFO", msg, job_id=job_id, table_key=table_key)
                if checkpoint_fn and total - last_cp >= CHECKPOINT_INTERVAL:
                    checkpoint_fn(total)
                    last_cp = total
        finally:
            if writer:
                writer.close()
        if total == 0:
            tbl = pa.table({"_empty": pa.array([], type=pa.string())})
            pq.write_table(tbl, str(output_path), compression="snappy")
        return total

    # Multi-shard path
    queues: List[Queue] = [Queue(maxsize=8) for _ in range(num_shards)]
    shard_paths = [output_dir / f"data_{start_shard_idx + i:03d}.parquet" for i in range(num_shards)]

    total = 0
    shard_cursor = 0
    last_cp = 0

    with ThreadPoolExecutor(max_workers=num_shards, thread_name_prefix="arrow-shard") as pool:
        futures: List[Future] = [
            pool.submit(_shard_writer, queues[i], shard_paths[i], i)
            for i in range(num_shards)
        ]

        try:
            for rb in record_batches:
                if job_id is not None:
                    _check_cancel(job_id)
                tbl = pa.Table.from_batches([rb])
                queues[shard_cursor % num_shards].put(tbl)
                shard_cursor += 1
                total += rb.num_rows

                if total % 100_000 == 0:
                    msg = (
                        f"[WRITE] streamed {total:,} rows to data_*.parquet "
                        f"({num_shards} shards)"
                    )
                    _log_sync_message("INFO", msg, job_id=job_id, table_key=table_key)
                if checkpoint_fn and total - last_cp >= CHECKPOINT_INTERVAL:
                    checkpoint_fn(total)
                    last_cp = total
        finally:
            for q in queues:
                q.put(_SENTINEL)

        for fut in futures:
            fut.result(timeout=300)

    if total == 0:
        tbl = pa.table({"_empty": pa.array([], type=pa.string())})
        pq.write_table(tbl, str(shard_paths[0]), compression="snappy")

    return total


def _register_duckdb_view(ds_id: int, schema: str, table: str) -> None:
    """Register or refresh a DuckDB VIEW pointing at the Parquet files.

    Supports both single-file (data.parquet) and sharded (data_*.parquet)
    layouts, plus optional incremental delta files.
    """
    from app.services.duckdb_engine import DuckDBEngine

    vname = _view_name(ds_id, schema, table)
    pdir = _parquet_dir(ds_id, schema, table)
    ppath = _parquet_path(ds_id, schema, table)      # data.parquet
    ddir = _delta_dir(ds_id, schema, table)

    # Collect all parquet sources
    sources: List[str] = []

    # Check for sharded files (data_000.parquet, data_001.parquet, ...)
    shard_files = sorted(pdir.glob("data_*.parquet")) if pdir.exists() else []
    if shard_files:
        sources.append(str(pdir / "data_*.parquet"))
    elif ppath.exists():
        sources.append(str(ppath))

    if not sources:
        return

    # Include delta files if present
    if ddir.exists() and any(ddir.glob("*.parquet")):
        sources.append(str(ddir / "*.parquet"))

    if len(sources) == 1:
        sql = (
            f"CREATE OR REPLACE VIEW {vname} AS "
            f"SELECT * FROM read_parquet('{sources[0]}', union_by_name=true)"
        )
    else:
        source_list = ", ".join(f"'{s}'" for s in sources)
        sql = (
            f"CREATE OR REPLACE VIEW {vname} AS "
            f"SELECT * FROM read_parquet([{source_list}], union_by_name=true)"
        )

    with DuckDBEngine.write_conn() as conn:
        conn.execute(sql)
    DuckDBEngine._refresh_read_pool()
    logger.info("DuckDB VIEW registered: %s (sources=%d)", vname, len(sources))


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
    *,
    job_id: int | None = None,
) -> int:
    """
    Sync a single table from the datasource into Parquet + DuckDB.

    Features:
    - Streaming (constant-memory) fetching.
    - Staging directory for full_refresh (old data preserved until new data is complete).
    - Checkpoint resume: on cancel/fail, saves progress; next sync resumes from checkpoint.

    Returns the number of rows synced (including rows from a previous checkpoint).
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

    # ── Incremental ───────────────────────────────────────────────────
    if strategy == "incremental" and watermark_col:
        last_max = _get_watermark_max(ds.id, schema_name, table_name, watermark_col)
        if last_max is not None:
            if isinstance(last_max, datetime):
                wm_literal = f"'{last_max.isoformat()}'"
            elif isinstance(last_max, date):
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
                sql = (
                    f'SELECT * FROM "{schema_name}"."{table_name}"'
                    f' WHERE "{watermark_col}" > {wm_literal}'
                )

            # Write delta to a temp file; rename on success so partial
            # writes never leave a corrupt file in the delta dir.
            table_key = f"{schema_name}.{table_name}"
            ddir = _delta_dir(ds.id, schema_name, table_name)
            ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            delta_path = ddir / f"{ts}.parquet"
            tmp_delta = ddir / f".tmp_{ts}.parquet"

            # Clean up stale tmp delta files from previous failed syncs
            ddir.mkdir(parents=True, exist_ok=True)
            for stale in ddir.glob(".tmp_*.parquet"):
                stale.unlink(missing_ok=True)

            _, batches = DataSourceConnectionService.stream_query(
                ds.type, ds.config, sql, timeout_seconds=3600,
            )
            _log_sync_message(
                "INFO",
                f"[SOURCE] incremental query ready for {table_key} using {watermark_col}",
                job_id=job_id,
                table_key=table_key,
            )
            _log_sync_message(
                "INFO",
                f"[WRITE] writing delta rows into {tmp_delta.name}",
                job_id=job_id,
                table_key=table_key,
            )
            count = _write_parquet_from_stream(
                batches, tmp_delta,
                job_id=job_id, table_key=table_key,
            )
            if count == 0:
                tmp_delta.unlink(missing_ok=True)
                _log_sync_message(
                    "INFO",
                    f"[DONE] no new rows found for {table_key}",
                    job_id=job_id,
                    table_key=table_key,
                )
                return 0
            # Atomically make the delta visible
            tmp_delta.rename(delta_path)
            _log_sync_message(
                "INFO",
                f"[FINALIZE] delta file saved as {delta_path.name} ({count:,} rows)",
                job_id=job_id,
                table_key=table_key,
            )
            _log_sync_message(
                "INFO",
                f"[DUCKDB] refreshing analytical view for {table_key}",
                job_id=job_id,
                table_key=table_key,
            )
            _register_duckdb_view(ds.id, schema_name, table_name)
            _log_sync_message(
                "INFO",
                f"[DONE] table ready with {count:,} incremental rows",
                job_id=job_id,
                table_key=table_key,
            )
            return count
        else:
            # First run — fall through to full_refresh
            strategy = "full_refresh"

    # ── full_refresh / append_only ────────────────────────────────────
    table_key = f"{schema_name}.{table_name}"
    pdir = _parquet_dir(ds.id, schema_name, table_name)
    ppath = _parquet_path(ds.id, schema_name, table_name)
    ddir = _delta_dir(ds.id, schema_name, table_name)
    staging = _staging_dir(ds.id, schema_name, table_name)

    if strategy == "append_only":
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        delta_path = ddir / f"{ts}.parquet"
        _, batches = DataSourceConnectionService.stream_table_data(
            ds.type, ds.config, schema_name, table_name,
        )
        _log_sync_message(
            "INFO",
            f"[SOURCE] opening append-only stream for {table_key}",
            job_id=job_id,
            table_key=table_key,
        )
        _log_sync_message(
            "INFO",
            f"[WRITE] writing append-only rows into {delta_path.name}",
            job_id=job_id,
            table_key=table_key,
        )
        count = _write_parquet_from_stream(
            batches, delta_path,
            job_id=job_id, table_key=table_key,
        )
        _log_sync_message(
            "INFO",
            f"[DUCKDB] refreshing analytical view for {table_key}",
            job_id=job_id,
            table_key=table_key,
        )
        _register_duckdb_view(ds.id, schema_name, table_name)
        _log_sync_message(
            "INFO",
            f"[DONE] append-only write complete with {count:,} rows",
            job_id=job_id,
            table_key=table_key,
        )
        return count

    # ── full_refresh with staging + checkpoint ────────────────────────
    # Check for existing checkpoint from a previously interrupted sync.
    cp = _load_checkpoint(ds.id, schema_name, table_name)
    rows_to_skip = 0
    start_shard = 0

    if cp and cp.get("strategy") == "full_refresh":
        rows_to_skip = cp.get("rows_written", 0)
        start_shard = cp.get("next_shard_idx", 0)
        if rows_to_skip > 0 and staging.exists():
            if job_id is not None:
                _emit_log(
                    job_id, "INFO",
                    f"Resuming from checkpoint: {rows_to_skip:,} rows already written, "
                    f"continuing from shard {start_shard}",
                    table_key=table_key,
                )
        else:
            # Checkpoint exists but staging is gone — start fresh
            rows_to_skip = 0
            start_shard = 0
            _clear_checkpoint(ds.id, schema_name, table_name)
    else:
        # No checkpoint — clean staging dir if leftover
        if staging.exists():
            shutil.rmtree(staging)

    staging.mkdir(parents=True, exist_ok=True)

    # Build a checkpoint callback (called periodically by writers)
    def _cp_callback(rows_written: int) -> None:
        _save_checkpoint(ds.id, schema_name, table_name, {
            "strategy": "full_refresh",
            "rows_written": rows_to_skip + rows_written,
            "next_shard_idx": start_shard + SYNC_WRITER_THREADS,
            "started_at": datetime.now(timezone.utc).isoformat(),
        })

    is_bigquery = ds_type_val == "bigquery"
    dest_name = "data_*.parquet" if SYNC_WRITER_THREADS > 1 else "data.parquet"

    _log_sync_message(
        "INFO",
        f"[SOURCE] opening full-refresh stream for {table_key}",
        job_id=job_id,
        table_key=table_key,
    )

    if is_bigquery:
        from app.core.crypto import decrypt_config as _dec
        _cfg = _dec(ds.config)
        project_id = _cfg.get("project_id", "")
        sql = f"SELECT * FROM `{project_id}.{schema_name}.{table_name}`"

        _log_sync_message(
            "INFO",
            f"[SOURCE] reading from BigQuery via Arrow fast path ({SYNC_WRITER_THREADS} shards)",
            job_id=job_id,
            table_key=table_key,
        )
        _log_sync_message(
            "INFO",
            f"[WRITE] writing streamed rows into staging/{dest_name}",
            job_id=job_id,
            table_key=table_key,
        )

        arrow_batches = DataSourceConnectionService.stream_bigquery_arrow(
            _cfg, sql, timeout_seconds=3600,
        )
        if rows_to_skip > 0:
            arrow_batches = _skip_rows_arrow(arrow_batches, rows_to_skip)

        count = _write_parquet_from_arrow_stream(
            arrow_batches, staging,
            num_shards=SYNC_WRITER_THREADS,
            start_shard_idx=start_shard,
            job_id=job_id, table_key=table_key,
            checkpoint_fn=_cp_callback,
        )
    else:
        _, batches = DataSourceConnectionService.stream_table_data(
            ds.type, ds.config, schema_name, table_name,
        )
        _log_sync_message(
            "INFO",
            f"[SOURCE] source stream connected for {table_key}",
            job_id=job_id,
            table_key=table_key,
        )
        _log_sync_message(
            "INFO",
            f"[WRITE] writing streamed rows into staging/{dest_name}",
            job_id=job_id,
            table_key=table_key,
        )
        if rows_to_skip > 0:
            batches = _skip_rows_dicts(batches, rows_to_skip)

        if SYNC_WRITER_THREADS > 1:
            count = _write_parquet_sharded(
                batches, staging,
                num_shards=SYNC_WRITER_THREADS,
                start_shard_idx=start_shard,
                job_id=job_id, table_key=table_key,
                checkpoint_fn=_cp_callback,
            )
        else:
            count = _write_parquet_from_stream(
                batches, staging / "data.parquet",
                job_id=job_id, table_key=table_key,
                checkpoint_fn=_cp_callback,
            )

    total_rows = rows_to_skip + count
    _log_sync_message(
        "INFO",
        f"[SOURCE] finished reading source stream with {count:,} new rows",
        job_id=job_id,
        table_key=table_key,
    )

    # ── Atomic swap: staging → main ─────────────────────────────────
    # 1. Delete old data from main dir (but NOT staging)
    _log_sync_message(
        "INFO",
        f"[FINALIZE] swapping staged parquet files into active dataset for {table_key}",
        job_id=job_id,
        table_key=table_key,
    )
    if ppath.exists():
        ppath.unlink()
    for old_shard in pdir.glob("data_*.parquet") if pdir.exists() else []:
        old_shard.unlink()
    if ddir.exists():
        shutil.rmtree(ddir)

    # 2. Move staging files to main dir
    for staged_file in staging.iterdir():
        if staged_file.name.startswith("."):
            continue  # skip hidden files
        staged_file.rename(pdir / staged_file.name)
    staging.rmdir()

    # 3. Clear checkpoint + register view
    _clear_checkpoint(ds.id, schema_name, table_name)
    _log_sync_message(
        "INFO",
        f"[DUCKDB] refreshing analytical view for {table_key}",
        job_id=job_id,
        table_key=table_key,
    )
    _register_duckdb_view(ds.id, schema_name, table_name)

    if job_id is not None and rows_to_skip > 0:
        _log_sync_message(
            "INFO",
            f"[DONE] table ready with {total_rows:,} rows ({rows_to_skip:,} resumed + {count:,} new)",
            job_id=job_id,
            table_key=table_key,
        )
    else:
        _log_sync_message(
            "INFO",
            f"[DONE] table ready with {total_rows:,} rows",
            job_id=job_id,
            table_key=table_key,
        )

    return total_rows


# ── Delta compaction with optional dedup ──────────────────────────────────────

def _should_compact(ds_id: int, schema: str, table: str) -> bool:
    """Check if delta files exceed compaction thresholds."""
    ddir = _delta_dir(ds_id, schema, table)
    if not ddir.exists():
        return False

    delta_files = list(ddir.glob("*.parquet"))
    if not delta_files:
        return False

    # Threshold 1: too many delta files
    if len(delta_files) > COMPACT_DELTA_FILE_THRESHOLD:
        return True

    # Threshold 2: delta total size exceeds ratio of base size
    delta_bytes = sum(f.stat().st_size for f in delta_files)
    pdir = _parquet_dir(ds_id, schema, table)
    base_bytes = 0
    ppath = pdir / "data.parquet"
    if ppath.exists():
        base_bytes = ppath.stat().st_size
    else:
        for sf in pdir.glob("data_*.parquet"):
            base_bytes += sf.stat().st_size

    if base_bytes > 0 and delta_bytes > base_bytes * COMPACT_DELTA_SIZE_RATIO:
        return True

    return False


def _compact_deltas(
    ds_id: int,
    schema: str,
    table: str,
    tbl_cfg: Dict[str, Any],
    *,
    job_id: int | None = None,
) -> int:
    """
    Merge base parquet + all delta files into a fresh set of sharded base files.

    If a primary_key is configured in tbl_cfg, rows are deduplicated: only
    the latest row per PK is kept (ordered by watermark column or row position).

    Returns the total row count after compaction.
    """
    from app.services.duckdb_engine import DuckDBEngine

    pdir = _parquet_dir(ds_id, schema, table)
    ddir = _delta_dir(ds_id, schema, table)
    vname = _view_name(ds_id, schema, table)
    table_key = f"{schema}.{table}"

    if job_id is not None:
        _emit_log(job_id, "INFO", f"Compacting {table_key} …", table_key=table_key)

    # Read ALL data (base + deltas) through the existing DuckDB VIEW
    # so schema evolution is handled by union_by_name.
    try:
        with DuckDBEngine.read_conn() as conn:
            result = conn.execute(f"SELECT * FROM {vname}")
            full_table: pa.Table = result.fetch_arrow_table()
    except Exception as e:
        logger.error("Compaction failed for %s: cannot read view: %s", table_key, e)
        if job_id is not None:
            _emit_log(job_id, "ERROR", f"Compaction read failed: {e}", table_key=table_key)
        return 0

    # Dedup by primary_key if configured
    primary_key = tbl_cfg.get("primary_key")
    watermark_col = tbl_cfg.get("watermark_column")

    if primary_key and full_table.num_rows > 0:
        pk_cols = primary_key if isinstance(primary_key, list) else [primary_key]
        # Verify all PK columns exist
        existing_cols = set(full_table.column_names)
        pk_cols = [c for c in pk_cols if c in existing_cols]

        if pk_cols:
            before = full_table.num_rows
            # Use DuckDB for efficient dedup: ROW_NUMBER() PARTITION BY pk
            # ORDER BY watermark DESC (latest wins), or by rowid if no watermark.
            order_col = watermark_col if watermark_col and watermark_col in existing_cols else None
            try:
                with DuckDBEngine.write_conn() as conn:
                    conn.register("_compact_src", full_table)
                    pk_csv = ", ".join(f'"{c}"' for c in pk_cols)
                    if order_col:
                        order_clause = f'"{order_col}" DESC'
                    else:
                        order_clause = "rowid DESC"
                    dedup_sql = (
                        f"SELECT * EXCLUDE (_rn) FROM ("
                        f"  SELECT *, ROW_NUMBER() OVER (PARTITION BY {pk_csv} ORDER BY {order_clause}) AS _rn"
                        f"  FROM _compact_src"
                        f") WHERE _rn = 1"
                    )
                    full_table = conn.execute(dedup_sql).fetch_arrow_table()
                    conn.unregister("_compact_src")
                after = full_table.num_rows
                if before != after:
                    msg = f"Dedup {table_key}: {before:,} → {after:,} rows ({before - after:,} duplicates removed)"
                    logger.info(msg)
                    if job_id is not None:
                        _emit_log(job_id, "INFO", msg, table_key=table_key)
            except Exception as e:
                logger.warning("Dedup failed for %s, keeping all rows: %s", table_key, e)

    total_rows = full_table.num_rows

    # Write compacted data to staging dir, then swap
    staging = _staging_dir(ds_id, schema, table)
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)

    # Split into shards
    num_shards = min(SYNC_WRITER_THREADS, max(1, total_rows // 100_000))
    rows_per_shard = max(1, total_rows // num_shards) if num_shards > 0 else total_rows

    for i in range(num_shards):
        start_row = i * rows_per_shard
        end_row = total_rows if i == num_shards - 1 else (i + 1) * rows_per_shard
        shard = full_table.slice(start_row, end_row - start_row)
        shard_path = staging / f"data_{i:03d}.parquet"
        pq.write_table(shard, str(shard_path), compression="snappy", write_statistics=True)

    # Atomic swap: remove old base + deltas, move staging in
    ppath = pdir / "data.parquet"
    if ppath.exists():
        ppath.unlink()
    for old_shard in pdir.glob("data_*.parquet"):
        old_shard.unlink()
    if ddir.exists():
        shutil.rmtree(ddir)

    for staged_file in staging.iterdir():
        if staged_file.name.startswith("."):
            continue
        staged_file.rename(pdir / staged_file.name)
    staging.rmdir()

    # Re-register DuckDB view with new base (no deltas)
    _register_duckdb_view(ds_id, schema, table)

    msg = f"Compaction complete: {table_key} → {total_rows:,} rows in {num_shards} shard(s)"
    logger.info(msg)
    if job_id is not None:
        _emit_log(job_id, "INFO", msg, table_key=table_key)

    return total_rows


def _run_sync_job(data_source_id: int, job_id: int) -> None:
    """
    Core sync execution — runs in a background thread.
    Opens its own DB session so it is safe to call from any thread.
    """
    # Initialise cancel flag + per-table progress map
    _sync_cancel_flags[job_id] = threading.Event()
    _sync_table_progress[job_id] = {}

    db = SessionLocal()
    total_rows = 0
    total_failed = 0
    errors: List[str] = []

    _emit_log(job_id, "INFO", f"Sync started for datasource {data_source_id}")

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
            table_configs = {}

        # Build a set of tables that the user has actually added to workspaces.
        from app.models import DatasetWorkspaceTable
        workspace_tables = (
            db.query(DatasetWorkspaceTable.source_table_name)
            .filter(
                DatasetWorkspaceTable.datasource_id == data_source_id,
                DatasetWorkspaceTable.source_kind == "physical_table",
                DatasetWorkspaceTable.enabled.is_(True),
            )
            .all()
        )
        selected_table_keys: set = set()
        for (stn,) in workspace_tables:
            if stn:
                selected_table_keys.add(stn.strip('"').strip("'").strip())

        schema_list = DataSourceConnectionService.get_schema_browser(ds.type, ds.config)
        if not schema_list:
            raise ValueError("No schemas/tables found in datasource")

        # Build list of tables to sync (for progress tracking)
        tables_to_sync: List[tuple] = []
        for schema_entry in schema_list:
            schema_name: str = schema_entry["schema"]
            for table_entry in schema_entry.get("tables", []):
                table_name: str = table_entry["name"]
                table_key = f"{schema_name}.{table_name}"
                tbl_cfg = table_configs.get(table_key, {})
                if table_key not in selected_table_keys:
                    if not tbl_cfg.get("enabled", False):
                        continue
                tables_to_sync.append((schema_name, table_name, table_key, tbl_cfg))

        _emit_log(job_id, "INFO", f"Found {len(tables_to_sync)} table(s) to sync")

        # Initialise progress for all tables
        for (_, _, tk, _) in tables_to_sync:
            _sync_table_progress[job_id][tk] = "pending"

        for idx, (schema_name, table_name, table_key, tbl_cfg) in enumerate(tables_to_sync, 1):
            _check_cancel(job_id)

            _sync_table_progress[job_id][table_key] = "running"
            _emit_log(
                job_id, "INFO",
                f"[{idx}/{len(tables_to_sync)}] Syncing {table_key} (strategy={tbl_cfg.get('strategy', 'full_refresh')})",
                table_key=table_key,
            )

            try:
                count = _sync_one_table(
                    ds, schema_name, table_name, tbl_cfg,
                    job_id=job_id,
                )
                total_rows += count
                _sync_table_progress[job_id][table_key] = "done"
                msg = f"[{idx}/{len(tables_to_sync)}] {table_key} → {count:,} rows synced"
                logger.info(f"[sync ds={data_source_id}] {msg}")
                _emit_log(job_id, "INFO", msg, table_key=table_key)

                # Auto-compact delta files if thresholds exceeded
                parts = table_key.split(".", 1)
                if len(parts) == 2 and _should_compact(ds.id, parts[0], parts[1]):
                    try:
                        _compact_deltas(ds.id, parts[0], parts[1], tbl_cfg, job_id=job_id)
                    except Exception as ce:
                        logger.warning("Auto-compact failed for %s: %s", table_key, ce)
                        _emit_log(job_id, "WARN", f"Compaction skipped: {ce}", table_key=table_key)
            except SyncCancelled:
                _sync_table_progress[job_id][table_key] = "cancelled"
                raise
            except Exception as e:
                errors.append(f"{table_key}: {e}")
                total_failed += 1
                _sync_table_progress[job_id][table_key] = "failed"
                logger.error(f"[sync ds={data_source_id}] {table_key} error: {e}", exc_info=True)
                _emit_log(job_id, "ERROR", f"{table_key}: {e}", table_key=table_key)

        # Mark job finished
        job.status = "success" if not errors else "failed"
        job.finished_at = datetime.now(timezone.utc)
        job.rows_synced = total_rows
        job.rows_failed = total_failed
        job.error_message = "\n".join(errors) if errors else None
        db.commit()

        finish_msg = f"Sync finished: status={job.status} rows={total_rows:,} failed={total_failed}"
        logger.info(f"[sync ds={data_source_id}] job={job_id} {finish_msg}")
        _emit_log(job_id, "INFO", finish_msg)

    except SyncCancelled:
        logger.info(f"[sync ds={data_source_id}] job={job_id} cancelled by user")
        _emit_log(job_id, "WARN", "Sync cancelled by user")
        try:
            job = db.query(SyncJob).filter(SyncJob.id == job_id).first()
            if job:
                job.status = "cancelled"
                job.finished_at = datetime.now(timezone.utc)
                job.rows_synced = total_rows
                job.rows_failed = total_failed
                job.error_message = "Cancelled by user"
                db.commit()
        except Exception:
            pass

    except Exception as e:
        logger.error(f"[sync ds={data_source_id}] job={job_id} fatal: {e}", exc_info=True)
        _emit_log(job_id, "ERROR", f"Fatal error: {e}")
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
        # Clean up cancel flag (but keep logs for a while so SSE clients
        # can finish reading).  Logs are bounded by _MAX_LOG_LINES per job
        # and will be evicted when the dict grows too large.
        _sync_cancel_flags.pop(job_id, None)
        _sync_table_progress.pop(job_id, None)
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

            # Clean up leftover staging dirs and tmp delta files
            staging = table_dir / ".staging"
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
                logger.info("Startup: cleaned stale staging dir %s", staging)
            delta_d = table_dir / "delta"
            if delta_d.exists():
                for tmp in delta_d.glob(".tmp_*.parquet"):
                    tmp.unlink(missing_ok=True)

            ppath = table_dir / "data.parquet"
            shard_files = sorted(table_dir.glob("data_*.parquet"))

            if not ppath.exists() and not shard_files:
                continue

            # dir_name is already "{_sanitize(schema)}__{_sanitize(table)}"
            # so view name = f"synced_ds{ds_id}__{dir_name}" matches _view_name() exactly
            dir_name = table_dir.name
            vname = f"synced_ds{ds_id}__{dir_name}"
            ddir = table_dir / "delta"

            # Collect all parquet sources
            sources: List[str] = []
            if shard_files:
                sources.append(str(table_dir / "data_*.parquet"))
            elif ppath.exists():
                sources.append(str(ppath))

            if ddir.exists() and any(ddir.glob("*.parquet")):
                sources.append(str(ddir / "*.parquet"))

            if len(sources) == 1:
                sql = (
                    f"CREATE OR REPLACE VIEW {vname} AS "
                    f"SELECT * FROM read_parquet('{sources[0]}', union_by_name=true)"
                )
            else:
                source_list = ", ".join(f"'{s}'" for s in sources)
                sql = (
                    f"CREATE OR REPLACE VIEW {vname} AS "
                    f"SELECT * FROM read_parquet([{source_list}], union_by_name=true)"
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
