"""Registry + run tables for the AI Intelligence runtime.

Flows and agents are DATA here, not code. That is the whole point: the future
Flow Studio only adds a UI over these rows, and a customer changing how the
assistant analyses their business is a row update, not a deployment.

No `tenant_id`: AppBI is single-tenant and the real isolation unit is the
dashboard plus the shared-link token, so those are the scope columns.

Table naming follows the existing `ai_*` prefix (ai_bot_knowledge,
ai_chat_sessions, ai_chat_turn_logs, ai_evidence).
"""
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.core.database import Base


class AiAgentVersion(Base):
    """One specialist: prompt + I/O schema + tool allowlist + model policy.

    Versioned and immutable once published, so a rollback is "point at the
    previous version", never "restore a prompt from git".
    """

    __tablename__ = "ai_agent_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    agent_key = Column(String(64), nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)
    status = Column(String(16), nullable=False, default="draft")  # draft|published|archived
    display_name = Column(String(160), nullable=False)

    # Policy, not a model id: the AI Gateway maps policy × provider → model, so
    # a retired vendor model is a config row change, not a deploy.
    model_policy = Column(String(32), nullable=False, default="deep_reason")
    prompt_template = Column(Text, nullable=False, default="")
    input_schema = Column(JSON, nullable=False, default=dict)
    output_schema = Column(JSON, nullable=False, default=dict)
    tool_allowlist = Column(JSON, nullable=False, default=list)
    # Which state fields this agent may patch. Enforced at runtime.
    writable_state_fields = Column(JSON, nullable=False, default=list)
    runtime_config = Column(JSON, nullable=False, default=dict)

    # Seeded by the system; cannot be deleted, only superseded.
    is_builtin = Column(Boolean, nullable=False, default=False)
    created_by = Column(String(128), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (UniqueConstraint("agent_key", "version", name="uq_ai_agent_version"),)

    @property
    def ref(self) -> str:
        return f"{self.agent_key}@{self.version}"


class AiFlowVersion(Base):
    """One analysis procedure: the node graph plus its budget."""

    __tablename__ = "ai_flow_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    flow_key = Column(String(64), nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)
    # draft | ready | in_review | published | archived
    status = Column(String(16), nullable=False, default="draft")
    display_name = Column(String(160), nullable=False)

    description = Column(Text, nullable=True)
    owner = Column(String(128), nullable=True)
    tags = Column(JSON, nullable=False, default=list)

    graph = Column(JSON, nullable=False, default=dict)
    limits = Column(JSON, nullable=False, default=dict)
    requires_tools = Column(Boolean, nullable=False, default=True)

    # Release gate bookkeeping (GĐ6): a flow may not be published unless its
    # eval pass rate is at least that of the version it replaces.
    eval_suite = Column(String(64), nullable=True)
    eval_pass_rate = Column(Float, nullable=True)
    eval_ran_at = Column(DateTime(timezone=True), nullable=True)

    is_builtin = Column(Boolean, nullable=False, default=False)
    created_by = Column(String(128), nullable=True)
    published_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (UniqueConstraint("flow_key", "version", name="uq_ai_flow_version"),)


class AiAssistant(Base):
    """One chatbot: which flow handles which intent, on whose budget."""

    __tablename__ = "ai_assistants"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(64), nullable=False, unique=True, index=True)
    display_name = Column(String(160), nullable=False)
    status = Column(String(16), nullable=False, default="draft")

    # [{"when_intent": ["lookup"], "flow": "builtin_lookup_v1"}, ...]
    # The last entry SHOULD match "*" so every question resolves to something.
    routing = Column(JSON, nullable=False, default=list)
    credential_ref = Column(String(64), nullable=True)
    budget = Column(JSON, nullable=False, default=dict)
    knowledge_scope = Column(JSON, nullable=False, default=dict)
    locale = Column(String(8), nullable=False, default="vi-VN")
    eval_suite = Column(String(64), nullable=True)

    created_by = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AiAssistantBinding(Base):
    """Where an assistant is actually served.

    Resolution order is public_link → dashboard → global, so a specific report
    can override the house default without touching anyone else.
    """

    __tablename__ = "ai_assistant_bindings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    assistant_id = Column(Integer, nullable=False, index=True)
    surface = Column(String(16), nullable=False)      # public_link | dashboard | global
    surface_ref = Column(String(128), nullable=True)  # token | dashboard_id | NULL
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("surface", "surface_ref", name="uq_ai_binding_surface"),
    )


