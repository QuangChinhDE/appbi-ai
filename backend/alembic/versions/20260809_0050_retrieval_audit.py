"""Audit trail for reads out of the vector store

`retrieval_count` on a document was a bare counter: it could say a document had
been used 40 times and nothing else. An enterprise question is not "how often"
but "who read which passage, when, and in answer to what" — and a counter cannot
be subpoenaed, reviewed, or used to explain an answer after the fact.

One row per RETRIEVAL rather than per chunk: a retrieval is the event, and the
passages it returned belong to that event. Per-chunk rows would multiply the
volume by k and bury the thing being asked about.

The question itself is stored as a SHA-256 digest plus its length, never as
text. The audit needs to prove that two answers came from the same question and
to correlate with an application log; keeping the wording would turn a security
control into a second copy of everything users asked.

Revision ID: 20260809_0050
Revises: 20260809_0049
"""
import sqlalchemy as sa
from alembic import op

revision = "20260809_0050"
down_revision = "20260809_0049"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "govern_doc_retrieval_log",
        sa.Column("id", sa.Integer, primary_key=True),
        # WHO read. 'dashboard_bot' today; an Agent Flow step would name itself
        # here, which is the point of not calling this column 'dashboard_id'.
        sa.Column("consumer", sa.String(48), nullable=False, server_default="unknown"),
        sa.Column("consumer_ref", sa.String(64), nullable=True),
        sa.Column("actor", sa.String(128), nullable=True),
        sa.Column("question_hash", sa.String(64), nullable=True),
        sa.Column("question_chars", sa.Integer, nullable=False, server_default="0"),
        sa.Column("doc_ids", sa.JSON, nullable=False, server_default="[]"),
        sa.Column("chunk_ids", sa.JSON, nullable=False, server_default="[]"),
        sa.Column("top_similarity", sa.Float, nullable=True),
        sa.Column("occurred_at", sa.DateTime, server_default=sa.func.now(), index=True),
    )
    op.create_index(
        "idx_govern_retrieval_consumer_time",
        "govern_doc_retrieval_log",
        ["consumer", "consumer_ref", "occurred_at"],
    )


def downgrade():
    op.drop_index("idx_govern_retrieval_consumer_time", table_name="govern_doc_retrieval_log")
    op.drop_table("govern_doc_retrieval_log")
