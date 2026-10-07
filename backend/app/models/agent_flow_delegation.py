"""Explicit delegation of a flow owner's data authority (decision Q2).

A run of an Agent Flow uses the CALLER's live authority intersected with what
the flow attached. When the owner wants someone to get answers from data that
person cannot read themselves, the owner records it here: one row per grantee
(user or team), per resource, per action. Revocable (revoked_at), audited, and
consulted on every turn. Nothing else - owning, sharing or publishing a flow -
implies it.
"""
from __future__ import annotations

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base


class AgentFlowDelegation(Base):
    __tablename__ = "agent_flow_delegations"

    id = Column(Integer, primary_key=True, index=True)
    brain_key = Column(String(64), nullable=False, index=True)
    grantee_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    grantee_team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=True)
    #: "dataset" | "document"
    resource_type = Column(String(16), nullable=False)
    resource_id = Column(Integer, nullable=False)
    #: "read" (the only action a run needs on a delegated resource)
    action = Column(String(16), nullable=False, default="read")
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    revoked_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    __table_args__ = (
        CheckConstraint("(grantee_user_id IS NULL) <> (grantee_team_id IS NULL)",
                        name="ck_agent_flow_delegation_one_grantee"),
        CheckConstraint("resource_type IN ('dataset', 'document')", name="ck_agent_flow_delegation_type"),
        CheckConstraint("action IN ('read')", name="ck_agent_flow_delegation_action"),
        Index("ix_agent_flow_delegation_lookup", "brain_key", "revoked_at"),
    )
