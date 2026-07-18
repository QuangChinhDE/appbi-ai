"""Dataset calendar dimension helpers."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.models.dataset import Dataset, DatasetTable

CALENDAR_SOURCE_KIND = "generated_calendar"
CALENDAR_TABLE_DISPLAY_NAME = "Date"
CALENDAR_DEFAULT_START_DATE = "2000-01-01"
CALENDAR_DEFAULT_END_DATE = "2100-12-31"
CALENDAR_DEFAULT_TIMEZONE = "UTC"
CALENDAR_DEFAULT_WEEK_START_DAY = "monday"
CALENDAR_DEFAULT_FISCAL_YEAR_START_MONTH = 1

TEMPORAL_COLUMN_TYPES = {"date", "datetime", "timestamp"}
FILTERABLE_CALENDAR_FIELDS = {
    "date",
    "year",
    "quarter",
    "year_quarter",
    "month",
    "month_name",
    "month_short",
    "year_month",
    "week_of_year_iso",
    "day_of_month",
    "day_of_week_iso",
    "day_name",
    "is_weekend",
}

CALENDAR_DIMENSIONS: List[Dict[str, Any]] = [
    {"name": "date", "type": "date", "sql": "date", "label": "Date", "description": None, "hidden": False},
    {"name": "date_key", "type": "number", "sql": "date_key", "label": "Date Key", "description": None, "hidden": True},
    {"name": "year", "type": "number", "sql": "year", "label": "Year", "description": None, "hidden": False},
    {"name": "quarter", "type": "number", "sql": "quarter", "label": "Quarter", "description": None, "hidden": False},
    {"name": "year_quarter", "type": "string", "sql": "year_quarter", "label": "Year Quarter", "description": None, "hidden": False},
    {"name": "month", "type": "number", "sql": "month", "label": "Month", "description": None, "hidden": False},
    {"name": "month_name", "type": "string", "sql": "month_name", "label": "Month Name", "description": None, "hidden": False},
    {"name": "month_short", "type": "string", "sql": "month_short", "label": "Month Short", "description": None, "hidden": False},
    {"name": "year_month", "type": "string", "sql": "year_month", "label": "Year Month", "description": None, "hidden": False},
    {"name": "week_of_year_iso", "type": "number", "sql": "week_of_year_iso", "label": "ISO Week", "description": None, "hidden": False},
    {"name": "week_start_date", "type": "date", "sql": "week_start_date", "label": "Week Start Date", "description": None, "hidden": False},
    {"name": "week_end_date", "type": "date", "sql": "week_end_date", "label": "Week End Date", "description": None, "hidden": False},
    {"name": "day_of_month", "type": "number", "sql": "day_of_month", "label": "Day Of Month", "description": None, "hidden": False},
    {"name": "day_of_week_iso", "type": "number", "sql": "day_of_week_iso", "label": "ISO Day Of Week", "description": None, "hidden": False},
    {"name": "day_name", "type": "string", "sql": "day_name", "label": "Day Name", "description": None, "hidden": False},
    {"name": "is_weekend", "type": "yesno", "sql": "is_weekend", "label": "Is Weekend", "description": None, "hidden": False},
    {"name": "month_start_date", "type": "date", "sql": "month_start_date", "label": "Month Start Date", "description": None, "hidden": False},
    {"name": "month_end_date", "type": "date", "sql": "month_end_date", "label": "Month End Date", "description": None, "hidden": False},
]

CALENDAR_MEASURES: List[Dict[str, Any]] = [
    {
        "name": "count",
        "type": "count",
        "sql": "*",
        "label": "Count",
        "description": "Total number of calendar rows",
        "hidden": False,
    }
]


def _slugify(value: str | None, *, default: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9]+", "_", str(value or "").strip()).strip("_").lower()
    return text or default


def _safe_int(value: Any, default: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))


def _coerce_date_string(value: Any, default: str) -> str:
    if isinstance(value, date):
        return value.isoformat()
    text = str(value or "").strip()
    if not text:
        return default
    try:
        return date.fromisoformat(text[:10]).isoformat()
    except ValueError:
        return default


def normalize_calendar_dimension_settings(
    raw_settings: Dict[str, Any] | None,
    *,
    enabled_default: bool,
) -> Dict[str, Any]:
    raw = dict(raw_settings or {})
    start_date = _coerce_date_string(raw.get("start_date"), CALENDAR_DEFAULT_START_DATE)
    end_date = _coerce_date_string(raw.get("end_date"), CALENDAR_DEFAULT_END_DATE)
    if start_date > end_date:
        start_date, end_date = end_date, start_date

    week_start_day = str(raw.get("week_start_day") or CALENDAR_DEFAULT_WEEK_START_DAY).strip().lower()
    if week_start_day not in {"monday", "sunday"}:
        week_start_day = CALENDAR_DEFAULT_WEEK_START_DAY

    return {
        "enabled": bool(raw.get("enabled", enabled_default)),
        "start_date": start_date,
        "end_date": end_date,
        "timezone": str(raw.get("timezone") or CALENDAR_DEFAULT_TIMEZONE).strip() or CALENDAR_DEFAULT_TIMEZONE,
        "week_start_day": week_start_day,
        "fiscal_year_start_month": _safe_int(
            raw.get("fiscal_year_start_month"),
            CALENDAR_DEFAULT_FISCAL_YEAR_START_MONTH,
            minimum=1,
            maximum=12,
        ),
        "auto_join_temporal_columns": bool(raw.get("auto_join_temporal_columns", True)),
        "excluded_auto_joins": normalize_calendar_auto_join_exclusions(
            raw.get("excluded_auto_joins") or raw.get("excluded_date_links")
        ),
    }


def normalize_calendar_auto_join_exclusions(raw_exclusions: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_exclusions, list):
        return []

    exclusions: List[Dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for item in raw_exclusions:
        view_name = ""
        column_name = ""

        if isinstance(item, dict):
            view_name = str(item.get("view_name") or item.get("from_view") or "").strip()
            column_name = str(
                item.get("column_name")
                or item.get("from_column")
                or item.get("calendar_source_field")
                or ""
            ).strip()
        elif isinstance(item, str):
            text = item.strip()
            if "." in text:
                view_name, column_name = [part.strip() for part in text.split(".", 1)]

        if not view_name or not column_name:
            continue

        key = (view_name, column_name)
        if key in seen:
            continue
        seen.add(key)
        exclusions.append({
            "view_name": view_name,
            "column_name": column_name,
        })

    return exclusions


def normalize_dataset_settings(
    raw_settings: Dict[str, Any] | None,
    *,
    enabled_default: bool,
) -> Dict[str, Any]:
    raw = dict(raw_settings or {})
    return {
        "calendar_dimension": normalize_calendar_dimension_settings(
            raw.get("calendar_dimension"),
            enabled_default=enabled_default,
        )
    }


def get_dataset_settings(dataset: Dataset | Any, *, enabled_default: bool = False) -> Dict[str, Any]:
    return normalize_dataset_settings(getattr(dataset, "settings", None), enabled_default=enabled_default)


def get_calendar_settings(dataset: Dataset | Any, *, enabled_default: bool = False) -> Dict[str, Any]:
    return get_dataset_settings(dataset, enabled_default=enabled_default)["calendar_dimension"]


def is_calendar_join_excluded(
    settings: Dict[str, Any] | None,
    *,
    view_name: str,
    column_name: str,
) -> bool:
    normalized_view_name = str(view_name or "").strip()
    normalized_column_name = str(column_name or "").strip()
    if not normalized_view_name or not normalized_column_name:
        return False

    exclusions = normalize_calendar_auto_join_exclusions(
        (settings or {}).get("excluded_auto_joins")
    )
    return any(
        item["view_name"] == normalized_view_name and item["column_name"] == normalized_column_name
        for item in exclusions
    )


def exclude_calendar_join(
    dataset: Dataset | Any,
    *,
    view_name: str,
    column_name: str,
    enabled_default: bool = False,
) -> bool:
    normalized_view_name = str(view_name or "").strip()
    normalized_column_name = str(column_name or "").strip()
    if not normalized_view_name or not normalized_column_name:
        return False

    current_settings = get_dataset_settings(dataset, enabled_default=enabled_default)
    calendar_settings = dict(current_settings.get("calendar_dimension") or {})
    exclusions = normalize_calendar_auto_join_exclusions(calendar_settings.get("excluded_auto_joins"))
    key = {
        "view_name": normalized_view_name,
        "column_name": normalized_column_name,
    }

    if any(
        item["view_name"] == key["view_name"] and item["column_name"] == key["column_name"]
        for item in exclusions
    ):
        return False

    exclusions.append(key)
    calendar_settings["excluded_auto_joins"] = exclusions
    dataset.settings = normalize_dataset_settings(
        {"calendar_dimension": calendar_settings},
        enabled_default=bool(calendar_settings.get("enabled", enabled_default)),
    )
    return True


def is_generated_calendar_table(table: DatasetTable | Any | None) -> bool:
    return str(getattr(table, "source_kind", "") or "").strip().lower() == CALENDAR_SOURCE_KIND


def build_calendar_columns_cache() -> Dict[str, Any]:
    return {
        "columns": [
            {
                "name": column["name"],
                "type": column["type"],
                "nullable": False,
            }
            for column in CALENDAR_DIMENSIONS
        ]
    }


def _calendar_row_values(current: date) -> Dict[str, Any]:
    iso_weekday = current.isoweekday()
    week_start = current - timedelta(days=iso_weekday - 1)
    month_start = current.replace(day=1)
    if current.month == 12:
        next_month_start = current.replace(year=current.year + 1, month=1, day=1)
    else:
        next_month_start = current.replace(month=current.month + 1, day=1)
    month_end = next_month_start - timedelta(days=1)
    quarter = ((current.month - 1) // 3) + 1
    return {
        "date": current.isoformat(),
        "date_key": int(current.strftime("%Y%m%d")),
        "year": current.year,
        "quarter": quarter,
        "year_quarter": f"{current.year}-Q{quarter}",
        "month": current.month,
        "month_name": current.strftime("%B"),
        "month_short": current.strftime("%b"),
        "year_month": current.strftime("%Y-%m"),
        "week_of_year_iso": int(current.isocalendar().week),
        "week_start_date": week_start.isoformat(),
        "week_end_date": (week_start + timedelta(days=6)).isoformat(),
        "day_of_month": current.day,
        "day_of_week_iso": iso_weekday,
        "day_name": current.strftime("%A"),
        "is_weekend": iso_weekday in (6, 7),
        "month_start_date": month_start.isoformat(),
        "month_end_date": month_end.isoformat(),
    }


def build_calendar_sample_rows(settings: Dict[str, Any], limit: int = 64) -> List[Dict[str, Any]]:
    start = date.fromisoformat(settings["start_date"])
    end = date.fromisoformat(settings["end_date"])
    rows: List[Dict[str, Any]] = []
    current = start
    while current <= end and len(rows) < max(1, int(limit)):
        rows.append(_calendar_row_values(current))
        current += timedelta(days=1)
    return rows


def build_calendar_live_sql(settings: Dict[str, Any], dialect: str) -> str:
    """Generate calendar SQL for live query execution against a real database.

    Supports bigquery, postgresql, mysql, and duckdb dialects.
    duckdb is used for google_sheets and manual datasources.
    """
    start_date = settings["start_date"]
    end_date = settings["end_date"]

    if dialect == "duckdb":
        return f"""
