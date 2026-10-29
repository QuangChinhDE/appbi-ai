"""AI runtime: the usage ledger, public answer turns, and no plaintext link keys.

PO directive (2026-10-28): one Answer Core for AI Chat and the public Dashboard AI
Bot; credentials and token budget under one server policy.

EXPAND (additive):
  * `ai_usage_ledger`     - one row per paid model call, reserved BEFORE the call
                            and settled after (services/ai_runtime/gateway.py);
  * `public_answer_turns` - the public bot's turns through the Answer Core
                            (idempotency, one terminal write, follow-up plan).

MIGRATE (idempotent): a public link that still holds its provider key in plain
text (`appearance_config.ai_bot_key`) has it moved into the encrypted credential
store that already exists (`ai_provider_credentials`, Fernet), owned by the
dashboard's owner; the link keeps only `ai_bot_credential_id`. A second run finds
no `ai_bot_key` and does nothing. When encryption is not configured the key is
LEFT where it is and counted in the log (never printed): the runtime no longer
reads a key from a link's JSON, and the operator must configure encryption and
re-run. A key that sat in plain text should be rotated at the provider; this
migration does not and cannot do that.

DOWNGRADE restores each migrated key into the link and deletes the credential
rows this migration created, then drops the two tables.
"""
from __future__ import annotations

import json
import logging
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20261028_0001"
down_revision: Union[str, None] = "20261027_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

log = logging.getLogger("alembic.20261028_0001")

_MIGRATED_MARK = "ai_bot_credential_migrated"


def _provider_of(key: str, configured: str) -> str:
    configured = (configured or "").strip().lower()
    if configured in ("openai", "anthropic", "gemini"):
        return configured
    if key.startswith("sk-ant-"):
        return "anthropic"
    if key.startswith("AIza"):
        return "gemini"
    return "openai"


def _as_dict(raw) -> dict:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            value = json.loads(raw)
            return dict(value) if isinstance(value, dict) else {}
        except ValueError:
            return {}
    return {}


