"""Agent Flows: brains as a first-class, shareable resource.

Creates `agent_brain_versions` and adds `agent_brain` to the resource-share enum
so a brain is shared through the same mechanism as a Dataset or a Dashboard.

SELF-CONTAINED ON PURPOSE. It imports nothing from `app` — a migration that reads
live code breaks `alembic upgrade head` the day that code is deleted, which is
exactly what happened with 0035 and took a fresh deploy down.

No seed data. The previous module shipped built-in flows from a migration, and
they became the thing nobody could tell apart from their own work. A deployment
starts with no brains, and a link with no brain says so.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260811_0041"
down_revision = "20260810_0040"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_brain_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("brain_key", sa.String(length=64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="draft"),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("body", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("owner_email", sa.String(length=255), nullable=True),
        sa.Column("created_by", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_builtin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("brain_key", "version", name="uq_agent_brain_version"),
    )
    op.create_index("ix_agent_brain_versions_brain_key", "agent_brain_versions", ["brain_key"])
    op.create_index("ix_agent_brain_versions_status", "agent_brain_versions", ["status"])
    op.create_index("ix_agent_brain_key_status", "agent_brain_versions", ["brain_key", "status"])
    op.create_index("ix_agent_brain_versions_owner_email", "agent_brain_versions", ["owner_email"])

    # `resourcetype` is a Postgres enum, so a new member needs ALTER TYPE. IF NOT
    # EXISTS because a database may already have been through this on a branch, and
    # a migration that only runs on one history is a migration that breaks a
    # fresh deploy.
    op.execute("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'agent_brain'")


def downgrade() -> None:
    op.drop_index("ix_agent_brain_versions_owner_email", table_name="agent_brain_versions")
    op.drop_index("ix_agent_brain_key_status", table_name="agent_brain_versions")
    op.drop_index("ix_agent_brain_versions_status", table_name="agent_brain_versions")
    op.drop_index("ix_agent_brain_versions_brain_key", table_name="agent_brain_versions")
    op.drop_table("agent_brain_versions")
    # The enum member is left in place. Postgres cannot drop one without rebuilding
    # the type, and rebuilding a type other tables depend on to undo an additive
    # change is a far bigger risk than an unused label.
