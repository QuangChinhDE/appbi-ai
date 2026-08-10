"""What a public link is allowed to let a flow read. Defined BEFORE it is assigned.

WHY THIS IS A TABLE AND NOT A KEY IN `appearance_config`
--------------------------------------------------------
It used to be one string: `appearance_config.ai_bot_flow_key`. The flow was named,
and the DATA SCOPE was worked out at run time — every chart of the dashboard, every
document the flow's author could read. Nobody ever defined anything.

That inverts the rule this module now follows: the scope is declared when the flow
is assigned, and a flow with no valid declaration does not run. Four things make it
a table rather than a field:

  1. It has a VALIDATION STATE (`active` / `broken` / `needs_review`), which a JSON
     blob inside another object cannot carry.
  2. Every run references it — the Runs view is filtered by link, and "this flow
     works on link A and is broken on link B" is the normal case once one flow
     serves several dashboards.
  3. It is queried in REVERSE: "which links use this flow". That used to mean
     loading every active link and parsing its JSON, once per call.
  4. `pinned_version` needs somewhere to live, and without it publishing a flow is
     all-or-nothing across every link that uses it — so nobody dares edit.
"""
from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from app.core.database import Base


class AgentFlowBinding(Base):
    """One link's contract with one flow."""

    __tablename__ = "agent_flow_bindings"

    id = Column(Integer, primary_key=True, index=True)

    #: ONE link runs ONE flow. Enforced by the unique constraint rather than by
    #: convention, because "which flow answers on this link" must have one answer.
    link_id = Column(
        Integer,
        ForeignKey("dashboard_public_links.id", ondelete="CASCADE"),
        nullable=False,
    )
    #: Denormalised so "which dashboards does this flow serve" is one query. The
    #: link owns the truth; this follows it.
    dashboard_id = Column(Integer, nullable=True, index=True)

    brain_key = Column(String(64), nullable=False, index=True)

    #: NULL means "follow whatever is published". A number pins this link to one
    #: version — which is what lets an author publish a breaking change without
    #: taking down every link that has not been re-mapped yet.
    pinned_version = Column(Integer, nullable=True)

    #: draft | active | broken | needs_review
    #:
    #: `needs_review` exists only for links migrated from the old single-key setup:
    #: they keep running exactly as before, but they cannot receive a NEW flow
    #: version until someone has looked at what they expose. That is how the rule
    #: takes effect immediately without breaking anything already live.
    status = Column(String(16), nullable=False, default="draft", index=True)

    #: The declaration itself: allowed charts, requirement→field resolution,
    #: knowledge subset, capabilities, defaults, budget. Shape validated by
    #: `services/agent_flows/binding.py::DataContract`.
    data_contract = Column(JSONB, nullable=False, default=dict)

    #: Errors and warnings from the last preflight, kept so the UI can explain a
    #: `broken` binding without re-running the check on every page load.
    last_validation = Column(JSONB, nullable=True)
    validated_at = Column(DateTime(timezone=True), nullable=True)

    #: Whether the viewer's questions may be stored with their text. Per link,
    #: because one deployment can have a public marketing dashboard and an internal
    #: revenue one behind the same product.
    store_question_content = Column(Boolean, nullable=False, default=True)

    note = Column(Text, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("link_id", name="uq_agent_flow_binding_link"),
        Index("ix_agent_flow_binding_flow", "brain_key", "status"),
    )
