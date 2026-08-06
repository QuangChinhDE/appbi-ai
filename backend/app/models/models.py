"""
SQLAlchemy models for the BI application.
"""
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, ForeignKey, JSON, Boolean, Enum, Float,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from datetime import datetime
import enum
import uuid

from app.core.database import Base


class DataSourceType(str, enum.Enum):
    """Supported data source types."""
    POSTGRESQL = "postgresql"
    MYSQL = "mysql"
    BIGQUERY = "bigquery"
    GOOGLE_SHEETS = "google_sheets"
    #: A named Google Docs connection. Unlike the others this holds no tabular
    #: data — it exists so a Knowledge Doc can pick WHICH Google account to read
    #: a document through, the same way BigQuery/Sheets sources are picked.
    GOOGLE_DOCS = "google_docs"
    MANUAL = "manual"


class ChartType(str, enum.Enum):
    """Supported chart types."""
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


class DataSource(Base):
    """
    Data source connection configuration.
    Stores connection details for external SQL databases.
    """
    __tablename__ = "data_sources"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    type = Column(Enum(DataSourceType, values_callable=lambda obj: [e.value for e in obj]), nullable=False)
    description = Column(Text, nullable=True)
    
    # Connection configuration stored as JSON
    # Format depends on type:
    # PostgreSQL/MySQL: {host, port, database, username, password}
    # BigQuery: {project_id, credentials_json, dataset}
    config = Column(JSON, nullable=False)

    # Sync configuration (schedule + per-table strategies + retry + notification)
    # Format: {schedule: {...}, tables: {...}, retry: {...}, notification: {...}}
    sync_config = Column(JSON, nullable=True)

    # Ownership
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    sync_jobs = relationship("SyncJob", back_populates="data_source", cascade="all, delete-orphan")


class Chart(Base):
    """
    Chart definition based on a dataset.
    Defines visualization configuration.
    """
    __tablename__ = "charts"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text, nullable=True)
    
    # Foreign key to dataset table
    dataset_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="SET NULL"), nullable=True)
    
    # Chart type
    chart_type = Column(Enum(ChartType), nullable=False)
    
    # Chart configuration stored as JSON
    # Format depends on chart_type:
    # Bar/Line: {x_axis: "column_name", y_axis: "column_name", ...}
    # Pie: {label: "column_name", value: "column_name"}
    # Time Series: {time_column: "column_name", value_column: "column_name", ...}
    config = Column(JSON, nullable=False)
    
    # Ownership
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    
    # Relationships
    dataset_table = relationship("DatasetTable", foreign_keys=[dataset_table_id])
    dashboard_charts = relationship("DashboardChart", back_populates="chart", cascade="all, delete-orphan")
    chart_meta = relationship("ChartMetadata", back_populates="chart", uselist=False, cascade="all, delete-orphan")
    parameters = relationship("ChartParameter", back_populates="chart", cascade="all, delete-orphan")


