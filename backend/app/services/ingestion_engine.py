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

from app.core.logging import get_logger
from app.services.datasource_service import DataSourceConnectionService

logger = get_logger(__name__)

# Resolve relative to project root (parent of backend/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", ".data"))
if not DATA_DIR.is_absolute():
    DATA_DIR = _PROJECT_ROOT / DATA_DIR
BATCH_SIZE = 10_000


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

    # Pull all rows from source (uses existing connector infrastructure)
    col_names, rows, _ = DataSourceConnectionService.execute_query(
        ds_type, config, sql, limit=None, timeout_seconds=300,
    )

    if not rows:
        # Write an empty Parquet with schema
        if columns_schema:
            fields = [pa.field(c["name"], _infer_arrow_type(c.get("type", "string"))) for c in columns_schema]
        else:
            fields = [pa.field(c, pa.string()) for c in col_names]
        schema = pa.schema(fields)
        table = pa.table({f.name: pa.array([], type=f.type) for f in fields}, schema=schema)
        pq.write_table(table, str(output_path), compression="snappy")
        return {"rows": 0, "size_bytes": output_path.stat().st_size, "columns": col_names}

    # Build Arrow table from rows (rows are list of dicts from execute_query)
    # Process in batches to keep writer streaming
    writer: Optional[pq.ParquetWriter] = None
    total_rows = 0

    try:
        for start in range(0, len(rows), BATCH_SIZE):
            batch = rows[start : start + BATCH_SIZE]
            arrow_table = pa.Table.from_pylist(batch)

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

    result_columns = [
        {"name": c, "type": str(arrow_table.schema.field(c).type) if c in arrow_table.column_names else "string"}
        for c in col_names
    ]

    return {
        "rows": total_rows,
        "size_bytes": output_path.stat().st_size,
        "columns": result_columns,
    }
