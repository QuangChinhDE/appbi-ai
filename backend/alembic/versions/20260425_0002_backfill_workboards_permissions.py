"""Backfill ``workboards`` permission key for existing users.

The Workboard module is brand-new; existing users' ``permissions`` JSONB
columns do not contain a ``workboards`` key. ``_normalize_permissions``
defaults missing keys to ``"none"``, which would hide the Workboards
sidebar entry for every existing account — including the bootstrap admin.

This migration mirrors each user's ``dashboards`` level into a fresh
``workboards`` key so that:
  * full-access users (admins) immediately see and can manage workboards;
  * editors get edit access (matching their dashboards level);
  * viewers get view access;
  * users explicitly denied dashboards stay at ``none``.

Revision ID: 20260425_0002
Revises: 20260425_0001
Create Date: 2026-04-25
"""
from __future__ import annotations

from alembic import op


revision = "20260425_0002"
down_revision = "20260425_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE users
        SET permissions = permissions || jsonb_build_object(
            'workboards',
            COALESCE(permissions ->> 'dashboards', 'none')
        )
        WHERE NOT (permissions ? 'workboards');
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE users
        SET permissions = permissions - 'workboards'
        WHERE permissions ? 'workboards';
        """
    )
