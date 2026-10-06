"""THE authorization registry: the one place module and resource facts live.

Before this, the same facts were written out by hand in four places that had
already drifted once each (core.dependencies._MODEL_TO_MODULE /
_MODEL_TO_RESOURCE_TYPE, core.permissions._RESOURCE_TO_MODULE,
core.share_access._RESOURCE_MODEL_MAP, api.permissions level tables): a
resource missing from one map was silently "not shared" on one path and
shareable on another; the chat-thread owner column was recognised by the list
filter and not by the object check.

Everything below is DATA. The old names are derived from it (kept as aliases so
callers do not churn), and tests/test_authz_registry.py asserts there is no
other copy.

`core` is a leaf layer: models are named by class name, never imported here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Optional, Tuple

#: Ordered entitlement ladder. Stored value "full" is the MODULE ADMINISTRATOR
#: entitlement (decision Q8); it is never an object relation.
LEVEL_ORDER: Dict[str, int] = {"none": 0, "view": 1, "edit": 2, "full": 3}
MODULE_ADMIN_LEVEL = "full"


@dataclass(frozen=True)
class ModuleSpec:
    key: str
    levels: Tuple[str, ...] = ("none", "view", "edit", "full")
    #: Feature flag deciding whether the module is offered at all. None = always.
    enabled: Optional[Callable[[], bool]] = None
    #: Personal access tokens may be scoped to this module.
    pat_eligible: bool = False


def _flag(*names: str) -> Callable[[], bool]:
    def _check() -> bool:
        from app.core.config import settings

        return all(bool(getattr(settings, n, False)) for n in names)
    return _check


MODULES: Tuple[ModuleSpec, ...] = (
    ModuleSpec("data_sources", pat_eligible=True),
    ModuleSpec("datasets", pat_eligible=True),
    ModuleSpec("govern", enabled=_flag("METADATA_CATALOG_ENABLED", "GOVERN_ENABLED")),
    ModuleSpec("agent_flows", enabled=_flag("METADATA_CATALOG_ENABLED", "GOVERN_ENABLED")),
    ModuleSpec("chat", enabled=_flag("METADATA_CATALOG_ENABLED", "GOVERN_ENABLED")),
    ModuleSpec("observability", enabled=_flag("METADATA_CATALOG_ENABLED", "OBSERVABILITY_ENABLED")),
    ModuleSpec("explore_charts", pat_eligible=True),
    ModuleSpec("dashboards", pat_eligible=True),
    ModuleSpec("workboards", enabled=_flag("WORKBOARDS_ENABLED"), pat_eligible=True),
    ModuleSpec("settings", levels=("none", "full")),
)

MODULE_KEYS: Tuple[str, ...] = tuple(m.key for m in MODULES)
MODULE_SPECS: Dict[str, ModuleSpec] = {m.key: m for m in MODULES}
ALL_MODULE_ALLOWED_LEVELS: Dict[str, list] = {m.key: list(m.levels) for m in MODULES}
PAT_MODULES: Tuple[str, ...] = tuple(m.key for m in MODULES if m.pat_eligible)


def module_enabled(key: str) -> bool:
    spec = MODULE_SPECS.get(key)
    if spec is None:
        return False
    return True if spec.enabled is None else bool(spec.enabled())


@dataclass(frozen=True)
class ResourceSpec:
    #: ResourceType value (resource_shares.resource_type).
    resource_type: str
    #: ORM class name (core never imports feature models).
    model: str
    #: Module whose entitlement is the ceiling for this resource.
    module: str
    #: Attribute whose value a ResourceShare row carries.
    share_key: str = "id"
    #: Columns that make a caller the OWNER, in priority order. An *_email
    #: column is compared case-insensitively to the caller's email.
    owner_attrs: Tuple[str, ...] = ("owner_id",)
    #: Which policy decides it (see core.authz.decision).
    policy: str = "generic"
    #: May be shared through the generic /shares endpoints.
    shareable: bool = True
    notes: str = ""


RESOURCES: Tuple[ResourceSpec, ...] = (
    ResourceSpec("datasource", "DataSource", "data_sources"),
    ResourceSpec("dataset", "Dataset", "datasets", policy="dataset"),
    ResourceSpec("chart", "Chart", "explore_charts"),
    ResourceSpec("dashboard", "Dashboard", "dashboards"),
    ResourceSpec("workboard", "Workboard", "workboards"),
    ResourceSpec("knowledge_doc", "GovernKnowledgeDoc", "govern"),
    ResourceSpec("agent_brain", "AgentBrainVersion", "agent_flows", share_key="brain_key",
                 owner_attrs=("owner_email",),
                 notes="shares keyed by brain_key: one share covers every version"),
    # A conversation is owned through `user_id`. The object check used to know
    # only owner_id/owner_email, so the owner of a thread could not share it.
    ResourceSpec("chat_thread", "AgentFlowChatThread", "chat", owner_attrs=("user_id",)),
    ResourceSpec("ai_credential", "AiProviderCredential", "agent_flows"),
)

RESOURCE_SPECS: Dict[str, ResourceSpec] = {r.resource_type: r for r in RESOURCES}
MODEL_SPECS: Dict[str, ResourceSpec] = {r.model: r for r in RESOURCES}

# ── Derived, never re-typed ─────────────────────────────────────────────────
RESOURCE_TO_MODULE: Dict[str, str] = {r.resource_type: r.module for r in RESOURCES}
MODEL_TO_MODULE: Dict[str, str] = {r.model: r.module for r in RESOURCES}


def spec_for(resource) -> Optional[ResourceSpec]:
    """The spec of an ORM instance (by class name), or None (= unknown: deny)."""
    return MODEL_SPECS.get(type(resource).__name__)


def spec_for_model(model) -> Optional[ResourceSpec]:
    return MODEL_SPECS.get(getattr(model, "__name__", ""))
