"""The authz registry is the ONLY copy of module and resource facts.

core/authz/registry.py declares modules (keys, levels, flags, PAT eligibility)
and resources (model, ResourceType, module, share key, owner columns, policy).
Every older name must BE the registry's object or be derived from it, and the
places that cannot import it (share map with model classes, the frontend's
ModuleKey union) must agree with it - otherwise the next drift is silent.
"""
from __future__ import annotations

import pathlib
import re

from app.core.authz import registry


def test_old_names_are_the_registry():
    from app.api import permissions as api_perms
    from app.core import dependencies, permissions, personal_access_tokens

    assert dependencies.MODULE_KEYS is registry.MODULE_KEYS
    assert dependencies.LEVEL_ORDER is registry.LEVEL_ORDER
    assert permissions.LEVEL_ORDER is registry.LEVEL_ORDER
    assert api_perms.LEVEL_ORDER is registry.LEVEL_ORDER
    assert permissions._RESOURCE_TO_MODULE is registry.RESOURCE_TO_MODULE
    assert api_perms._ALL_MODULE_ALLOWED_LEVELS is registry.ALL_MODULE_ALLOWED_LEVELS
    assert personal_access_tokens.PAT_MODULES is registry.PAT_MODULES
    assert dependencies._MODEL_TO_MODULE == registry.MODEL_TO_MODULE
    assert {k: v.value for k, v in dependencies._MODEL_TO_RESOURCE_TYPE.items()} == {
        r.model: r.resource_type for r in registry.RESOURCES
    }


def test_share_map_agrees_with_the_registry():
    import app.services.agent_flows.credentials  # noqa: F401  (registers ai_credential)
    from app.core.share_access import _RESOURCE_MODEL_MAP

    for rtype, (model, module, key) in _RESOURCE_MODEL_MAP.items():
        spec = registry.RESOURCE_SPECS.get(rtype.value)
        assert spec is not None, f"{rtype.value} is shareable but not in the registry"
        assert spec.model == model.__name__, rtype
        assert spec.module == module, rtype
        assert spec.share_key == key, rtype
    shareable = {r.resource_type for r in registry.RESOURCES if r.shareable}
    assert shareable == {k.value for k in _RESOURCE_MODEL_MAP}, "registry says shareable, share map disagrees"


def test_every_resource_type_is_registered_or_declared_legacy():
    from app.models.resource_share import ResourceType

    legacy_unused = {"dataset_model", "chat_session"}
    for rt in ResourceType:
        assert rt.value in registry.RESOURCE_SPECS or rt.value in legacy_unused, rt


def test_registered_models_have_their_owner_columns():
    import app.main  # noqa: F401  (imports every model)
    from app.core.database import Base

    classes = {m.class_.__name__: m.class_ for m in Base.registry.mappers}
    for spec in registry.RESOURCES:
        cls = classes.get(spec.model)
        assert cls is not None, f"registry names unknown model {spec.model}"
        assert any(hasattr(cls, a) for a in spec.owner_attrs), (spec.model, spec.owner_attrs)
        assert hasattr(cls, spec.share_key), (spec.model, spec.share_key)
        assert spec.module in registry.MODULE_KEYS


def test_frontend_module_keys_match_the_registry():
    root = pathlib.Path(__file__).resolve().parents[2]
    src = (root / "frontend/src/hooks/use-permissions.ts").read_text(encoding="utf-8")
    block = re.search(r"export type ModuleKey\s*=([^;]+);", src).group(1)
    fe = re.findall(r"'([a-z_]+)'", block)
    assert tuple(fe) == registry.MODULE_KEYS, (fe, registry.MODULE_KEYS)
    lvl = re.search(r"export type PermissionLevel\s*=([^;]+);", src).group(1)
    assert set(re.findall(r"'([a-z_]+)'", lvl)) == set(registry.LEVEL_ORDER)


def test_module_flags_agree_with_mounted_routers():
    """A module the registry enables must have its router mounted, and the other
    way round (checked with every flag on, as the security job runs)."""
    from app.main import app

    paths = {getattr(r, "path", "") for r in app.routes}
    prefix = {"workboards": "/api/v1/workboards", "govern": "/api/v1/catalog",
              "agent_flows": "/api/v1/agent-flows", "observability": "/api/v1/observability"}
    for key, pre in prefix.items():
        mounted = any(p.startswith(pre) for p in paths)
        assert mounted == registry.module_enabled(key), (key, mounted)
