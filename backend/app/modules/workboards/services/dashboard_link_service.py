"""Manage DashboardPublicLink rows owned by a workboard's dashboard screens.

Design (simpler than the earlier per-screen filter-overrides approach):

  * Each ``kind='dashboard'`` screen in *managed* mode stores
    ``dashboard_id`` plus an optional ``role_filter_mapping`` — a list of
    ``{datasetId, semanticField, operator}`` slots whose value is filled with
    the viewer's ``app_user.role`` at provision time.
  * The set of distinct roles on the workboard's ``app_users`` is the
    fan-out factor: one ``DashboardPublicLink`` per (screen, role) pair, with
    ``source='workboard'`` and a deterministic name
    ``wb:<wid>:<sid>:role=<role>``. The link's ``filters_config`` is the
    mapping with each slot's value replaced by the role string. When
    ``role_filter_mapping`` is empty all roles share an identical link (no
    filters) — useful for "everyone sees the same charts".
  * Sync runs eagerly on three triggers: app_user create/update/delete and
    workboard layout save. The function is idempotent; a no-op converges in
    a single pass.

We deliberately do NOT alter the dashboard public-runtime filter pipeline.
The managed link's filters look identical to any user-created share's
filters; the runtime applies them the same way (no hard-lock, no
``_dedupe_filters_by_field`` change). That matches the existing dashboard
share dialog's mental model and avoids regressing the ACR work the user just
shipped.
"""
from __future__ import annotations

import copy
import secrets
from typing import Any, Dict, List, Optional

from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.core.dependencies import get_effective_permission
from app.core.logging import get_logger
from app.models.models import Dashboard, DashboardPublicLink
from app.models.user import User
from app.modules.workboards.models import Workboard, WorkboardAppUser
from app.modules.workboards.roles import normalize_app_user_role

logger = get_logger(__name__)

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _managed_name(workboard_id: int, screen_id: str, role: str) -> str:
    """Deterministic link name.

    ``role`` is the post-normalised, non-empty role string. We use ``=`` in
    the suffix instead of ``:`` so a future role string containing ``:``
    can't collide with the ``wb:<id>:<sid>:`` prefix used elsewhere.
    """
    return f"wb:{workboard_id}:{screen_id}:role={role}"


def _norm_role(raw: Optional[str]) -> Optional[str]:
    """Return the canonical role string we key links by, or None to skip."""
    candidate = normalize_app_user_role(raw)
    if not candidate:
        return None
    return str(candidate).strip()[:64] or None