WITH RECURSIVE calendar_series AS (
  SELECT DATE '{start_date}' AS d
  UNION ALL
  SELECT d + INTERVAL '1 day' FROM calendar_series WHERE d < DATE '{end_date}'
)
SELECT
  d AS date,
  CAST(strftime(d, '%Y%m%d') AS BIGINT) AS date_key,
  CAST(EXTRACT(YEAR FROM d) AS INTEGER) AS year,
  CAST(EXTRACT(QUARTER FROM d) AS INTEGER) AS quarter,
  CAST(EXTRACT(YEAR FROM d) AS VARCHAR) || '-Q' || CAST(EXTRACT(QUARTER FROM d) AS VARCHAR) AS year_quarter,
  CAST(EXTRACT(MONTH FROM d) AS INTEGER) AS month,
  monthname(d) AS month_name,
  substr(monthname(d), 1, 3) AS month_short,
  strftime(d, '%Y-%m') AS year_month,
  CAST(strftime(d, '%V') AS INTEGER) AS week_of_year_iso,
  d - ((CAST(strftime(d, '%u') AS INTEGER) - 1) * INTERVAL '1 day') AS week_start_date,
  d + ((7 - CAST(strftime(d, '%u') AS INTEGER)) * INTERVAL '1 day') AS week_end_date,
  CAST(EXTRACT(DAY FROM d) AS INTEGER) AS day_of_month,
  CAST(strftime(d, '%u') AS INTEGER) AS day_of_week_iso,
  dayname(d) AS day_name,
  CASE WHEN CAST(strftime(d, '%u') AS INTEGER) IN (6, 7) THEN TRUE ELSE FALSE END AS is_weekend,
  d - ((CAST(EXTRACT(DAY FROM d) AS INTEGER) - 1) * INTERVAL '1 day') AS month_start_date,
  (d - ((CAST(EXTRACT(DAY FROM d) AS INTEGER) - 1) * INTERVAL '1 day') + INTERVAL '1 month' - INTERVAL '1 day') AS month_end_date
