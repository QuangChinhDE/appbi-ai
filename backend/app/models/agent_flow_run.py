"""Run history, split into three tables because the three parts have three lifetimes.

WHY NOT ONE TABLE
-----------------
  runs      metrics: status, latency, tokens, path, version, link. Small rows, and
            the only thing that answers "is v6 better than v5" — so KEPT.
  content   the viewer's question, the answer, the envelopes. What makes analysis
            possible, and also the only personal data here. PRUNED (default 180d).
  steps     the per-node trace. By far the largest — a loop of four over an agent is
            a dozen rows for one question — and the least valuable after the week
            somebody debugs it. PRUNED HARDEST (default 30d).

At the mockup's own figure of 312 runs a day, one flow writes ~114k runs and over a
million step rows a year. Deciding the retention now is cheaper than discovering it
from a full disk later.

WHY NOT REUSE `ai_chat_turn_logs`
---------------------------------
It is keyed by link token and knows nothing about flows: no brain_key, no version,
no execution path, no per-node trace. It answers "what did this link cost"; this
answers "what did this flow do, and did the new version do it better". Two questions,
two tables, and merging them would make neither answerable.
"""
from __future__ import annotations

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB

from app.core.database import Base


class AgentFlowRun(Base):
    """One turn of one flow. Metrics only — kept indefinitely."""

    __tablename__ = "agent_flow_runs"

    id = Column(Integer, primary_key=True, index=True)
    #: `FlowInput.request.id`. The same id the envelope carries, so a trace in a log
    #: and a row here are provably the same run.
    run_key = Column(String(64), nullable=False, unique=True, index=True)

    brain_key = Column(String(64), nullable=False, index=True)
    version = Column(Integer, nullable=True)
    binding_id = Column(Integer, nullable=True, index=True)
    link_token = Column(String(64), nullable=True, index=True)
    dashboard_id = Column(Integer, nullable=True, index=True)
    session_key = Column(String(64), nullable=True, index=True)
    #: Set instead of `binding_id` when the turn came from direct chat. Exactly one
    #: of the two is ever non-NULL, which is what keeps every existing cost and
    #: latency report working unchanged across both surfaces.
    chat_thread_id = Column(
        Integer,
        ForeignKey("agent_flow_chat_threads.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    #: ok | partial | blocked | failed | throttled
    status = Column(String(16), nullable=False, default="ok", index=True)
    #: "Path A · Loop×4 · MEDIUM" — what the Runs table shows at a glance, and what
    #: makes "which branch never runs" answerable without reading every trace.
    execution_path = Column(String(255), nullable=True)
    trigger = Column(String(20), nullable=True)

    #: The author's own trial. Excluded from every statistic — without this the
    #: first week of a flow's numbers is mostly its author testing it.
    is_test = Column(Boolean, nullable=False, default=False, index=True)

    latency_ms = Column(Integer, nullable=True)
    llm_calls = Column(Integer, nullable=False, default=0)
    tool_calls = Column(Integer, nullable=False, default=0)
    prompt_tokens = Column(Integer, nullable=False, default=0)
    completion_tokens = Column(Integer, nullable=False, default=0)
    usd = Column(Float, nullable=True)

    #: Why a run never started. This is the most useful column for fixing a binding,
    #: so it is a first-class field rather than something buried in a notice blob.
    blocked_reason = Column(String(64), nullable=True)
    missing_requirements = Column(JSONB, nullable=True)

    #: Normalised question, kept AFTER the content row is pruned so long-range
    #: grouping ("what do people actually ask") survives retention.
    question_norm = Column(Text, nullable=True)
    #: up | down, from the viewer's thumbs. It rates text the SERVER produced, so
    #: unlike anything else a public client posts, it cannot smuggle in a claim.
    rating = Column(String(8), nullable=True)

    #: SET WHEN THIS RUN IS A SKILL INVOKED BY ANOTHER RUN. The parent's `run_key`
    #: (known when the parent turn starts, so a child records itself mid-turn),
    #: the parent node that invoked it, and how: agent_capability | skill_node |
    #: coordinator_lane. NULL = a top-level run.
    parent_run_key = Column(String(64), nullable=True, index=True)
    parent_step_key = Column(String(64), nullable=True)
    invoked_as = Column(String(24), nullable=True)

    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    __table_args__ = (
        Index("ix_agent_flow_runs_flow_time", "brain_key", "created_at"),
        Index("ix_agent_flow_runs_binding_time", "binding_id", "created_at"),
        #: Loading a thread's transcript is "this thread's runs, oldest first", and
        #: the per-user daily quota is "this user's threads' runs since midnight".
        #: Both are this index.
        Index("ix_agent_flow_runs_thread_time", "chat_thread_id", "created_at"),
    )


class AgentFlowRunContent(Base):
    """Question, answer and both envelopes. Pruned on a retention window."""

    __tablename__ = "agent_flow_run_content"

    run_id = Column(
        Integer,
        ForeignKey("agent_flow_runs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    question = Column(Text, nullable=True)
    answer = Column(Text, nullable=True)
    citations = Column(JSONB, nullable=True)
    notices = Column(JSONB, nullable=True)

    #: THE REPLAY PAIR. Storing the input envelope is what lets a stored run be
    #: re-executed against a later version of the flow — comparing v5 and v6 on the
    #: real questions real viewers asked, rather than on a test script.
    input_envelope = Column(JSONB, nullable=True)
    output_envelope = Column(JSONB, nullable=True)

    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )


class AgentFlowRunStep(Base):
    """One node's turn inside one run. The debug trail; pruned hardest."""

    __tablename__ = "agent_flow_run_steps"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(
        Integer, ForeignKey("agent_flow_runs.id", ondelete="CASCADE"), nullable=False
    )
    seq = Column(Integer, nullable=False, default=0)

    node_key = Column(String(64), nullable=False)
    node_type = Column(String(32), nullable=True)
    node_name = Column(String(255), nullable=True)
    #: ok | error | skipped | reused | blocked. `reused` is distinct from `ok` on
    #: purpose: a table that reports a skipped node as having run misstates the cost
    #: of the turn.
    status = Column(String(16), nullable=False, default="ok")

    branch = Column(String(120), nullable=True)
    iteration = Column(Integer, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    tool_calls = Column(JSONB, nullable=True)
    #: What this step was HANDED. Recorded alongside what it produced, because a
    #: node that answered badly and a node that was given nothing to answer from
    #: look identical when only the output is kept.
    input_preview = Column(Text, nullable=True)
    output_preview = Column(Text, nullable=True)
    #: What this step COST. The turn's total says a flow is expensive without
    #: saying which step made it so, and the answer is usually one node carrying a
    #: context it did not need. NULL means "written before this was recorded" —
    #: distinct from 0, which would claim the step was free.
    prompt_tokens = Column(Integer, nullable=True)
    completion_tokens = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)
    #: An Agent step's capability view: granted, eligible (and why not), shown per
    #: round, discovered, invoked, rejected. NULL for every other node type.
    capability_trace = Column(JSONB, nullable=True)
    #: Where the budget went: calls spent, what was available at the start, what
    #: the step was made to leave for later steps. NULL on rows before ledgers.
    budget = Column(JSONB, nullable=True)

    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    __table_args__ = (Index("ix_agent_flow_run_steps_run", "run_id", "seq"),)
