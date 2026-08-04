"""P2-02: Intelligence registry + run tables, with built-in flow seeded

Flows and agents become DATA. The seeded `builtin_thinking_v1` wraps the
existing pre-v2 agent in a single `legacy` node, so turning the runtime on
changes the plumbing without changing a single answer — and turning it off
again is one feature flag.

No tenant_id: AppBI is single-tenant, and the isolation unit is dashboard +
shared-link token.

Revision ID: 20260805_0034
Revises: 20260804_0033
"""
import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260805_0034"
down_revision = "20260804_0033"
branch_labels = None
depends_on = None


TABLES = (
    "ai_agent_versions",
    "ai_flow_versions",
    "ai_assistants",
    "ai_assistant_bindings",
    "ai_model_policies",
    "ai_runs",
    "ai_node_runs",
)

# policy × provider → model. In the DB because vendors retire models without
# notice (claude-3-5-haiku-20241022 began 404-ing mid-life and needed a code
# patch); an admin should fix that with an UPDATE, not a deploy.
MODEL_POLICIES = [
    ("fast_classify",    "anthropic", "claude-haiku-4-5",  True,  1),
    ("fast_classify",    "openai",    "gpt-4o-mini",       True,  1),
    ("fast_classify",    "gemini",    "gemini-2.5-flash",  False, 1),
    ("structured_plan",  "anthropic", "claude-haiku-4-5",  True,  1),
    ("structured_plan",  "openai",    "gpt-4o-mini",       True,  1),
    ("structured_plan",  "gemini",    "gemini-2.5-flash",  False, 1),
    ("deep_reason",      "anthropic", "claude-sonnet-4-5", True,  1),
    ("deep_reason",      "openai",    "gpt-4o",            True,  1),
    ("deep_reason",      "gemini",    "gemini-2.5-pro",    False, 1),
    ("compose",          "anthropic", "claude-haiku-4-5",  True,  1),
    ("compose",          "openai",    "gpt-4o-mini",       True,  1),
    ("compose",          "gemini",    "gemini-2.5-flash",  False, 1),
    ("critic",           "anthropic", "claude-haiku-4-5",  True,  1),
    ("critic",           "openai",    "gpt-4o-mini",       True,  1),
    ("critic",           "gemini",    "gemini-2.5-flash",  False, 1),
]

# The migration bridge. guard → route → legacy → verify → end.
# `verify` runs in whatever mode INTELLIGENCE_VERIFIER_MODE says; with the
# default "off" it is a no-op, so this graph is behaviour-identical to today.
BUILTIN_THINKING_GRAPH = {
    "entrypoint": "guard",
    "requires_tools": True,
    "nodes": {
        "guard": {
            "type": "guard",
            "next": "route",
            "routes": {"blocked": "end"},
        },
        "route": {
            "type": "route",
            "next": "legacy",
            "routes": {"normal": "legacy", "thinking": "legacy", "*": "legacy"},
        },
        "legacy": {
            "type": "legacy",
            "next": "verify",
            "config": {
                "mode": "auto",
                "writable_state_fields": [
                    "answer", "usd", "tool_calls", "model_calls",
                ],
            },
        },
        "verify": {
            "type": "function",
            "handler": "verify_claims",
            "on_success": "end",
            "on_failure": "end",
            "config": {"writable_state_fields": ["verification"]},
        },
        "end": {"type": "end"},
    },
    "limits": {
        "max_model_calls": 12,
        "max_tool_calls": 20,
        "deadline_seconds": 240,
        "max_usd": 1.0,
        "max_loops_per_node": 1,
    },
}


def _has_table(name: str) -> bool:
    try:
        return name in inspect(op.get_bind()).get_table_names()
    except Exception:
        return False


