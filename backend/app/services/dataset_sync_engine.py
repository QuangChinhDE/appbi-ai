"""
Dataset sync engine: pulls data from a Dataset's source → Parquet → DuckDB VIEW.

This replaces the old sync_engine.py which synced at DataSource level into PostgreSQL.
The new approach syncs at Dataset level into Parquet files, queried via DuckDB.

Storage:
  /data/datasets/{id}/data.parquet         ← full materialized data
  /data/datasets/{id}/delta/{ts}.parquet   ← append-only incremental files

Modes (from dataset.sync_config.mode):
  full_refresh  — drop + re-pull + write data.parquet
  incremental   — pull WHERE watermark > last_value, append to delta/
  append_only   — pull all new rows, append to delta/
  manual        — only sync when manually triggered
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import Dataset, DataSource, SyncJobRun
from app.services.datasource_service import DataSourceConnectionService
from app.services.ingestion_engine import (
    DATA_DIR,
    dataset_delta_dir,
    dataset_parquet_path,
    pull_to_parquet,
)

logger = get_logger(__name__)


def _compile_dataset_sql(db_session, dataset: Dataset) -> str:
    """Compile the dataset's final SQL (with transformations)."""
    from app.services.dataset_service import compile_transformed_sql
    if dataset.transformations:
        try:
            return compile_transformed_sql(db_session, dataset)
        except Exception:
            return dataset.sql_query
    return dataset.sql_query


def _run_sync(dataset_id: int, job_run_id: int, triggered_by: str = "manual") -> None:
    """
    Core sync execution — runs in a background thread.
    Each call opens its own DB session for thread safety.
    """
    db = SessionLocal()
    start_time = time.time()

    try:
        dataset: Optional[Dataset] = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not dataset:
            raise ValueError(f"Dataset {dataset_id} not found")

        job_run: Optional[SyncJobRun] = db.query(SyncJobRun).filter(SyncJobRun.id == job_run_id).first()
        if not job_run:
            raise ValueError(f"SyncJobRun {job_run_id} not found")

        data_source: Optional[DataSource] = dataset.data_source
        if not data_source:
            raise ValueError(f"DataSource for dataset {dataset_id} not found")

        sync_config = dataset.sync_config or {}
        mode = sync_config.get("mode", "full_refresh")
        incremental_cfg = sync_config.get("incremental", {})

        # Compile SQL
        final_sql = _compile_dataset_sql(db, dataset)
        output_path = dataset_parquet_path(dataset_id)

        if mode == "incremental" and incremental_cfg.get("watermark_column"):
            rows_pulled = _sync_incremental(
                dataset, data_source, final_sql, output_path, incremental_cfg, db
            )
        elif mode == "append_only":
            rows_pulled = _sync_append_only(dataset, data_source, final_sql, output_path)
        else:
            # full_refresh (default) or manual
            rows_pulled = _sync_full_refresh(dataset, data_source, final_sql, output_path)

        duration = time.time() - start_time

        # Register DuckDB VIEW
        from app.services.duckdb_engine import DuckDBEngine
        DuckDBEngine.register_dataset(dataset_id, str(output_path))

        # Update materialization metadata on dataset
        size_bytes = output_path.stat().st_size if output_path.exists() else 0
        mat = dict(dataset.materialization or {})
        mat.update({
            "mode": "parquet",
            "storage_path": str(output_path.relative_to(DATA_DIR)),
            "row_count": rows_pulled,
            "size_bytes": size_bytes,
            "last_refreshed_at": datetime.now(timezone.utc).isoformat(),
            "last_duration_seconds": round(duration, 2),
            "status": "idle",
            "error": None,
        })
        dataset.materialization = mat
        # Using flag_modified to ensure SQLAlchemy detects JSON mutation
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(dataset, "materialization")

        # Mark job success
        job_run.status = "success"
        job_run.rows_pulled = rows_pulled
        job_run.duration_seconds = round(duration, 2)
        job_run.finished_at = datetime.now(timezone.utc)
        db.commit()

        logger.info(
            "[sync dataset=%d] job_run=%d finished: rows=%d duration=%.1fs",
            dataset_id, job_run_id, rows_pulled, duration,
        )

    except Exception as e:
        duration = time.time() - start_time
        logger.error("[sync dataset=%d] job_run=%d failed: %s", dataset_id, job_run_id, e, exc_info=True)
        try:
            job_run = db.query(SyncJobRun).filter(SyncJobRun.id == job_run_id).first()
            if job_run:
                job_run.status = "failed"
                job_run.error = str(e)
                job_run.duration_seconds = round(duration, 2)
                job_run.finished_at = datetime.now(timezone.utc)

            ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
            if ds:
                mat = dict(ds.materialization or {})
                mat["status"] = "idle"
                mat["error"] = str(e)
                ds.materialization = mat
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(ds, "materialization")

            db.commit()
        except Exception:
            db.rollback()
    finally:
        db.close()


# ── Sync modes ────────────────────────────────────────────────────────────────

