"""Snapshot storage + schedule config for a dataset (Pha A + B).

Lives on ``dataset.settings["snapshot_config"]`` so it rides the existing dataset
settings JSON (no migration). Shape:

    {
      "schedule": {"mode": "manual"|"hourly"|"daily"|"cron",
                    "at": "HH:MM", "cron": "0 2 * * *", "timezone": "UTC"},
      "tables": {
        "<dataset_table_id>": {
          "partition_field": "sale_date",
          "partition_granularity": "DAY"|"MONTH"|"YEAR",
          "cluster_fields": ["store_id", "product_id"]   # <= 4
        }
      }
    }

The BI Engineer sets this in the Sync & Publish modal; build_table_snapshot reads
it to create a PARTITIONED + CLUSTERED BigQuery snapshot instead of a plain table,
and the refresh scheduler reads ``schedule`` to run Sync & Publish on a cadence.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

# BigQuery partition columns must be one of these physical types.
_PARTITION_ELIGIBLE = {"DATE", "TIMESTAMP", "DATETIME"}
_GRANULARITIES = {"DAY", "MONTH", "YEAR", "HOUR"}
_SCHEDULE_MODES = {"manual", "hourly", "daily", "cron"}
MAX_CLUSTER_FIELDS = 4


def get_snapshot_config(dataset: Any) -> Dict[str, Any]:
    settings = getattr(dataset, "settings", None) or {}
    cfg = settings.get("snapshot_config")
    return cfg if isinstance(cfg, dict) else {}


def table_storage_config(dataset: Any, table_id: int) -> Dict[str, Any]:
    tables = get_snapshot_config(dataset).get("tables")
    if not isinstance(tables, dict):
        return {}
    entry = tables.get(str(table_id))
    return entry if isinstance(entry, dict) else {}


def schedule_config(dataset: Any) -> Dict[str, Any]:
    sch = get_snapshot_config(dataset).get("schedule")
    return sch if isinstance(sch, dict) else {"mode": "manual"}


def resolved_partition_cluster(
    storage: Dict[str, Any], bq_schema: Optional[list]
) -> Tuple[Optional[str], str, Optional[List[str]], Optional[str]]:
    """Validate a table's storage config against the ACTUAL snapshot schema.

    Returns (partition_field, partition_granularity, cluster_fields, warning).
    A partition_field that is absent from the schema or not a DATE/TIMESTAMP/
    DATETIME column is DROPPED with a warning (clustering still applies) so a
    bad config never breaks the load — it just falls back to a plain/clustered
    table. cluster_fields are filtered to columns present in the schema (<=4)."""
    if not storage:
        return None, "DAY", None, None

    schema_types: Dict[str, str] = {}
    for f in (bq_schema or []):
        name = getattr(f, "name", None)
        ftype = str(getattr(f, "field_type", "") or getattr(f, "type_", "") or "").upper()
        if name:
            schema_types[name] = ftype

    warning = None
    part_field = (storage.get("partition_field") or "").strip() or None
    gran = str(storage.get("partition_granularity") or "DAY").upper()
    if gran not in _GRANULARITIES:
        gran = "DAY"
    if part_field:
        # When we HAVE the schema, enforce the eligible type; when schema is
        # unknown (autodetect load) trust the config and let BQ validate.
        if schema_types:
            t = schema_types.get(part_field)
            if t is None:
                warning = f"partition field '{part_field}' not in snapshot schema — partitioning skipped"
                part_field = None
            elif t not in _PARTITION_ELIGIBLE:
                warning = (
                    f"partition field '{part_field}' is {t}, not DATE/TIMESTAMP/DATETIME "
                    f"— partitioning skipped (set its column type to a date type to enable)"
                )
                part_field = None

    cluster = storage.get("cluster_fields") or []
    if not isinstance(cluster, list):
        cluster = []
    cluster = [str(c).strip() for c in cluster if str(c).strip()]
    if schema_types:
        cluster = [c for c in cluster if c in schema_types]
    cluster = cluster[:MAX_CLUSTER_FIELDS] or None

    return part_field, gran, cluster, warning


def validate_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize + validate an incoming snapshot_config payload (from the API).
    Raises ValueError on a structurally invalid schedule; per-table storage is
    stored as-is and validated against the real schema at build time."""
    out: Dict[str, Any] = {}
    sch = payload.get("schedule")
    if isinstance(sch, dict):
        mode = str(sch.get("mode") or "manual").lower()
        if mode not in _SCHEDULE_MODES:
            raise ValueError(f"schedule.mode phải là một trong {_SCHEDULE_MODES}")
        norm = {"mode": mode, "timezone": str(sch.get("timezone") or "UTC")}
        if mode == "daily":
            norm["at"] = str(sch.get("at") or "02:00")
        elif mode == "cron":
            cron = str(sch.get("cron") or "").strip()
            if not cron:
                raise ValueError("schedule.cron trống")
            try:
                from apscheduler.triggers.cron import CronTrigger
                CronTrigger.from_crontab(cron)
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"cron không hợp lệ: {exc}") from exc
            norm["cron"] = cron
        out["schedule"] = norm
    tables = payload.get("tables")
    if isinstance(tables, dict):
        norm_tables: Dict[str, Any] = {}
        for tid, entry in tables.items():
            if not isinstance(entry, dict):
                continue
            cf = entry.get("cluster_fields") or []
            if not isinstance(cf, list):
                cf = []
            norm_tables[str(tid)] = {
                "partition_field": (entry.get("partition_field") or "").strip() or None,
                "partition_granularity": str(entry.get("partition_granularity") or "DAY").upper(),
                "cluster_fields": [str(c).strip() for c in cf if str(c).strip()][:MAX_CLUSTER_FIELDS],
            }
        out["tables"] = norm_tables
    return out
