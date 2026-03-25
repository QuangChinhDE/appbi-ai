"""Add saved AI Agent report specs and runs.

Revision ID: 20260324_0013
Revises: 20260324_0012
Create Date: 2026-03-24
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260324_0013"
down_revision = "20260324_0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_report_specs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="draft"),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("latest_dashboard_id", sa.Integer(), sa.ForeignKey("dashboards.id", ondelete="SET NULL"), nullable=True),
        sa.Column("selected_tables_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("brief_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("approved_plan_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_agent_report_specs_id", "agent_report_specs", ["id"])
    op.create_index("ix_agent_report_specs_name", "agent_report_specs", ["name"])
    op.create_index("ix_agent_report_specs_owner_id", "agent_report_specs", ["owner_id"])

    op.create_table(
        "agent_report_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("report_spec_id", sa.Integer(), sa.ForeignKey("agent_report_specs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("triggered_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("dashboard_id", sa.Integer(), sa.ForeignKey("dashboards.id", ondelete="SET NULL"), nullable=True),
        sa.Column("target_dashboard_id", sa.Integer(), sa.ForeignKey("dashboards.id", ondelete="SET NULL"), nullable=True),
        sa.Column("build_mode", sa.String(length=30), nullable=False, server_default="new_dashboard"),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="queued"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("input_brief_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("plan_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("result_summary_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_agent_report_runs_id", "agent_report_runs", ["id"])
    op.create_index("ix_agent_report_runs_report_spec_id", "agent_report_runs", ["report_spec_id"])
    op.create_index("ix_agent_report_runs_triggered_by", "agent_report_runs", ["triggered_by"])


def downgrade() -> None:
    op.drop_index("ix_agent_report_runs_triggered_by", table_name="agent_report_runs")
    op.drop_index("ix_agent_report_runs_report_spec_id", table_name="agent_report_runs")
    op.drop_index("ix_agent_report_runs_id", table_name="agent_report_runs")
    op.drop_table("agent_report_runs")

    op.drop_index("ix_agent_report_specs_owner_id", table_name="agent_report_specs")
    op.drop_index("ix_agent_report_specs_name", table_name="agent_report_specs")
    op.drop_index("ix_agent_report_specs_id", table_name="agent_report_specs")
    op.drop_table("agent_report_specs")
