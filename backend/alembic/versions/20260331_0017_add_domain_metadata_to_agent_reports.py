"""add_domain_metadata_to_agent_reports

Revision ID: 20260331_0017
Revises: 20260328_0016
Create Date: 2026-03-31 13:45:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260331_0017"
down_revision = "20260328_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_report_specs", sa.Column("domain_id", sa.String(length=100), nullable=True))
    op.add_column("agent_report_specs", sa.Column("domain_version", sa.String(length=50), nullable=True))
    op.add_column("agent_report_runs", sa.Column("domain_id", sa.String(length=100), nullable=True))
    op.add_column("agent_report_runs", sa.Column("domain_version", sa.String(length=50), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_report_runs", "domain_version")
    op.drop_column("agent_report_runs", "domain_id")
    op.drop_column("agent_report_specs", "domain_version")
    op.drop_column("agent_report_specs", "domain_id")
