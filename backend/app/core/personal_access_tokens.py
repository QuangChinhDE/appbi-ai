"""Helpers for opaque personal access tokens."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from collections.abc import Mapping

from app.core.config import settings

PAT_TOKEN_PREFIX = "appbi_pat_"
PAT_SECRET_BYTES = 32
PAT_MAX_EXPIRES_IN_DAYS = 365
PAT_MODULES = (
    "data_sources",
    "datasets",
    "explore_charts",
    "dashboards",
    "workboards",
)
PAT_SCOPE_ALLOWED_LEVELS: dict[str, tuple[str, ...]] = {
    "data_sources": ("none", "view", "edit", "full"),
    "datasets": ("none", "view", "edit", "full"),
    "explore_charts": ("none", "view", "edit", "full"),
    "dashboards": ("none", "view", "edit", "full"),
    "workboards": ("none", "view", "edit", "full"),
}
PAT_LEVEL_ORDER = {"none": 0, "view": 1, "edit": 2, "full": 3}


def create_personal_access_token_secret() -> str:
    return secrets.token_urlsafe(PAT_SECRET_BYTES)


def build_personal_access_token(token_id: uuid.UUID, secret: str) -> str:
    return f"{PAT_TOKEN_PREFIX}{token_id.hex}.{secret}"


def build_personal_access_token_hint(token_id: uuid.UUID, secret_suffix: str) -> str:
    return f"{PAT_TOKEN_PREFIX}{token_id.hex[:8]}...{secret_suffix}"


def hash_personal_access_token_secret(secret: str) -> str:
    key = settings.SECRET_KEY.encode("utf-8")
    return hmac.new(key, secret.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_personal_access_token_secret(secret: str, secret_hash: str) -> bool:
    expected = hash_personal_access_token_secret(secret)
    return hmac.compare_digest(expected, str(secret_hash or ""))


def parse_personal_access_token(raw_token: str) -> tuple[uuid.UUID, str] | None:
    token = str(raw_token or "").strip()
    if not token.startswith(PAT_TOKEN_PREFIX):
        return None

    payload = token[len(PAT_TOKEN_PREFIX):]
    token_id_text, separator, secret = payload.partition(".")
    if not separator or not token_id_text or not secret:
        return None

    try:
        token_id = uuid.UUID(hex=token_id_text)
    except ValueError:
        return None

    return token_id, secret


def validate_personal_access_token_scopes(scopes: Mapping[str, object] | None) -> dict[str, str]:
    if not isinstance(scopes, Mapping) or not scopes:
        raise ValueError("At least one module scope is required")

    normalized: dict[str, str] = {}
    for module, raw_level in scopes.items():
        if module not in PAT_SCOPE_ALLOWED_LEVELS:
            raise ValueError(f"Invalid module: {module}")

        level = str(raw_level or "none").strip().lower()
        allowed_levels = PAT_SCOPE_ALLOWED_LEVELS[module]
        if level not in allowed_levels:
            raise ValueError(
                f"Invalid level '{level}' for module '{module}'. Allowed: {list(allowed_levels)}"
            )
        if level != "none":
            normalized[module] = level

    if not normalized:
        raise ValueError("At least one module scope with access above 'none' is required")

    return normalized


def ensure_scopes_within_user_permissions(
    scopes: Mapping[str, str],
    user_permissions: Mapping[str, str],
) -> None:
    for module, requested_level in scopes.items():
        user_level = str(user_permissions.get(module, "none") or "none").strip().lower()
        if PAT_LEVEL_ORDER.get(requested_level, 0) > PAT_LEVEL_ORDER.get(user_level, 0):
            raise ValueError(
                f"Requested level '{requested_level}' for module '{module}' exceeds your current permission '{user_level}'"
            )
