"""
Dataset Models - Table-based dataset like NocoDB/Airtable
"""
from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Float, ForeignKey, Text, JSON
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import expression
from datetime import datetime

from app.core.database import Base


class Dataset(Base):
    """
    Dataset - like NocoDB Base or Airtable Base
    A dataset contains multiple tables from various datasources
    """
    __tablename__ = "datasets"
    
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    settings = Column(JSONB, nullable=True, default=None)
    dictionary = Column(JSONB, nullable=True, default=None)
    dictionary_updated_at = Column(DateTime, nullable=True, default=None)
    # Drafts are created by the Dashboard HTML Import wizard so users can edit
    # per-table transformations before materializing charts. They are excluded
    # from normal listings and deleted if the wizard is cancelled.
    is_draft = Column(Boolean, nullable=False, default=False, server_default="false", index=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # ── Publish lifecycle (Import-mode: design on source → Sync & Publish →
    #    Dashboards read ONLY the published snapshot generation). See
    #    dataset_publish_service. NULL publish_state = LEGACY dataset (pre-Phase-1):
    #    keeps the old live/opt-in-snapshot behaviour untouched, so existing
    #    dashboards never break — the published-only gate applies ONLY to a
    #    dataset explicitly taken through Sync & Publish. ─────────────────────
    #    draft | ready | syncing | published | changes_pending | sync_failed | disabled
    publish_state = Column(String(24), nullable=True, index=True)
    # The snapshot generation Dashboards MUST read (pinned; never "latest").
    published_generation = Column(BigInteger, nullable=True)
    published_at = Column(DateTime, nullable=True)
    # sha256 of the LOCKED design (tables+schema+relationships+measures+transforms)
    # captured at publish; a later design edit ⇒ publish_state=changes_pending
    # while Dashboards keep serving published_generation.
    published_design_fingerprint = Column(String(64), nullable=True)
    last_sync_error = Column(Text, nullable=True)
    # Security scope token baked into the cache key + snapshot governance:
    # "shared" (all authorized viewers see the same rows) today; becomes a
    # tenant/RLS-principal once per-user row security lands. NULL = legacy.
    security_scope = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)
    
    # Relationships
    tables = relationship("DatasetTable", back_populates="dataset", cascade="all, delete-orphan")
    quality_rules = relationship("DatasetQualityRule", back_populates="dataset", cascade="all, delete-orphan")
    quality_runs = relationship("DatasetQualityRun", back_populates="dataset", cascade="all, delete-orphan")
    quality_schedule = relationship(
        "DatasetQualitySchedule",
        back_populates="dataset",
        uselist=False,
        cascade="all, delete-orphan",
    )


class DatasetTable(Base):
    """
    Table in a dataset
    References a physical table/view from a datasource
    """
    __tablename__ = "dataset_tables"
    
    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    datasource_id = Column(Integer, ForeignKey("data_sources.id", ondelete="CASCADE"), nullable=True, index=True)
    
    # Source specification
    source_kind = Column(String(50), default="physical_table", nullable=False)  # "physical_table" | "sql_query" | "derived_table" | "generated_calendar"
    source_table_name = Column(String(500), nullable=True)  # For physical_table: e.g., "public.orders"
    source_query = Column(Text, nullable=True)  # For sql_query: SELECT statement
    display_name = Column(String(255), nullable=False)  # User-friendly name
    
    # Query routing — "synced" = DuckDB (default), "live" = direct source query
    query_mode = Column(String(20), default="synced", nullable=False, server_default="synced")
    estimated_row_count = Column(BigInteger, nullable=True)  # From source INFORMATION_SCHEMA
    estimated_size_bytes = Column(BigInteger, nullable=True)  # From source INFORMATION_SCHEMA

    # Status and config
    enabled = Column(Boolean, default=True, nullable=True)
    transformations = Column(JSON, default=None, nullable=True)  # Transform steps
    # Workboard access-audit: when True, the table is treated as shared/dim
    # data in mini-apps (no miniapp_user filter applied even if no chain to a
    # per-user fact exists). Default False so missing-config stays loud.
    miniapp_share = Column(Boolean, default=False, nullable=False, server_default=expression.false())
    
    # Cache for performance
    columns_cache = Column(JSON, nullable=True)  # Cached column metadata
    sample_cache = Column(JSON, nullable=True)  # Cached sample data
    type_overrides = Column(JSON, nullable=True)  # {"col_name": "integer"} user-defined type overrides
    column_formats = Column(JSON, nullable=True)  # {"col_name": {formatType, decimalPlaces, ...}} full display format per column
    
    # AI metadata — populated automatically by TableStatsService
    column_stats = Column(JSONB, nullable=True, default=None)
    auto_description = Column(Text, nullable=True, default=None)
    stats_updated_at = Column(DateTime, nullable=True, default=None)

    # Knowledge system fields — Feedback-Driven Knowledge System
    column_descriptions = Column(JSONB, nullable=True, default=None)    # {"col": "description"}
    common_questions = Column(JSONB, nullable=True, default=None)        # ["question1", ...]
    query_aliases = Column(JSONB, nullable=True, default=None)           # ["GMV", "doanh thu"] from feedback
    description_source = Column(String(20), nullable=True, default=None) # "auto"|"user"|"feedback"
    description_updated_at = Column(DateTime, nullable=True, default=None)
    schema_hash = Column(String(64), nullable=True, default=None)        # SHA256 of sorted col:dtype
    schema_change_pending = Column(Boolean, nullable=True, default=False) # True = schema changed, user description may be stale
    generation_status = Column(String(20), nullable=True, default="idle")  # idle|queued|processing|succeeded|failed|stale
    generation_error = Column(Text, nullable=True, default=None)
    generation_requested_at = Column(DateTime, nullable=True, default=None)
    generation_finished_at = Column(DateTime, nullable=True, default=None)
    stale_reason = Column(Text, nullable=True, default=None)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)

    # Relationships
    dataset = relationship("Dataset", back_populates="tables")
    quality_rules = relationship("DatasetQualityRule", back_populates="table", cascade="all, delete-orphan")


