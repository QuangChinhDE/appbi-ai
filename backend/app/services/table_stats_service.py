"""
TableStatsService — compute column-level statistics for workspace tables.

Approach: fetch a sample of rows via the existing DataSourceConnectionService,
compute stats in-memory. Works with ALL datasource types (PostgreSQL, MySQL,
BigQuery, Google Sheets, manual CSV) without any special-casing.
"""
import statistics
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


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

            # Cardinality: distinct count of string representations
            cardinality = len({str(v) for v in non_null})

            # min / max (string comparison is fine for display purposes)
            str_vals = [str(v) for v in non_null]
            min_val = min(str_vals) if str_vals else None
            max_val = max(str_vals) if str_vals else None

            # Sample: up to 5 unique representative values
            seen: set = set()
            samples: List[str] = []
            for v in non_null:
                sv = str(v)
                if sv not in seen:
                    seen.add(sv)
                    samples.append(sv)
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
    def update_table_stats(db: Session, table_id: int) -> Optional[Dict[str, Dict]]:
        """
        Compute and persist column stats for a workspace table.
        Returns the stats dict, or None if the table cannot be reached.
        Safe to call in a background task — all errors are caught.
        """
        from app.models.dataset_workspace import DatasetWorkspaceTable
        from app.models.models import DataSource

        try:
            table = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == table_id
            ).first()

            if not table:
                logger.warning("TableStats: table %s not found", table_id)
                return None

            if not table.columns_cache:
                logger.info("TableStats: table %s has no columns_cache yet, skipping", table_id)
                return None

            datasource = db.query(DataSource).filter(
                DataSource.id == table.datasource_id
            ).first()
            if not datasource:
                logger.warning("TableStats: datasource not found for table %s", table_id)
                return None

            from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
            from app.services.duckdb_engine import DuckDBEngine

            rows = None
            cols = list(table.columns_cache) if table.columns_cache else []

            if table.source_kind == "sql_query":
                if not table.source_query:
                    return None
                # Only run against synced DuckDB view — skip if not yet synced
                rewritten = rewrite_sql_for_duckdb(datasource.id, table.source_query)
                if not rewritten:
                    return None
                try:
                    rows = DuckDBEngine.query(
                        f"SELECT * FROM ({rewritten}) AS _q LIMIT {TableStatsService.SAMPLE_LIMIT}"
                    )
                except Exception:
                    return None
            else:
                if not table.source_table_name:
                    return None
                # Only run against synced DuckDB view — skip if not yet synced
                view_name = get_synced_view(datasource.id, table.source_table_name)
                if not view_name:
                    return None
                try:
                    rows = DuckDBEngine.query(
                        f"SELECT * FROM {view_name} LIMIT {TableStatsService.SAMPLE_LIMIT}"
                    )
                except Exception:
                    return None

            if not rows:
                return None

            # Convert rows to list-of-dicts if needed
            if rows and not isinstance(rows[0], dict):
                rows = [dict(zip(cols, row)) for row in rows]

            stats = TableStatsService.compute_stats_from_sample(
                table.columns_cache, rows
            )

            table.column_stats = stats
            table.stats_updated_at = datetime.utcnow()
            db.commit()

            logger.info(
                "TableStats: updated stats for table %s (%d columns, %d sample rows)",
                table_id, len(stats), len(rows),
            )

            # Schema change detection — runs after commit so table reflects new stats
            from app.services.schema_change_service import SchemaChangeService
            SchemaChangeService.check_and_handle(db, table_id, stats)

            return stats

        except Exception as exc:
            logger.warning("TableStats: failed for table %s — %s", table_id, exc)
            db.rollback()
            return None