def _dashboard_screens(layout_json: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not isinstance(layout_json, dict):
        return []
    screens = layout_json.get("screens")
    if not isinstance(screens, list):
        return []
    return [
        s for s in screens
        if isinstance(s, dict) and str(s.get("kind") or "") == "dashboard"
    ]


def _user_can_view_dashboard(
    db: Session, dashboard: Dashboard, creator: Optional[User]
) -> bool:
    if creator is None:
        # No identifiable creator (system import) — accept; an admin must
        # intervene if the bind is wrong.
        return True
    effective = get_effective_permission(db, creator, dashboard, "dashboards")
    return effective in {"view", "edit", "full"}


def _distinct_roles_on_workboard(db: Session, workboard_id: int) -> List[str]:
    """All distinct, normalised app_user roles attached to this workboard.

    Returned sorted so the call signature is deterministic — useful in
    tests and for human inspection of the resulting links list.
    """
    rows = (
        db.query(WorkboardAppUser.role)
        .filter(WorkboardAppUser.workboard_id == workboard_id)
        .filter(WorkboardAppUser.active.is_(True))
        .all()
    )
    seen: set[str] = set()
    for (raw,) in rows:
        canonical = _norm_role(raw)
        if canonical:
            seen.add(canonical)
    return sorted(seen)


def _coerce_slot(entry: Any) -> Optional[Dict[str, Any]]:
    """Validate one filter slot and return a normalised dict, or None.

    Same contract the dashboard public runtime uses
    (``app/api/public.py::_public_filter_semantic_refs``): ``datasetId``
    must be an int and ``semanticField`` must contain a dot. Anything else
    would be silently ignored downstream, which is worse than dropping it
    here because the builder UI would suggest the slot is wired up.
    """
    if not isinstance(entry, dict):
        return None
    dataset_id = entry.get("datasetId")
    if not isinstance(dataset_id, int):
        try:
            dataset_id = int(dataset_id)
        except (TypeError, ValueError):
            return None
    semantic_field = entry.get("semanticField")
    if not isinstance(semantic_field, str) or "." not in semantic_field:
        return None
    return {
        "datasetId": dataset_id,
        "semanticField": semantic_field,
        "operator": entry.get("operator") or "eq",
    }


def _build_filters_config(
    mapping: List[Dict[str, Any]],
    role: str,
    static_filters: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Render the saved mapping into a concrete filters_config for one role.

    Order: role-mapped slots first, then static filters. The slicer model
    keys filters by (datasetId, semanticField) so a static filter that
    duplicates a role-mapped slot would be ignored downstream — we keep
    both in case the runtime ever changes, but the builder UI should
    prevent that case.
    """
    out: List[Dict[str, Any]] = []
    for entry in mapping or []:
        slot = _coerce_slot(entry)
        if slot is None:
            continue
        out.append({**slot, "value": role})

    for entry in static_filters or []:
        slot = _coerce_slot(entry)
        if slot is None:
            continue
        record: Dict[str, Any] = {**slot, "value": entry.get("value")}
        # Optional type hint (e.g. 'dropdown') survives — the dashboard
        # runtime forwards it to the FE for sensible default rendering.
        if isinstance(entry, dict) and entry.get("type"):
            record["type"] = entry["type"]
        out.append(record)
    return out


def _commit_link_changes(
    db: Session,
    link: DashboardPublicLink,
    *,
    dashboard_id: int,
    filters_config: List[Dict[str, Any]],
    password_hash: Optional[str],
) -> bool:
    """Update an existing link only when something the user controls changed.

    Returns True iff a field actually changed. Token, access_count, and
    timestamps are never touched here — they belong to the runtime.
    """
    changed = False
    if link.dashboard_id != dashboard_id:
        link.dashboard_id = dashboard_id
        changed = True
    if (link.filters_config or []) != filters_config:
        link.filters_config = filters_config
        changed = True
    if password_hash is None and link.password_hash is not None:
        link.password_hash = None
        changed = True
    elif password_hash is not None and link.password_hash is None:
        # First time the builder sets a password. We hash exactly once here;
        # later saves with the same plaintext re-use the existing hash so we
        # don't flap the row on every workboard save (bcrypt is salted →
        # non-deterministic).
        link.password_hash = password_hash
        changed = True
    if not link.is_active:
        link.is_active = True
        changed = True
    return changed


def sync_workboard_dashboard_links(
    db: Session,
    workboard: Workboard,
    *,
    creator: Optional[User] = None,
) -> Workboard:
    """Reconcile managed DashboardPublicLink rows for *workboard*.

    Fan-out = (managed dashboard screens) × (distinct app_user roles).
    Idempotent. Mutates ``workboard.layout_json`` in place to write back
    ``managed_links: {role: token}`` per screen so the public runtime can
    look up the token by role without an extra join.
    """
    layout = copy.deepcopy(workboard.layout_json or {})
    screens = _dashboard_screens(layout)

    distinct_roles = _distinct_roles_on_workboard(db, workboard.id)

    name_prefix = f"wb:{workboard.id}:"
    existing_rows = (
        db.query(DashboardPublicLink)
        .filter(
            DashboardPublicLink.source == "workboard",
            DashboardPublicLink.name.like(f"{name_prefix}%"),
        )
        .all()
    )
    existing: Dict[str, DashboardPublicLink] = {row.name: row for row in existing_rows}

    keep_names: set[str] = set()

    for screen in screens:
        dash_spec = screen.get("dashboard") or {}
        if not isinstance(dash_spec, dict):
            continue

        # Manual mode (or empty config) — clear any stale managed map.
        dashboard_id = dash_spec.get("dashboard_id")
        if dashboard_id is None:
            dash_spec["managed_links"] = {}
            continue

        try:
            dashboard_id_int = int(dashboard_id)
        except (TypeError, ValueError):
            logger.warning(
                "workboard %s screen %s: invalid dashboard_id=%r; skipping sync",
                workboard.id, screen.get("id"), dashboard_id,
            )
            dash_spec["managed_links"] = {}
            continue

        dashboard = (
            db.query(Dashboard).filter(Dashboard.id == dashboard_id_int).first()
        )
        if not dashboard:
            logger.warning(
                "workboard %s screen %s: dashboard_id=%s not found",
                workboard.id, screen.get("id"), dashboard_id_int,
            )
            dash_spec["managed_links"] = {}
            continue

        if not _user_can_view_dashboard(db, dashboard, creator):
            logger.warning(
                "workboard %s creator lacks view access to dashboard %s; skipping screen %s",
                workboard.id, dashboard_id_int, screen.get("id"),
            )
            dash_spec["managed_links"] = {}
            continue

        mapping = dash_spec.get("role_filter_mapping") or []
        static_filters = dash_spec.get("static_filters") or []
        password = dash_spec.get("password")
        password_hash = (
            _pwd_context.hash(password)
            if isinstance(password, str) and password
            else None
        )

        screen_id = str(screen.get("id") or "")
        managed_map: Dict[str, str] = {}

        # When no role exists on the workboard yet, still create a single
        # link (filters_config = static_filters only) so the builder's
        # "Preview as nobody" works and the share becomes usable the moment
        # the first app_user is added.
        roles_to_provision = distinct_roles or [""]

        for role in roles_to_provision:
            link_name = _managed_name(
                workboard.id, screen_id, role or "__default__",
            )
            keep_names.add(link_name)

            filters_config = _build_filters_config(
                mapping if role else [],
                role,
                static_filters=static_filters,
            )

            link = existing.get(link_name)
            if link is None:
                link = DashboardPublicLink(
                    dashboard_id=dashboard_id_int,
                    name=link_name,
                    token=secrets.token_urlsafe(32),
                    filters_config=filters_config,
                    appearance_config={},
                    is_active=True,
                    source="workboard",
                    created_by=getattr(workboard, "owner_id", None),
                    password_hash=password_hash,
                )
                db.add(link)
                db.flush()
            else:
                _commit_link_changes(
                    db, link,
                    dashboard_id=dashboard_id_int,
                    filters_config=filters_config,
                    password_hash=password_hash,
                )
            managed_map[role or "__default__"] = link.token

        dash_spec["managed_links"] = managed_map

    # Garbage-collect rows the layout no longer references (deleted screen,
    # removed role, manual mode).
    for name, row in existing.items():
        if name not in keep_names:
            db.delete(row)
            logger.info(
                "workboard %s: deleted stale managed link id=%s name=%s",
                workboard.id, row.id, row.name,
            )

    workboard.layout_json = layout
    db.commit()
    db.refresh(workboard)
    return workboard


def delete_all_for_workboard(db: Session, workboard_id: int) -> int:
    """Drop every managed link a workboard owns.

    Called when the workboard itself is deleted (cascade from
    ``dashboards.id`` handles the orthogonal case where the dashboard is
    deleted upstream).
    """
    name_prefix = f"wb:{workboard_id}:"
    deleted = (
        db.query(DashboardPublicLink)
        .filter(
            DashboardPublicLink.source == "workboard",
            DashboardPublicLink.name.like(f"{name_prefix}%"),
        )
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
        logger.info(
            "workboard %s: deleted %d managed dashboard links",
            workboard_id, deleted,
        )
    return int(deleted or 0)


def resolve_managed_token(
    *,
    layout_json: Optional[Dict[str, Any]],
    screen_id: str,
    app_user_role: Optional[str],
) -> Optional[str]:
    """Pick the share token for a public-runtime request.

    Returns ``None`` for manual-mode screens; the runtime then falls back to
    ``screen.dashboard.share_token``.
    """
    for screen in _dashboard_screens(layout_json):
        if str(screen.get("id") or "") != screen_id:
            continue
        dash_spec = screen.get("dashboard") or {}
        if not isinstance(dash_spec, dict):
            return None
        managed = dash_spec.get("managed_links") or {}
        if not isinstance(managed, dict) or not managed:
            return None
        role = _norm_role(app_user_role)
        if role and role in managed:
            return managed[role]
        return managed.get("__default__")
    return None
