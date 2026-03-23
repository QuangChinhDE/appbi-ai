"""Add ai_feedback table for Feedback-Driven Knowledge System.

Revision ID: 20260322_fb02
Revises: 20260322_fb01
Create Date: 2026-03-22

Creates ai_feedback table.
Note: session_id and message_id are VARCHAR (no FK) because chat sessions
      are stored in-memory in the AI service, not persisted to PostgreSQL.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '20260322_fb02'
down_revision = '20260322_fb01'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'ai_feedback',
        sa.Column('id', UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()')),
        # Context — no FK because sessions are in-memory
        sa.Column('session_id', sa.String(100), nullable=True),
        sa.Column('message_id', sa.String(100), nullable=True),
        sa.Column('user_id', UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'),
                  nullable=False),
        sa.Column('user_query', sa.Text(), nullable=False),
        # What AI matched (may be wrong)
        sa.Column('ai_matched_resource_type', sa.String(50), nullable=True),
        sa.Column('ai_matched_resource_id', sa.Integer(), nullable=True),
        # What user says is correct
        sa.Column('feedback_type', sa.String(30), nullable=False),
        # Values: "wrong_table" | "wrong_chart" | "unclear" | "other"
        sa.Column('correct_resource_type', sa.String(50), nullable=True),
        # Values: "chart" | "workspace_table"
        sa.Column('correct_resource_id', sa.Integer(), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('is_positive', sa.Boolean(),
                  nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(),
                  nullable=False, server_default=sa.text('NOW()')),
    )

    op.create_index(
        'idx_ai_feedback_correct_resource',
        'ai_feedback',
        ['correct_resource_type', 'correct_resource_id'],
    )
    op.create_index(
        'idx_ai_feedback_user_id',
        'ai_feedback',
        ['user_id'],
    )
    op.create_index(
        'idx_ai_feedback_created_at',
        'ai_feedback',
        ['created_at'],
        postgresql_ops={'created_at': 'DESC'},
    )


def downgrade():
    op.drop_index('idx_ai_feedback_created_at', table_name='ai_feedback')
    op.drop_index('idx_ai_feedback_user_id', table_name='ai_feedback')
    op.drop_index('idx_ai_feedback_correct_resource', table_name='ai_feedback')
    op.drop_table('ai_feedback')