class Dashboard(Base):
    """
    Dashboard containing multiple charts with layout information.
    """
    __tablename__ = "dashboards"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), unique=True, nullable=False, index=True)
    description = Column(Text, nullable=True)
    
    # Store dashboard-level FILTER PANE entries as JSON.
    # Structure: [{"id": "uuid", "datasetId": 1, "field": "country", "type": "dropdown",
    #             "operator": "in", "value": ["US"], "public_mode": "visible",
    #             "allow_override": false}]
    # `public_mode` ∈ {"visible", "locked", "hidden"} controls behavior on
    # public links; `allow_override` lets viewers change a visible-banner
    # value via the mini-pane. See docs/filter-semantics.md §2.2.
    filters_config = Column(JSON, nullable=True, default=list)

    # Phase-A — slicer-visual entries (separate from filters pane). Each
    # entry renders as a canvas block in the SlicerBar. Slicers are
    # always visible to viewers; public visibility differences are
    # expressed at the public-link level (DashboardPublicLink.filters_config).
    # Same field shape as filters_config except `public_mode` is implicit-visible.
    # Phase-G — image children (logos etc.) ALSO live in this list as
    # entries with `type='image'`. They render inside the same cluster
    # as slicers; the filter pipeline skips them since they are not
    # query predicates.
    slicers_config = Column(JSON, nullable=True, default=list)

    # Phase-G — slicer cluster layout metadata. NULL means "use default
    # top-bar auto-stack layout" (backward compatible). Shape:
    #   {
    #     position: 'top' | 'left' | 'free',
    #     x, y, w, h (12-col grid coords when dashboard.layout_mode='grid'),
    #     xPx, yPx, wPx, hPx (pixel coords when 'canvas'),
    #     direction: 'horizontal' | 'vertical' | 'grid',
    #     gap, background, border
    #   }
    slicer_cluster_layout = Column(JSON, nullable=True)

    pages_config = Column(JSON, nullable=True, default=list)

    # Layout mode: "grid" (react-grid-layout, default) or "canvas" (free positioning)
    layout_mode = Column(String(16), nullable=False, server_default="grid", default="grid")
    # Theme: {mode: "dark"|"light", accent: "#ffcc00", fontFamily: "...", cardStyle: "soft"|"sharp"}
    theme_config = Column(JSON, nullable=True, default=dict)
    # Canvas mode geometry: {width: 1440, height: 900, snap: 8, background: "#0b0f0b"}
    canvas_config = Column(JSON, nullable=True, default=dict)

    # Ownership
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Public link sharing — null means not shared
    share_token = Column(String(64), nullable=True, unique=True, index=True)
    public_filters_config = Column(JSON, nullable=True, default=list)

    # Phase-15.56 — draft snapshot. When set, editors see this overlay
    # on top of the live columns; public viewers still read the live
    # columns. Clicking "Lưu / Publish" applies the snapshot onto the
    # live columns + dashboard_charts rows, then clears this field.
    # Shape: {
    #   name?, description?, filters_config?, slicers_config?,
    #   pages_config?, layout_mode?, theme_config?, canvas_config?,
    #   public_filters_config?, layouts?,
    #   dashboard_charts?: [
    #     {id?, chart_id?, widget_type, widget_config, layout, parameters}
    #   ]
    # }
    # Phase-A (PBI rework): `slicers_config` was added so slicer-block
    # edits share the same draft / publish lifecycle as filter-pane
    # edits and layout edits.
    draft_snapshot = Column(JSON, nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    # Phase-B17 — set ONLY by POST /publish (not draft saves). Used as the
    # optimistic-concurrency version so a second editor can't silently clobber
    # a publish made after they loaded.
    last_published_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    # order_by id: dashboard_charts had NO deterministic order, so different
    # eager-load queries (authed build endpoint vs public endpoint) returned the
    # tiles in different orders. With overlapping tile positions, react-grid-layout
    # resolves overlaps by child order → the SAME dashboard rendered with a
    # DIFFERENT arrangement on build vs public/embed. Ordering by id makes every
    # consumer (build, public, embed, export, AI bot) see one stable order.
    dashboard_charts = relationship(
        "DashboardChart",
        back_populates="dashboard",
        cascade="all, delete-orphan",
        order_by="DashboardChart.id",
    )
    public_links = relationship("DashboardPublicLink", back_populates="dashboard", cascade="all, delete-orphan")


class DashboardPublicLink(Base):
    """
    A named public share link for a dashboard, each with its own filter set and access tracking.
    One dashboard can have many public links with different filters.
    """
    __tablename__ = "dashboard_public_links"

    id = Column(Integer, primary_key=True, index=True)
    dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    token = Column(String(64), nullable=False, unique=True, index=True)
    # Canonical hash of (dashboard_id + locked filters) for embed-API managed
    # links. Lets the M2M endpoint dedupe "1 filter set = 1 link" via a partial
    # unique index (source='embed_api'). Null for user/workboard links.
    filter_hash = Column(String(64), nullable=True, index=True)
    filters_config = Column(JSON, nullable=True, default=list)
    appearance_config = Column(JSON, nullable=True, default=dict)
    is_active = Column(Boolean, nullable=False, default=True)

    # Security & governance
    expires_at = Column(DateTime(timezone=True), nullable=True)  # null = never expires
    password_hash = Column(String(255), nullable=True)  # optional password protection
    max_access_count = Column(Integer, nullable=True)  # null = unlimited
    allowed_ips = Column(JSON, nullable=True, default=list)  # optional IP allowlist

    # Tracking
    access_count = Column(Integer, nullable=False, default=0)
    last_accessed_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Provenance: 'user' (manual share dialog) | 'workboard' (auto-managed by a
    # workboard dashboard screen). Managed links are hidden in the share UI and
    # garbage-collected when the owning screen/role disappears.
    source = Column(String(20), nullable=False, default="user", server_default="user", index=True)

    # Draft/Published staging for source='workboard' managed links. Draft-autosave
    # sync only ever touches stage='draft' rows; Publish promotes them into
    # stage='published' rows that the LIVE runtime resolves — so a draft edit can
    # never mutate/delete the link a Live user is embedding. 'user'/'embed_api'
    # links are always 'published' (no draft concept). A partial unique index on
    # (name, stage) WHERE source='workboard' lets the two managed sets coexist.
    stage = Column(String(16), nullable=False, default="published", server_default="published", index=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    dashboard = relationship("Dashboard", back_populates="public_links")

    @property
    def has_password(self) -> bool:
        return self.password_hash is not None


class DashboardChart(Base):
    """
    Association table between dashboards and charts with layout information.
    """
    __tablename__ = "dashboard_charts"
    
    id = Column(Integer, primary_key=True, index=True)
    
    # Foreign keys
    dashboard_id = Column(Integer, ForeignKey("dashboards.id"), nullable=False)
    # Nullable so non-chart widgets (text/countdown/shape/image/parameter_switcher) can live here.
    chart_id = Column(Integer, ForeignKey("charts.id"), nullable=True)

    # Discriminator: "chart" (default) | "text" | "countdown" | "image" | "shape" | "parameter_switcher"
    widget_type = Column(String(32), nullable=False, server_default="chart", default="chart")
    # Free-form per-widget config (only used when widget_type != "chart")
    widget_config = Column(JSON, nullable=True, default=dict)

    # Layout information for react-grid-layout
    # Format: {x: 0, y: 0, w: 6, h: 4, xPx?, yPx?, wPx?, hPx?, z?}
    layout = Column(JSON, nullable=False)

    # Runtime parameter values for this chart instance in this dashboard
    # Format: {"date_range": "last_30_days", "region": "VN"}
    parameters = Column(JSON, nullable=True, default=dict)
    
    # Relationships
    dashboard = relationship("Dashboard", back_populates="dashboard_charts")
    chart = relationship("Chart", back_populates="dashboard_charts")


class ChartMetadata(Base):
    """
    Semantic metadata for a chart (business meaning layer).
    Separate from chart config — does not affect rendering or execution.
    """
    __tablename__ = "chart_metadata"

    id = Column(Integer, primary_key=True, index=True)
    chart_id = Column(Integer, ForeignKey("charts.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)

    # Business domain: sales / marketing / finance / operations / hr
    domain = Column(String(100), nullable=True)

    # Analysis intent: trend / comparison / ranking / summary / distribution
    intent = Column(String(100), nullable=True)

    # Business metric names (semantic labels, NOT technical column names)
    # Example: ["revenue", "order_count"]
    metrics = Column(JSON, nullable=True, default=list)

    # Business dimension names (semantic labels)
    # Example: ["month", "region"]
    dimensions = Column(JSON, nullable=True, default=list)

    # Free-form tags for search and classification
    # Example: ["sales", "performance", "q1"]
    tags = Column(JSON, nullable=True, default=list)

    # Knowledge system fields — Feedback-Driven Knowledge System
    auto_description = Column(Text, nullable=True, default=None)          # AI-generated chart description
    insight_keywords = Column(JSON, nullable=True, default=None)          # ["revenue by region", "doanh thu vùng"]
    common_questions = Column(JSON, nullable=True, default=None)          # ["Drill down APAC?", ...]
    query_aliases = Column(JSON, nullable=True, default=None)             # From feedback loop
    description_source = Column(String(20), nullable=True, default=None)  # "auto"|"user"|"feedback"
    description_updated_at = Column(DateTime(timezone=True), nullable=True, default=None)
    generation_status = Column(String(20), nullable=True, default="idle")  # idle|queued|processing|succeeded|failed|stale
    generation_error = Column(Text, nullable=True, default=None)
    generation_requested_at = Column(DateTime(timezone=True), nullable=True, default=None)
    generation_finished_at = Column(DateTime(timezone=True), nullable=True, default=None)
    stale_reason = Column(Text, nullable=True, default=None)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    chart = relationship("Chart", back_populates="chart_meta")


class ChartParameter(Base):
    """
    Parameter definition for a chart template.
    Declares what parameters the chart can accept; does NOT store values.
    Values live in DashboardChart.parameters at runtime.
    """
    __tablename__ = "chart_parameters"

    id = Column(Integer, primary_key=True, index=True)
    chart_id = Column(Integer, ForeignKey("charts.id", ondelete="CASCADE"), nullable=False, index=True)

    # Parameter name: date_range, region, product_category
    parameter_name = Column(String(100), nullable=False)

    # Parameter type: time_range, dimension, measure
    parameter_type = Column(String(50), nullable=False)

    # Column mapping JSON: {"column": "order_date", "type": "date"}
    # Tells the system which dataset column this parameter maps to
    column_mapping = Column(JSON, nullable=True)

    # Default value used when no override is supplied
    default_value = Column(String(255), nullable=True)

    # Human-readable description of the parameter
    description = Column(Text, nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    chart = relationship("Chart", back_populates="parameters")


class SyncJob(Base):
    """
    Record of a single sync job execution for a data source.
    Tracks status, timing, rows affected, and errors.
    """
    __tablename__ = "sync_jobs"

    id = Column(Integer, primary_key=True, index=True)
    data_source_id = Column(Integer, ForeignKey("data_sources.id", ondelete="CASCADE"), nullable=False, index=True)

    # "running" | "success" | "failed" | "timeout"
    status = Column(String(20), nullable=False, default="running")

    # "full_refresh" | "incremental" | "append_only" | "manual"
    mode = Column(String(30), nullable=False)

    started_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    finished_at = Column(DateTime(timezone=True), nullable=True)

    # Rows affected in this run
    rows_synced = Column(Integer, nullable=True)
    rows_failed = Column(Integer, nullable=True)

    error_message = Column(Text, nullable=True)

    # "schedule" | "manual"
    triggered_by = Column(String(50), nullable=True, default="manual")

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationships
    data_source = relationship("DataSource", back_populates="sync_jobs")


# ---------------------------------------------------------------------------
# Embedding integration (machine-to-machine) — see embed_link_service.py
# ---------------------------------------------------------------------------

class EmbedGrant(Base):
    """A short-lived, rotating opaque token exposed in an iframe URL. Resolves
    to a managed DashboardPublicLink without exposing that link's own token.
    Only the SHA-256 hash of the 256-char token is stored.

    Minted by POST /api/v1/integrations/embed/resolve, authenticated with the
    caller's Personal Access Token (PAT) — the same token the MCP uses. The
    grant is scoped to whatever the PAT's user can access; `created_by` records
    that user for audit.
    """
    __tablename__ = "embed_grants"

    id = Column(UUID(as_uuid=True), primary_key=True)
    link_id = Column(Integer, ForeignKey("dashboard_public_links.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    use_count = Column(Integer, nullable=False, default=0)

    # Title the host app wants the embedded report to show ("header" in the
    # resolve payload). Lives on the GRANT, not on the managed link: links are
    # deduped by filter set, so two host apps embedding the same slice under
    # different titles would otherwise overwrite each other's header. Empty →
    # the report falls back to the managed link's internal name.
    header = Column(String(200), nullable=True)

    # Snapshot of the minting PAT's embed origin allowlist. Copied here so the
    # policy lookup that guards the iframe is ONE row read by token (no join to
    # the PAT on a hot path), and so an already-issued link keeps the policy it
    # was issued under. Grants live ~1h, so a change on the PAT takes effect for
    # every link minted after it — fast enough without touching live grants.
    allowed_origins = Column(JSONB, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at = Column(DateTime(timezone=True), nullable=True)


class GoogleOAuthPending(Base):
    """A Google credential granted in the consent popup but not yet attached to
    a data source — the popup finishes before a NEW source has an id. Single-use
    and short-lived: saving the data source consumes the row and moves the
    credential into that source's own encrypted config."""
    __tablename__ = "google_oauth_pending"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    email = Column(String(255), nullable=False)
    credentials = Column(Text, nullable=False)   # encrypted authorized-user JSON
    scopes = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=func.now())
