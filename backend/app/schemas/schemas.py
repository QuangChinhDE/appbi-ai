"""
Pydantic schemas for request/response validation.
"""
from pydantic import BaseModel, Field, ConfigDict, model_validator, field_serializer, field_validator
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum
from uuid import UUID

from app.schemas.datasource_config import validate_datasource_config
from app.schemas.chart_config import DashboardChartLayout, DashboardChartItem, DashboardLayoutUpdate


# Enums
class DataSourceTypeSchema(str, Enum):
    """Data source types."""
    POSTGRESQL = "postgresql"
    MYSQL = "mysql"
    BIGQUERY = "bigquery"
    GOOGLE_SHEETS = "google_sheets"
    GOOGLE_DOCS = "google_docs"
    MANUAL = "manual"


class ChartTypeSchema(str, Enum):
    """Chart types."""
    BAR = "BAR"
    HORIZONTAL_BAR = "HORIZONTAL_BAR"
    LINE = "LINE"
    PIE = "PIE"
    DONUT = "DONUT"
    RADAR = "RADAR"
    POLAR_AREA = "POLAR_AREA"
    TIME_SERIES = "TIME_SERIES"
    TABLE = "TABLE"
    MATRIX = "MATRIX"
    AREA = "AREA"
    STACKED_BAR = "STACKED_BAR"
    GROUPED_BAR = "GROUPED_BAR"
    BAR_LINE = "BAR_LINE"
    SCATTER = "SCATTER"
    BUBBLE = "BUBBLE"
    HEATMAP = "HEATMAP"
    TREEMAP = "TREEMAP"
    FUNNEL = "FUNNEL"
    GAUGE = "GAUGE"
    WATERFALL = "WATERFALL"
    MAP_POINT = "MAP_POINT"
    MAP_REGION = "MAP_REGION"
    BOXPLOT = "BOXPLOT"
    BULLET = "BULLET"
    SANKEY = "SANKEY"
    SUNBURST = "SUNBURST"
    RIBBON = "RIBBON"
    TIMELINE = "TIMELINE"
    WORD_CLOUD = "WORD_CLOUD"
    KPI = "KPI"
    PODIUM = "PODIUM"
    NINE_BOX = "NINE_BOX"


# Data Source Schemas
class DataSourceBase(BaseModel):
    """Base schema for data source."""
    name: str = Field(..., min_length=1, max_length=255)
    type: DataSourceTypeSchema
    description: Optional[str] = None
    config: Dict[str, Any] = Field(..., description="Connection configuration")


class DataSourceCreate(DataSourceBase):
    """Schema for creating a data source."""
    
    @model_validator(mode='after')
    def validate_config(self):
        """Validate config matches the data source type."""
        self.config = validate_datasource_config(self.type.value, self.config)
        return self


class DataSourceUpdate(BaseModel):
    """Schema for updating a data source."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    type: Optional[DataSourceTypeSchema] = None
    
    @model_validator(mode='after')
    def validate_config(self):
        """Validate config if both type and config are provided."""
        if self.config is not None and self.type is not None:
            self.config = validate_datasource_config(self.type.value, self.config)
        return self


class DataSourceResponse(DataSourceBase):
    """Schema for data source response."""
    id: int
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

    @field_serializer('config')
    def mask_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Mask sensitive credential fields before returning in API response.

        The Google connection's non-secret facts (which account, which Google
        APIs it may call) are surfaced under `google` so the form can show
        "connected as X" / "needs reconnect" per SOURCE without ever shipping
        the token itself.
        """
        from app.core.crypto import mask_config_for_response, decrypt_config
        masked = mask_config_for_response(config)
        try:
            if str((config or {}).get("auth_mode") or "").lower() == "google_oauth":
                from app.services.google_data_access_service import source_google_capabilities
                plain = decrypt_config(config or {})
                has_own = bool(plain.get("google_oauth_credentials"))
                caps = source_google_capabilities(plain)
                masked["google"] = {
                    "connected": has_own or bool(plain.get("google_oauth_user_id")),
                    "email": plain.get("google_oauth_email"),
                    "per_source": has_own,
                    "capabilities": caps if has_own else None,
                }
        except Exception:  # noqa: BLE001 — status is cosmetic, never break the read
            pass
        return masked


