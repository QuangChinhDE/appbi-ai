"""P0-01: anonymous AI memory must pass through the review ledger

Until now ``remember_fact`` wrote ``ai_bot_knowledge.status='validated'``
directly — from a PUBLIC, unauthenticated chat. Anything validated is injected
into every later turn's system prompt for that dashboard, for every viewer, so
one anonymous visitor could poison what the assistant tells everyone else.

The code change routes anonymous teaching to ``status='candidate'`` plus a
pending ``govern_review_items`` row. This migration deals with the rows that are
ALREADY validated from that route:

* every ``source='user_taught'`` + ``status='validated'`` row is demoted to
  ``candidate`` and gets a pending review item, so a human confirms it once;
* nothing is deleted — approving in /ai-inbox restores it exactly.

We demote rather than grandfather because we cannot tell, after the fact, which
of those rows came from a trusted colleague and which from a stranger. Demoting
is recoverable in one click; leaving a poisoned row in place is not.

Rows learned by the bot itself (``source='bot_finding'`` etc.) are untouched:
they are evidence-derived and already governed by the recurrence/decay loop.

Revision ID: 20260803_0032
Revises: 20260730_0031
"""
import json

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "20260803_0032"
down_revision = "20260730_0031"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    try:
        return name in inspect(op.get_bind()).get_table_names()
    except Exception:
        return False


def upgrade() -> None:
    bind = op.get_bind()
    if not _has_table("ai_bot_knowledge"):
        return

    rows = bind.execute(
        sa.text(
            """
            SELECT id, dashboard_id, kind, content, confidence
            FROM ai_bot_knowledge
            WHERE status = 'validated' AND source = 'user_taught'
            """
        )
    ).fetchall()
    if not rows:
        return

    ids = [r[0] for r in rows]
    bind.execute(
        sa.text(
            "UPDATE ai_bot_knowledge SET status = 'candidate' WHERE id = ANY(:ids)"
        ),
        {"ids": ids},
    )

    if not _has_table("govern_review_items"):
        # Ledger not deployed (catalog module off). Demotion still applied —
        # fail safe: the content simply stops being injected until the module
        # is enabled and the rows are reviewed.
        return

    evidence = (
        "Tri thức được dạy qua chat trước khi có cổng duyệt — "
        "xác nhận lại để tiếp tục áp dụng."
    )
    for rid, dashboard_id, kind, content, confidence in rows:
        exists = bind.execute(
            sa.text(
                """
                SELECT 1 FROM govern_review_items
                WHERE entity_type = 'memory' AND entity_id = :rid AND status = 'pending'
                LIMIT 1
                """
            ),
            {"rid": rid},
        ).first()
        if exists:
            continue
        bind.execute(
            sa.text(
                """
                INSERT INTO govern_review_items
                    (entity_type, entity_id, action, title, payload, evidence,
                     confidence, source, status, created_by, created_at)
                VALUES
                    ('memory', :rid, 'suggest', :title, CAST(:payload AS JSON),
                     :evidence, :confidence, 'ai', 'pending', 'migration_0032', NOW())
                """
            ),
            {
                "rid": rid,
                "title": (content or "")[:512],
                "payload": json.dumps(
                    {"dashboard_id": dashboard_id, "kind": kind, "content": content},
                    ensure_ascii=False,
                ),
                "evidence": evidence,
                "confidence": float(confidence or 0.0),
            },
        )


def downgrade() -> None:
    """Restore the pre-gate state: re-validate what this migration demoted."""
    bind = op.get_bind()
    if not _has_table("ai_bot_knowledge") or not _has_table("govern_review_items"):
        return
    bind.execute(
        sa.text(
            """
            UPDATE ai_bot_knowledge SET status = 'validated'
            WHERE id IN (
                SELECT entity_id FROM govern_review_items
                WHERE entity_type = 'memory' AND created_by = 'migration_0032'
            )
            AND status = 'candidate'
            """
        )
    )
    bind.execute(
        sa.text(
            "DELETE FROM govern_review_items "
            "WHERE entity_type = 'memory' AND created_by = 'migration_0032'"
        )
    )