FROM calendar_series
""".strip()

    if dialect == "bigquery":
        return f"""
SELECT
  d AS date,
  CAST(FORMAT_DATE('%Y%m%d', d) AS INT64) AS date_key,
  EXTRACT(YEAR FROM d) AS year,
  EXTRACT(QUARTER FROM d) AS quarter,
  CONCAT(CAST(EXTRACT(YEAR FROM d) AS STRING), '-Q', CAST(EXTRACT(QUARTER FROM d) AS STRING)) AS year_quarter,
  EXTRACT(MONTH FROM d) AS month,
  FORMAT_DATE('%B', d) AS month_name,
  FORMAT_DATE('%b', d) AS month_short,
  FORMAT_DATE('%Y-%m', d) AS year_month,
  EXTRACT(ISOWEEK FROM d) AS week_of_year_iso,
  DATE_TRUNC(d, ISOWEEK) AS week_start_date,
  DATE_ADD(DATE_TRUNC(d, ISOWEEK), INTERVAL 6 DAY) AS week_end_date,
  EXTRACT(DAY FROM d) AS day_of_month,
  MOD(EXTRACT(DAYOFWEEK FROM d) + 5, 7) + 1 AS day_of_week_iso,
  FORMAT_DATE('%A', d) AS day_name,
  CASE WHEN MOD(EXTRACT(DAYOFWEEK FROM d) + 5, 7) + 1 IN (6, 7) THEN TRUE ELSE FALSE END AS is_weekend,
  DATE_TRUNC(d, MONTH) AS month_start_date,
  DATE_SUB(DATE_ADD(DATE_TRUNC(d, MONTH), INTERVAL 1 MONTH), INTERVAL 1 DAY) AS month_end_date
