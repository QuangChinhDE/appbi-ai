"""THE authorization decision: principal + action + resource -> decision.

    can(db, user, action, resource)       -> Decision (allowed, reason, via)
    require(db, user, action, resource)   -> resource, or 404 (cannot read) / 403
    capabilities(db, user, resource)      -> {action: bool} for the frontend
    scope(db, user, Model)                -> SQL-filtered query of readable rows

The PRINCIPAL is the authenticated User object as the auth layer stamped it: a
human session, or a personal access token (capped by its scopes, see
core.dependencies._normalize_permissions). Public links, embed grants and
workspace app users authenticate through their own capability paths and never
reach this module as a User.

ACTIONS are business actions, not HTTP verbs. Each resource POLICY says which
actions exist for it; an action a policy does not declare is DENIED, and an
unknown resource is DENIED.

Policies:
* "generic" - owner / share (user or team) / module entitlement, through
  core.dependencies.get_effective_permission (none < view < edit < full,
  where full = owner with the module at edit, or the module administrator).
* "dataset" - the canonical Dataset capability model
  (services.dataset_grants_service.dataset_capabilities).
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Dict, Iterable, Optional

from fastapi import HTTPException, status


class Action(str, Enum):
    READ = "read"
    EXPLORE = "explore"
    BUILD = "build"
    EDIT = "edit"
    DELETE = "delete"
    SHARE = "share"
    GRANT = "grant"
    PUBLISH = "publish"
    MANAGE = "manage"
    TRIGGER_COMPUTE = "trigger_compute"
    USE_SECRET = "use_secret"
    MANAGE_SECRET = "manage_secret"
    EXPORT = "export"
    EXPORT_CREDENTIALS = "export_credentials"
    RUNTIME_READ = "runtime_read"
    RUNTIME_WRITE = "runtime_write"
    UPLOAD_MEDIA = "upload_media"


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str
    via: str = ""

    def __bool__(self) -> bool:
        return self.allowed


# Generic policy: the effective level each action needs.
_GENERIC_NEEDS: Dict[Action, str] = {
    Action.READ: "view",
    Action.RUNTIME_READ: "view",
    Action.EXPLORE: "view",
    Action.EDIT: "edit",
    Action.BUILD: "view",
    Action.RUNTIME_WRITE: "edit",
    Action.UPLOAD_MEDIA: "edit",
    Action.EXPORT: "edit",
    Action.TRIGGER_COMPUTE: "edit",
    Action.USE_SECRET: "edit",
    Action.DELETE: "full",
    Action.SHARE: "full",
    Action.GRANT: "full",
    Action.PUBLISH: "full",
    Action.MANAGE: "full",
    Action.MANAGE_SECRET: "full",
    Action.EXPORT_CREDENTIALS: "full",
}

# Dataset policy: the capability each action needs.
_DATASET_NEEDS: Dict[Action, str] = {
    Action.READ: "view",
    Action.EXPLORE: "explore",
    Action.EXPORT: "explore",
    Action.BUILD: "build",
    Action.EDIT: "edit",
    Action.TRIGGER_COMPUTE: "edit",
    Action.GRANT: "reshare",
    Action.SHARE: "reshare",
    Action.PUBLISH: "manage",
    Action.MANAGE: "manage",
    Action.DELETE: "manage",
}


def _spec(resource):
    from app.core.authz.registry import spec_for

    return spec_for(resource)


def can(db, user, action: Action, resource) -> Decision:
    if user is None or resource is None:
        return Decision(False, "no principal or resource")
    try:
        action = Action(action)
    except ValueError:
        return Decision(False, f"unknown action {action!r}")
    spec = _spec(resource)
    if spec is None:
        return Decision(False, f"unregistered resource {type(resource).__name__}")
    if spec.policy == "dataset":
        need = _DATASET_NEEDS.get(action)
        if need is None:
            return Decision(False, f"action {action.value} is not defined for datasets")
        from app.services.dataset_grants_service import dataset_capabilities

        caps = dataset_capabilities(db, user, resource)
        return Decision(need in caps, f"needs {need}", "dataset_policy")
    if spec.policy == "generic":
        need = _GENERIC_NEEDS.get(action)
        if need is None:
            return Decision(False, f"action {action.value} is not defined for {spec.resource_type}")
        from app.core.dependencies import LEVEL_ORDER, get_effective_permission

        eff = get_effective_permission(db, user, resource, spec.module)
        return Decision(LEVEL_ORDER.get(eff, 0) >= LEVEL_ORDER[need], f"needs {need}, has {eff}",
                        "generic_policy")
    return Decision(False, f"unknown policy {spec.policy!r}")


def require(db, user, action: Action, resource):
    """The resource, or 404 when the caller cannot even read it (existence is
    not disclosed) / 403 when they can read but not do ``action``."""
    if can(db, user, action, resource):
        return resource
    if action != Action.READ and can(db, user, Action.READ, resource):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"Permission denied: {Action(action).value}")
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


def require_all(db, user, pairs: Iterable) -> None:
    """Cross-resource operations: every (action, resource) must be allowed."""
    for action, resource in pairs:
        require(db, user, action, resource)


def capabilities(db, user, resource, actions: Optional[Iterable[Action]] = None) -> Dict[str, bool]:
    """What THIS caller may do with ``resource`` - computed here, consumed by the
    frontend as UX. Every mutation is still re-checked by the API."""
    spec = _spec(resource)
    if spec is None:
        return {}
    table = _DATASET_NEEDS if spec.policy == "dataset" else _GENERIC_NEEDS
    acts = list(actions) if actions is not None else list(table)
    if spec.policy == "dataset":
        from app.services.dataset_grants_service import dataset_capabilities

        caps = dataset_capabilities(db, user, resource)
        return {a.value: table.get(a) in caps for a in acts if a in table}
    from app.core.dependencies import LEVEL_ORDER, get_effective_permission

    eff = LEVEL_ORDER.get(get_effective_permission(db, user, resource, spec.module), 0)
    return {a.value: eff >= LEVEL_ORDER[table[a]] for a in acts if a in table}


def capabilities_for_level(level: str | None) -> Dict[str, bool]:
    """Generic-resource capabilities from an effective level the caller already
    computed (no query). The level -> action table stays HERE, so no endpoint
    or page compares levels itself."""
    from app.core.dependencies import LEVEL_ORDER

    eff = LEVEL_ORDER.get(level or "none", 0)
    return {a.value: eff >= LEVEL_ORDER[need] for a, need in _GENERIC_NEEDS.items()}


def scope(db, user, model):
    """Rows of ``model`` the caller may READ - the same policy as ``can(READ)``."""
    from app.core.authz.registry import spec_for_model
    from app.core.permissions import _owned_or_shared
    from app.models.resource_share import ResourceType

    spec = spec_for_model(model)
    if spec is None:
        return db.query(model).filter(False)
    return _owned_or_shared(db, model, ResourceType(spec.resource_type), user)



#: Where a resource carries ITS CALLER's capabilities. `capabilities` everywhere,
#: except on a data source, whose `capabilities` is the PROVIDER's (what the
#: connector can do - Source module, services/source_capabilities.py).
_CAPS_ATTR = {"datasource": "access_capabilities"}


def caps_attr(resource_or_spec) -> str:
    spec = resource_or_spec if hasattr(resource_or_spec, "resource_type") else _spec(resource_or_spec)
    return _CAPS_ATTR.get(getattr(spec, "resource_type", ""), "capabilities")


def attach_capabilities(db, user, resources) -> None:
    """Set ``resource.capabilities`` = {action: bool} on every resource, for the
    frontend to decide which controls to show WITHOUT knowing owners, shares,
    teams, grants, PAT caps or module admins. Batched: a constant number of
    queries for a whole list. Every mutation is still re-checked by the API.

    Generic resources reuse the effective level the endpoint already stamped
    (``user_permission``); ``publish`` is ownership + capped entitlement (no
    query). Datasets use the batched Dataset policy."""
    rs = [r for r in (resources or []) if r is not None]
    if not rs:
        return
    spec = _spec(rs[0])
    if spec is None:
        return
    if spec.policy == "dataset":
        from app.services.dataset_grants_service import batch_dataset_capabilities

        caps = batch_dataset_capabilities(db, user, rs)
        for r in rs:
            have = caps.get(r.id, set())
            setattr(r, caps_attr(spec), {a.value: need in have for a, need in _DATASET_NEEDS.items()})
        return
    from app.core.dependencies import LEVEL_ORDER, can_publish, get_effective_permission

    for r in rs:
        level = getattr(r, "user_permission", None) or get_effective_permission(db, user, r, spec.module)
        n = LEVEL_ORDER.get(level, 0)
        out = {a.value: n >= LEVEL_ORDER[need] for a, need in _GENERIC_NEEDS.items()}
        out["publish"] = n > 0 and can_publish(db, user, r, spec.module)
        setattr(r, caps_attr(spec), out)
