"""Canonical app-user roles for workboards."""
from __future__ import annotations

from typing import Any, Optional


APP_USER_ROLE_USER = "user"
APP_USER_ROLE_ADMIN = "admin"
APP_USER_ROLE_OWNER = "owner"
DEFAULT_APP_USER_PIN = "123456"
CANONICAL_APP_USER_ROLES = (
    APP_USER_ROLE_USER,
    APP_USER_ROLE_ADMIN,
    APP_USER_ROLE_OWNER,
)


def normalize_app_user_role(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    lowered = text.lower()
    if lowered in CANONICAL_APP_USER_ROLES:
        return lowered
    return text


def is_owner_role(value: Any) -> bool:
    return str(value or "").strip().lower() == APP_USER_ROLE_OWNER


# Roles that act as app MANAGERS: they bypass per-screen visibility/access and
# RLS (see every screen + every row, may write anything, like the app builder).
# owner + admin. Use ONLY at access-gate bypass sites — never for owner-specific
# concerns (e.g. default-PIN warnings, which stay on is_owner_role).
PRIVILEGED_APP_USER_ROLES = (APP_USER_ROLE_ADMIN, APP_USER_ROLE_OWNER)


def is_privileged_role(value: Any) -> bool:
    return str(value or "").strip().lower() in PRIVILEGED_APP_USER_ROLES


def build_default_owner_username(workboard_id: Any) -> str:
    return f"owner_{int(workboard_id)}"