FROM UNNEST(GENERATE_DATE_ARRAY(DATE '{start_date}', DATE '{end_date}')) AS d
""".strip()

    if dialect == "mysql":
        return f"""
WITH RECURSIVE calendar_series AS (
  SELECT CAST('{start_date}' AS DATE) AS d
  UNION ALL
  SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM calendar_series WHERE d < '{end_date}'
)
SELECT
  d AS date,
  CAST(DATE_FORMAT(d, '%Y%m%d') AS UNSIGNED) AS date_key,
  YEAR(d) AS year,
  QUARTER(d) AS quarter,
  CONCAT(CAST(YEAR(d) AS CHAR), '-Q', CAST(QUARTER(d) AS CHAR)) AS year_quarter,
  MONTH(d) AS month,
  MONTHNAME(d) AS month_name,
  DATE_FORMAT(d, '%b') AS month_short,
  DATE_FORMAT(d, '%Y-%m') AS year_month,
  WEEK(d, 3) AS week_of_year_iso,
  DATE_SUB(d, INTERVAL (WEEKDAY(d)) DAY) AS week_start_date,
  DATE_ADD(DATE_SUB(d, INTERVAL (WEEKDAY(d)) DAY), INTERVAL 6 DAY) AS week_end_date,
  DAY(d) AS day_of_month,
  WEEKDAY(d) + 1 AS day_of_week_iso,
  DAYNAME(d) AS day_name,
  CASE WHEN WEEKDAY(d) + 1 IN (6, 7) THEN TRUE ELSE FALSE END AS is_weekend,
  DATE_SUB(d, INTERVAL (DAY(d) - 1) DAY) AS month_start_date,
  LAST_DAY(d) AS month_end_date
FROM calendar_series
""".strip()

    # Default: PostgreSQL
    return f"""
