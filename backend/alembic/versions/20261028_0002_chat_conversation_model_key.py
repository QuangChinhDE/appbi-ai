"""AI Chat: the API key and model a person chose for a conversation.

PO 2026-10-28: every AI Chat conversation and every public Dashboard AI Bot runs on
the key and model a person supplied - there is no server default. A conversation
references its key in the encrypted store (`ai_provider_credentials`) and names its
model. Additive: two nullable columns; existing conversations have neither and ask
their owner to choose before the next question.

Revision ID: 20261028_0002
Revises: 20261028_0001
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261028_0002"
down_revision: Union[str, None] = "20261028_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("chat_conversations", sa.Column("ai_credential_id", sa.Integer(), nullable=True))
    op.add_column("chat_conversations", sa.Column("ai_model", sa.String(length=80), nullable=True))
    op.create_foreign_key("fk_chat_conversations_ai_credential", "chat_conversations", "ai_provider_credentials",
                          ["ai_credential_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    op.drop_constraint("fk_chat_conversations_ai_credential", "chat_conversations", type_="foreignkey")
    op.drop_column("chat_conversations", "ai_model")
    op.drop_column("chat_conversations", "ai_credential_id")
