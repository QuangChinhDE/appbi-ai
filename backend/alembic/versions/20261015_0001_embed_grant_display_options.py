"""embed_grants.display_options: per-grant viewer options set by the host app

POST /integrations/embed/resolve can now ask for report export (PDF/PPTX) on
the embed and hide the "Đang lọc theo…" filter banner. Stored on the GRANT, not
on the managed link: links are deduped by filter set, so two host apps
embedding the same slice must not overwrite each other's options.

Additive, nullable: every existing grant reads NULL (= defaults: no export,
banner shown) — exactly today's behaviour.

Parent is 20261012_0001 (the head master and demo share) so the SAME file can
ship to master as a hotfix; 20261015_0002 merges it back into demo's chain.

Revision ID: 20261015_0001
Revises: 20261012_0001
Create Date: 2026-10-15
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "20261015_0001"
down_revision: Union[str, None] = "20261012_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("embed_grants", sa.Column("display_options", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("embed_grants", "display_options")