def upgrade() -> None:
    if not _has_table("ai_agent_versions"):
        op.create_table(
            "ai_agent_versions",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("agent_key", sa.String(length=64), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("status", sa.String(length=16), nullable=False, server_default="draft"),
            sa.Column("display_name", sa.String(length=160), nullable=False),
            sa.Column("model_policy", sa.String(length=32), nullable=False, server_default="deep_reason"),
            sa.Column("prompt_template", sa.Text(), nullable=False, server_default=""),
            sa.Column("input_schema", sa.JSON(), nullable=False),
            sa.Column("output_schema", sa.JSON(), nullable=False),
            sa.Column("tool_allowlist", sa.JSON(), nullable=False),
            sa.Column("writable_state_fields", sa.JSON(), nullable=False),
            sa.Column("runtime_config", sa.JSON(), nullable=False),
            sa.Column("is_builtin", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_by", sa.String(length=128), nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("agent_key", "version", name="uq_ai_agent_version"),
        )
        op.create_index("ix_ai_agent_versions_agent_key", "ai_agent_versions", ["agent_key"])

    if not _has_table("ai_flow_versions"):
        op.create_table(
            "ai_flow_versions",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("flow_key", sa.String(length=64), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("status", sa.String(length=16), nullable=False, server_default="draft"),
            sa.Column("display_name", sa.String(length=160), nullable=False),
            sa.Column("graph", sa.JSON(), nullable=False),
            sa.Column("limits", sa.JSON(), nullable=False),
            sa.Column("requires_tools", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("eval_suite", sa.String(length=64), nullable=True),
            sa.Column("eval_pass_rate", sa.Float(), nullable=True),
            sa.Column("eval_ran_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("is_builtin", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_by", sa.String(length=128), nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("flow_key", "version", name="uq_ai_flow_version"),
        )
        op.create_index("ix_ai_flow_versions_flow_key", "ai_flow_versions", ["flow_key"])

    if not _has_table("ai_assistants"):
        op.create_table(
            "ai_assistants",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("key", sa.String(length=64), nullable=False, unique=True),
            sa.Column("display_name", sa.String(length=160), nullable=False),
            sa.Column("status", sa.String(length=16), nullable=False, server_default="draft"),
            sa.Column("routing", sa.JSON(), nullable=False),
            sa.Column("credential_ref", sa.String(length=64), nullable=True),
            sa.Column("budget", sa.JSON(), nullable=False),
            sa.Column("knowledge_scope", sa.JSON(), nullable=False),
            sa.Column("locale", sa.String(length=8), nullable=False, server_default="vi-VN"),
            sa.Column("eval_suite", sa.String(length=64), nullable=True),
            sa.Column("created_by", sa.String(length=128), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
        op.create_index("ix_ai_assistants_key", "ai_assistants", ["key"])

    if not _has_table("ai_assistant_bindings"):
        op.create_table(
            "ai_assistant_bindings",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("assistant_id", sa.Integer(), nullable=False),
            sa.Column("surface", sa.String(length=16), nullable=False),
            sa.Column("surface_ref", sa.String(length=128), nullable=True),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("surface", "surface_ref", name="uq_ai_binding_surface"),
        )
        op.create_index("ix_ai_assistant_bindings_assistant_id", "ai_assistant_bindings", ["assistant_id"])

    if not _has_table("ai_model_policies"):
        op.create_table(
            "ai_model_policies",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("policy", sa.String(length=32), nullable=False),
            sa.Column("provider", sa.String(length=16), nullable=False),
            sa.Column("model", sa.String(length=120), nullable=False),
            sa.Column("supports_tools", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("priority", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.UniqueConstraint("policy", "provider", "priority", name="uq_ai_model_policy"),
        )
        op.create_index("ix_ai_model_policies_policy", "ai_model_policies", ["policy"])

    if not _has_table("ai_runs"):
        op.create_table(
            "ai_runs",
            sa.Column("id", sa.String(length=64), primary_key=True),
            sa.Column("assistant_key", sa.String(length=64), nullable=True),
            sa.Column("flow_key", sa.String(length=64), nullable=False),
            sa.Column("flow_version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("mode", sa.String(length=16), nullable=True),
            sa.Column("dashboard_id", sa.Integer(), nullable=False),
            sa.Column("link_token", sa.String(length=200), nullable=True),
            sa.Column("session_key", sa.String(length=64), nullable=True),
            sa.Column("turn_index", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("actor_type", sa.String(length=16), nullable=False, server_default="public_session"),
            sa.Column("actor_ref", sa.String(length=128), nullable=True),
            sa.Column("question", sa.Text(), nullable=True),
            sa.Column("intent", sa.String(length=32), nullable=True),
            sa.Column("status", sa.String(length=16), nullable=False, server_default="running"),
            sa.Column("current_node", sa.String(length=64), nullable=True),
            sa.Column("model_calls", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("tool_calls", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("prompt_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("completion_tokens", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
            sa.Column("verification_coverage", sa.Float(), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("latency_ms", sa.Integer(), nullable=True),
            sa.Column("error_code", sa.String(length=64), nullable=True),
        )
        op.create_index("ix_ai_runs_dash_started", "ai_runs", ["dashboard_id", "started_at"])
        op.create_index("ix_ai_runs_flow_started", "ai_runs", ["flow_key", "started_at"])

    if not _has_table("ai_node_runs"):
        op.create_table(
            "ai_node_runs",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("run_id", sa.String(length=64), nullable=False),
            sa.Column("seq", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("node_key", sa.String(length=64), nullable=False),
            sa.Column("node_type", sa.String(length=16), nullable=False),
            sa.Column("agent_key", sa.String(length=64), nullable=True),
            sa.Column("agent_version", sa.Integer(), nullable=True),
            sa.Column("status", sa.String(length=16), nullable=False, server_default="ok"),
            sa.Column("provider", sa.String(length=16), nullable=True),
            sa.Column("model", sa.String(length=120), nullable=True),
            sa.Column("prompt_tokens", sa.Integer(), nullable=True),
            sa.Column("completion_tokens", sa.Integer(), nullable=True),
            sa.Column("usd", sa.Numeric(12, 6), nullable=True),
            sa.Column("latency_ms", sa.Integer(), nullable=True),
            sa.Column("error", sa.JSON(), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_ai_node_runs_run_seq", "ai_node_runs", ["run_id", "seq"])
        op.create_index("ix_ai_node_runs_run_id", "ai_node_runs", ["run_id"])

    _seed(op.get_bind())


def _seed(bind) -> None:
    existing = bind.execute(
        sa.text("SELECT count(*) FROM ai_model_policies")
    ).scalar()
    if not existing:
        for policy, provider, model, tools, priority in MODEL_POLICIES:
            bind.execute(
                sa.text(
                    "INSERT INTO ai_model_policies "
                    "(policy, provider, model, supports_tools, priority, enabled) "
                    "VALUES (:p, :pr, :m, :t, :i, TRUE)"
                ),
                {"p": policy, "pr": provider, "m": model, "t": tools, "i": priority},
            )

    has_flow = bind.execute(
        sa.text("SELECT count(*) FROM ai_flow_versions WHERE flow_key = 'builtin_thinking_v1'")
    ).scalar()
    if not has_flow:
        bind.execute(
            sa.text(
                "INSERT INTO ai_flow_versions "
                "(flow_key, version, status, display_name, graph, limits, "
                " requires_tools, is_builtin, created_by, published_at, created_at) "
                "VALUES ('builtin_thinking_v1', 1, 'published', "
                "'Luồng mặc định (bọc trợ lý hiện tại)', CAST(:graph AS JSON), "
                "CAST(:limits AS JSON), TRUE, TRUE, 'system', NOW(), NOW())"
            ),
            {
                "graph": json.dumps(BUILTIN_THINKING_GRAPH, ensure_ascii=False),
                "limits": json.dumps(BUILTIN_THINKING_GRAPH["limits"]),
            },
        )


def downgrade() -> None:
    for name in reversed(TABLES):
        if _has_table(name):
            op.drop_table(name)