class DataSourceTestRequest(BaseModel):
    """Schema for testing a data source connection."""
    type: DataSourceTypeSchema
    config: Dict[str, Any]
    # When editing an existing datasource, frontend can pass ID so backend
    # can fill in any sensitive fields the user left blank (masked as '').
    data_source_id: int | None = None


class DataSourceTestResponse(BaseModel):
    """Schema for data source test result."""
    success: bool
    message: str


# Chart Schemas
class ChartBase(BaseModel):
    """Base schema for chart."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    dataset_table_id: Optional[int] = Field(None, description="Dataset table source")
    chart_type: ChartTypeSchema
    config: Dict[str, Any] = Field(..., description="Chart configuration")


class ChartCreate(ChartBase):
    """Schema for creating a chart."""

    @model_validator(mode='after')
    def validate_source(self):
        """dataset_table_id must be set."""
        if self.dataset_table_id is None:
            raise ValueError("dataset_table_id must be provided")
        return self

    @model_validator(mode='after')
    def validate_config_shape(self):
        """Phase-9 + Phase-12: prevent obviously broken chart configs.

        Two layers of protection:

        1. Container shape — config must carry at least one of
           ``roleConfig`` / ``generatedRoleConfig`` / ``customRoleConfig``
           / ``customSql`` / ``semanticBinding``. Phase-9 introduced this
           after empty ``{}`` configs were silently saved by a broken UI
           flow and surfaced as "no data" charts only at render time.

        2. Per-metric aggregation — every ``roleConfig.metrics[].agg``
           (and the singleton ``lineMetric`` / ``benchmarkMetric`` /
           ``tablePivotMetric``) must use one of the supported aggregation
           names, OR ``"auto"`` for measures whose aggregation is part of
           the semantic definition (Phase-3). The Explore renderer crashes
           on unknown ``agg`` strings (``m.agg.toUpperCase()`` etc.), so
           we reject them here instead of letting MCP-authored configs
           slip past validation and brick the chart at view time.
        """
        if not isinstance(self.config, dict):
            raise ValueError("config must be an object")
        recognised_keys = {
            "roleConfig", "generatedRoleConfig", "customRoleConfig",
            "customSql", "semanticBinding",
        }
        if not (set(self.config.keys()) & recognised_keys):
            raise ValueError(
                "config phải có ít nhất một trong: roleConfig, generatedRoleConfig, "
                "customRoleConfig, customSql, semanticBinding"
            )

        allowed_aggs = {
            "sum", "avg", "count", "min", "max", "count_distinct", "auto",
        }

        def _check_metric(metric, where: str) -> None:
            # Phase-15.41: previously `if not isinstance(metric, dict): return`
            # silently let a bare string slip through, so a list of strings
            # like ["deals.revenue"] passed validation but rendered empty
            # at chart time (the FE expects {field, agg} objects). Reject
            # the shape now so callers know to wrap each ref in a dict.
            if not isinstance(metric, dict):
                raise ValueError(
                    f"config.{where} must be an object with `field` + `agg`, "
                    f"got {type(metric).__name__}={metric!r}. Wrap bare "
                    "string refs like {'field': 'view.col', 'agg': 'sum'}."
                )
            raw_field = metric.get("field")
            if raw_field is None or not str(raw_field).strip():
                raise ValueError(
                    f"config.{where}.field is required — must be a non-empty "
                    "string (qualified `view.field` for semantic measures, "
                    "or a bare column for live-table charts)."
                )
            raw_agg = metric.get("agg")
            if raw_agg is None:
                # Missing agg → FE renders `undefined.toUpperCase()` and
                # crashes. Reject so callers fix the payload upstream.
                raise ValueError(
                    f"config.{where}.agg is missing — must be one of "
                    f"{sorted(allowed_aggs)}."
                )
            agg = str(raw_agg).strip().lower()
            if agg not in allowed_aggs:
                raise ValueError(
                    f"config.{where}.agg={raw_agg!r} is not supported — "
                    f"use one of {sorted(allowed_aggs)}."
                )

        for container_key in ("roleConfig", "generatedRoleConfig", "customRoleConfig"):
            container = self.config.get(container_key)
            if not isinstance(container, dict):
                continue
            # Phase-15.41: reject metrics-as-non-list and metrics-as-list-of-strings.
            raw_metrics = container.get("metrics")
            if raw_metrics is not None:
                if not isinstance(raw_metrics, list):
                    raise ValueError(
                        f"config.{container_key}.metrics must be a list of "
                        f"{{field, agg}} objects, got {type(raw_metrics).__name__}."
                    )
                for index, metric in enumerate(raw_metrics):
                    _check_metric(metric, f"{container_key}.metrics[{index}]")
            for solo_key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
                metric = container.get(solo_key)
                if metric is not None:
                    _check_metric(metric, f"{container_key}.{solo_key}")

        # Phase-15.39: enforce per-chart-type required role_config keys.
        # ChartCreate previously accepted (e.g.) a BAR chart with no
        # `dimension` — Pydantic shrugged, save succeeded, render-time
        # crashed. The CHART_REQUIRED_ROLE_KEYS canonical map fixes that
        # by checking the role-config container (the first one that's
        # actually populated) against the chart_type's contract.
        from app.schemas.chart_config import check_chart_required_role_keys, check_role_config_shape

        # Pick the populated container — generatedRoleConfig and
        # roleConfig are usually mirrors; customRoleConfig is the
        # advanced opt-out. Validate against the first non-empty one.
        role_to_check: Optional[Dict[str, Any]] = None
        for container_key in ("generatedRoleConfig", "roleConfig", "customRoleConfig"):
            container = self.config.get(container_key)
            if isinstance(container, dict) and container:
                role_to_check = container
                break
        # Skip when caller chose customSql or semanticBinding instead of
        # the role-config path — those are explicit raw-SQL paths and
        # don't have role-config requirements.
        if role_to_check is not None and not self.config.get("customSql"):
            # Phase-15.82 — structural shape check fires BEFORE required-key
            # check so a malformed `metrics: "foo"` doesn't masquerade as
            # missing role keys (more helpful error).
            shape_errors = check_role_config_shape(role_to_check)
            if shape_errors:
                raise ValueError(
                    f"role_config shape errors: {'; '.join(shape_errors)}"
                )
            missing = check_chart_required_role_keys(
                str(self.chart_type), role_to_check
            )
            if missing:
                raise ValueError(
                    f"chart_type={self.chart_type!r} is missing required "
                    f"role_config: {'; '.join(missing)}"
                )
        return self


class ChartUpdate(BaseModel):
    """Schema for updating a chart."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    chart_type: Optional[ChartTypeSchema] = None
    config: Optional[Dict[str, Any]] = None
    dataset_table_id: Optional[int] = None

    @model_validator(mode='after')
    def validate_config_shape(self):
        """Mirror ChartCreate's metric.agg guard on updates so an MCP-
        authored PATCH cannot put the chart into the same un-renderable
        state Phase-12 audit caught for fresh creates."""
        if self.config is None:
            return self
        if not isinstance(self.config, dict):
            raise ValueError("config must be an object")
        allowed_aggs = {
            "sum", "avg", "count", "min", "max", "count_distinct", "auto",
        }

        def _check_metric(metric, where: str) -> None:
            # Phase-15.41: same hardening as ChartCreate — reject non-dict
            # metric entries (bare strings) and missing field.
            if not isinstance(metric, dict):
                raise ValueError(
                    f"config.{where} must be an object with `field` + `agg`, "
                    f"got {type(metric).__name__}={metric!r}. Wrap bare "
                    "string refs like {'field': 'view.col', 'agg': 'sum'}."
                )
            raw_field = metric.get("field")
            if raw_field is None or not str(raw_field).strip():
                raise ValueError(
                    f"config.{where}.field is required — non-empty string."
                )
            raw_agg = metric.get("agg")
            if raw_agg is None:
                raise ValueError(
                    f"config.{where}.agg is missing — must be one of "
                    f"{sorted(allowed_aggs)}."
                )
            agg = str(raw_agg).strip().lower()
            if agg not in allowed_aggs:
                raise ValueError(
                    f"config.{where}.agg={raw_agg!r} is not supported — "
                    f"use one of {sorted(allowed_aggs)}."
                )

        for container_key in ("roleConfig", "generatedRoleConfig", "customRoleConfig"):
            container = self.config.get(container_key)
            if not isinstance(container, dict):
                continue
            raw_metrics = container.get("metrics")
            if raw_metrics is not None:
                if not isinstance(raw_metrics, list):
                    raise ValueError(
                        f"config.{container_key}.metrics must be a list of "
                        f"{{field, agg}} objects, got {type(raw_metrics).__name__}."
                    )
                for index, metric in enumerate(raw_metrics):
                    _check_metric(metric, f"{container_key}.metrics[{index}]")
            for solo_key in ("lineMetric", "benchmarkMetric", "tablePivotMetric"):
                metric = container.get(solo_key)
                if metric is not None:
                    _check_metric(metric, f"{container_key}.{solo_key}")

        # Phase-15.39: enforce per-chart-type required role_config keys on
        # updates too. Only when the caller actually passed a chart_type;
        # a config-only PATCH can't be checked without knowing the type
        # (route handler should disallow that anyway).
        if self.chart_type is not None:
            from app.schemas.chart_config import check_chart_required_role_keys, check_role_config_shape

            role_to_check: Optional[Dict[str, Any]] = None
            for container_key in ("generatedRoleConfig", "roleConfig", "customRoleConfig"):
                container = self.config.get(container_key)
                if isinstance(container, dict) and container:
                    role_to_check = container
                    break
            if role_to_check is not None and not self.config.get("customSql"):
                shape_errors = check_role_config_shape(role_to_check)
                if shape_errors:
                    raise ValueError(
                        f"role_config shape errors: {'; '.join(shape_errors)}"
                    )
                missing = check_chart_required_role_keys(
                    str(self.chart_type), role_to_check
                )
                if missing:
                    raise ValueError(
                        f"chart_type={self.chart_type!r} is missing required "
                        f"role_config: {'; '.join(missing)}"
                    )
        return self