class DatasetQualityRule(Base):
    """
    A single data-quality expectation on a table or column.

    dimension  ∈ { completeness | validity | uniqueness | consistency | timeliness | accuracy }
    rule_type  is a string code within that dimension, e.g. "not_null", "accepted_values".
    config     is a JSONB bag of parameters that depend on rule_type.
    """
    __tablename__ = "dataset_quality_rules"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="CASCADE"), nullable=False, index=True)
    column_name = Column(String(255), nullable=True)   # None → table-level rule
    dimension = Column(String(50), nullable=False)     # e.g. "completeness"
    rule_type = Column(String(80), nullable=False)     # e.g. "not_null"
    name = Column(String(255), nullable=False)         # human label
    config = Column(JSONB, nullable=True, default=dict)
    severity = Column(String(20), nullable=False, default="warning")  # info | warning | error
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)

    # Relationships
    dataset = relationship("Dataset", back_populates="quality_rules")
    table = relationship("DatasetTable", back_populates="quality_rules")


class DatasetQualityRun(Base):
    """
    A recorded execution of all quality rules for a dataset.
    Results are stored as JSONB: { "<rule_id>": { passed, rows_checked, rows_failed, detail } }
    """
    __tablename__ = "dataset_quality_runs"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(String(20), nullable=False, default="queued")   # queued | running | completed | failed
    score = Column(Float, nullable=True)                            # 0–100 overall pass-rate
    results = Column(JSONB, nullable=True)                          # per-rule detail
    progress_done = Column(Integer, nullable=True)                  # rules checked so far
    progress_total = Column(Integer, nullable=True)                 # total enabled rules
    error_message = Column(Text, nullable=True)
    triggered_by_id = Column(String(36), nullable=True)             # user UUID string
    trigger_source = Column(String(20), nullable=False, default="manual")  # "manual" | "schedule"
    schedule_id = Column(
        Integer,
        ForeignKey("dataset_quality_schedules.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)

    # Relationships
    dataset = relationship("Dataset", back_populates="quality_runs")
    schedule = relationship("DatasetQualitySchedule", back_populates="runs")


class DatasetQualitySchedule(Base):
    """
    Automation configuration for dataset quality checks.

    One schedule per dataset. When enabled with type="schedule", the in-process
    APScheduler (see `dataset_quality_scheduler`) creates a cron job that
    triggers a full quality run and emails a PDF report to `recipient_email`
    (and any `cc_emails`) after each scheduled run.
    """
    __tablename__ = "dataset_quality_schedules"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(
        Integer,
        ForeignKey("datasets.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    enabled = Column(Boolean, nullable=False, default=False, index=True)
    type = Column(String(20), nullable=False, default="manual")   # "manual" | "schedule"
    cron = Column(String(120), nullable=True)
    timezone = Column(String(80), nullable=False, default="UTC")
    recipient_email = Column(String(320), nullable=True)
    cc_emails = Column(JSONB, nullable=True, default=list)
    notify_on_success = Column(Boolean, nullable=False, default=True)
    notify_on_failure = Column(Boolean, nullable=False, default=True)
    last_run_at = Column(DateTime, nullable=True)
    last_run_status = Column(String(20), nullable=True)
    last_error = Column(Text, nullable=True)
    next_run_at = Column(DateTime, nullable=True)
    created_by_id = Column(String(36), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)

    dataset = relationship("Dataset", back_populates="quality_schedule", uselist=False)
    runs = relationship("DatasetQualityRun", back_populates="schedule")


class DatasetTableSnapshot(Base):
    """
    Near-realtime snapshot-materialization registry (Dashboard perf #5).

    Each row records a physical flat table (in the datasource's snapshot dataset,
    e.g. `appbi_snapshots`) that materializes ONE dataset table's resolved output.
    Charts read the flat snapshot instead of re-running the heavy source pipeline.

    Freshness/consistency model:
      • `fingerprint` = sha256(resolved-source-SQL + ordered columns + dialect).
        A snapshot is only usable when its fingerprint matches the live model —
        a model edit changes the fingerprint and forces a rebuild.
      • Exactly one row per table is `is_current` (partial-unique index). A build
        inserts a `building` row; on success ONE txn flips the pointer
        (old → superseded, new → ready + is_current). A failed build leaves the
        previous current untouched, so readers never see a torn/half-built state.
      • A dashboard render resolves all its tables in ONE registry read, so every
        tile of that open sees a self-consistent snapshot set.
    """
    __tablename__ = "dataset_table_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    dataset_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="CASCADE"), nullable=False, index=True)
    version = Column(BigInteger, nullable=False)                 # monotonic per table (epoch-ms)
    physical_ref = Column(Text, nullable=False)                  # project.appbi_snapshots.snap_t{tid}_v{ver}
    fingerprint = Column(String(64), nullable=False)             # sha256 of resolved SQL + schema + dialect
    row_count = Column(BigInteger, nullable=True)
    build_ms = Column(Integer, nullable=True)
    status = Column(String(16), nullable=False, default="building")  # building | ready | failed | superseded
    error = Column(Text, nullable=True)
    is_current = Column(Boolean, nullable=False, default=False, server_default=expression.false(), index=True)
    built_at = Column(DateTime, nullable=True)                   # set when status → ready
    # perf #5 — MAX(last_modified_time) of the source tables this snapshot read,
    # captured at build. A later render compares the current source watermark to
    # this to detect SOURCE-DATA changes (not just SQL/schema) and rebuild only
    # when the data actually changed — change-driven refresh, no time-based spam.
    source_watermark = Column(DateTime(timezone=True), nullable=True)
    # ── Refactor Phase 4: dataset-level consistency + host identity ─────────
    # generation — ONE id (epoch-ms of the refresh batch) stamped on every row
    # built in the same refresh_all_for_dataset pass. A chart resolves the
    # newest COMPLETE generation, so its tables always come from the SAME
    # refresh — never a torn half-old/half-new mix while a rebuild is running.
    # NULL on legacy rows (pre-Phase-4) → per-table is_current fallback.
    generation = Column(BigInteger, nullable=True, index=True)
    # Which BigQuery datasource/project/location HOSTS this physical table —
    # recorded at build so read-time credential/host selection comes from the
    # registry (what actually happened) instead of being re-derived from
    # mutable datasource config (issue #18/#19).
    host_datasource_id = Column(Integer, nullable=True)
    host_project = Column(String(255), nullable=True)
    host_location = Column(String(64), nullable=True)
    # Delayed GC (issue #10): the physical table of a superseded snapshot is
    # kept until the dataset has a NEWER complete generation + a grace window,
    # so in-flight queries that resolved the old refs never read a dropped
    # table. Set when the physical table is actually dropped.
    retired_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)



class DatasetGrant(Base):
    """Per-Dataset access grant — Phase 1 of the Power-BI-style "Dataset is a
    governed data asset" model. DELIBERATELY SEPARATE from the shared
    ResourceShare table (governance principle #5): Dataset access has finer,
    dataset-specific verbs and its own lifecycle (composition/Build, Reshare),
    so it must not be entangled with the generic view/edit share used by
    dashboards/charts. ResourceShare(DATASET, view/edit) is NOT auto-migrated
    into build/reshare (principle #4) — legacy shares keep meaning view/edit only.

    Verbs (ascending capability):
      view     — consume dashboards built on this dataset (read published data)
      explore  — ad-hoc query / preview against the published dataset
      build    — create NEW content FROM this dataset (dashboards, or a
                 downstream Dataset that references this one). REQUIRED on a
                 parent to compose a child (principle #3).
      reshare  — grant access to others
      edit     — modify the dataset design (tables/relationships/measures)
      manage   — full control incl. grants, publish, delete (owner-equivalent)
    Exactly one of user_id / team_id is set (like ResourceShare)."""
    __tablename__ = "dataset_grants"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=True)
    verb = Column(String(16), nullable=False, default="view")  # view|explore|build|reshare|edit|manage
    granted_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)


class DatasetDependency(Base):
    """Lineage edge for Dataset-on-Dataset composition (Phase-2, model landed
    now so the migration + cycle/depth guards exist before the feature ships).
    child references parent; parent_generation PINS the exact published
    generation of the parent the child was validated against (principle #2 —
    NEVER auto-read latest). A new parent publish flips the child to
    changes_pending; the pin only advances when the child re-validates +
    re-publishes."""
    __tablename__ = "dataset_dependencies"

    id = Column(Integer, primary_key=True, index=True)
    child_dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_generation = Column(BigInteger, nullable=True)  # pinned parent generation
    materialized = Column(Boolean, nullable=False, default=False, server_default=expression.false())
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)

    __table_args__ = (
        # a child pins a given parent once
        # (UniqueConstraint declared in migration to keep model import light)
    )
