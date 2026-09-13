"""AI Chat becomes its own permission module — carry existing access across.

Revision ID: 20260914_0001
Revises: 20260913_0001
Create Date: 2026-09-14

WHY A DATA MIGRATION AND NOT JUST A NEW KEY
-------------------------------------------
Per-user permissions live in `users.permissions` JSONB, and a module the user has
no key for reads as `none` — the sidebar hides it and `require_permission` answers
403. So the moment `chat` becomes its own key, everybody who could open AI Chat
yesterday through `agent_flows: view` loses it, silently, with no error anyone
would connect to a rename.

This carries the access across: anybody whose `agent_flows` is `view` or better
gets `chat: view`, which is exactly what they could already do. Nobody gains
anything — `agent_flows: none` stays without chat.

`settings: full` accounts are skipped deliberately: a missing key back-fills to
the module's ceiling for them at read time (`_get_user_permissions`), so writing a
row would only freeze a value that is already correct and would have to be
re-migrated the next time the ceiling moves.

Reversible: the down leg drops the key again, which is the honest inverse. It does
not restore chat access through `agent_flows`, because on the old code that is
what the old key already meant.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260914_0001"
down_revision: Union[str, None] = "20260913_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: What counts as already having chat. `LEVEL_ORDER` in the app has `view` at 1;
#: anything at or above it could open the module under the old shared key.
_GRANTS_CHAT = ("view", "edit", "full")


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, permissions FROM users WHERE permissions IS NOT NULL")
    ).fetchall()

    moved = 0
    for user_id, perms in rows:
        if isinstance(perms, str):
            try:
                perms = json.loads(perms)
            except ValueError:
                continue
        if not isinstance(perms, dict) or "chat" in perms:
            continue
        # An admin's missing key back-fills at read time; leave it missing.
        if str(perms.get("settings") or "").strip().lower() == "full":
            continue
        if str(perms.get("agent_flows") or "").strip().lower() not in _GRANTS_CHAT:
            continue
        updated = dict(perms)
        updated["chat"] = "view"
        conn.execute(
            sa.text("UPDATE users SET permissions = CAST(:p AS jsonb) WHERE id = :i"),
            {"p": json.dumps(updated), "i": user_id},
        )
        moved += 1
    print(f"[chat-module] carried AI Chat access to {moved} user(s)")


def downgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, permissions FROM users WHERE permissions IS NOT NULL")
    ).fetchall()
    for user_id, perms in rows:
        if isinstance(perms, str):
            try:
                perms = json.loads(perms)
            except ValueError:
                continue
        if not isinstance(perms, dict) or "chat" not in perms:
            continue
        updated = {k: v for k, v in perms.items() if k != "chat"}
        conn.execute(
            sa.text("UPDATE users SET permissions = CAST(:p AS jsonb) WHERE id = :i"),
            {"p": json.dumps(updated), "i": user_id},
        )
