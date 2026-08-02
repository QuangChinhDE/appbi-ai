"""P6: seed the Flow Studio — starter agents + a clonable flow template

An empty Studio is a dead end: the first thing an author needs is something that
already works, to clone and reword. This seeds four published agents (composer,
data_analyst, advisor, critic) and a second built-in flow — the short "lookup"
lane — built from the SAME node types the palette offers, so cloning it yields a
graph a person can actually read.

Idempotent: skips anything already present, so it is safe on a database that
already ran the GĐ2 seed.

Revision ID: 20260806_0035
Revises: 20260805_0034
"""
import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260806_0035"
down_revision = "20260805_0034"
branch_labels = None
depends_on = None

SEEDED_AGENT_KEYS = ("composer", "data_analyst", "advisor", "critic")
SEEDED_FLOW_KEY = "builtin_lookup_v1"


def _has_table(name: str) -> bool:
    try:
        return name in inspect(op.get_bind()).get_table_names()
    except Exception:
        return False


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table("ai_agent_versions") or not _has_table("ai_flow_versions"):
        return

    # Imported at runtime so the live definition and the seed cannot drift —
    # a test asserts the GĐ2 migration's frozen copy matches, and from here on
    # new seeds read the canonical module directly.
    from app.services.intelligence.registry.builtins import (
        BUILTIN_AGENTS,
        BUILTIN_LOOKUP_GRAPH,
    )

    for agent in BUILTIN_AGENTS:
        exists = bind.execute(
            sa.text("SELECT 1 FROM ai_agent_versions WHERE agent_key = :k LIMIT 1"),
            {"k": agent["agent_key"]},
        ).first()
        if exists:
            continue
        bind.execute(
            sa.text(
                "INSERT INTO ai_agent_versions "
                "(agent_key, version, status, display_name, model_policy, "
                " prompt_template, input_schema, output_schema, tool_allowlist, "
                " writable_state_fields, runtime_config, is_builtin, created_by, "
                " published_at, created_at) "
                "VALUES (:k, 1, 'published', :n, :p, :tpl, "
                " CAST('{}' AS JSON), CAST('{}' AS JSON), CAST(:tools AS JSON), "
                " CAST(:fields AS JSON), CAST(:cfg AS JSON), TRUE, 'system', NOW(), NOW())"
            ),
            {
                "k": agent["agent_key"],
                "n": agent["display_name"],
                "p": agent["model_policy"],
                "tpl": agent["prompt_template"],
                "tools": json.dumps(agent["tool_allowlist"]),
                "fields": json.dumps(agent["writable_state_fields"]),
                "cfg": json.dumps(agent.get("runtime_config") or {}),
            },
        )

    exists = bind.execute(
        sa.text("SELECT 1 FROM ai_flow_versions WHERE flow_key = :k LIMIT 1"),
        {"k": SEEDED_FLOW_KEY},
    ).first()
    if not exists:
        bind.execute(
            sa.text(
                "INSERT INTO ai_flow_versions "
                "(flow_key, version, status, display_name, graph, limits, "
                " requires_tools, is_builtin, created_by, published_at, created_at) "
                "VALUES (:k, 1, 'published', :n, CAST(:g AS JSON), CAST(:l AS JSON), "
                " TRUE, TRUE, 'system', NOW(), NOW())"
            ),
            {
                "k": SEEDED_FLOW_KEY,
                "n": "Luồng tra cứu nhanh (mẫu)",
                "g": json.dumps(BUILTIN_LOOKUP_GRAPH, ensure_ascii=False),
                "l": json.dumps(BUILTIN_LOOKUP_GRAPH["limits"]),
            },
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _has_table("ai_agent_versions"):
        bind.execute(
            sa.text(
                "DELETE FROM ai_agent_versions "
                "WHERE is_builtin = TRUE AND agent_key = ANY(:keys)"
            ),
            {"keys": list(SEEDED_AGENT_KEYS)},
        )
    if _has_table("ai_flow_versions"):
        bind.execute(
            sa.text("DELETE FROM ai_flow_versions WHERE flow_key = :k AND is_builtin = TRUE"),
            {"k": SEEDED_FLOW_KEY},
        )
