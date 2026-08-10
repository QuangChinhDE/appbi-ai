"""Agent Flow v2: bindings, run history, and a server-owned session store

Three things, one migration, because a flow cannot run without all three.

BINDINGS. A public link used to name a flow in a single string
(`appearance_config.ai_bot_flow_key`) and the data scope was worked out at run
time: every chart on the dashboard, every document the flow's author could read.
Nobody declared anything. `agent_flow_bindings` is that declaration — allowed
charts, requirement→field resolution, knowledge subset, capabilities, budget —
made BEFORE the flow is assigned, with a validation state of its own and a
`pinned_version` so publishing a change cannot silently break every link at once.

Existing links are migrated to a binding that reproduces TODAY'S behaviour exactly
(`charts.mode = "all_current"`) and marked `needs_review`. Nothing changes on
deploy day; what changes is that they cannot receive a new flow version until
someone has looked at what they expose.

RUNS. Split three ways by lifetime: metrics kept, content pruned on a retention
window, per-node trace pruned hardest. See `app/models/agent_flow_run.py`.

FLOW_STATE. Conversation memory for a flow has to live somewhere the viewer cannot
write. `ai_chat_sessions.conv_state` is assigned straight from the request body on
a public unauthenticated endpoint, so a variable stored there could be set by the
person asking the question — and then read into prompts, branch conditions and tool
arguments. This column is written only by the runtime.

Revision ID: 20260810_0052
Revises: 20260809_0051
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260810_0052"
down_revision = "20260809_0051"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The Activity tab reuses `audit_logs` rather than growing a fourth table: it
    # already records who did what to which resource, with a JSONB detail blob. The
    # only thing in the way was the action enum, so these are added to it. Safe in
    # one transaction because nothing below writes a row USING them.
    for value in (
        "agent_flow_saved",
        "agent_flow_published",
        "agent_flow_rolled_back",
        "agent_flow_restored",
        "agent_flow_deleted",
        "agent_flow_assigned",
        "agent_flow_unassigned",
    ):
        op.execute(f"ALTER TYPE auditaction ADD VALUE IF NOT EXISTS '{value}'")

    op.create_table(
        "agent_flow_bindings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "link_id",
            sa.Integer(),
            sa.ForeignKey("dashboard_public_links.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("dashboard_id", sa.Integer(), nullable=True),
        sa.Column("brain_key", sa.String(64), nullable=False),
        sa.Column("pinned_version", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column(
            "data_contract",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("last_validation", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("validated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "store_question_content", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("link_id", name="uq_agent_flow_binding_link"),
    )
    op.create_index("ix_agent_flow_bindings_brain_key", "agent_flow_bindings", ["brain_key"])
    op.create_index("ix_agent_flow_bindings_status", "agent_flow_bindings", ["status"])
    op.create_index("ix_agent_flow_bindings_dashboard", "agent_flow_bindings", ["dashboard_id"])
    op.create_index("ix_agent_flow_binding_flow", "agent_flow_bindings", ["brain_key", "status"])

    op.create_table(
        "agent_flow_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("run_key", sa.String(64), nullable=False),
        sa.Column("brain_key", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("binding_id", sa.Integer(), nullable=True),
        sa.Column("link_token", sa.String(64), nullable=True),
        sa.Column("dashboard_id", sa.Integer(), nullable=True),
        sa.Column("session_key", sa.String(64), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="ok"),
        sa.Column("execution_path", sa.String(255), nullable=True),
        sa.Column("trigger", sa.String(20), nullable=True),
        sa.Column("is_test", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("llm_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tool_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("usd", sa.Float(), nullable=True),
        sa.Column("blocked_reason", sa.String(64), nullable=True),
        sa.Column("missing_requirements", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("question_norm", sa.Text(), nullable=True),
        sa.Column("rating", sa.String(8), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("run_key", name="uq_agent_flow_run_key"),
    )
    for col in ("brain_key", "binding_id", "link_token", "dashboard_id", "session_key",
                "status", "is_test", "created_at"):
        op.create_index(f"ix_agent_flow_runs_{col}", "agent_flow_runs", [col])
    op.create_index("ix_agent_flow_runs_flow_time", "agent_flow_runs", ["brain_key", "created_at"])
    op.create_index(
        "ix_agent_flow_runs_binding_time", "agent_flow_runs", ["binding_id", "created_at"]
    )

    op.create_table(
        "agent_flow_run_content",
        sa.Column(
            "run_id",
            sa.Integer(),
            sa.ForeignKey("agent_flow_runs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("question", sa.Text(), nullable=True),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("citations", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("notices", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("input_envelope", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("output_envelope", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index(
        "ix_agent_flow_run_content_created_at", "agent_flow_run_content", ["created_at"]
    )

    op.create_table(
        "agent_flow_run_steps",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Integer(),
            sa.ForeignKey("agent_flow_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seq", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("node_key", sa.String(64), nullable=False),
        sa.Column("node_type", sa.String(32), nullable=True),
        sa.Column("node_name", sa.String(255), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="ok"),
        sa.Column("branch", sa.String(120), nullable=True),
        sa.Column("iteration", sa.Integer(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("tool_calls", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("output_preview", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_agent_flow_run_steps_run", "agent_flow_run_steps", ["run_id", "seq"])
    op.create_index(
        "ix_agent_flow_run_steps_created_at", "agent_flow_run_steps", ["created_at"]
    )

    # Server-owned conversation memory. Deliberately NOT `conv_state`, which is
    # assigned from the request body on a public endpoint.
    op.add_column(
        "ai_chat_sessions",
        sa.Column("flow_state", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )

    # ── Migrate live links, WITHOUT changing what they do today ───────────────
    #
    # `charts.mode = "all_current"` reproduces the old behaviour exactly (every
    # chart on the dashboard). `needs_review` is what makes the new rule bite: these
    # bindings keep answering, but they cannot be handed a new flow version until
    # someone has declared what they expose.
    op.execute(
        """
        INSERT INTO agent_flow_bindings
            (link_id, dashboard_id, brain_key, status, data_contract,
             store_question_content, created_by, created_at, updated_at)
        SELECT
            l.id,
            l.dashboard_id,
            trim(l.appearance_config->>'ai_bot_flow_key'),
            'needs_review',
            jsonb_build_object(
                'charts', jsonb_build_object('mode', 'all_current', 'ids', '[]'::jsonb),
                'resolve', '{}'::jsonb,
                'knowledge', jsonb_build_object('mode', 'flow_all'),
                'capabilities', jsonb_build_object(
                    'web_search',
                    COALESCE((l.appearance_config->>'ai_bot_web_search_enabled')::boolean, false),
                    'read_rows', true,
                    'max_rows_per_call', 5000),
                'defaults', '{}'::jsonb,
                'budget', jsonb_build_object(
                    'max_llm_calls', 12, 'max_tool_calls', 40, 'max_seconds', 45)
            ),
            true,
            'migration:20260810_0052',
            now(), now()
        FROM dashboard_public_links l
        WHERE l.is_active IS TRUE
          AND COALESCE(trim(l.appearance_config->>'ai_bot_flow_key'), '') <> ''
        ON CONFLICT (link_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_column("ai_chat_sessions", "flow_state")
    op.drop_table("agent_flow_run_steps")
    op.drop_table("agent_flow_run_content")
    op.drop_table("agent_flow_runs")
    op.drop_table("agent_flow_bindings")