def upgrade() -> None:
    op.create_table(
        "ai_usage_ledger",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("call_id", sa.String(36), nullable=False, unique=True),
        sa.Column("purpose", sa.String(40), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("provider", sa.String(20), nullable=True),
        sa.Column("model", sa.String(120), nullable=True),
        sa.Column("user_id", sa.String(64), nullable=True),
        sa.Column("link_id", sa.Integer(), nullable=True),
        sa.Column("turn_ref", sa.String(64), nullable=True),
        sa.Column("credential_ref", sa.String(40), nullable=True),
        sa.Column("reserved_usd", sa.Float(), nullable=False),
        sa.Column("actual_usd", sa.Float(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("error", sa.String(80), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_ai_usage_ledger_created", "ai_usage_ledger", ["created_at"])
    op.create_index("ix_ai_usage_ledger_link_created", "ai_usage_ledger", ["link_id", "created_at"])
    op.create_index("ix_ai_usage_ledger_user_created", "ai_usage_ledger", ["user_id", "created_at"])
    op.create_index("ix_ai_usage_ledger_turn", "ai_usage_ledger", ["turn_ref"])

    op.create_table(
        "public_answer_turns",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("link_id", sa.Integer(), sa.ForeignKey("dashboard_public_links.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("conversation_key", sa.String(64), nullable=False),
        sa.Column("turn_id", sa.String(32), nullable=False, unique=True),
        sa.Column("idempotency_key", sa.String(64), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("envelope", sa.JSON(), nullable=True),
        sa.Column("plan", sa.JSON(), nullable=True),
        sa.Column("usd", sa.Float(), nullable=True),
        sa.Column("rating", sa.String(8), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("link_id", "idempotency_key", name="uq_public_answer_turns_link_idem"),
    )
    op.create_index("ix_public_answer_turns_conversation", "public_answer_turns",
                    ["link_id", "conversation_key", "created_at"])

    _move_link_keys()


def _move_link_keys() -> None:
    bind = op.get_bind()
    links = sa.table("dashboard_public_links", sa.column("id", sa.Integer), sa.column("dashboard_id", sa.Integer),
                     sa.column("appearance_config", sa.JSON))
    rows = bind.execute(sa.select(links.c.id, links.c.dashboard_id, links.c.appearance_config)).all()
    holders = [(r.id, r.dashboard_id, _as_dict(r.appearance_config)) for r in rows]
    holders = [(i, d, cfg) for i, d, cfg in holders if str(cfg.get("ai_bot_key") or "").strip()]
    if not holders:
        return
    from app.core.crypto import encrypt_value

    moved = kept = 0
    for link_id, dashboard_id, cfg in holders:
        key = str(cfg.get("ai_bot_key") or "").strip()
        try:
            secret_enc = encrypt_value(key)
        except Exception:  # noqa: BLE001 - encryption not configured: the key stays, counted, never printed
            kept += 1
            continue
        if not str(secret_enc).startswith("_enc:"):
            kept += 1  # dev/test without a key would store plain text: leave the link as it is
            continue
        owner = bind.execute(sa.text("SELECT owner_id FROM dashboards WHERE id = :d"), {"d": dashboard_id}).scalar()
        provider = _provider_of(key, str(cfg.get("ai_bot_provider") or ""))
        cred_id = bind.execute(sa.text(
            "INSERT INTO ai_provider_credentials (name, provider, secret_enc, key_hint, is_default, owner_id, "
            "created_at, updated_at) VALUES (:n, :p, :s, :h, false, :o, now(), now()) RETURNING id"),
            {"n": f"Public link {link_id} AI bot key (migrated)", "p": provider, "s": secret_enc,
             "h": key[-4:], "o": owner}).scalar()
        cfg.pop("ai_bot_key", None)
        cfg.pop("ai_bot_key_configured", None)
        cfg["ai_bot_credential_id"] = int(cred_id)
        cfg["ai_bot_provider"] = provider
        cfg[_MIGRATED_MARK] = True
        bind.execute(links.update().where(links.c.id == link_id).values(appearance_config=cfg))
        moved += 1
    log.warning("20261028_0001: %d public-link AI key(s) moved to the encrypted store, %d left (encryption "
                "not configured). Rotate any key that was stored in plain text.", moved, kept)


def downgrade() -> None:
    bind = op.get_bind()
    links = sa.table("dashboard_public_links", sa.column("id", sa.Integer), sa.column("appearance_config", sa.JSON))
    rows = bind.execute(sa.select(links.c.id, links.c.appearance_config)).all()
    migrated = [(r.id, _as_dict(r.appearance_config)) for r in rows]
    migrated = [(i, cfg) for i, cfg in migrated if cfg.get(_MIGRATED_MARK) and cfg.get("ai_bot_credential_id")]
    if migrated:
        from app.core.crypto import decrypt_value

        for link_id, cfg in migrated:
            cred_id = int(cfg["ai_bot_credential_id"])
            enc = bind.execute(sa.text("SELECT secret_enc FROM ai_provider_credentials WHERE id = :i"),
                               {"i": cred_id}).scalar()
            if enc:
                cfg["ai_bot_key"] = decrypt_value(enc)
            cfg.pop("ai_bot_credential_id", None)
            cfg.pop(_MIGRATED_MARK, None)
            bind.execute(links.update().where(links.c.id == link_id).values(appearance_config=cfg))
            bind.execute(sa.text("DELETE FROM ai_provider_credentials WHERE id = :i"), {"i": cred_id})
    op.drop_index("ix_public_answer_turns_conversation", table_name="public_answer_turns")
    op.drop_table("public_answer_turns")
    for ix in ("ix_ai_usage_ledger_turn", "ix_ai_usage_ledger_user_created", "ix_ai_usage_ledger_link_created",
               "ix_ai_usage_ledger_created"):
        op.drop_index(ix, table_name="ai_usage_ledger")
    op.drop_table("ai_usage_ledger")
