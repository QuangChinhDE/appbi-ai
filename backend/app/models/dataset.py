"""
Dataset Models - Table-based dataset like NocoDB/Airtable
"""
from sqlalchemy import Column, Integer, BigInteger, String, Boolean, DateTime, Float, ForeignKey, Text, JSON
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
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
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)
    
    # Relationships
    tables = relationship("DatasetTable", back_populates="dataset", cascade="all, delete-orphan")
    quality_rules = relationship("DatasetQualityRule", back_populates="dataset", cascade="all, delete-orphan")
    quality_runs = relationship("DatasetQualityRun", back_populates="dataset", cascade="all, delete-orphan")


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
    error_message = Column(Text, nullable=True)
    triggered_by_id = Column(String(36), nullable=True)             # user UUID string
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)

    # Relationships
    dataset = relationship("Dataset", back_populates="quality_runs")