class AiModelPolicy(Base):
    """policy × provider → model.

    In the DB rather than in code because vendors retire models without notice
    (claude-3-5-haiku-20241022 started 404-ing mid-life and needed a code patch).
    An admin fixes that with an UPDATE.
    """

    __tablename__ = "ai_model_policies"

    id = Column(Integer, primary_key=True, autoincrement=True)
    policy = Column(String(32), nullable=False, index=True)
    provider = Column(String(16), nullable=False)
    model = Column(String(120), nullable=False)
    supports_tools = Column(Boolean, nullable=False, default=True)
    priority = Column(Integer, nullable=False, default=1)
    enabled = Column(Boolean, nullable=False, default=True)

    __table_args__ = (
        UniqueConstraint("policy", "provider", "priority", name="uq_ai_model_policy"),
    )


class AiRun(Base):
    """One executed turn."""

    __tablename__ = "ai_runs"

    id = Column(String(64), primary_key=True)  # hex uuid, also the evidence run_ref
    assistant_key = Column(String(64), nullable=True)
    flow_key = Column(String(64), nullable=False, index=True)
    flow_version = Column(Integer, nullable=False, default=1)
    mode = Column(String(16), nullable=True)   # live | preview | shadow

    dashboard_id = Column(Integer, nullable=False, index=True)
    link_token = Column(String(200), nullable=True)
    session_key = Column(String(64), nullable=True)
    turn_index = Column(Integer, nullable=False, default=0)
    actor_type = Column(String(16), nullable=False, default="public_session")
    actor_ref = Column(String(128), nullable=True)

    question = Column(Text, nullable=True)
    intent = Column(String(32), nullable=True)
    status = Column(String(16), nullable=False, default="running")
    current_node = Column(String(64), nullable=True)

    model_calls = Column(Integer, nullable=False, default=0)
    tool_calls = Column(Integer, nullable=False, default=0)
    prompt_tokens = Column(Integer, nullable=False, default=0)
    completion_tokens = Column(Integer, nullable=False, default=0)
    usd = Column(Numeric(12, 6), nullable=False, default=0)
    verification_coverage = Column(Float, nullable=True)

    started_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)
    latency_ms = Column(Integer, nullable=True)
    error_code = Column(String(64), nullable=True)

    __table_args__ = (
        Index("ix_ai_runs_dash_started", "dashboard_id", "started_at"),
        Index("ix_ai_runs_flow_started", "flow_key", "started_at"),
    )


class AiNodeRun(Base):
    """One node execution inside a run — the rows the trace tree is built from."""

    __tablename__ = "ai_node_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    run_id = Column(String(64), nullable=False, index=True)
    seq = Column(Integer, nullable=False, default=0)
    node_key = Column(String(64), nullable=False)
    node_type = Column(String(16), nullable=False)
    agent_key = Column(String(64), nullable=True)
    agent_version = Column(Integer, nullable=True)
    status = Column(String(16), nullable=False, default="ok")

    provider = Column(String(16), nullable=True)
    # The model ACTUALLY used, never the policy name — otherwise a cost or
    # quality regression cannot be attributed after a policy row changes.
    model = Column(String(120), nullable=True)
    prompt_tokens = Column(Integer, nullable=True)
    completion_tokens = Column(Integer, nullable=True)
    usd = Column(Numeric(12, 6), nullable=True)
    latency_ms = Column(Integer, nullable=True)
    error = Column(JSON, nullable=True)

    started_at = Column(DateTime(timezone=True), nullable=True)
    completed_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (Index("ix_ai_node_runs_run_seq", "run_id", "seq"),)
