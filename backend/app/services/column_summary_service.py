"""Column summary for the Kaggle-style "eye" tooltip on dataset table headers.

Produces, for one column, the stats needed to render a tooltip: total rows,
unique count, null count, and either top values (categorical) or
min/max/avg + histogram bins (numeric/date). Runs against the same resolved
relation that charts use, so the summary reflects the active type overrides.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.core.logging import get_logger
from app.services import query_cache

logger = get_logger(__name__)


_NUMERIC_TYPES = {"integer", "float", "bigint", "double", "decimal", "numeric"}
_DATE_TYPES = {"date", "datetime", "timestamp"}
_HIST_BINS = 20


@dataclass
class ColumnSummary:
    column: str
    detected_kind: str  # "numeric" | "categorical" | "date" | "boolean" | "empty"
    total_rows: int
    null_count: int
    distinct_count: Optional[int] = None
    top_values: List[Dict[str, Any]] = field(default_factory=list)
    min_value: Any = None
    max_value: Any = None
    avg_value: Any = None
    histogram: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "column": self.column,
            "detected_kind": self.detected_kind,
            "total_rows": self.total_rows,
            "null_count": self.null_count,
            "distinct_count": self.distinct_count,
            "top_values": self.top_values,
            "min_value": self.min_value,
            "max_value": self.max_value,
            "avg_value": self.avg_value,
            "histogram": self.histogram,
        }


def _detect_kind(column_name: str, db_table) -> str:
    overrides = getattr(db_table, "type_overrides", None) or {}
    target = str(overrides.get(column_name) or "").lower()
    if target in _NUMERIC_TYPES:
        return "numeric"
    if target in _DATE_TYPES:
        return "date"
    if target == "boolean":
        return "boolean"
    return "categorical"


def _categorical_summary(
    ds_type: str,
    config,
    base_table: str,
    quoted_col: str,
    top_limit: int,
) -> Dict[str, Any]:
    from app.services.datasource_service import DataSourceConnectionService

    sql = (
        f"SELECT {quoted_col} AS value, COUNT(*) AS cnt "
        f"FROM {base_table} "
        f"WHERE {quoted_col} IS NOT NULL "
        f"GROUP BY {quoted_col} "
        f"ORDER BY cnt DESC "
        f"LIMIT {int(top_limit)}"
    )
    _, rows, _ = DataSourceConnectionService.execute_query(
        ds_type, config, sql, timeout_seconds=60
    )
    return {
        "top_values": [
            {"value": str(r.get("value")) if r.get("value") is not None else None, "count": int(r.get("cnt") or 0)}
            for r in (rows or [])
        ]
    }


def _numeric_summary(
    ds_type: str,
    config,
    base_table: str,
    quoted_col: str,
) -> Dict[str, Any]:
    from app.services.datasource_service import DataSourceConnectionService

    stats_sql = (
        f"SELECT MIN({quoted_col}) AS min_v, MAX({quoted_col}) AS max_v, AVG({quoted_col}) AS avg_v "
        f"FROM {base_table} WHERE {quoted_col} IS NOT NULL"
    )
    _, rows, _ = DataSourceConnectionService.execute_query(
        ds_type, config, stats_sql, timeout_seconds=60
    )
    if not rows:
        return {"min_value": None, "max_value": None, "avg_value": None, "histogram": []}
    row = rows[0]
    min_v = row.get("min_v")
    max_v = row.get("max_v")
    avg_v = row.get("avg_v")
    histogram: List[Dict[str, Any]] = []
    if min_v is not None and max_v is not None and min_v != max_v:
        bins = _HIST_BINS
        try:
            min_f = float(min_v)
            max_f = float(max_v)
        except (TypeError, ValueError):
            return {"min_value": min_v, "max_value": max_v, "avg_value": avg_v, "histogram": []}
        step = (max_f - min_f) / bins
        bucket_expr = (
            f"LEAST(CAST(FLOOR(({quoted_col} - {min_f}) / {step}) AS BIGINT), {bins - 1})"
        )
        hist_sql = (
            f"SELECT {bucket_expr} AS bucket, COUNT(*) AS cnt "
            f"FROM {base_table} "
            f"WHERE {quoted_col} IS NOT NULL "
            f"GROUP BY bucket ORDER BY bucket"
        )
        _, hist_rows, _ = DataSourceConnectionService.execute_query(
            ds_type, config, hist_sql, timeout_seconds=60
        )
        for r in (hist_rows or []):
            try:
                b = int(r.get("bucket"))
            except (TypeError, ValueError):
                continue
            lo = min_f + b * step
            hi = lo + step
            histogram.append({"bin_start": lo, "bin_end": hi, "count": int(r.get("cnt") or 0)})
    return {
        "min_value": min_v,
        "max_value": max_v,
        "avg_value": avg_v,
        "histogram": histogram,
    }


def get_column_summary(
    datasource,
    db_table,
    column: str,
    *,
    top_limit: int = 10,
) -> ColumnSummary:
    from app.services.dataset_relation_service import resolve_dataset_table_relation
    from app.services.datasource_service import DataSourceConnectionService
    from app.services.live_query_service import (
        _dialect_for_ds_type,
        _quote_identifier,
        build_dataset_table_cache_identifier,
    )

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    dialect = _dialect_for_ds_type(ds_type)
    table_identifier = build_dataset_table_cache_identifier(db_table)

    cache_payload = {"column": column, "top_limit": top_limit}
    cached = query_cache.get_cached(
        datasource.id, table_identifier, "column_summary", cache_payload, []
    )
    if cached is not None:
        return ColumnSummary(**cached)

    plan = resolve_dataset_table_relation(datasource, db_table)
    base_table = f"({plan.sql}) AS _appbi_summary"
    quoted_col = _quote_identifier(column, dialect)

    overall_sql = (
        f"SELECT COUNT(*) AS total_rows, "
        f"COUNT(*) - COUNT({quoted_col}) AS null_count, "
        f"COUNT(DISTINCT {quoted_col}) AS distinct_count "
        f"FROM {base_table}"
    )
    _, rows, _ = DataSourceConnectionService.execute_query(
        ds_type, datasource.config, overall_sql, timeout_seconds=60
    )
    overall = rows[0] if rows else {}
    total_rows = int(overall.get("total_rows") or 0)
    null_count = int(overall.get("null_count") or 0)
    distinct_count = int(overall.get("distinct_count") or 0)

    kind = _detect_kind(column, db_table)
    if total_rows == 0:
        kind = "empty"

    extra: Dict[str, Any] = {}
    if kind == "numeric":
        extra = _numeric_summary(ds_type, datasource.config, base_table, quoted_col)
    elif kind in ("categorical", "boolean", "date"):
        extra = _categorical_summary(
            ds_type, datasource.config, base_table, quoted_col, top_limit
        )

    summary = ColumnSummary(
        column=column,
        detected_kind=kind,
        total_rows=total_rows,
        null_count=null_count,
        distinct_count=distinct_count,
        top_values=extra.get("top_values", []),
        min_value=extra.get("min_value"),
        max_value=extra.get("max_value"),
        avg_value=extra.get("avg_value"),
        histogram=extra.get("histogram", []),
    )

    query_cache.set_cached(
        datasource.id,
        table_identifier,
        "column_summary",
        cache_payload,
        [],
        summary.to_dict(),
    )
    return summary
