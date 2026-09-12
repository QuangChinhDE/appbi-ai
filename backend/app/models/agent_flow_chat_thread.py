"""One conversation between one signed-in user and one flow, with no report.

WHY NOT `AgentFlowBinding`
-------------------------
A binding means "this public link runs this flow": it carries `link_id` (a NOT NULL
FK to `dashboard_public_links`), `dashboard_id` and the link's `appearance_config`.
A direct chat has none of those. Reusing the table would mean nulling out most of
its load-bearing columns and adding a `if link_id is None` branch to every reader —
publish checks, drift checks, the bindings list. A sibling table costs one migration
and leaves those readers alone.

WHAT IS DELIBERATELY *NOT* HERE
-------------------------------
  pinned_version   A thread always runs the flow's current `published` version. The
                   version that actually ran a turn is recorded per-run on
                   `agent_flow_runs.version`, which is the honest place for it — a
                   column here would claim a thread has one version when it may
                   have spanned three.
  the transcript   Lives in `agent_flow_run_content`, written by the runtime. Never
                   in `ai_chat_sessions.messages`, which a public endpoint assigns
                   straight from a request body.
  the knowledge scope  Re-derived every turn from the user's CURRENT rights. A
                   stored copy would keep answering from a document after the grant
                   behind it was revoked.
"""
from __future__ import annotations

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base


class AgentFlowChatThread(Base):
    """A direct-chat conversation. Metadata only."""

    __tablename__ = "agent_flow_chat_threads"

    id = Column(Integer, primary_key=True, index=True)

    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: The flow, by its stable key — never a version row id, for the same reason a
    #: public link stores `brain_key`: publishing decides which version that means.
    brain_key = Column(String(64), nullable=False, index=True)

    title = Column(String(255), nullable=True)

    #: Owner of this thread's row in `ai_chat_sessions`, which holds the runtime
    #: memory. Generated once at creation and never regenerated: `load_memory`
    #: drops memory whose stored token differs from the caller's, so a key that
    #: changed per request would silently lose the conversation's memory every turn.
    session_key = Column(String(64), nullable=False, unique=True, index=True)

    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_active_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    #: Soft delete, and the ONLY lifecycle state. There is no separate `archived_at`:
    #: two columns for one user-facing action is how an Archive button and a Delete
    #: button end up writing the same field and meaning different things to different
    #: screens. Runs keep pointing here after deletion so cost history survives a
    #: user tidying their chat list.
    deleted_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_agent_flow_chat_threads_user_active", "user_id", "last_active_at"),
    )
