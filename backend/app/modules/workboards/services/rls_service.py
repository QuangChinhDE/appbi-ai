"""Row-level security engine for workboards.

The runtime calls :func:`build_rls_filter` before every read query and
:func:`enforce_write_access` before every insert/update/delete to translate
the workboard's declared :class:`RowLevelSecurity` rules + the caller's
identity into concrete LiveQuery filter dicts.

There are two identity sources that can drive RLS:

* AppBI authenticated user — the legacy path, used when an admin opens the
  workboard inside the AppBI shell. Only the legacy ``owner_column`` rule
  applies here today; broader role-based rules are reserved for app users.
* Workspace app user — the new path, used when a worker/foreman opens the
  public ``/w/{token}`` link. The role attached to their session token
  picks one of ``app_user_rules`` (falling back to ``app_user_default``).

If RLS is enabled but no matching rule is found and no default exists, the
engine fails closed: list queries return zero rows and writes are denied.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status

from app.core.logging import get_logger
from app.modules.workboards.roles import is_owner_role
from app.modules.workboards.schemas import RlsRoleRule, RowLevelSecurity

logger = get_logger(__name__)


_PLACEHOLDER_RE = re.compile(r"^\{\{\s*app_user\.([a-zA-Z0-9_]+)\s*\}\}$")


# ── Identity wrapper ──────────────────────────────────────────────────────

class CallerIdentity:
    """Light wrapper around the caller's identity, abstracting over
    AppBI users and workspace app users."""

    __slots__ = ("appbi_user_id", "app_user")

    def __init__(
        self,
        *,
        appbi_user_id: Optional[str] = None,
        app_user: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.appbi_user_id = appbi_user_id
        self.app_user = app_user or None

    @property
    def is_app_user(self) -> bool:
        return self.app_user is not None

    @property
    def role(self) -> Optional[str]:
        if not self.app_user:
            return None
        role = self.app_user.get("role")
        return str(role) if role is not None else None


def identity_from_appbi(user) -> CallerIdentity:
    return CallerIdentity(appbi_user_id=str(getattr(user, "id", "")) or None)


def identity_from_app_user(app_user_payload: Dict[str, Any]) -> CallerIdentity:
    return CallerIdentity(app_user=dict(app_user_payload or {}))


# ── Rule resolution ───────────────────────────────────────────────────────

def _resolve_placeholder(value: Any, identity: CallerIdentity) -> Any:
    """Substitute ``{{app_user.<key>}}`` placeholders inside the rule value.

    Returns the substituted value, or ``None`` if the placeholder cannot be
    resolved (e.g. the app user has no such context column). Callers treat
    ``None`` as "no possible match" — the safe default.
    """
    if not isinstance(value, str):
        return value
    match = _PLACEHOLDER_RE.match(value.strip())
    if not match:
        return value
    key = match.group(1)
    if not identity.app_user:
        return None
    if key == "username":
        return identity.app_user.get("username")
    return identity.app_user.get(key)


def _pick_rule(rls: RowLevelSecurity, identity: CallerIdentity) -> Optional[RlsRoleRule]:
    if not identity.is_app_user:
        return None
    role = (identity.role or "").strip().lower()
    for rule in rls.app_user_rules or []:
        if rule.role.strip().lower() == role:
            return rule
    return rls.app_user_default


# ── Public API ────────────────────────────────────────────────────────────

class RlsDenied(HTTPException):
    def __init__(self, detail: str = "You do not have access to this resource.") -> None:
        super().__init__(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def build_rls_filter(
    rls: Optional[RowLevelSecurity],
    identity: CallerIdentity,
) -> Tuple[List[Dict[str, Any]], bool]:
    """Translate RLS config + identity into LiveQuery filter dicts.

    Returns ``(filters, allowed)``:

    * ``filters`` is the list of additional filter dicts to append to the
      caller-supplied filters before executing the read query.
    * ``allowed=False`` means the caller is hard-denied (e.g. RLS is
      enabled, they're an app user, no rule matches their role and no
      default exists). The runtime should return an empty result without
      executing the query in that case.

    When RLS is disabled (or rls is None), returns ``([], True)``.
    """
    if rls is None or not rls.enabled:
        return [], True

    # Legacy AppBI-user owner filter.
    if not identity.is_app_user and rls.owner_column and identity.appbi_user_id:
        return (
            [
                {
                    "field": rls.owner_column,
                    "operator": "eq",
                    "value": identity.appbi_user_id,
                }
            ],
            True,
        )

    if not identity.is_app_user:
        # AppBI user with no owner_column rule → unrestricted (admin path).
        return [], True

    if is_owner_role(identity.role):
        return [], True

    rule = _pick_rule(rls, identity)
    if rule is None:
        # Closed by default: app users that don't match any rule see nothing.
        return [], False

    if rule.unrestricted:
        return [], True

    if not rule.filter_column:
        return [], False

    resolved = _resolve_placeholder(rule.filter_value, identity)
    if resolved is None:
        return [], False
    return (
        [
            {
                "field": rule.filter_column,
                "operator": "eq",
                "value": resolved,
            }
        ],
        True,
    )


def enforce_write_access(
    rls: Optional[RowLevelSecurity],
    identity: CallerIdentity,
    *,
    op: str,
    row_values: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Validate that ``identity`` may perform ``op`` and constrain payload.

    ``op`` is one of ``"insert"``, ``"update"``, ``"delete"``.

    Returns a sanitised copy of ``row_values`` with any read-only columns
    stripped out. Raises :class:`RlsDenied` if the caller is forbidden.
    """
    if rls is None or not rls.enabled:
        return dict(row_values or {})

    # AppBI users with the legacy owner_column rule are unrestricted on
    # writes; the legacy contract relied on object-level permission checks
    # in the API layer, which still run. We don't want to retro-tighten.
    if not identity.is_app_user:
        return dict(row_values or {})

    if is_owner_role(identity.role):
        return dict(row_values or {})

    rule = _pick_rule(rls, identity)
    if rule is None:
        raise RlsDenied()

    if op == "insert" and not rule.can_create:
        raise RlsDenied("Your role cannot create rows in this workboard.")
    if op == "update" and not rule.can_update:
        raise RlsDenied("Your role cannot update rows in this workboard.")
    if op == "delete" and not rule.can_delete:
        raise RlsDenied("Your role cannot delete rows in this workboard.")

    cleaned: Dict[str, Any] = dict(row_values or {})

    # When the rule pins a filter column to the caller (e.g. worker_email
    # = {{app_user.username}}), force-write that column to the caller's
    # value on insert so a worker cannot impersonate someone else.
    if op == "insert" and rule.filter_column and not rule.unrestricted:
        forced = _resolve_placeholder(rule.filter_value, identity)
        if forced is not None:
            cleaned[rule.filter_column] = forced

    if rule.readonly_columns:
        for col in rule.readonly_columns:
            cleaned.pop(col, None)

    if rule.writable_columns is not None:
        # Whitelist: keep only the listed columns + the auto-set RLS column.
        allowed = set(rule.writable_columns)
        if rule.filter_column and not rule.unrestricted:
            allowed.add(rule.filter_column)
        cleaned = {k: v for k, v in cleaned.items() if k in allowed}

    return cleaned
