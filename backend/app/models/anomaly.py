"""
SQLAlchemy models for Phase 4 Proactive Intelligence:
- MonitoredMetric: user-defined metrics to watch for anomalies
- AnomalyAlert: detected anomaly instances
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Integer,
    String, Text, func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.core.database import Base


class MonitoredMetric(Base):
    __tablename__ = "monitored_metrics"

    id = Column(Integer, primary_key=True, index=True)
    dataset_table_id = Column(Integer, ForeignKey("dataset_tables.id", ondelete="CASCADE"), nullable=False)
    metric_column = Column(String(200), nullable=False)
    aggregation = Column(String(20), nullable=False, default="sum")
    time_column = Column(String(200), nullable=True)
    dimension_columns = Column(JSONB, default=list)       # list of column names
    check_frequency = Column(String(20), nullable=False, default="daily")  # daily/hourly/weekly
    threshold_z_score = Column(Float, nullable=False, default=2.0)
    is_active = Column(Boolean, nullable=False, default=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    alerts = relationship("AnomalyAlert", back_populates="metric", cascade="all, delete-orphan")
    dataset_table = relationship("DatasetTable", foreign_keys=[dataset_table_id])
    owner = relationship("User", foreign_keys=[owner_id])


class AnomalyAlert(Base):
    __tablename__ = "anomaly_alerts"

    id = Column(Integer, primary_key=True, index=True)
    monitored_metric_id = Column(Integer, ForeignKey("monitored_metrics.id", ondelete="CASCADE"), nullable=False)
    detected_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    current_value = Column(Float, nullable=False)
    expected_value = Column(Float, nullable=False)
    z_score = Column(Float, nullable=False)
    change_pct = Column(Float, nullable=False)
    dimension_values = Column(JSONB, nullable=True)   # {"region": "EU", ...}
    severity = Column(String(20), nullable=False, default="info")   # info/warning/critical
    is_read = Column(Boolean, nullable=False, default=False)
    explanation = Column(Text, nullable=True)

    # Relationships
    metric = relationship("MonitoredMetric", back_populates="alerts")
