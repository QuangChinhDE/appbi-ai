"""
Ingestion engine: stream data from a source → Parquet file.

Uses PyArrow to write Parquet in streaming batches, keeping RAM usage at
O(BATCH_SIZE) regardless of total row count.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import pyarrow as pa
import pyarrow.parquet as pq

from app.core.config import settings
from app.core.logging import get_logger
from app.services.datasource_service import DataSourceConnectionService

logger = get_logger(__name__)

# Single source of truth — resolved by config.py
DATA_DIR = settings.data_dir_path
# Larger batches reduce source DB round-trips and create bigger Parquet row
# groups (one write_table() call = one row group = BATCH_SIZE rows).
BATCH_SIZE = int(os.environ.get("SYNC_STREAM_BATCH_SIZE", "50000"))


def _infer_arrow_type(py_type_str: str) -> pa.DataType:
    """Map a column type string to a PyArrow type."""
    t = py_type_str.lower()
    if t in ("integer", "int", "bigint", "int4", "int8", "serial", "bigserial"):
        return pa.int64()
    if t in ("float", "double", "double precision", "numeric", "decimal",
             "real", "float4", "float8", "money", "number"):
        return pa.float64()
    if t in ("boolean", "bool"):
        return pa.bool_()
    if "timestamp" in t or t == "datetime":
        return pa.timestamp("us")
    if t == "date":
        return pa.date32()
    if t in ("time", "timetz"):
        return pa.time64("us")
    return pa.string()


def dataset_parquet_path(dataset_id: int) -> Path:
    """Canonical Parquet path for a dataset."""
    return DATA_DIR / "datasets" / str(dataset_id) / "data.parquet"


def dataset_delta_dir(dataset_id: int) -> Path:
    """Delta directory for append-only incremental Parquet files."""
    return DATA_DIR / "datasets" / str(dataset_id) / "delta"


def pull_to_parquet(
    ds_type: str,
    config: dict,
    sql: str,
    output_path: Path,
    columns_schema: Optional[List[Dict[str, Any]]] = None,
    on_progress: Optional[Callable[[int], None]] = None,
) -> Dict[str, Any]:
    """
    Pull data from source via SQL and write to a Parquet file.

    Uses streaming for SQL-based datasources (PostgreSQL, MySQL, BigQuery) to
    keep memory usage at O(BATCH_SIZE) regardless of total row count.

    Args:
        ds_type: DataSource type string
        config: DataSource connection config
        sql: SELECT query to execute on source
        output_path: Where to write the .parquet file
        columns_schema: Optional pre-known column schema [{name, type}, ...]
        on_progress: Optional callback(total_rows_so_far)

    Returns:
        {"rows": int, "size_bytes": int, "columns": [{name, type}, ...]}
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Try streaming for SQL datasources (constant-memory)
    try:
        col_names, batches = DataSourceConnectionService.stream_query(
            ds_type, config, sql, timeout_seconds=3600,
        )
    except (AttributeError, TypeError):
        # Fallback for datasource types that don't support streaming
        col_names, rows, _ = DataSourceConnectionService.execute_query(
            ds_type, config, sql, limit=None, timeout_seconds=300,
        )
        # Wrap in single-batch generator
        batches = iter([rows]) if rows else iter([])

    writer: Optional[pq.ParquetWriter] = None
    total_rows = 0
    last_arrow_table = None

    try:
        for batch in batches:
            if not batch:
                continue
            arrow_table = pa.Table.from_pylist(batch)
            last_arrow_table = arrow_table

            if writer is None:
                writer = pq.ParquetWriter(
                    str(output_path), arrow_table.schema, compression="snappy"
                )

            writer.write_table(arrow_table)
            total_rows += len(batch)

            if on_progress:
                on_progress(total_rows)
    finally:
        if writer:
            writer.close()

    if total_rows == 0:
        # Write an empty Parquet with schema
        if columns_schema:
            fields = [pa.field(c["name"], _infer_arrow_type(c.get("type", "string"))) for c in columns_schema]
        else:
            fields = [pa.field(c, pa.string()) for c in col_names]
        schema = pa.schema(fields)
        table = pa.table({f.name: pa.array([], type=f.type) for f in fields}, schema=schema)
        pq.write_table(table, str(output_path), compression="snappy")
        return {"rows": 0, "size_bytes": output_path.stat().st_size, "columns": col_names}

    result_columns = [
        {"name": c, "type": str(last_arrow_table.schema.field(c).type) if last_arrow_table and c in last_arrow_table.column_names else "string"}
        for c in col_names
    ]

    return {
        "rows": total_rows,
        "size_bytes": output_path.stat().st_size,
        "columns": result_columns,
    }
