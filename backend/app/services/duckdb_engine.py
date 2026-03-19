"""
DuckDB persistent engine with read connection pool + write lock.

Architecture:
  - READ:  N connections from pool, concurrent, borrowed → returned
  - WRITE: 1 exclusive connection with write_lock, serialized
  - Reads do NOT block each other; writes block reads only briefly during pool refresh

Used by:
  - Chart queries (read)
  - AI Agent queries (read)
  - Sync ingestion (write — register VIEW after Parquet write)

Storage layout:
  /data/duckdb.duckdb         ← persistent catalog + indexes
  /data/datasets/{id}/data.parquet
  /data/datasets/{id}/delta/*.parquet
"""
from __future__ import annotations

import os
import queue
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import duckdb

from app.core.logging import get_logger

logger = get_logger(__name__)

# Resolve relative to project root (parent of backend/)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
DATA_DIR = Path(os.environ.get("DATA_DIR", ".data"))
if not DATA_DIR.is_absolute():
    DATA_DIR = _PROJECT_ROOT / DATA_DIR
DUCKDB_PATH = DATA_DIR / "duckdb.duckdb"
READ_POOL_SIZE = int(os.environ.get("DUCKDB_READ_POOL_SIZE", "4"))


class DuckDBEngine:
    """Read connection pool + exclusive write lock for DuckDB persistent database."""

    _read_pool: Optional[queue.Queue] = None
    _write_conn: Optional[duckdb.DuckDBPyConnection] = None
    _write_lock = threading.Lock()
    _init_lock = threading.Lock()
    _initialized = False

    # ── Initialization ───────────────────────────────────────────────────────

    @classmethod
    def _initialize(cls) -> None:
        with cls._init_lock:
            if cls._initialized:
                return
            DUCKDB_PATH.parent.mkdir(parents=True, exist_ok=True)

            # Single read-write connection (DuckDB only allows one writer)
            cls._write_conn = duckdb.connect(str(DUCKDB_PATH), read_only=False)

            # Read pool: cursor-based — each "connection" is a cursor from write_conn
            cls._read_pool = queue.Queue(maxsize=READ_POOL_SIZE)
            for _ in range(READ_POOL_SIZE):
                cls._read_pool.put(cls._write_conn.cursor())

            cls._initialized = True
            logger.info(
                "DuckDB engine initialized: path=%s, read_pool=%d",
                DUCKDB_PATH, READ_POOL_SIZE,
            )

    # ── Connection context managers ──────────────────────────────────────────

    @classmethod
    @contextmanager
    def read_conn(cls):
        """Borrow a read connection from pool. Concurrent reads OK."""
        if not cls._initialized:
            cls._initialize()
        conn = cls._read_pool.get(timeout=30)
        try:
            yield conn
        finally:
            cls._read_pool.put(conn)

    @classmethod
    @contextmanager
    def write_conn(cls):
        """Exclusive write connection. Blocks concurrent writes."""
        if not cls._initialized:
            cls._initialize()
        with cls._write_lock:
            yield cls._write_conn

    # ── Public API ───────────────────────────────────────────────────────────

    @classmethod
    def query(cls, sql: str, params: list = None) -> List[Dict[str, Any]]:
        """Execute a read-only SQL query, return list of dicts."""
        with cls.read_conn() as conn:
            if params:
                result = conn.execute(sql, params)
            else:
                result = conn.execute(sql)
            columns = [desc[0] for desc in result.description]
            rows = result.fetchall()
            return [dict(zip(columns, row)) for row in rows]

    @classmethod
    def query_to_dicts(cls, sql: str, params: list = None) -> List[Dict[str, Any]]:
        """Execute a read-only SQL query, return list of dicts."""
        return cls.query(sql, params)

    @classmethod
    def register_dataset(cls, dataset_id: int, parquet_path: str) -> None:
        """Register or refresh a DuckDB VIEW pointing at Parquet file(s)."""
        view_name = f"dataset_{dataset_id}"
        pp = Path(parquet_path)
        delta_dir = pp.parent / "delta"

        if delta_dir.exists() and any(delta_dir.glob("*.parquet")):
            delta_glob = str(delta_dir / "*.parquet")
            sql = (
                f"CREATE OR REPLACE VIEW {view_name} AS "
                f"SELECT * FROM read_parquet(['{parquet_path}', '{delta_glob}'])"
            )
        else:
            sql = (
                f"CREATE OR REPLACE VIEW {view_name} AS "
                f"SELECT * FROM read_parquet('{parquet_path}')"
            )

        with cls.write_conn() as conn:
            conn.execute(sql)

        cls._refresh_read_pool()
        logger.info("DuckDB VIEW registered: %s → %s", view_name, parquet_path)

    @classmethod
    def unregister_dataset(cls, dataset_id: int) -> None:
        """Drop a dataset VIEW if it exists."""
        view_name = f"dataset_{dataset_id}"
        with cls.write_conn() as conn:
            conn.execute(f"DROP VIEW IF EXISTS {view_name}")
        cls._refresh_read_pool()

    @classmethod
    def has_view(cls, dataset_id: int) -> bool:
        """Check whether a dataset VIEW is registered."""
        view_name = f"dataset_{dataset_id}"
        try:
            with cls.read_conn() as conn:
                result = conn.execute(
                    "SELECT COUNT(*) FROM duckdb_views() WHERE view_name = ?",
                    [view_name],
                ).fetchone()
                return result[0] > 0
        except Exception:
            return False

    # ── Internal helpers ─────────────────────────────────────────────────────

    @classmethod
    def _refresh_read_pool(cls) -> None:
        """Drain and recreate read cursors so they see new VIEWs."""
        if cls._read_pool is None:
            return
        with cls._write_lock:
            old_cursors = []
            while not cls._read_pool.empty():
                try:
                    old_cursors.append(cls._read_pool.get_nowait())
                except queue.Empty:
                    break
            for c in old_cursors:
                try:
                    c.close()
                except Exception:
                    pass
            for _ in range(READ_POOL_SIZE):
                cls._read_pool.put(cls._write_conn.cursor())

    @classmethod
    def shutdown(cls) -> None:
        """Close all connections. Called on app shutdown."""
        if cls._write_conn:
            try:
                cls._write_conn.close()
            except Exception:
                pass
            cls._write_conn = None
        if cls._read_pool:
            while not cls._read_pool.empty():
                try:
                    cls._read_pool.get_nowait().close()
                except Exception:
                    pass
            cls._read_pool = None
        cls._initialized = False
        logger.info("DuckDB engine shut down")
