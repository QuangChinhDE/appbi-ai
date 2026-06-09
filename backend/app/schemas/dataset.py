"""Schemas for Datasets (Table-based Datasets)"""
from datetime import date, datetime
from typing import Literal, Optional, List, Dict, Any, Union
from pydantic import BaseModel, Field, model_validator
from uuid import UUID


# ===== Dataset Schemas =====


class CalendarAutoJoinExclusion(BaseModel):
    view_name: str = Field(..., min_length=1, max_length=255)
    column_name: str = Field(..., min_length=1, max_length=255)


class CalendarDimensionSettings(BaseModel):
    enabled: bool = True
    start_date: date = Field(default=date(2000, 1, 1))
    end_date: date = Field(default=date(2100, 12, 31))
    timezone: str = "UTC"
    week_start_day: str = Field(default="monday", pattern="^(monday|sunday)$")
    fiscal_year_start_month: int = Field(default=1, ge=1, le=12)
    auto_join_temporal_columns: bool = True
    excluded_auto_joins: List[CalendarAutoJoinExclusion] = Field(default_factory=list)


class DatasetSettings(BaseModel):
    calendar_dimension: CalendarDimensionSettings = Field(default_factory=CalendarDimensionSettings)


class DatasetDictionaryColumnQuality(BaseModel):
    required: Optional[bool] = None
    unique: Optional[bool] = None
    accepted_values: List[str] = Field(default_factory=list)
    min_value: Optional[Union[str, float, int]] = None
    max_value: Optional[Union[str, float, int]] = None
    pattern: Optional[str] = Field(default=None, max_length=500)
    format_hint: Optional[Literal["email", "phone", "url", "date", "datetime", "currency", "percent", "custom"]] = None
    null_threshold_percent: Optional[float] = Field(default=None, ge=0, le=100)
    distinct_threshold: Optional[float] = Field(default=None, ge=0)
    severity: Optional[Literal["info", "warning", "error"]] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


class DatasetDictionaryColumnNote(BaseModel):
    column_name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    business_name: Optional[str] = Field(default=None, max_length=255)
    examples: List[str] = Field(default_factory=list)
    quality: Optional[DatasetDictionaryColumnQuality] = None


class DatasetDictionaryTableNote(BaseModel):
    table_id: int
    business_role: Optional[str] = Field(default=None, max_length=2000)
    grain: Optional[str] = Field(default=None, max_length=2000)
    join_hint: Optional[str] = Field(default=None, max_length=2000)
    owner_note: Optional[str] = Field(default=None, max_length=2000)
    freshness_expectation: Optional[str] = Field(default=None, max_length=2000)
    row_count_expectation: Optional[str] = Field(default=None, max_length=1000)
    important_columns: List[str] = Field(default_factory=list)
    column_notes: List[DatasetDictionaryColumnNote] = Field(default_factory=list)


class DatasetDictionary(BaseModel):
    overview: Optional[str] = Field(default=None, max_length=2000)
    business_purpose: Optional[str] = Field(default=None, max_length=2000)
    usage_guidelines: Optional[str] = Field(default=None, max_length=2000)
    ai_context: Optional[str] = Field(default=None, max_length=4000)
    default_filters: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    table_notes: List[DatasetDictionaryTableNote] = Field(default_factory=list)


class DatasetDictionaryStats(BaseModel):
    warnings: int = 0
    default_filters: int = 0
    table_notes: int = 0
    covered_tables: int = 0
    total_tables: int = 0


class DatasetDictionaryResponse(BaseModel):
    dictionary: DatasetDictionary = Field(default_factory=DatasetDictionary)
    dictionary_updated_at: Optional[datetime] = None
    stats: DatasetDictionaryStats = Field(default_factory=DatasetDictionaryStats)
    compiled_context: str = ""


class DatasetBase(BaseModel):
    """Base dataset schema"""
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    settings: Optional[DatasetSettings] = None
    dictionary: Optional[DatasetDictionary] = None


class DatasetCreate(DatasetBase):
    """Schema for creating a new dataset"""
    pass


class DatasetUpdate(BaseModel):
    """Schema for updating a dataset"""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    settings: Optional[DatasetSettings] = None


