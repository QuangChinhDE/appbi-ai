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
