"""Single source of truth for the SQL relation a DatasetTable resolves to.

Why this exists: chart, preview, anomaly, table-stats, distinct-values, derived
tables, dashboard validate — every one of these needs the same base SELECT for
a given DatasetTable. They used to call `build_live_base_query_plan` directly,
each with its own `apply_type_overrides=` value. That led to drift where one
path saw a CAST and another did not, producing the SUM(VARCHAR) class of bugs.

This module exposes one entrypoint, `resolve_dataset_table_relation`, that
always applies type overrides and transformations. Specialty paths that
deliberately need the raw base (audit before save, semantic view definition)
keep calling `build_live_base_query_plan` directly with a documented reason.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from app.core.logging import get_logger
from app.services.live_query_service import (
    LiveBaseQueryPlan,
    build_live_base_query_plan,
)

logger = get_logger(__name__)


def resolve_dataset_table_relation(
    datasource,
    db_table,
    *,
    partition_days_ago: Optional[int] = None,
    bigquery_partition_meta: Optional[Dict[str, Any]] = None,
) -> LiveBaseQueryPlan:
    """Return the canonical LiveBaseQueryPlan for a DatasetTable.

    All non-specialty callers MUST go through this. Type overrides and
    transformations are always applied, so chart-time SQL matches preview-time
    SQL by construction. Pass the BigQuery partition kwargs through unchanged
    when the caller participates in BigQuery partition lookback.
    """
    return build_live_base_query_plan(
        datasource,
        db_table,
        apply_type_overrides=True,
        partition_days_ago=partition_days_ago,
        bigquery_partition_meta=bigquery_partition_meta,
    )


def logical_relation_columns(db, db_table, reason: Optional[list] = None) -> Optional[list]:
    """The columns the table's LOGICAL relation has NOW ([{name, type}]) — the
    source after the table's transformations and type overrides, i.e. what every
    chart reads — inferred on its engine. None when it cannot be determined (no
    datasource of its own, unreadable source): callers then say "unknown", never
    "unchanged". The one place health, drift and observability read a table's
    current schema from, instead of the cached description of it. ``reason``
    (a list) receives why it could not be read, for the user-facing detail."""
    if db_table is None or not getattr(db_table, "datasource_id", None):
        return None
    from app.models.models import DataSource
    from app.services.datasource_service import DataSourceConnectionService

    ds = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if ds is None:
        return None
    ds_type = ds.type if isinstance(ds.type, str) else ds.type.value
    try:
        plan = resolve_dataset_table_relation(ds, db_table)
        cols = DataSourceConnectionService.infer_column_types(
            ds_type, ds.config, f"SELECT * FROM ({plan.sql}) AS _appbi_cols")
    except Exception as exc:  # noqa: BLE001 — unknown, never "unchanged"
        logger.warning("logical_relation_columns failed for table %s: %s", getattr(db_table, "id", None), exc)
        if reason is not None:
            reason.append(str(exc).strip().splitlines()[0][:300] if str(exc).strip() else type(exc).__name__)
        return None
    return [{"name": str(c.get("name")), "type": c.get("type")}
            for c in cols or [] if isinstance(c, dict) and c.get("name")]
