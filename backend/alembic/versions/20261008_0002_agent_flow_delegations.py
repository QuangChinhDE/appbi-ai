"""agent_flow_delegations: explicit, revocable delegation of a flow owner's data.

Decision Q2: a flow runs with the CALLER's authority intersected with what the
flow attached; the owner's authority reaches a caller only through a row here.
Additive table only. NO backfill: flows that relied on the owner's authority are
listed by GET /agent-flows/admin/delegation-impact for an owner/admin to decide;
nothing is delegated silently. Downgrade drops the table.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20261008_0002"
down_revision = "20261008_0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_flow_delegations",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("brain_key", sa.String(64), nullable=False),
        sa.Column("grantee_user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("grantee_team_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("teams.id", ondelete="CASCADE"), nullable=True),
        sa.Column("resource_type", sa.String(16), nullable=False),
        sa.Column("resource_id", sa.Integer, nullable=False),
        sa.Column("action", sa.String(16), nullable=False, server_default="read"),
        sa.Column("created_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.CheckConstraint("(grantee_user_id IS NULL) <> (grantee_team_id IS NULL)",
                           name="ck_agent_flow_delegation_one_grantee"),
        sa.CheckConstraint("resource_type IN ('dataset', 'document')", name="ck_agent_flow_delegation_type"),
        sa.CheckConstraint("action IN ('read')", name="ck_agent_flow_delegation_action"),
    )
    op.create_index("ix_agent_flow_delegations_brain_key", "agent_flow_delegations", ["brain_key"])
    op.create_index("ix_agent_flow_delegation_lookup", "agent_flow_delegations", ["brain_key", "revoked_at"])


def downgrade():
    op.drop_index("ix_agent_flow_delegation_lookup", table_name="agent_flow_delegations")
    op.drop_index("ix_agent_flow_delegations_brain_key", table_name="agent_flow_delegations")
    op.drop_table("agent_flow_delegations")