SELECT
  d::date AS date,
  CAST(TO_CHAR(d::date, 'YYYYMMDD') AS BIGINT) AS date_key,
  EXTRACT(YEAR FROM d::date)::INTEGER AS year,
  EXTRACT(QUARTER FROM d::date)::INTEGER AS quarter,
  EXTRACT(YEAR FROM d::date)::VARCHAR || '-Q' || EXTRACT(QUARTER FROM d::date)::VARCHAR AS year_quarter,
  EXTRACT(MONTH FROM d::date)::INTEGER AS month,
  TO_CHAR(d::date, 'FMMonth') AS month_name,
  TO_CHAR(d::date, 'Mon') AS month_short,
  TO_CHAR(d::date, 'YYYY-MM') AS year_month,
  EXTRACT(WEEK FROM d::date)::INTEGER AS week_of_year_iso,
  DATE_TRUNC('week', d::date)::DATE AS week_start_date,
  (DATE_TRUNC('week', d::date) + INTERVAL '6 days')::DATE AS week_end_date,
  EXTRACT(DAY FROM d::date)::INTEGER AS day_of_month,
  EXTRACT(ISODOW FROM d::date)::INTEGER AS day_of_week_iso,
  TO_CHAR(d::date, 'FMDay') AS day_name,
  CASE WHEN EXTRACT(ISODOW FROM d::date) IN (6, 7) THEN TRUE ELSE FALSE END AS is_weekend,
  DATE_TRUNC('month', d::date)::DATE AS month_start_date,
  (DATE_TRUNC('month', d::date) + INTERVAL '1 month' - INTERVAL '1 day')::DATE AS month_end_date