# ─── Chart Metadata Schemas ────────────────────────────────────────────────────

class ChartMetadataUpsert(BaseModel):
    """Schema for creating or replacing chart semantic metadata."""
    domain: Optional[str] = Field(None, max_length=100, description="Business domain: sales / marketing / finance")
    intent: Optional[str] = Field(None, max_length=100, description="Analysis intent: trend / comparison / ranking / summary")
    metrics: Optional[List[str]] = Field(default_factory=list, description="Business metric names (semantic labels)")
    dimensions: Optional[List[str]] = Field(default_factory=list, description="Business dimension names (semantic labels)")
    tags: Optional[List[str]] = Field(default_factory=list, description="Free-form tags for search")


class ChartMetadataResponse(ChartMetadataUpsert):
    """Schema for chart metadata response."""
    id: int
    chart_id: int
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ─── Chart Parameter Schemas ────────────────────────────────────────────────────

class ChartParameterCreate(BaseModel):
    """Schema for creating a chart parameter definition."""
    parameter_name: str = Field(..., min_length=1, max_length=100, description="e.g. date_range, region")
    parameter_type: str = Field(..., min_length=1, max_length=50, description="time_range / dimension / measure")
    column_mapping: Optional[Dict[str, Any]] = Field(
        None, description='e.g. {"column": "order_date", "type": "date"}'
    )
    default_value: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None


