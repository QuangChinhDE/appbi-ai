"""Move app users from project datasets into AppBI-native ``workboard_app_users``.

Revision ID: 20260429_0001
Revises: 20260428_0002
Create Date: 2026-04-29

The previous design pinned end-user identity (username/PIN/role/active/context)
to a project-owned dataset table. That kept credentials in business data —
fragile to dataset re-imports, leaked through dataset preview, and forced
schema-drift wars whenever Excel headers changed.

Now identity lives next to the workboard that owns it. One row per
(workboard, username); credentials are bcrypt-hashed in AppBI's own DB.

Migration plan:

1. Create the new ``workboard_app_users`` table.
2. For every workspace whose ``app_users_config`` was populated, run a
   best-effort backfill: read every row through the existing dataset-based
   reader, then INSERT into ``workboard_app_users`` for each workboard
   listed in that workspace's menu_config. We dedupe on (workboard_id,
   username); if the same username appears in two workboards via the same
   workspace, both rows are inserted — different mini-apps, different
   accounts as far as login is concerned.
3. Drop ``workboards.app_users_config`` (added two days ago, no production
   data) and ``workboard_workspaces.app_users_config`` (the legacy column).

Backfill is wrapped in try/except per-workspace: an unparseable config or
unreachable datasource shouldn't block the schema upgrade. Anything that
fails just stays empty — admins can recreate users via the new Builder
"Users" tab.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

logger = logging.getLogger("alembic.workboard_app_users_native")

revision = "20260429_0001"
down_revision = "20260428_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workboard_app_users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "workboard_id",
            sa.Integer(),
            sa.ForeignKey("workboards.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("username", sa.String(255), nullable=False),
        sa.Column("pin_hash", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=True),
        sa.Column("role", sa.String(64), nullable=True),
        sa.Column(
            "active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "context",
            JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("workboard_id", "username", name="uq_wb_app_user"),
    )

    _backfill_users_from_workspace_configs()

    # Now-redundant columns. Drop both in the same revision so we don't
    # leave callers reading stale data while waiting for a follow-up.
    op.drop_column("workboards", "app_users_config")
    op.drop_column("workboard_workspaces", "app_users_config")


def downgrade() -> None:
    op.add_column(
        "workboard_workspaces",
        sa.Column("app_users_config", JSONB(), nullable=True),
    )
    op.add_column(
        "workboards",
        sa.Column("app_users_config", JSONB(), nullable=True),
    )
    op.drop_table("workboard_app_users")


# ── Backfill ─────────────────────────────────────────────────────────────


def _backfill_users_from_workspace_configs() -> None:
    """Best-effort copy of legacy app_users rows into workboard_app_users.

    We import inside the function so importing alembic in environments
    without the full app context (e.g. ``alembic upgrade head`` from a
    bare image) still works — the import only fires when this revision
    actually runs, by which point the runtime modules are present.
    """
    bind = op.get_bind()

    workspaces = bind.execute(
        sa.text(
            """
            SELECT id, app_users_config, menu_config
            FROM workboard_workspaces
            WHERE app_users_config IS NOT NULL
              AND app_users_config <> '{}'::jsonb
            """
        )
    ).fetchall()

    if not workspaces:
        return

    try:
        # Lazy imports — see docstring.
        from app.models.dataset import DatasetTable
        from app.models.models import DataSource
        from app.modules.workboards.models import Workboard
        from app.modules.workboards.workspace_schemas import AppUsersConfig
        from app.services.live_query_service import LiveQueryService
        from sqlalchemy.orm import Session
    except Exception as exc:  # pragma: no cover
        logger.warning(
            "skipping app_users backfill: runtime modules unavailable (%s)", exc
        )
        return

    session = Session(bind=bind)

    for ws_row in workspaces:
        try:
            cfg = AppUsersConfig.model_validate(ws_row.app_users_config or {})
        except Exception:
            logger.warning(
                "workspace %s has malformed app_users_config; skipping backfill",
                ws_row.id,
            )
            continue

        slugs = [
            (item.get("workboard_slug") or "").strip()
            for item in (ws_row.menu_config or [])
            if isinstance(item, dict) and item.get("workboard_slug")
        ]
        slugs = [s for s in slugs if s]
        if not slugs:
            continue

        workboards = (
            session.query(Workboard).filter(Workboard.slug.in_(slugs)).all()
        )
        if not workboards:
            continue

        rows = _read_app_user_rows(session, cfg)
        if not rows:
            logger.info(
                "workspace %s: app_users table empty or unreadable, skipping",
                ws_row.id,
            )
            continue

        for wb in workboards:
            for row in rows:
                username = _stringify(row.get(cfg.username_column))
                pin_hash = _stringify(row.get(cfg.credential_column))
                if not username or not pin_hash:
                    continue
                full_name = (
                    _stringify(row.get("full_name"))
                    or _stringify(row.get("name"))
                    or None
                )
                role = (
                    _stringify(row.get(cfg.role_column))
                    if cfg.role_column
                    else None
                )
                active = _coerce_active(row, cfg)
                context = {
                    col: row.get(col)
                    for col in (cfg.context_columns or [])
                    if col in row
                }
                try:
                    bind.execute(
                        sa.text(
                            """
                            INSERT INTO workboard_app_users
                              (workboard_id, username, pin_hash, full_name,
                               role, active, context)
                            VALUES
                              (:workboard_id, :username, :pin_hash, :full_name,
                               :role, :active, CAST(:context AS jsonb))
                            ON CONFLICT (workboard_id, username) DO NOTHING
                            """
                        ),
                        {
                            "workboard_id": wb.id,
                            "username": username,
                            "pin_hash": pin_hash,
                            "full_name": full_name,
                            "role": role,
                            "active": active,
                            "context": _json_dumps(context),
                        },
                    )
                except Exception as exc:
                    logger.warning(
                        "backfill failed for workspace=%s workboard=%s user=%s: %s",
                        ws_row.id,
                        wb.id,
                        username,
                        exc,
                    )

    session.close()


def _read_app_user_rows(session: Any, cfg: Any) -> List[Dict[str, Any]]:
    from app.models.dataset import DatasetTable
    from app.models.models import DataSource
    from app.services.live_query_service import LiveQueryService

    table = (
        session.query(DatasetTable).filter(DatasetTable.id == cfg.table_id).first()
    )
    if table is None:
        return []
    ds = (
        session.query(DataSource)
        .filter(DataSource.id == table.datasource_id)
        .first()
    )
    if ds is None:
        return []
    try:
        result = LiveQueryService.execute_preview_query(
            ds, table, limit=10000, offset=0, filters=[]
        )
    except Exception as exc:
        logger.warning("could not read app_users table=%s: %s", cfg.table_id, exc)
        return []
    rows = result.get("rows") or []
    return [r for r in rows if isinstance(r, dict)]


def _stringify(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _coerce_active(row: Dict[str, Any], cfg: Any) -> bool:
    if not cfg.active_column:
        return True
    raw = row.get(cfg.active_column)
    expected = getattr(cfg, "active_value", None)
    if expected is not None:
        return raw == expected
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return raw != 0
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "active", "enabled", "y", "t"}
    return bool(raw)


def _json_dumps(value: Any) -> str:
    import json

    return json.dumps(value or {}, ensure_ascii=False)
