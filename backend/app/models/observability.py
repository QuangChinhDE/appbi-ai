"""
Observability spine — unifies the data-observability pillars on top of the
existing Quality (DatasetQualityRule/Run) and Anomaly (MonitoredMetric/
AnomalyAlert) engines.

Three tables:
  - ObservabilityMonitor : a freshness/volume/schema check on a dataset table.
                           (Quality rules and anomaly metrics are their OWN
                           detectors; this table only owns the 3 pillars that
                           had no home before.)
  - ObservabilityCheck   : time-series snapshot of each monitor run (value +
                           status), so trends/sparklines work even when the
                           source has no time column.
  - ObservabilityIncident: ONE lifecycle store for breaches from ANY detector
                           (quality | anomaly | freshness | volume | schema),
                           with open→acknowledged→resolved + first/resolved
                           timestamps → MTTR.

Pillars (market 5-pillar model): freshness · volume · schema · distribution ·
quality. `distribution` is covered by anomaly + quality rules; the 3 new
monitor kinds cover freshness/volume/schema.
"""
from datetime import datetime

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, Index,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.core.database import Base


# Monitor kinds owned by this spine (anomaly + quality live in their own tables)
MONITOR_KINDS = ("freshness", "volume", "schema")

# Unified incident sources
INCIDENT_SOURCES = ("freshness", "volume", "schema", "quality", "anomaly")

INCIDENT_STATUSES = ("open", "acknowledged", "resolved")


class ObservabilityMonitor(Base):
    """A freshness / volume / schema health check on a single dataset table."""
    __tablename__ = "observability_monitors"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    dataset_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="CASCADE"), nullable=False, index=True)

    kind = Column(String(20), nullable=False)        # freshness | volume | schema
    name = Column(String(255), nullable=False)
    # config bag, kind-specific:
    #   freshness: {"time_column": str, "max_lag_hours": float}
    #   volume:    {"time_column": str|None, "z_threshold": float, "min_rows": int|None}
    #   schema:    {}  (compares columns_cache fingerprint over time)
    config = Column(JSONB, nullable=True, default=dict)
    severity = Column(String(20), nullable=False, default="warning")  # info|warning|critical
    is_active = Column(Boolean, nullable=False, default=True)

    # Last-run cache (for fast list rendering)
    last_status = Column(String(20), nullable=True)     # ok | breached | error | unknown
    last_value = Column(Float, nullable=True)
    last_detail = Column(JSONB, nullable=True)
    last_checked_at = Column(DateTime, nullable=True)

    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)

    dataset_table = relationship("DatasetTable", foreign_keys=[dataset_table_id])
    checks = relationship("ObservabilityCheck", back_populates="monitor", cascade="all, delete-orphan")


class ObservabilityCheck(Base):
    """One recorded execution of a monitor — the time-series history."""
    __tablename__ = "observability_checks"

    id = Column(Integer, primary_key=True, index=True)
    monitor_id = Column(Integer, ForeignKey("observability_monitors.id", ondelete="CASCADE"), nullable=False, index=True)
    checked_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    value = Column(Float, nullable=True)             # freshness=lag hours; volume=row count
    status = Column(String(20), nullable=False, default="ok")  # ok | breached | error
    detail = Column(JSONB, nullable=True)

    monitor = relationship("ObservabilityMonitor", back_populates="checks")


class ObservabilityIncident(Base):
    """Unified incident across every detector, with full lifecycle + MTTR."""
    __tablename__ = "observability_incidents"

    id = Column(Integer, primary_key=True, index=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    dataset_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="SET NULL"), nullable=True)

    source = Column(String(20), nullable=False)      # freshness|volume|schema|quality|anomaly
    pillar = Column(String(20), nullable=False)      # freshness|volume|schema|quality|distribution
    # Stable de-dup handle so repeated breaches update ONE open incident.
    # e.g. "freshness:monitor_42", "quality:rule_88", "anomaly:metric_12"
    dedup_key = Column(String(120), nullable=False, index=True)

    title = Column(String(500), nullable=False)
    detail = Column(JSONB, nullable=True)
    severity = Column(String(20), nullable=False, default="warning")  # info|warning|critical
    status = Column(String(20), nullable=False, default="open")       # open|acknowledged|resolved

    first_seen_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    acknowledged_at = Column(DateTime, nullable=True)
    resolved_at = Column(DateTime, nullable=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)

    __table_args__ = (
        # Fast "open incident for this detector" upsert lookup.
        Index("ix_observability_incident_dedup_status", "dedup_key", "status"),
    )


# Alert channel kinds
ALERT_CHANNEL_KINDS = ("email", "slack", "webhook")


class ObservabilityAlertChannel(Base):
    """Where to send a notification when a NEW incident opens. A channel with
    dataset_id=None is global (all datasets); otherwise scoped to one dataset.
    min_severity gates which incidents fire (info < warning < critical)."""
    __tablename__ = "observability_alert_channels"

    id = Column(Integer, primary_key=True, index=True)
    kind = Column(String(20), nullable=False)        # email | slack | webhook
    name = Column(String(255), nullable=False)
    target = Column(Text, nullable=False)            # email address | slack webhook URL | webhook URL
    min_severity = Column(String(20), nullable=False, default="warning")
    is_active = Column(Boolean, nullable=False, default=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=True, index=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    last_sent_at = Column(DateTime, nullable=True)
    last_error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=True)
