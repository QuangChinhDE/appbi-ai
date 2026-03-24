"""
TableStatsService - compute column-level statistics for workspace tables.

Approach: fetch a sample of rows via the synced DuckDB view, compute stats
in-memory, and persist the latest schema snapshot. This service only updates
table stats + schema hash; callers decide whether the AI description should be
regenerated or marked stale.
"""
import logging
import statistics
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.services.schema_change_service import SchemaChangeService

logger = logging.getLogger(__name__)


def _normalize_columns_cache(columns_cache: Any) -> List[Any]:
    """Support both raw lists and {"columns": [...]} cache shapes."""
    if not columns_cache:
        return []
    if isinstance(columns_cache, dict):
        return list(columns_cache.get("columns", []))
    return list(columns_cache)


class TableStatsService:

    SAMPLE_LIMIT = 500  # rows used for stats computation

    @staticmethod
    def compute_stats_from_sample(
        columns: List[Any],
        rows: List[Dict],
    ) -> Dict[str, Dict]:
        """
        Compute per-column stats from a sample of rows.

        columns: list of {"name": str, "type": str} dicts (from columns_cache)
                 or plain strings.
        rows:    list of dicts {col_name: value, ...}.
        Returns: {col_name: {dtype, cardinality, null_count, null_pct,
                              min, max, samples, is_numeric, mean, std}}
        """
        stats: Dict[str, Dict] = {}

        for col_info in columns:
            if isinstance(col_info, dict):
                col_name = col_info.get("name", "")
                col_type = col_info.get("type", "string")
            else:
                col_name = str(col_info)
                col_type = "string"

            if not col_name:
                continue

            all_vals = [row.get(col_name) for row in rows if isinstance(row, dict)]
            non_null = [v for v in all_vals if v is not None and v != ""]

            null_count = len(all_vals) - len(non_null)
            null_pct = round(null_count / len(all_vals), 4) if all_vals else 0.0

            cardinality = len({str(v) for v in non_null})
            str_vals = [str(v) for v in non_null]
            min_val = min(str_vals) if str_vals else None
            max_val = max(str_vals) if str_vals else None

            seen: set = set()
            samples: List[str] = []
            for value in non_null:
                rendered = str(value)
                if rendered not in seen:
                    seen.add(rendered)
                    samples.append(rendered)
                if len(samples) >= 5:
                    break

            is_numeric = col_type.lower() in (
                "integer", "int", "bigint", "smallint", "float", "double",
                "decimal", "numeric", "number", "real",
            )

            mean_val: Optional[float] = None
            std_val: Optional[float] = None
            if is_numeric and non_null:
                try:
                    floats = [float(v) for v in non_null]
                    mean_val = round(sum(floats) / len(floats), 4)
                    if len(floats) > 1:
                        std_val = round(statistics.stdev(floats), 4)
                except (ValueError, TypeError):
                    pass

            stats[col_name] = {
                "dtype": col_type,
                "cardinality": cardinality,
                "null_count": null_count,
                "null_pct": null_pct,
                "min": min_val,
                "max": max_val,
                "samples": samples,
                "is_numeric": is_numeric,
                "mean": mean_val,
                "std": std_val,
            }

        return stats

    @staticmethod
    def update_table_stats(db: Session, table_id: int) -> Dict[str, Any]:
        """
        Compute and persist column stats for a workspace table.

        Returns a structured payload:
            {
              "stats": {...} | None,
              "changed": bool,
              "added": [...],
              "removed": [...],
              "new_hash": str | None,
              "reason": str | None,
            }

        Safe to call in a background task - all errors are caught.
        """
        from app.models.dataset_workspace import DatasetWorkspaceTable
        from app.models.models import DataSource
        from app.services.duckdb_engine import DuckDBEngine
        from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb

        try:
            table = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == table_id
            ).first()
            if not table:
                logger.warning("TableStats: table %s not found", table_id)
                return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": None, "reason": "table_not_found"}

            if not table.columns_cache:
                logger.info("TableStats: table %s has no columns_cache yet, skipping", table_id)
                return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "missing_columns_cache"}

            datasource = db.query(DataSource).filter(
                DataSource.id == table.datasource_id
            ).first()
            if not datasource:
                logger.warning("TableStats: datasource not found for table %s", table_id)
                return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "datasource_not_found"}

            rows = None
            normalized_columns = _normalize_columns_cache(table.columns_cache)
            cols = [
                column.get("name", "")
                if isinstance(column, dict)
                else str(column)
                for column in normalized_columns
            ]

            if table.source_kind == "sql_query":
                if not table.source_query:
                    return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "missing_source_query"}
                rewritten = rewrite_sql_for_duckdb(datasource.id, table.source_query)
                if not rewritten:
                    return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "not_synced"}
                try:
                    rows = DuckDBEngine.query(
                        f"SELECT * FROM ({rewritten}) AS _q LIMIT {TableStatsService.SAMPLE_LIMIT}"
                    )
                except Exception:
                    return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "duckdb_query_failed"}
            else:
                if not table.source_table_name:
                    return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "missing_source_table_name"}
                view_name = get_synced_view(datasource.id, table.source_table_name)
                if not view_name:
                    return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "not_synced"}
                try:
                    rows = DuckDBEngine.query(
                        f"SELECT * FROM {view_name} LIMIT {TableStatsService.SAMPLE_LIMIT}"
                    )
                except Exception:
                    return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "duckdb_query_failed"}

            if not rows:
                return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": table.schema_hash, "reason": "no_rows"}

            if rows and not isinstance(rows[0], dict):
                rows = [dict(zip(cols, row)) for row in rows]

            previous_column_stats = dict(table.column_stats or {})
            previous_schema_hash = table.schema_hash
            stats = TableStatsService.compute_stats_from_sample(
                normalized_columns, rows
            )
            schema_result = SchemaChangeService.detect_change(
                previous_column_stats,
                previous_schema_hash,
                stats,
            )

            table.column_stats = stats
            table.stats_updated_at = datetime.utcnow()
            table.schema_hash = schema_result["new_hash"]
            db.commit()

            logger.info(
                "TableStats: updated stats for table %s (%d columns, %d sample rows, schema_changed=%s)",
                table_id, len(stats), len(rows), schema_result["changed"],
            )

            return {
                "stats": stats,
                "changed": schema_result["changed"],
                "added": schema_result["added"],
                "removed": schema_result["removed"],
                "new_hash": schema_result["new_hash"],
                "reason": None,
            }

        except Exception as exc:
            logger.warning("TableStats: failed for table %s - %s", table_id, exc)
            db.rollback()
            return {"stats": None, "changed": False, "added": [], "removed": [], "new_hash": None, "reason": "exception"}