def _sync_full_refresh(
    dataset: Dataset,
    data_source: DataSource,
    sql: str,
    output_path: Path,
) -> int:
    """Drop + re-pull everything into data.parquet."""
    result = pull_to_parquet(
        ds_type=data_source.type.value,
        config=data_source.config,
        sql=sql,
        output_path=output_path,
    )
    # Clean up any delta files from a previous append_only/incremental mode
    delta_dir = dataset_delta_dir(dataset.id)
    if delta_dir.exists():
        for f in delta_dir.glob("*.parquet"):
            f.unlink()
    return result["rows"]


def _sync_incremental(
    dataset: Dataset,
    data_source: DataSource,
    base_sql: str,
    output_path: Path,
    incremental_cfg: dict,
    db,
) -> int:
    """Pull only new/updated rows using watermark column, write to delta."""
    watermark_col = incremental_cfg["watermark_column"]
    lookback = incremental_cfg.get("lookback_minutes", 0)

    mat = dataset.materialization or {}
    last_watermark = mat.get("incremental_watermark")

    if last_watermark is None or not output_path.exists():
        # First run — do full refresh to establish baseline
        rows = _sync_full_refresh(dataset, data_source, base_sql, output_path)
        # Set watermark from DuckDB
        _update_watermark(dataset, output_path, watermark_col, db)
        return rows

    # Build incremental SQL
    # Subtract lookback for safety overlap
    if lookback and incremental_cfg.get("watermark_type") == "timestamp":
        wm_value = f"'{last_watermark}'::timestamp - interval '{lookback} minutes'"
    else:
        wm_value = f"'{last_watermark}'"

    inc_sql = f'SELECT * FROM ({base_sql}) _base WHERE "{watermark_col}" > {wm_value}'

    delta_dir = dataset_delta_dir(dataset.id)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    delta_path = delta_dir / f"{ts}.parquet"

    result = pull_to_parquet(
        ds_type=data_source.type.value,
        config=data_source.config,
        sql=inc_sql,
        output_path=delta_path,
    )

    if result["rows"] > 0:
        _update_watermark(dataset, output_path, watermark_col, db)

    return result["rows"]


def _sync_append_only(
    dataset: Dataset,
    data_source: DataSource,
    sql: str,
    output_path: Path,
) -> int:
    """Append new data as a delta Parquet file."""
    if not output_path.exists():
        # First run — write base file
        return _sync_full_refresh(dataset, data_source, sql, output_path)

    delta_dir = dataset_delta_dir(dataset.id)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    delta_path = delta_dir / f"{ts}.parquet"

    result = pull_to_parquet(
        ds_type=data_source.type.value,
        config=data_source.config,
        sql=sql,
        output_path=delta_path,
    )
    return result["rows"]


def _update_watermark(dataset: Dataset, output_path: Path, watermark_col: str, db):
    """Read MAX(watermark_col) from DuckDB and store in materialization."""
    try:
        from app.services.duckdb_engine import DuckDBEngine
        DuckDBEngine.register_dataset(dataset.id, str(output_path))
        df = DuckDBEngine.query(f'SELECT MAX("{watermark_col}") AS wm FROM dataset_{dataset.id}')
        if not df.empty and df.iloc[0]["wm"] is not None:
            wm_val = df.iloc[0]["wm"]
            mat = dict(dataset.materialization or {})
            mat["incremental_watermark"] = str(wm_val)
            dataset.materialization = mat
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(dataset, "materialization")
            db.commit()
    except Exception as e:
        logger.warning("Failed to update watermark for dataset %d: %s", dataset.id, e)


# ── Public trigger ────────────────────────────────────────────────────────────

def trigger_dataset_sync(
    dataset_id: int,
    db,
    triggered_by: str = "manual",
    mode_override: str = None,
) -> SyncJobRun:
    """
    Public entry point to start a sync for a dataset.
    Creates a SyncJobRun record and starts the sync in a background thread.

    Returns the SyncJobRun (status=running).
    Raises HTTPException 409 if a sync is already running.
    """
    dataset = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset:
        raise ValueError(f"Dataset {dataset_id} not found")

    # Check for running sync
    running = (
        db.query(SyncJobRun)
        .filter(SyncJobRun.dataset_id == dataset_id, SyncJobRun.status == "running")
        .first()
    )
    if running:
        from fastapi import HTTPException
        raise HTTPException(status_code=409, detail="A sync job is already running for this dataset")

    sync_config = dataset.sync_config or {}
    mode = mode_override or sync_config.get("mode", "full_refresh")

    # Mark dataset as syncing
    mat = dict(dataset.materialization or {})
    mat["status"] = "running"
    dataset.materialization = mat
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(dataset, "materialization")

    job_run = SyncJobRun(
        dataset_id=dataset_id,
        triggered_by=triggered_by,
        mode=mode,
        status="running",
    )
    db.add(job_run)
    db.commit()
    db.refresh(job_run)

    # Launch background thread
    t = threading.Thread(
        target=_run_sync,
        args=(dataset_id, job_run.id, triggered_by),
        daemon=True,
    )
    t.start()

    return job_run