class DatasetResponse(DatasetBase):
    """Schema for dataset response"""
    id: int
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    datasource_ids: List[int] = Field(default_factory=list)
    dictionary_updated_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ===== Dataset Table Schemas =====

class DatasetTableBase(BaseModel):
    """Base table schema"""
    display_name: str = Field(..., description="User-friendly name, e.g., 'Orders'")
    enabled: bool = Field(default=True)
    transformations: Optional[List[Dict[str, Any]]] = Field(default=None, description="List of transformation steps")


class TableCreate(DatasetTableBase):
    """Schema for adding a table to dataset"""
    datasource_id: Optional[int] = None
    source_kind: str = Field(default="physical_table", description="'physical_table', 'sql_query', or 'derived_table'")
    source_table_name: Optional[str] = Field(None, description="Full table name for physical_table")
    source_query: Optional[str] = Field(None, description="SQL query for sql_query or derived_table")
    
    @model_validator(mode='after')
    def validate_source(self):
        """Validate that source fields match source_kind"""
        if self.source_kind == "physical_table":
            if self.datasource_id is None:
                raise ValueError("datasource_id is required when source_kind is 'physical_table'")
            if not self.source_table_name:
                raise ValueError("source_table_name is required when source_kind is 'physical_table'")
        elif self.source_kind == "sql_query":
            if self.datasource_id is None:
                raise ValueError("datasource_id is required when source_kind is 'sql_query'")
            if not self.source_query:
                raise ValueError("source_query is required when source_kind is 'sql_query'")
        elif self.source_kind == "derived_table":
            if self.datasource_id is not None:
                raise ValueError("datasource_id must be omitted when source_kind is 'derived_table'")
            if not self.source_query:
                raise ValueError("source_query is required when source_kind is 'derived_table'")
        else:
            raise ValueError(
                f"Invalid source_kind: {self.source_kind}. Must be 'physical_table', 'sql_query', or 'derived_table'"
            )
        return self


class TableUpdate(BaseModel):
    """Schema for updating a table"""
    display_name: Optional[str] = None
    source_query: Optional[str] = None
    enabled: Optional[bool] = None
    transformations: Optional[List[Dict[str, Any]]] = None
    type_overrides: Optional[Dict[str, Any]] = Field(default=None, description="User-defined column type overrides. Each value is either a type string ('float', 'date', ...) or an object {type, format} where format is a user-facing pattern (e.g. 'DD/MM/YYYY') used to parse date/datetime strings.")
    column_formats: Optional[Dict[str, Any]] = Field(default=None, description="Full display format config per column")