FROM generate_series(DATE '{start_date}', DATE '{end_date}', INTERVAL '1 day') AS calendar_series(d)
""".strip()


def hydrate_calendar_table_metadata(table: DatasetTable, settings: Dict[str, Any]) -> None:
    table.display_name = CALENDAR_TABLE_DISPLAY_NAME
    table.source_table_name = "__generated_calendar__"
    table.source_query = None
    table.query_mode = "synced"
    table.transformations = []
    table.columns_cache = build_calendar_columns_cache()
    table.sample_cache = build_calendar_sample_rows(settings)
    table.type_overrides = None
    table.column_formats = None
    table.column_stats = None
    table.auto_description = "System-generated standard calendar dimension for date joins and reporting filters."
    table.schema_hash = "generated_calendar_v1"
    table.stats_updated_at = None
    table.column_descriptions = None
    table.common_questions = None
    table.query_aliases = None
    table.description_source = "auto"
    table.schema_change_pending = False
    table.generation_status = "succeeded"
    table.generation_error = None
    table.stale_reason = None


def get_calendar_table(db: Session, dataset_id: int) -> Optional[DatasetTable]:
    return (
        db.query(DatasetTable)
        .filter(DatasetTable.dataset_id == dataset_id, DatasetTable.source_kind == CALENDAR_SOURCE_KIND)
        .first()
    )


def ensure_calendar_table(
    db: Session,
    dataset: Dataset,
) -> DatasetTable:
    settings = get_calendar_settings(dataset, enabled_default=True)
    # Lock the parent dataset row to prevent concurrent calendar table creation.
    db.query(Dataset).filter(Dataset.id == dataset.id).with_for_update().first()
    table = get_calendar_table(db, dataset.id)
    if table is None:
        table = DatasetTable(
            dataset_id=dataset.id,
            datasource_id=None,
            source_kind=CALENDAR_SOURCE_KIND,
            display_name=CALENDAR_TABLE_DISPLAY_NAME,
            enabled=True,
            transformations=[],
            query_mode="synced",
        )
        db.add(table)
        db.flush()

    hydrate_calendar_table_metadata(table, settings)
    return table


def remove_calendar_table(db: Session, dataset_id: int) -> bool:
    table = get_calendar_table(db, dataset_id)
    if table is None:
        return False
    db.delete(table)
    return True


def normalize_column_type(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return ""

    if normalized == "date":
        return "date"
    if normalized.startswith("date["):
        return "date"
    if normalized in {"datetime", "datetime64", "datetime64[ns]"}:
        return "datetime"
    if "timestamp" in normalized or normalized.startswith("timestamptz"):
        return "timestamp"
    return normalized


def iter_temporal_columns(table: DatasetTable | Any) -> List[Dict[str, str]]:
    if is_generated_calendar_table(table):
        return []

    raw_columns = getattr(table, "columns_cache", None)
    if isinstance(raw_columns, dict):
        raw_columns = raw_columns.get("columns", [])
    if not isinstance(raw_columns, list):
        return []

    from app.services.type_override_service import _override_type as _ovr_type
    overrides = getattr(table, "type_overrides", None) or {}
    seen: set[str] = set()
    temporal_columns: List[Dict[str, str]] = []
    for column in raw_columns:
        source_type = None
        if isinstance(column, dict):
            name = str(column.get("name") or "").strip()
            raw_type = _ovr_type(overrides.get(name)) or column.get("type")
            # PHYSICAL warehouse type — the value-sampled semantic `type` labels a
            # real BigQuery TIMESTAMP as "datetime", which lost the instant-ness
            # needed to decide timezone conversion (audit #4 miss found in E2E).
            source_type = str(column.get("source_type") or "").strip().lower() or None
        else:
            name = str(column or "").strip()
            raw_type = _ovr_type(overrides.get(name))
        if not name or name in seen:
            continue
        normalized_type = normalize_column_type(raw_type)
        if normalized_type in TEMPORAL_COLUMN_TYPES:
            seen.add(name)
            temporal_columns.append(
                {"name": name, "type": normalized_type, "source_type": source_type}
            )
    return temporal_columns


def build_calendar_role_view_name(base_view_name: str, column_name: str) -> str:
    return f"{_slugify(base_view_name, default='table')}__{_slugify(column_name, default='date')}__date_dim"


def disambiguate_role_view_name(candidate: str, taken: set, column_name: str) -> str:
    """Semantic-audit 2026-07 (#5) — two temporal columns whose names slugify
    identically ('Order Date' vs 'order_date') used to collapse into ONE
    role-dim: one date field silently lost its calendar, and rendering both
    join edges onto the same alias dropped rows where the two dates differ.
    On collision, append a short stable hash of the RAW column name (so the
    suffix never changes across regenerations); first-in-column-order keeps
    the plain name (existing non-colliding datasets are untouched)."""
    if candidate not in taken:
        return candidate
    import hashlib as _h

    suffix = _h.md5(str(column_name).encode("utf-8")).hexdigest()[:4]
    base = candidate[:-len("__date_dim")] if candidate.endswith("__date_dim") else candidate
    out = f"{base}_{suffix}__date_dim"
    n = 2
    while out in taken:  # paranoid: raw-name hash collision
        out = f"{base}_{suffix}{n}__date_dim"
        n += 1
    return out


def build_calendar_role_display_name(base_label: str, column_name: str) -> str:
    return f"Date - {base_label}.{column_name}"


# IANA timezone names only (Asia/Ho_Chi_Minh, UTC, Etc/GMT+7 …) — the strict
# charset doubles as SQL-injection protection for the macro payload.
_TZ_NAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9_+\-/]*")

# Render-time macro carried inside a join's sql_on. The stored template must
# stay DIALECT-PORTABLE (one sql_on executes on the sync dialect live AND on
# BigQuery in snapshot mode), so the tz-aware date expression cannot be baked
# in at model-gen time; renderers expand it per execution dialect via
# `expand_local_date_macros`.
_LOCAL_DATE_MACRO_RE = re.compile(
    r"\$\{APPBI_LOCAL_DATE\(([^|)]+)\|([A-Za-z][A-Za-z0-9_+\-/]*)\)\}"
)


def expand_local_date_macros(sql: str, dialect: str | None) -> str:
    """Expand ${APPBI_LOCAL_DATE(<expr>|<tz>)} into the execution dialect's
    'local calendar date of this instant' expression. Naive/unknown dialects
    fall back to plain CAST(expr AS DATE) — exactly the pre-timezone
    behaviour, so a macro can never leak raw into SQL."""
    if "APPBI_LOCAL_DATE" not in (sql or ""):
        return sql
    d = (dialect or "").strip().lower()

    def _one(m: "re.Match[str]") -> str:
        expr = m.group(1).strip()
        tz = m.group(2).strip()
        if not _TZ_NAME_RE.fullmatch(tz):
            return f"CAST({expr} AS DATE)"
        if d == "bigquery":
            return f"DATE({expr}, '{tz}')"
        if d in ("postgresql", "duckdb"):
            # naive timestamps are stored as UTC instants in our pipeline —
            # interpret as UTC, then shift to the calendar timezone.
            return f"CAST(({expr} AT TIME ZONE 'UTC' AT TIME ZONE '{tz}') AS DATE)"
        if d == "mysql":
            return f"DATE(CONVERT_TZ({expr}, 'UTC', '{tz}'))"
        return f"CAST({expr} AS DATE)"

    return _LOCAL_DATE_MACRO_RE.sub(_one, sql)


def build_calendar_join_sql(
    from_column: str,
    column_type: str,
    role_view_name: str,
    timezone: str | None = None,
    physical_type: str | None = None,
) -> str:
    # Semantic-audit 2026-07 (#4) — the calendar settings carry a `timezone`
    # the join previously IGNORED: a TIMESTAMP row at 2023-06-30T20:00Z with
    # tz=+7 belongs to July locally but joined the June 30 calendar row, so
    # near-midnight rows mis-bucketed month/quarter/year. For an EXPLICIT
    # non-UTC timezone on a true-INSTANT column, emit the dialect-portable
    # local-date macro; UTC (the default) keeps the plain CAST — byte-identical
    # to the pre-fix template, no silent shift for existing datasets.
    #
    # E2E fix: the instant check keys on the PHYSICAL warehouse type, not the
    # value-sampled semantic type — BigQuery TIMESTAMP columns are frequently
    # sampled as semantic "datetime", which made the tz branch silently
    # no-op. TIMESTAMP/TIMESTAMPTZ are instants (tz-convertible); a genuine
    # wall-clock DATETIME/DATE carries no tz and keeps the plain CAST.
    tz = str(timezone or "").strip()
    phys = str(physical_type or "").strip().lower().split("(", 1)[0].strip()
    ctype = str(column_type or "").strip().lower()
    _INSTANT_PHYS = {"timestamp", "timestamptz", "timestamp_tz", "timestamp with time zone"}
    is_instant = phys in _INSTANT_PHYS or (not phys and ctype == "timestamp")
    if (
        tz and tz.upper() != "UTC" and is_instant
        and _TZ_NAME_RE.fullmatch(tz)
    ):
        return f"${{APPBI_LOCAL_DATE(${{TABLE}}.{from_column}|{tz})}} = ${{{role_view_name}}}.date"
    # Always normalize temporal joins to DATE. This avoids runtime mismatches
    # such as BigQuery TIMESTAMP = DATE when upstream metadata or overrides mark
    # a timestamp-like source column as a plain date.
    lhs = f"CAST(${{TABLE}}.{from_column} AS DATE)"
    return f"{lhs} = ${{{role_view_name}}}.date"


def build_calendar_binding_mapping(semantic_field: str, source_field: str, field_name: str) -> Dict[str, Any]:
    return {
        "semanticField": semantic_field,
        "sourceField": source_field,
        "calendarField": field_name,
    }


def build_calendar_filter_expression(field_name: str, source_field: str, dialect: str) -> Optional[str]:
    safe_source = source_field.replace('"', "").replace("`", "")
    if not safe_source:
        return None

    if dialect == "bigquery":
        date_expr = f"DATE(`{safe_source}`)"
        year_expr = f"EXTRACT(YEAR FROM {date_expr})"
        quarter_expr = f"EXTRACT(QUARTER FROM {date_expr})"
        month_expr = f"EXTRACT(MONTH FROM {date_expr})"
        iso_week_expr = f"EXTRACT(ISOWEEK FROM {date_expr})"
        iso_dow_expr = f"EXTRACT(ISODOW FROM {date_expr})"
        day_expr = f"EXTRACT(DAY FROM {date_expr})"
        month_name_expr = f"FORMAT_DATE('%B', {date_expr})"
        month_short_expr = f"FORMAT_DATE('%b', {date_expr})"
        day_name_expr = f"FORMAT_DATE('%A', {date_expr})"
        year_month_expr = f"FORMAT_DATE('%Y-%m', {date_expr})"
    elif dialect == "mysql":
        date_expr = f"DATE(`{safe_source}`)"
        year_expr = f"EXTRACT(YEAR FROM {date_expr})"
        quarter_expr = f"QUARTER({date_expr})"
        month_expr = f"EXTRACT(MONTH FROM {date_expr})"
        iso_week_expr = f"WEEK({date_expr}, 3)"
        iso_dow_expr = f"(WEEKDAY({date_expr}) + 1)"
        day_expr = f"EXTRACT(DAY FROM {date_expr})"
        month_name_expr = f"MONTHNAME({date_expr})"
        month_short_expr = f"DATE_FORMAT({date_expr}, '%b')"
        day_name_expr = f"DAYNAME({date_expr})"
        year_month_expr = f"DATE_FORMAT({date_expr}, '%Y-%m')"
    elif dialect == "duckdb":
        date_expr = f'CAST("{safe_source}" AS DATE)'
        year_expr = f"CAST(EXTRACT(YEAR FROM {date_expr}) AS INTEGER)"
        quarter_expr = f"CAST(EXTRACT(QUARTER FROM {date_expr}) AS INTEGER)"
        month_expr = f"CAST(EXTRACT(MONTH FROM {date_expr}) AS INTEGER)"
        iso_week_expr = f"CAST(strftime({date_expr}, '%V') AS INTEGER)"
        iso_dow_expr = f"CAST(strftime({date_expr}, '%u') AS INTEGER)"
        day_expr = f"CAST(EXTRACT(DAY FROM {date_expr}) AS INTEGER)"
        month_name_expr = f"monthname({date_expr})"
        month_short_expr = f"substr(monthname({date_expr}), 1, 3)"
        day_name_expr = f"dayname({date_expr})"
        year_month_expr = f"strftime({date_expr}, '%Y-%m')"
    else:
        date_expr = f'CAST("{safe_source}" AS DATE)'
        year_expr = f"EXTRACT(YEAR FROM {date_expr})"
        quarter_expr = f"EXTRACT(QUARTER FROM {date_expr})"
        month_expr = f"EXTRACT(MONTH FROM {date_expr})"
        iso_week_expr = f"EXTRACT(WEEK FROM {date_expr})"
        iso_dow_expr = f"EXTRACT(ISODOW FROM {date_expr})"
        day_expr = f"EXTRACT(DAY FROM {date_expr})"
        month_name_expr = f"TO_CHAR({date_expr}, 'FMMonth')"
        month_short_expr = f"TO_CHAR({date_expr}, 'Mon')"
        day_name_expr = f"TO_CHAR({date_expr}, 'FMDay')"
        year_month_expr = f"TO_CHAR({date_expr}, 'YYYY-MM')"

    expr_map = {
        "date": date_expr,
        "year": year_expr,
        "quarter": quarter_expr,
        "year_quarter": f"CAST({year_expr} AS VARCHAR) || '-Q' || CAST({quarter_expr} AS VARCHAR)",
        "month": month_expr,
        "month_name": month_name_expr,
        "month_short": month_short_expr,
        "year_month": year_month_expr,
        "week_of_year_iso": iso_week_expr,
        "day_of_month": day_expr,
        "day_of_week_iso": iso_dow_expr,
        "day_name": day_name_expr,
        "is_weekend": f"CASE WHEN {iso_dow_expr} IN (6, 7) THEN TRUE ELSE FALSE END",
    }
    return expr_map.get(field_name)


def get_calendar_role_view_display(view_name: str) -> Optional[str]:
    match = re.match(r"^(?P<base>.+)__([^_].*)__date_dim$", view_name or "")
    if not match:
        return None
    base = str(match.group("base") or "").replace("_", " ").strip().title()
    column_slug = str(view_name).split("__")[-2].replace("_", " ").strip()
    if not base or not column_slug:
        return None
    return f"Date - {base}.{column_slug}"


def iter_calendar_binding_fields(
    joins: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    mappings: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for join in joins or []:
        if join.get("origin") != "auto_calendar":
            continue
        role_view = str(join.get("view") or "").strip()
        source_field = str(join.get("from_column") or "").strip()
        for field_name in FILTERABLE_CALENDAR_FIELDS:
            semantic_field = f"{role_view}.{field_name}"
            if semantic_field in seen:
                continue
            seen.add(semantic_field)
            mappings.append(build_calendar_binding_mapping(semantic_field, source_field, field_name))
    return mappings
