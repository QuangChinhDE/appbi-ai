"""
Persistence models for saved AI Agent report specs and runs.
"""
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base


class AgentReportSpec(Base):
    __tablename__ = "agent_report_specs"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False, index=True)
    description = Column(Text, nullable=True)
    status = Column(String(30), nullable=False, default="draft")

    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    latest_dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="SET NULL"), nullable=True)

    selected_tables_snapshot = Column(JSONB, nullable=False, default=list)
    brief_json = Column(JSONB, nullable=False, default=dict)
    approved_plan_json = Column(JSONB, nullable=True, default=None)
    current_step = Column(String(30), nullable=False, default="select")

    last_run_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    latest_dashboard = relationship("Dashboard", foreign_keys=[latest_dashboard_id])
    runs = relationship("AgentReportRun", back_populates="report_spec", cascade="all, delete-orphan")


class AgentReportRun(Base):
    __tablename__ = "agent_report_runs"

    id = Column(Integer, primary_key=True, index=True)
    report_spec_id = Column(Integer, ForeignKey("agent_report_specs.id", ondelete="CASCADE"), nullable=False, index=True)

    triggered_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="SET NULL"), nullable=True)
    target_dashboard_id = Column(Integer, ForeignKey("dashboards.id", ondelete="SET NULL"), nullable=True)

    build_mode = Column(String(30), nullable=False, default="new_dashboard")
    status = Column(String(30), nullable=False, default="queued")
    error = Column(Text, nullable=True)

    input_brief_json = Column(JSONB, nullable=False, default=dict)
    plan_json = Column(JSONB, nullable=False, default=dict)
    result_summary_json = Column(JSONB, nullable=True, default=None)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    finished_at = Column(DateTime(timezone=True), nullable=True)

    report_spec = relationship("AgentReportSpec", back_populates="runs")
    dashboard = relationship("Dashboard", foreign_keys=[dashboard_id])
    target_dashboard = relationship("Dashboard", foreign_keys=[target_dashboard_id])