class TableResponse(DatasetTableBase):
    """Schema for table response"""
    id: int
    dataset_id: int
    datasource_id: Optional[int] = None
    source_kind: str
    source_table_name: Optional[str] = None
    source_query: Optional[str] = None
    query_mode: str = "synced"
    estimated_row_count: Optional[int] = None
    estimated_size_bytes: Optional[int] = None
    transformations: Optional[List[Dict[str, Any]]] = None
    columns_cache: Optional[Union[List[Any], Dict[str, Any]]] = None
    sample_cache: Optional[List[Dict[str, Any]]] = None
    type_overrides: Optional[Dict[str, Any]] = None
    column_formats: Optional[Dict[str, Any]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ===== Dataset with Tables =====

class DatasetWithTables(DatasetResponse):
    """Dataset response including its tables"""
    tables: List[TableResponse] = []


# ===== Table Preview Schemas =====

class ColumnMetadata(BaseModel):
    """Column metadata for preview"""
    name: str
    type: str  # 'string', 'number', 'date', 'boolean', etc. — value-sampled SEMANTIC type
    nullable: bool = True
    # PHYSICAL warehouse storage type as reported by the source schema
    # (e.g. BigQuery "string"/"integer"/"timestamp", Postgres "text"/"int4").
    # Recorded so a numeric aggregate over a physically-STRING column
    # (Airbyte / Google-Sheets / CSV store numbers as text) can be SAFE_CAST
    # even when `type` was value-sampled to a numeric label. None on legacy
    # caches / sources where the physical schema could not be resolved.
    source_type: Optional[str] = None


class FilterCondition(BaseModel):
    """Filter condition"""
    field: str
    operator: str = Field(
        ...,
        pattern="^(=|!=|>|<|>=|<=|LIKE|IN|eq|neq|gt|gte|lt|lte|like|in|not_in|between|contains|not_contains|starts_with|is_null|is_not_null)$",
    )
    value: Any = None


class TablePreviewRequest(BaseModel):
    """Request schema for table preview"""
    limit: int = Field(default=100, ge=1, le=1000)
    offset: int = Field(default=0, ge=0)
    filters: Optional[List[FilterCondition]] = None
    sort: Optional[Dict[str, str]] = None  # {'column': 'asc'|'desc'}


class TablePreviewResponse(BaseModel):
    """Response schema for table preview"""
    columns: List[ColumnMetadata]
    rows: List[Dict[str, Any]]
    total: int  # Total rows in table (without limit)
    has_more: bool  # Whether there are more rows


# ===== Datasource Table List =====

class DatasourceTable(BaseModel):
    """Schema for tables from datasource"""
    name: str  # Full table name (e.g., 'public.orders')
    schema: Optional[str] = None  # Schema name (e.g., 'public')
    table_type: str = Field(default="table")  # 'table' or 'view'


# ===== Execute Query Schemas =====

class AggregationSpec(BaseModel):
    """Aggregation specification.

    ``function`` accepts the 6 built-in aggregates plus ``auto`` — which means
    "use the aggregation stored on the semantic measure". The Explore editor
    sends ``auto`` for any metric pulled from a measure (because the
    aggregation is part of the measure definition, not a per-chart choice).
    """
    field: str
    function: str = Field(..., pattern="^(sum|avg|count|min|max|count_distinct|auto)$")


class OrderBySpec(BaseModel):
    """Order by specification"""
    field: str
    direction: str = Field(default="DESC", pattern="^(ASC|DESC)$")


class ExecuteQueryRequest(BaseModel):
    """Request schema for executing query with aggregations"""
    dimensions: Optional[List[str]] = None
    measures: Optional[List[AggregationSpec]] = None
    filters: Optional[List[FilterCondition]] = None
    order_by: Optional[List[OrderBySpec]] = None
    time_grains: Optional[Dict[str, Literal["day", "week", "month", "quarter", "year"]]] = None
    # Phase-15.83 — chart-render path (FE Explore + dashboard tile) sends
    # NO_LIMIT_SENTINEL (10M) after the row-cap removal. Upper bound bumped
    # from 10000 to match so requests aren't 422-rejected. Default stays
    # at 1000 for legacy callers (table preview, MCP).
    limit: int = Field(default=1000, ge=1, le=10_000_000)


class ExecuteQueryResponse(BaseModel):
    """Response schema for executed query"""
    columns: List[ColumnMetadata]
    rows: List[Dict[str, Any]]


# ===== Dataset Quality Schemas =====

QualityDimension = Literal[
    "completeness", "validity", "uniqueness", "consistency", "timeliness", "accuracy"
]
QualitySeverity = Literal["info", "warning", "error"]


class QualityRuleConfig(BaseModel):
    """
    Flexible config bag — validated loosely here; the service layer does
    rule_type-specific validation before execution.

    Common fields by rule_type:
      not_null            → {}
      not_blank           → {}
      completeness_pct    → { threshold: float (0-100) }
      accepted_values     → { values: list[str] }
      pattern_match       → { pattern: str, flags?: str }
      range_check         → { min?: float|str, max?: float|str }
      format_check        → { format: "email"|"url"|"date"|"datetime"|"phone" }
      unique_column       → {}
      unique_combo        → { columns: list[str] }
    cross_column_check  → { expression: str }   (SQL boolean expr)
    cross_table         → { secondary_table_id: int, join_condition: str, expression: str }
      freshness_days      → { max_days: int, column: str }
      row_count_range     → { min?: int, max?: int }
      statistical_range   → { min_z?: float, max_z?: float }
    """
    model_config = {"extra": "allow"}

    threshold: Optional[float] = Field(default=None, ge=0, le=100)
    values: Optional[List[str]] = Field(default=None)
    pattern: Optional[str] = Field(default=None, max_length=500)
    flags: Optional[str] = Field(default=None, max_length=10)
    min: Optional[Union[str, float, int]] = Field(default=None)
    max: Optional[Union[str, float, int]] = Field(default=None)
    format: Optional[str] = Field(default=None, max_length=50)
    columns: Optional[List[str]] = Field(default=None)
    expression: Optional[str] = Field(default=None, max_length=1000)
    secondary_table_id: Optional[int] = Field(default=None, ge=1)
    join_condition: Optional[str] = Field(default=None, max_length=1000)
    column: Optional[str] = Field(default=None, max_length=255)
    max_days: Optional[int] = Field(default=None, ge=0)
    min_z: Optional[float] = Field(default=None)
    max_z: Optional[float] = Field(default=None)
    sql: Optional[str] = Field(default=None, max_length=5000)


class QualityRuleCreate(BaseModel):
    table_id: int
    column_name: Optional[str] = Field(default=None, max_length=255)
    dimension: QualityDimension
    rule_type: str = Field(..., min_length=1, max_length=80)
    name: str = Field(..., min_length=1, max_length=255)
    config: Optional[QualityRuleConfig] = Field(default_factory=QualityRuleConfig)
    severity: QualitySeverity = "warning"
    enabled: bool = True


class QualityRuleBulkCreate(BaseModel):
    rules: List[QualityRuleCreate] = Field(..., min_length=1, max_length=200)


class QualityRuleUpdate(BaseModel):
    column_name: Optional[str] = Field(default=None, max_length=255)
    dimension: Optional[QualityDimension] = None
    rule_type: Optional[str] = Field(default=None, max_length=80)
    name: Optional[str] = Field(default=None, max_length=255)
    config: Optional[QualityRuleConfig] = None
    severity: Optional[QualitySeverity] = None
    enabled: Optional[bool] = None


class QualityRuleResponse(BaseModel):
    id: int
    dataset_id: int
    table_id: int
    column_name: Optional[str] = None
    dimension: str
    rule_type: str
    name: str
    config: Optional[Dict[str, Any]] = None
    severity: str
    enabled: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class QualityRuleResult(BaseModel):
    """Result for a single rule within a run."""
    rule_id: int
    passed: bool
    rows_checked: Optional[int] = None
    rows_failed: Optional[int] = None
    detail: Optional[str] = None
    sql: Optional[str] = None
    preview_sql: Optional[str] = None
    preview_note: Optional[str] = None
    preview_columns: List[str] = Field(default_factory=list)
    preview_rows: List[Dict[str, Any]] = Field(default_factory=list)
    log: List[str] = Field(default_factory=list)
    elapsed_ms: Optional[int] = None
    skipped: Optional[bool] = None
    error: Optional[bool] = None


class QualityRuleDuplicateRequest(BaseModel):
    """Request body for duplicating a quality rule."""
    target_table_id: Optional[int] = Field(default=None, description="Target table ID; omit to keep same table")
    name_suffix: str = Field(default=" (copy)", max_length=80)


class QualityRunTriggerResponse(BaseModel):
    run_id: int
    status: str


class QualityRunResponse(BaseModel):
    id: int
    dataset_id: int
    status: str
    score: Optional[float] = None
    results: Optional[Dict[str, Any]] = None
    progress_done: Optional[int] = None
    progress_total: Optional[int] = None
    error_message: Optional[str] = None
    triggered_by_id: Optional[str] = None
    trigger_source: Optional[str] = None
    schedule_id: Optional[int] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class QualityDimensionSummary(BaseModel):
    dimension: str
    total: int
    enabled: int
    passed: Optional[int] = None
    failed: Optional[int] = None


class QualitySummaryResponse(BaseModel):
    """Aggregated summary for the Quality tab header."""
    total_rules: int
    enabled_rules: int
    covered_tables: int
    covered_columns: int
    last_run: Optional[QualityRunResponse] = None
    score: Optional[float] = None          # from last completed run
    dimension_breakdown: List[QualityDimensionSummary] = Field(default_factory=list)


# ── AI Rule Suggestion ────────────────────────────────────────────────────

class QualityRulePreviewRequest(BaseModel):
    table_id: int
    rule_type: str = Field(..., min_length=1, max_length=80)
    column_name: Optional[str] = Field(default=None, max_length=255)
    config: Optional[QualityRuleConfig] = Field(default_factory=QualityRuleConfig)


class QualityRulePreviewResponse(BaseModel):
    sql: Optional[str] = None
    pass_description: str = ""
    fail_description: str = ""
    scope_description: str = ""
    error: Optional[str] = None


class QualityRuleTestRequest(BaseModel):
    table_id: int
    rule_type: str = Field(..., min_length=1, max_length=80)
    column_name: Optional[str] = Field(default=None, max_length=255)
    config: Optional[QualityRuleConfig] = Field(default_factory=QualityRuleConfig)


class QualityRuleTestResponse(BaseModel):
    passed: bool
    rows_checked: Optional[int] = None
    rows_failed: Optional[int] = None
    detail: Optional[str] = None
    sql: Optional[str] = None
    preview_sql: Optional[str] = None
    preview_note: Optional[str] = None
    preview_columns: List[str] = Field(default_factory=list)
    preview_rows: List[Dict[str, Any]] = Field(default_factory=list)
    log: List[str] = Field(default_factory=list)
    elapsed_ms: Optional[int] = None
    skipped: Optional[bool] = None
    error: Optional[bool] = None


class QualityAISuggestColumnInfo(BaseModel):
    name: str
    type: str = ""

class QualityAISuggestRequest(BaseModel):
    description: str = Field(..., min_length=3, max_length=2000)
    table_name: str = Field(..., min_length=1, max_length=255)
    columns: List[QualityAISuggestColumnInfo] = Field(default_factory=list, max_length=500)

class QualityAISuggestResponse(BaseModel):
    rule_type: str
    dimension: str
    column_name: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    severity: str = "warning"
    name: str = ""
    explanation: str = ""


# ── Quality Schedule / Automation ────────────────────────────────────────

QualityScheduleType = Literal["manual", "schedule"]

_EMAIL_REGEX = r"^[^\s@]+@[^\s@]+\.[^\s@]+$"


class QualityScheduleUpsert(BaseModel):
    """Payload to create/update the automation config for a dataset."""
    enabled: bool = False
    type: QualityScheduleType = "manual"
    cron: Optional[str] = Field(default=None, max_length=120)
    timezone: str = Field(default="UTC", max_length=80)
    recipient_email: Optional[str] = Field(
        default=None,
        max_length=320,
        pattern=_EMAIL_REGEX,
    )
    cc_emails: List[str] = Field(default_factory=list, max_length=20)
    notify_on_success: bool = True
    notify_on_failure: bool = True

    @model_validator(mode="after")
    def _validate(self) -> "QualityScheduleUpsert":
        # Normalize email list
        cleaned: List[str] = []
        import re as _re
        for email in self.cc_emails or []:
            if not isinstance(email, str):
                continue
            e = email.strip().lower()
            if not e:
                continue
            if not _re.match(_EMAIL_REGEX, e):
                raise ValueError(f"Invalid CC email: {email!r}")
            cleaned.append(e)
        # Deduplicate while preserving order
        seen: set[str] = set()
        deduped: List[str] = []
        for e in cleaned:
            if e not in seen:
                seen.add(e)
                deduped.append(e)
        self.cc_emails = deduped

        if self.recipient_email:
            self.recipient_email = self.recipient_email.strip().lower()

        # Business rules when scheduled automation is on:
        if self.enabled and self.type == "schedule":
            if not self.cron or not self.cron.strip():
                raise ValueError("cron expression is required when schedule automation is enabled")
            # Lazy-import to keep schema module light.
            try:
                from apscheduler.triggers.cron import CronTrigger  # type: ignore
                CronTrigger.from_crontab(self.cron.strip())
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"Invalid cron expression: {exc}") from exc

            try:
                from zoneinfo import ZoneInfo
                ZoneInfo(self.timezone)
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"Invalid timezone: {self.timezone}") from exc

            if not self.recipient_email:
                raise ValueError("recipient_email is required when schedule automation is enabled")

        return self


class QualityScheduleResponse(BaseModel):
    id: Optional[int] = None
    dataset_id: int
    enabled: bool = False
    type: QualityScheduleType = "manual"
    cron: Optional[str] = None
    timezone: str = "UTC"
    recipient_email: Optional[str] = None
    cc_emails: List[str] = Field(default_factory=list)
    notify_on_success: bool = True
    notify_on_failure: bool = True
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[str] = None
    last_error: Optional[str] = None
    next_run_at: Optional[datetime] = None
    created_by_id: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}