class ChartParameterUpdate(BaseModel):
    """Schema for updating a chart parameter definition."""
    parameter_type: Optional[str] = Field(None, max_length=50)
    column_mapping: Optional[Dict[str, Any]] = None
    default_value: Optional[str] = Field(None, max_length=255)
    description: Optional[str] = None


class ChartParameterResponse(ChartParameterCreate):
    """Schema for chart parameter response."""
    id: int
    chart_id: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ─── Chart Response (extended) ──────────────────────────────────────────────────

class ChartResponse(ChartBase):
    """Schema for chart response."""
    id: int
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    dataset_id: Optional[int] = None
    dataset_name: Optional[str] = None
    dataset_table_name: Optional[str] = None
    datasource_id: Optional[int] = None
    is_owned_by_current_user: Optional[bool] = None
    is_shared: Optional[bool] = None
    created_at: datetime
    updated_at: datetime
    # validation_alias reads from ORM attr 'chart_meta'; serialized as 'metadata' in JSON
    metadata: Optional[ChartMetadataResponse] = Field(default=None, validation_alias="chart_meta")
    parameters: List[ChartParameterResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class DroppedFilterInfo(BaseModel):
    """Phase-15.78: one entry per runtime filter the BE silently dropped.

    Tester report (Section VIII): when a chart can't apply a filter — e.g.
    the field isn't in the chart's semantic binding, the dataset doesn't
    match, or the operator is unknown — the WHERE clause is built without
    it and the user has no idea the filter was ignored. We now record
    every drop with a machine-readable `reason` so the FE can banner it
    and DA can investigate without grepping logs.
    """
    field: Optional[str] = None
    semantic_field: Optional[str] = None
    operator: Optional[str] = None
    reason: str  # 'dataset_mismatch' | 'binding_unsupported' | 'unreachable_view' | 'no_join_path' | 'unknown_operator' | 'empty_value' | 'no_field'
    detail: Optional[str] = None  # human-readable, may include view names etc.


class ChartDebugInfo(BaseModel):
    """Phase-15.9: debug payload for the Explore "Query" tab.

    Optional metadata that helps DA understand HOW a chart's data was
    produced — which SQL ran, against which dialect, via which BE
    routing path (semantic engine vs legacy live_query), and what the
    engine warned about. Not consumed by the chart renderer; purely for
    the inspector tab. Omitted entirely on cache hits or when the BE
    can't safely surface the SQL (e.g. raw DataSourceConnectionService
    error paths). Callers MUST treat every field as optional.

    Phase-15.78 adds `dropped_filters` so the UI can warn when a filter
    the user applied didn't make it into the WHERE clause (see
    `DroppedFilterInfo`). Empty list = nothing dropped.
    """
    sql_emitted: Optional[str] = None
    dialect: Optional[str] = None  # 'postgresql' | 'bigquery' | 'mysql' | 'duckdb'
    routing: Optional[str] = None  # 'semantic_engine' | 'live_query'
    execution_time_ms: Optional[float] = None
    row_count: Optional[int] = None
    warnings: List[str] = Field(default_factory=list)
    dropped_filters: List[DroppedFilterInfo] = Field(default_factory=list)
    # Dashboard perf #5 — snapshot materialization freshness. `data_source_mode`
    # ∈ {live, snapshot, mixed}; `snapshot_as_of` is the oldest snapshot build
    # time used (ISO string) for the builder "Số tính đến HH:MM" label.
    data_source_mode: Optional[str] = None
    snapshot_as_of: Optional[str] = None
    # Public per-link TTL (Stage 2): served snapshot is older than the link TTL
    # and a background rebuild was kicked off — FE shows a "refreshing…" hint.
    snapshot_stale: Optional[bool] = None


class ChartDataResponse(BaseModel):
    """Schema for chart data response."""
    chart: ChartResponse
    data: List[Dict[str, Any]]
    pre_aggregated: bool = False
    # Phase-15.9: surface query + routing info so the Explore "Query" tab
    # can show DA what BE actually ran. Always optional — old clients
    # ignore the field, new clients display it. Never contains the raw
    # rows (those live in `data`); only metadata + the rendered SQL.
    debug: Optional[ChartDebugInfo] = None


# Dashboard Schemas
# Note: DashboardChartLayout and DashboardChartItem are imported from chart_config


class DashboardBase(BaseModel):
    """Base schema for dashboard."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    # Filter-pane entries (Dashboard.filters_config). See
    # `app.schemas.filter_entry.FilterEntry` for the canonical shape.
    filters_config: Optional[List[Dict[str, Any]]] = None
    # Slicer-visual entries (Dashboard.slicers_config). See
    # `app.schemas.filter_entry.SlicerEntry` for the canonical shape.
    # Slicers render as canvas blocks; filters render in the side pane.
    # Phase-G — image children (type='image') ALSO live in this list.
    slicers_config: Optional[List[Dict[str, Any]]] = None
    # Phase-G — cluster layout metadata. NULL = default top-bar
    # auto-stack (backward compatible). Shape documented in models.
    slicer_cluster_layout: Optional[Dict[str, Any]] = None
    public_filters_config: Optional[List[Dict[str, Any]]] = None
    pages_config: Optional[List[Dict[str, Any]]] = None
    # Layout mode + theme + canvas geometry. Defaults preserve existing behavior.
    layout_mode: Optional[str] = Field("grid", description="'grid' or 'canvas'")
    theme_config: Optional[Dict[str, Any]] = None
    canvas_config: Optional[Dict[str, Any]] = None


class DashboardCreate(DashboardBase):
    """Schema for creating a dashboard."""
    charts: List[DashboardChartItem] = []


class DashboardUpdate(BaseModel):
    """Schema for updating a dashboard.

    `pages_config` intentionally omitted — pages CRUD goes through the
    draft pipeline at PUT /dashboards/{id}/draft-filters so Publish /
    Discard can manage it atomically. Writing to live here would be
    overwritten on the next publish flush. Pydantic v2 default is
    `extra="ignore"`, so legacy clients still sending pages_config get
    silently dropped instead of 422'd.
    """
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    filters_config: Optional[List[Dict[str, Any]]] = None
    slicers_config: Optional[List[Dict[str, Any]]] = None
    slicer_cluster_layout: Optional[Dict[str, Any]] = None
    public_filters_config: Optional[List[Dict[str, Any]]] = None
    layout_mode: Optional[str] = None
    theme_config: Optional[Dict[str, Any]] = None
    canvas_config: Optional[Dict[str, Any]] = None


class DashboardShareRequest(BaseModel):
    """Schema for saving public-link-specific filters."""
    public_filters_config: Optional[List[Dict[str, Any]]] = None


class PublicLinkCreate(BaseModel):
    """Schema for creating a named public link."""
    name: str = Field(..., min_length=1, max_length=255)
    filters_config: Optional[List[Dict[str, Any]]] = None
    appearance_config: Optional[Dict[str, Any]] = None
    password: Optional[str] = Field(None, min_length=1, max_length=128)


class PublicLinkUpdate(BaseModel):
    """Schema for updating a public link."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    filters_config: Optional[List[Dict[str, Any]]] = None
    appearance_config: Optional[Dict[str, Any]] = None
    is_active: Optional[bool] = None
    # None = no change; empty string = clear password; non-empty = new password
    password: Optional[str] = Field(None, max_length=128)


class PublicLinkResponse(BaseModel):
    """Schema for public link response."""
    id: int
    dashboard_id: int
    name: str
    token: str
    filters_config: Optional[List[Dict[str, Any]]] = None
    appearance_config: Optional[Dict[str, Any]] = None
    is_active: bool
    has_password: bool = False
    access_count: int
    last_accessed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DashboardChartResponse(BaseModel):
    """Schema for dashboard chart response."""
    id: int
    chart_id: Optional[int] = None  # Null for non-chart widgets
    chart: Optional['ChartResponse'] = None  # Include full chart data
    layout: Dict[str, Any]  # Changed from Dict[str, int] to allow None values
    parameters: Optional[Dict[str, Any]] = None  # Runtime parameter values for this instance
    widget_type: Optional[str] = "chart"
    widget_config: Optional[Dict[str, Any]] = None

    model_config = ConfigDict(from_attributes=True)


class DashboardResponse(DashboardBase):
    """Schema for dashboard response."""
    id: int
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    share_token: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    last_published_at: Optional[datetime] = None  # Phase-B17 optimistic-concurrency version
    # Phase-B19 — per-dataset semantic models for the public viewer (so logged-out
    # tiles build label/format maps without an authed /datasets/{id}/model call).
    public_dataset_models: Optional[Dict[str, Any]] = None
    dashboard_charts: List[DashboardChartResponse] = []
    filters_config: Optional[List[Dict[str, Any]]] = None
    slicers_config: Optional[List[Dict[str, Any]]] = None
    slicer_cluster_layout: Optional[Dict[str, Any]] = None
    public_filters_config: Optional[List[Dict[str, Any]]] = None
    # Phase-15.81 — hidden per-link constraint set. Populated only on the
    # /public/dashboards/{token} response (server stuffs the link's own
    # filters_config here). FE merges them silently into chart-data
    # requests but never renders them in the top-bar slicer.
    public_link_hidden_filters: Optional[List[Dict[str, Any]]] = None
    available_filter_fields: Optional[List[Dict[str, Any]]] = None
    public_link_name: Optional[str] = None
    public_link_appearance: Optional[Dict[str, Any]] = None
    # Phase-15.56 — draft layout overlay. Set when the editor has
    # unsaved layout changes. Public viewers always see live `layout`
    # in dashboard_charts; the editor reads this field to render
    # the pending layout instead. Save / publish copies these onto
    # live rows and clears the field.
    draft_layouts: Optional[Dict[int, Dict[str, Any]]] = None
    has_draft: bool = False

    model_config = ConfigDict(from_attributes=True)


class DashboardRelayoutRequest(BaseModel):
    """Ask a dashboard to be re-flowed into a layout template's topology.

    Separate from saving `theme_config` on purpose: re-flowing moves tiles a
    person may have placed by hand, so it is something they ask for and can
    undo -- not something that happens because they tried a different colour.
    """
    template_family: str = Field(..., description="console | brief | ops | editorial | stage")
    page_id: Optional[str] = Field(
        None,
        description=(
            "Re-flow only this page. Omitted means the default page; a multi-page "
            "report is never re-flowed wholesale from one page's view."
        ),
    )


class PresentationPlanRequest(BaseModel):
    """Ask the model how this page should be arranged.

    The snapshot is built and sanitized by the CLIENT, which is the only place
    that knows what the renderer honours. The server does not read it, does not
    trust it and does not persist it -- it forwards it to a model and returns
    the plan. Nothing here can write to a dashboard.
    """
    prompt: str = Field(..., min_length=1, max_length=2000)
    snapshot: Dict[str, Any] = Field(
        ..., description="DashboardPresentationSnapshot — presentation state only, no data"
    )
    conversation: Optional[List[Dict[str, str]]] = Field(
        None,
        description=(
            "Earlier turns, so an iterative request ('bigger') is read against "
            "the preview the user is looking at."
        ),
    )
    images: Optional[List[str]] = Field(
        None,
        max_length=3,
        description=(
            "Up to 3 reference images as data URLs (data:image/...;base64,...). "
            "Presentation context for the design tier ONLY — the model reads a "
            "reference's layout and mood, never its content, and the plan it "
            "returns still cannot change any chart's data."
        ),
    )
    focused_chart_id: Optional[int] = Field(
        None,
        description=(
            "When set, the user clicked ONE visual and is restyling only it. The "
            "plan must touch that visual's appearance and nothing else — no layout "
            "move, no other tile, no theme."
        ),
    )

    @field_validator("images")
    @classmethod
    def _bound_images(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        """Keep the proxy from forwarding a junk or oversized payload.

        Not a security boundary — the plan is re-validated client-side regardless
        — but a request has no business carrying tens of megabytes, and a
        non-string here is a bug worth catching at the door rather than at the
        provider.
        """
        if value is None:
            return value
        total = 0
        for item in value:
            if not isinstance(item, str) or not item.strip():
                raise ValueError("each reference image must be a non-empty data-URL string")
            total += len(item)
            if len(item) > 8_000_000:  # ~6MB decoded, per image
                raise ValueError("a reference image is too large (max ~6MB each)")
        if total > 16_000_000:
            raise ValueError("reference images are too large in total")
        return value


class PresentationPlanResponse(BaseModel):
    """The model's answer, unmodified.

    Deliberately untyped beyond `plan`: the server validates nothing, so
    describing the plan's shape here would imply a guarantee it does not make.
    The client's validator is the authority.
    """
    plan: Dict[str, Any]


class DashboardAddChartRequest(BaseModel):
    """Schema for adding a chart or widget to a dashboard."""
    chart_id: Optional[int] = None
    layout: DashboardChartLayout
    parameters: Optional[Dict[str, Any]] = Field(
        None, description="Runtime parameter values for this chart instance"
    )
    widget_type: Optional[str] = Field(
        "chart", description="chart/text/countdown/image/shape/parameter_switcher"
    )
    widget_config: Optional[Dict[str, Any]] = None


class DashboardUpdateLayoutRequest(BaseModel):
    """Schema for updating dashboard layout."""
    chart_layouts: List[DashboardLayoutUpdate]


class DashboardUpdateWidgetRequest(BaseModel):
    """Schema for updating a widget's config (non-chart widgets only)."""
    widget_config: Dict[str, Any]


# Phase-15.81 v12 — filter draft staging request. Either field may be
# omitted to leave that scope untouched; passing an empty list clears
# the draft entry for that scope. The route writes both to
# draft_snapshot so layout/filter drafts share the publish/discard
# lifecycle.
class DashboardUpdateDraftFiltersRequest(BaseModel):
    """Schema for staging filter / slicer slot edits into draft_snapshot.

    Each field is optional — omitting it leaves that scope untouched in
    the draft snapshot; passing `[]` clears the entry for that scope.
    `slicers_config` was added in Phase-A of the PBI-parity rework so
    slicer edits share the same draft/publish lifecycle as filters and
    layouts. Phase-G added `slicer_cluster_layout` so cluster
    position/size/direction also travels through the draft pipeline.
    """
    filters_config: Optional[List[Dict[str, Any]]] = None
    slicers_config: Optional[List[Dict[str, Any]]] = None
    slicer_cluster_layout: Optional[Dict[str, Any]] = None
    pages_config: Optional[List[Dict[str, Any]]] = None


# Query Execution Schemas
class QueryExecuteRequest(BaseModel):
    """Schema for executing an ad-hoc query."""
    data_source_id: int
    sql_query: str = Field(..., min_length=1)
    # Phase-15.83 — ad-hoc query LIMIT cap bumped from 10000 to 10M
    # sentinel so the Explore custom-SQL path doesn't 422 when sending the
    # NO_LIMIT_SENTINEL chosen by the FE row-cap-removal change.
    limit: Optional[int] = Field(None, ge=1, le=10_000_000)
    timeout_seconds: Optional[int] = Field(30, ge=1, le=300, description="Query timeout in seconds")


class QueryExecuteResponse(BaseModel):
    """Schema for query execution result."""
    columns: List[str]
    data: List[Dict[str, Any]]
    row_count: int
    execution_time_ms: float


class SqlValidateRequest(BaseModel):
    """Schema for validating a SQL query against a datasource without executing it."""
    data_source_id: int
    sql_query: str = Field(..., min_length=1)


class SqlValidateResponse(BaseModel):
    """Schema for SQL validation result."""
    valid: bool
    error: Optional[str] = None
    dialect: Optional[str] = None


# Error Response Schema
class ErrorResponse(BaseModel):
    """Schema for error responses."""
    detail: str


# ── AI Chat Session ────────────────────────────────────────────────────────────

class AiChatSessionSave(BaseModel):
    """Payload the frontend sends to upsert a chat session."""
    session_key: str = Field(..., min_length=1, max_length=64)
    provider: Optional[str] = Field(None, max_length=20)
    model: Optional[str] = Field(None, max_length=120)
    # [{role: "user"|"assistant", content: "..."}] — status logs stripped client-side
    messages: List[Dict[str, Any]] = Field(default_factory=list)
    briefing: Optional[Dict[str, Any]] = None
    conv_state: Optional[Dict[str, Any]] = None
    turn_count: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0


class AiChatSessionResponse(BaseModel):
    """What the API returns when loading a session."""
    session_key: str
    provider: Optional[str]
    model: Optional[str]
    messages: List[Dict[str, Any]]
    briefing: Optional[Dict[str, Any]]
    conv_state: Optional[Dict[str, Any]]
    turn_count: int
    prompt_tokens: int
    completion_tokens: int
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


class AiChatSessionAdminRow(BaseModel):
    """Summary row for the admin session list endpoint."""
    id: int
    session_key: str
    provider: Optional[str]
    model: Optional[str]
    turn_count: int
    prompt_tokens: int
    completion_tokens: int
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True
