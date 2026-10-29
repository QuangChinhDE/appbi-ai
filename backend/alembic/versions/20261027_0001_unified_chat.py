"""Unified AI Chat: one conversation store, and the history of both old ones in it.

Contract: docs/features/unified-ai-chat/contract.md (section E).

EXPAND (additive): `chat_conversations`, `chat_turns`, `chat_extension_invocations`,
`chat_feedback`, and the `chat_conversation` share type. No existing table or row
is changed or removed: `analyst_sessions`, `analyst_session_turns`,
`agent_flow_chat_threads` and `analyst_feedback` stay exactly as they are, so the
history stays recoverable from them until the migration is accepted. Dropping
them is a LATER release, after the operator's backup/restore rehearsal.

MIGRATE (one-way, idempotent): every legacy conversation, turn, share and rating
is copied once (a second run inserts nothing: each row is keyed by its legacy id),
with its author and timestamps.

  analyst_sessions        -> chat_conversations  legacy_kind=analyst_session
  analyst_session_turns   -> chat_turns          origin=analyst_v1, same turn_id
  agent_flow_chat_threads -> chat_conversations  legacy_kind=flow_thread,
                                                 extension_flow_key=brain_key
  agent_flow_runs (chat)  -> chat_turns          origin=flow_v0, legacy_run_id
  resource_shares         -> resource_shares     type chat_conversation, SAME level
  analyst_feedback, runs.rating -> chat_feedback

A flow_v0 turn whose content row was pruned is imported anyway (question from
`question_norm`, `content_pruned` in its envelope): no turn disappears.

WHO MAY READ AN IMPORTED ANSWER is never widened. A flow_v0 turn's footprint is the
knowledge its flow had ATTACHED at the time (`input_envelope.binding.knowledge`), a
superset of what that run could read, so a viewer must hold every one of those
Datasets and documents to see it. With no input envelope the footprint is unknown
and the turn is shown to the person who asked it only.

MODULE ACCESS is carried, never widened: whoever held the retired `analyst` module
gets the same level of `chat` (`full` is carried as `edit`: oversight of every
conversation is not what `analyst: full` granted). Dataset rights are untouched.
`settings: full` accounts are skipped (their missing keys back-fill at read time).

The upgrade FAILS if any count does not reconcile (legacy rows vs imported rows).

DOWNGRADE drops the new tables and the copied share rows. The module-permission
carry is not reverted (it cannot be told apart from a later admin edit); recovery
for a failed release is the operator's database backup (docs/ops-runbook.md).

Revision ID: 20261027_0001
Revises: 20261026_0001
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20261027_0001"
down_revision: Union[str, None] = "20261026_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_LEVELS = {"none": 0, "view": 1, "edit": 2, "full": 3}


def _jsonb():
    return postgresql.JSONB()


def upgrade() -> None:
    op.create_table(
        "chat_conversations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("extension_flow_key", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_active_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("legacy_kind", sa.String(24), nullable=True),
        sa.Column("legacy_id", sa.Integer(), nullable=True),
        sa.UniqueConstraint("legacy_kind", "legacy_id", name="uq_chat_conversations_legacy"),
    )
    op.create_index("ix_chat_conversations_id", "chat_conversations", ["id"])
    op.create_index("ix_chat_conversations_user_id", "chat_conversations", ["user_id"])
    op.create_index("ix_chat_conversations_user_active", "chat_conversations", ["user_id", "last_active_at"])

    op.create_table(
        "chat_turns",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("chat_conversations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("turn_id", sa.String(32), nullable=False, unique=True),
        sa.Column("idempotency_key", sa.String(64), nullable=True),
        sa.Column("asked_by", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("origin", sa.String(16), nullable=False, server_default="core"),
        sa.Column("dataset_ids", _jsonb(), nullable=False, server_default="[]"),
        sa.Column("refs", _jsonb(), nullable=False, server_default="[]"),
        sa.Column("doc_ids", _jsonb(), nullable=False, server_default="[]"),
        sa.Column("envelope", _jsonb(), nullable=False, server_default="{}"),
        sa.Column("usage", _jsonb(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("legacy_run_id", sa.Integer(), nullable=True),
        sa.UniqueConstraint("conversation_id", "seq", name="uq_chat_turns_seq"),
        sa.UniqueConstraint("conversation_id", "idempotency_key", name="uq_chat_turns_idempotency"),
        sa.CheckConstraint("status IN ('running', 'answered', 'clarification_required', 'refused', 'failed', "
                           "'cancelled')", name="ck_chat_turns_status"),
    )
    op.create_index("ix_chat_turns_conversation_id", "chat_turns", ["conversation_id"])
    op.create_index("ix_chat_turns_asked_by", "chat_turns", ["asked_by"])
    op.create_index("ix_chat_turns_asker_time", "chat_turns", ["asked_by", "created_at"])
    op.create_index("uq_chat_turns_legacy_run", "chat_turns", ["legacy_run_id"], unique=True,
                    postgresql_where=sa.text("legacy_run_id IS NOT NULL"))

    op.create_table(
        "chat_extension_invocations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("invocation_id", sa.String(32), nullable=False, unique=True),
        sa.Column("turn_id", sa.String(32), nullable=False),
        sa.Column("conversation_id", sa.Integer(), sa.ForeignKey("chat_conversations.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("flow_key", sa.String(64), nullable=False),
        sa.Column("flow_version", sa.Integer(), nullable=True),
        sa.Column("reason", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("code", sa.String(48), nullable=True),
        sa.Column("run_key", sa.String(64), nullable=True),
        sa.Column("ceiling", _jsonb(), nullable=False, server_default="{}"),
        sa.Column("results", _jsonb(), nullable=False, server_default="[]"),
        sa.Column("warnings", _jsonb(), nullable=False, server_default="[]"),
        sa.Column("usage", _jsonb(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_chat_extension_invocations_turn_id", "chat_extension_invocations", ["turn_id"])

    op.create_table(
        "chat_feedback",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("turn_id", sa.String(32), nullable=False),
        sa.Column("verdict", sa.String(8), nullable=False),
        sa.Column("reason", sa.String(40), nullable=True),
        sa.Column("comment", sa.String(1000), nullable=True),
        sa.Column("rc_sha", sa.String(40), nullable=True),
        sa.Column("legacy_source", sa.String(24), nullable=True),
        sa.CheckConstraint("verdict IN ('up', 'down')", name="ck_chat_feedback_verdict"),
        sa.CheckConstraint("reason IS NULL OR reason IN ('correct', 'wrong_metric', 'wrong_dataset', "
                           "'wrong_metric_or_source', 'wrong_filter', 'incorrect_number', 'wrong_interpretation', "
                           "'unsupported_but_answerable', 'ux_issue', 'wrong_document')",
                           name="ck_chat_feedback_reason"),
    )
    op.create_index("ix_chat_feedback_user_id", "chat_feedback", ["user_id"])
    op.create_index("ix_chat_feedback_turn_id", "chat_feedback", ["turn_id"])

    if op.get_bind().dialect.name != "postgresql":
        return
    # A new enum member cannot be USED in the transaction that adds it.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'chat_conversation'")
    counts = import_legacy(op.get_bind())
    carried = _carry_module_access(op.get_bind())
    print(f"[unified-chat] imported {json.dumps(counts, sort_keys=True)}; chat access carried to {carried} user(s)")


# ── the import (frozen SQL: this migration must mean the same thing forever) ──

_STATUS_ANALYST = ("CASE t.status WHEN 'answered' THEN 'answered' WHEN 'clarify' THEN 'clarification_required' "
                   "ELSE 'refused' END")
_STATUS_FLOW = ("CASE r.status WHEN 'ok' THEN 'answered' WHEN 'partial' THEN 'answered' "
                "WHEN 'blocked' THEN 'refused' WHEN 'throttled' THEN 'refused' ELSE 'failed' END")

_IMPORT = [
    # 1. analyst sessions
    """
    INSERT INTO chat_conversations (user_id, title, created_at, last_active_at, deleted_at, legacy_kind, legacy_id)
    SELECT s.user_id, s.title, s.created_at, s.last_active_at, s.deleted_at, 'analyst_session', s.id
    FROM analyst_sessions s
    WHERE NOT EXISTS (SELECT 1 FROM chat_conversations c
                      WHERE c.legacy_kind = 'analyst_session' AND c.legacy_id = s.id)
    """,
    # 2. their turns (same turn_id: ledger rows and feedback keep pointing at them)
    f"""
    INSERT INTO chat_turns (conversation_id, seq, turn_id, asked_by, question, status, origin, dataset_ids, refs,
                            doc_ids, envelope, created_at, completed_at)
    SELECT c.id, t.seq, t.turn_id, t.asked_by, t.question, {_STATUS_ANALYST}, 'analyst_v1', t.dataset_ids,
           t.refs, '[]'::jsonb,
           jsonb_build_object('v', 'analyst_v1', 'response', t.response),
           t.created_at, t.created_at
    FROM analyst_session_turns t
    JOIN chat_conversations c ON c.legacy_kind = 'analyst_session' AND c.legacy_id = t.session_id
    WHERE NOT EXISTS (SELECT 1 FROM chat_turns x WHERE x.turn_id = t.turn_id)
    """,
    # 3. flow chat threads; the flow stays bound as the conversation's extension
    """
    INSERT INTO chat_conversations (user_id, title, extension_flow_key, created_at, last_active_at, deleted_at,
                                    legacy_kind, legacy_id)
    SELECT th.user_id, th.title, th.brain_key, th.created_at, th.last_active_at, th.deleted_at, 'flow_thread', th.id
    FROM agent_flow_chat_threads th
    WHERE NOT EXISTS (SELECT 1 FROM chat_conversations c
                      WHERE c.legacy_kind = 'flow_thread' AND c.legacy_id = th.id)
    """,
    # 4. their runs, one turn each, numbered by time; pruned content imported as such
    f"""
    INSERT INTO chat_turns (conversation_id, seq, turn_id, asked_by, question, status, origin, dataset_ids, refs,
                            doc_ids, envelope, created_at, completed_at, legacy_run_id)
    SELECT n.conversation_id, n.seq, n.turn_id, n.asked_by, n.question, n.status, 'flow_v0', n.dataset_ids,
           '[]'::jsonb, n.doc_ids, n.envelope, n.created_at, n.created_at, n.run_id
    FROM (
        SELECT c.id AS conversation_id,
               row_number() OVER (PARTITION BY r.chat_thread_id ORDER BY r.created_at, r.id) AS seq,
               substr(md5('flow_v0:' || r.run_key), 1, 32) AS turn_id,
               th.user_id AS asked_by,
               COALESCE(NULLIF(rc.question, ''), r.question_norm, '') AS question,
               {_STATUS_FLOW} AS status,
               COALESCE(rc.input_envelope #> '{{binding,knowledge,dataset_ids}}', '[]'::jsonb) AS dataset_ids,
               COALESCE(rc.input_envelope #> '{{binding,knowledge,doc_ids}}', '[]'::jsonb) AS doc_ids,
               jsonb_build_object(
                   'v', 'flow_v0', 'run_status', r.status, 'blocked_reason', r.blocked_reason,
                   'answer', rc.answer, 'citations', COALESCE(rc.citations, '[]'::jsonb),
                   'notices', COALESCE(rc.notices, '[]'::jsonb),
                   'content_pruned', rc.run_id IS NULL,
                   'footprint_known', rc.input_envelope IS NOT NULL) AS envelope,
               r.created_at, r.id AS run_id
        FROM agent_flow_runs r
        JOIN agent_flow_chat_threads th ON th.id = r.chat_thread_id
        JOIN chat_conversations c ON c.legacy_kind = 'flow_thread' AND c.legacy_id = th.id
        LEFT JOIN agent_flow_run_content rc ON rc.run_id = r.id
        WHERE r.chat_thread_id IS NOT NULL
    ) n
    WHERE NOT EXISTS (SELECT 1 FROM chat_turns x WHERE x.legacy_run_id = n.run_id)
    """,
    # 5. shares, at the SAME level, onto the conversation they were for
    """
    INSERT INTO resource_shares (resource_type, resource_id, user_id, team_id, permission, shared_by, created_at)
    SELECT 'chat_conversation', c.id::text, s.user_id, s.team_id, s.permission, s.shared_by, s.created_at
    FROM resource_shares s
    JOIN chat_conversations c
      ON (s.resource_type = 'analyst_session' AND c.legacy_kind = 'analyst_session'
          AND s.resource_id = c.legacy_id::text)
      OR (s.resource_type = 'chat_thread' AND c.legacy_kind = 'flow_thread'
          AND s.resource_id = c.legacy_id::text)
    ON CONFLICT DO NOTHING
    """,
    # 6. feedback: the analyst's rows as they are, a flow run's thumbs as the thread owner's
    """
    INSERT INTO chat_feedback (created_at, user_id, turn_id, verdict, reason, comment, rc_sha, legacy_source)
    SELECT f.created_at, f.user_id, f.turn_id, f.verdict, f.reason, f.comment, f.rc_sha, 'analyst_feedback'
    FROM analyst_feedback f
    WHERE NOT EXISTS (SELECT 1 FROM chat_feedback x WHERE x.legacy_source = 'analyst_feedback'
                      AND x.turn_id = f.turn_id AND x.user_id = f.user_id AND x.created_at = f.created_at)
    """,
    """
    INSERT INTO chat_feedback (created_at, user_id, turn_id, verdict, legacy_source)
    SELECT t.created_at, t.asked_by, t.turn_id, r.rating, 'flow_run_rating'
    FROM agent_flow_runs r JOIN chat_turns t ON t.legacy_run_id = r.id
    WHERE r.rating IN ('up', 'down')
      AND NOT EXISTS (SELECT 1 FROM chat_feedback x WHERE x.legacy_source = 'flow_run_rating'
                      AND x.turn_id = t.turn_id)
    """,
]

_RECONCILE = {
    "analyst_sessions": ("SELECT count(*) FROM analyst_sessions",
                         "SELECT count(*) FROM chat_conversations WHERE legacy_kind = 'analyst_session'"),
    "analyst_turns": ("SELECT count(*) FROM analyst_session_turns",
                      "SELECT count(*) FROM chat_turns WHERE origin = 'analyst_v1'"),
    "flow_threads": ("SELECT count(*) FROM agent_flow_chat_threads",
                     "SELECT count(*) FROM chat_conversations WHERE legacy_kind = 'flow_thread'"),
    "flow_turns": ("SELECT count(*) FROM agent_flow_runs WHERE chat_thread_id IS NOT NULL",
                   "SELECT count(*) FROM chat_turns WHERE origin = 'flow_v0'"),
    # a legacy share names its resource by string, with no FK: one whose conversation
    # row is gone shares nothing, before or after, and is counted under `orphan_shares`.
    # Imported = that legacy share has its counterpart on the imported conversation,
    # for the same person or team AT THE SAME LEVEL (shares made later on new
    # conversations are not imports and are not counted).
    "shares": ("SELECT count(*) FROM resource_shares s WHERE "
               "(s.resource_type = 'analyst_session' AND EXISTS (SELECT 1 FROM analyst_sessions a "
               "WHERE a.id::text = s.resource_id)) OR (s.resource_type = 'chat_thread' AND EXISTS "
               "(SELECT 1 FROM agent_flow_chat_threads t WHERE t.id::text = s.resource_id))",
               "SELECT count(*) FROM resource_shares s JOIN chat_conversations c "
               "ON (s.resource_type = 'analyst_session' AND c.legacy_kind = 'analyst_session' "
               "AND s.resource_id = c.legacy_id::text) OR (s.resource_type = 'chat_thread' "
               "AND c.legacy_kind = 'flow_thread' AND s.resource_id = c.legacy_id::text) "
               "WHERE EXISTS (SELECT 1 FROM resource_shares n WHERE n.resource_type = 'chat_conversation' "
               "AND n.resource_id = c.id::text AND n.permission = s.permission "
               "AND n.user_id IS NOT DISTINCT FROM s.user_id AND n.team_id IS NOT DISTINCT FROM s.team_id)"),
    "feedback": ("SELECT (SELECT count(*) FROM analyst_feedback) + (SELECT count(*) FROM agent_flow_runs "
                 "WHERE chat_thread_id IS NOT NULL AND rating IN ('up', 'down'))",
                 "SELECT count(*) FROM chat_feedback WHERE legacy_source IS NOT NULL"),
}


def import_legacy(conn) -> dict:
    """Copy every legacy conversation once; return {name: [legacy, imported]} and
    raise if any pair differs."""
    for stmt in _IMPORT:
        conn.execute(sa.text(stmt))
    counts = {k: [int(conn.execute(sa.text(a)).scalar() or 0), int(conn.execute(sa.text(b)).scalar() or 0)]
              for k, (a, b) in _RECONCILE.items()}
    bad = {k: v for k, v in counts.items() if v[0] != v[1]}
    if bad:
        raise RuntimeError(f"unified chat import does not reconcile: {bad}")
    counts["orphan_shares"] = int(conn.execute(sa.text(
        "SELECT count(*) FROM resource_shares WHERE resource_type IN ('analyst_session', 'chat_thread')"
    )).scalar() or 0) - counts["shares"][0]
    return counts


def _carry_module_access(conn) -> int:
    rows = conn.execute(sa.text("SELECT id, permissions FROM users WHERE permissions IS NOT NULL")).fetchall()
    moved = 0
    for user_id, perms in rows:
        if isinstance(perms, str):
            try:
                perms = json.loads(perms)
            except ValueError:
                continue
        if not isinstance(perms, dict):
            continue
        if str(perms.get("settings") or "").strip().lower() == "full":
            continue
        analyst = str(perms.get("analyst") or "none").strip().lower()
        if _LEVELS.get(analyst, 0) == 0:
            continue
        carried = "edit" if analyst == "full" else analyst
        current = str(perms.get("chat") or "none").strip().lower()
        if _LEVELS.get(current, 0) >= _LEVELS[carried]:
            continue
        conn.execute(sa.text("UPDATE users SET permissions = CAST(:p AS jsonb) WHERE id = :i"),
                     {"p": json.dumps({**perms, "chat": carried}), "i": user_id})
        moved += 1
    return moved


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("DELETE FROM resource_shares WHERE resource_type = 'chat_conversation'")
    op.drop_index("ix_chat_feedback_turn_id", table_name="chat_feedback")
    op.drop_index("ix_chat_feedback_user_id", table_name="chat_feedback")
    op.drop_table("chat_feedback")
    op.drop_index("ix_chat_extension_invocations_turn_id", table_name="chat_extension_invocations")
    op.drop_table("chat_extension_invocations")
    op.drop_index("uq_chat_turns_legacy_run", table_name="chat_turns")
    op.drop_index("ix_chat_turns_asker_time", table_name="chat_turns")
    op.drop_index("ix_chat_turns_asked_by", table_name="chat_turns")
    op.drop_index("ix_chat_turns_conversation_id", table_name="chat_turns")
    op.drop_table("chat_turns")
    op.drop_index("ix_chat_conversations_user_active", table_name="chat_conversations")
    op.drop_index("ix_chat_conversations_user_id", table_name="chat_conversations")
    op.drop_index("ix_chat_conversations_id", table_name="chat_conversations")
    op.drop_table("chat_conversations")
