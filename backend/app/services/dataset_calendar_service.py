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
    }


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


def build_calendar_duckdb_sql(settings: Dict[str, Any]) -> str:
    start_date = settings["start_date"]
    end_date = settings["end_date"]
    return f"""
SELECT
  CAST(d AS DATE) AS date,
  CAST(strftime(CAST(d AS DATE), '%Y%m%d') AS BIGINT) AS date_key,
  CAST(EXTRACT(YEAR FROM CAST(d AS DATE)) AS INTEGER) AS year,
  CAST(EXTRACT(QUARTER FROM CAST(d AS DATE)) AS INTEGER) AS quarter,
  CAST(EXTRACT(YEAR FROM CAST(d AS DATE)) AS VARCHAR) || '-Q' || CAST(EXTRACT(QUARTER FROM CAST(d AS DATE)) AS VARCHAR) AS year_quarter,
  CAST(EXTRACT(MONTH FROM CAST(d AS DATE)) AS INTEGER) AS month,
  monthname(CAST(d AS DATE)) AS month_name,
  substr(monthname(CAST(d AS DATE)), 1, 3) AS month_short,
  strftime(CAST(d AS DATE), '%Y-%m') AS year_month,
  CAST(strftime(CAST(d AS DATE), '%V') AS INTEGER) AS week_of_year_iso,
  CAST(date_trunc('week', CAST(d AS DATE)) AS DATE) AS week_start_date,
  CAST(date_trunc('week', CAST(d AS DATE)) + INTERVAL 6 DAY AS DATE) AS week_end_date,
  CAST(EXTRACT(DAY FROM CAST(d AS DATE)) AS INTEGER) AS day_of_month,
  CAST(strftime(CAST(d AS DATE), '%u') AS INTEGER) AS day_of_week_iso,
  dayname(CAST(d AS DATE)) AS day_name,
  CASE WHEN CAST(strftime(CAST(d AS DATE), '%u') AS INTEGER) IN (6, 7) THEN TRUE ELSE FALSE END AS is_weekend,
  CAST(date_trunc('month', CAST(d AS DATE)) AS DATE) AS month_start_date,
  CAST(date_trunc('month', CAST(d AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY AS DATE) AS month_end_date
FROM generate_series(DATE '{start_date}', DATE '{end_date}', INTERVAL 1 DAY) AS calendar_series(d)
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
    return str(value or "").strip().lower()


def iter_temporal_columns(table: DatasetTable | Any) -> List[Dict[str, str]]:
    if is_generated_calendar_table(table):
        return []

    raw_columns = getattr(table, "columns_cache", None)
    if isinstance(raw_columns, dict):
        raw_columns = raw_columns.get("columns", [])
    if not isinstance(raw_columns, list):
        return []

    overrides = getattr(table, "type_overrides", None) or {}
    seen: set[str] = set()
    temporal_columns: List[Dict[str, str]] = []
    for column in raw_columns:
        if isinstance(column, dict):
            name = str(column.get("name") or "").strip()
            raw_type = overrides.get(name) or column.get("type")
        else:
            name = str(column or "").strip()
            raw_type = overrides.get(name)
        if not name or name in seen:
            continue
        normalized_type = normalize_column_type(raw_type)
        if normalized_type in TEMPORAL_COLUMN_TYPES:
            seen.add(name)
            temporal_columns.append({"name": name, "type": normalized_type})
    return temporal_columns


def build_calendar_role_view_name(base_view_name: str, column_name: str) -> str:
    return f"{_slugify(base_view_name, default='table')}__{_slugify(column_name, default='date')}__date_dim"


def build_calendar_role_display_name(base_label: str, column_name: str) -> str:
    return f"Date - {base_label}.{column_name}"


def build_calendar_join_sql(from_column: str, column_type: str, role_view_name: str) -> str:
    normalized = normalize_column_type(column_type)
    if normalized == "date":
        lhs = f"${{TABLE}}.{from_column}"
    else:
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
