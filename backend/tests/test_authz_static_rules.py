"""Business code may not re-implement authorization (static, CI-enforced).

The authorization decision lives in core (registry, dependencies, permissions,
resource_shares, share_access, authz/) and in the Dataset policy service. A
module that reads ``user.permissions`` itself, queries ``ResourceShare`` /
``DatasetGrant`` directly, or decides "admin" by comparing a level to the
string ``"full"`` is building an authorization model of its own - which is how
every finding of the authz review happened (PAT caps bypassed, a second
Dataset engine, owner columns drifting, a NULL-dataset "global").

Each allow-list entry names WHY it may touch the internal directly. A new hit
fails CI: route it through the core API (decision.can/require/scope,
get_user_module_permission, is_module_admin, module_at_least,
dataset_grants_service) or argue for an entry here in review.
"""
from __future__ import annotations

import pathlib
import re

APP = pathlib.Path(__file__).resolve().parents[1] / "app"

CORE = {
    "core/dependencies.py", "core/permissions.py", "core/resource_shares.py",
    "core/share_access.py", "core/authz/registry.py", "core/authz/decision.py",
}

RULES = {
    # rule -> (regex, allow-list {path: reason})
    "raw user.permissions read": (
        re.compile(r"\b(current_user|user|admin|owner|u)\.permissions\b(?!\s*=[^=])"),
        {**{p: "core: the one normalizer / PAT cap" for p in CORE},
         "api/permissions.py": "the permission-matrix API itself (reads/writes the stored row)"},
    ),
    "direct ResourceShare query": (
        re.compile(r"\bResourceShare\b"),
        {**{p: "core share engine" for p in CORE},
         "api/shares.py": "the share API (the engine's only writer)",
         "core/user_deletion.py": "counts a deleted user's shares for the impact preview",
         "services/governance_service.py": "deleting a document removes its share rows",
         "modules/agent_flows/api.py": "delegation-impact report lists who a flow is shared with",
         "services/dataset_grants_service.py": "docstring only (legacy note)"},
    ),
    "direct DatasetGrant query": (
        re.compile(r"\bDatasetGrant\b"),
        {"services/dataset_grants_service.py": "THE Dataset policy and its storage",
         "api/shares.py": "ShareDialog adapter over grants",
         "core/permissions.py": "comment only",
         "services/dataset_composition_service.py": "docstring only"},
    ),
    "level compared to 'full'": (
        re.compile(r"""(permission|level|_level\([^)]*\)|perms?\.get\([^)]*\))\s*(==|!=)\s*['"]full['"]"""),
        {**{p: "core: the one place 'full' is interpreted" for p in CORE}},
    ),
}


def _files():
    for path in APP.rglob("*.py"):
        rel = path.relative_to(APP).as_posix()
        if rel.startswith("models/") or "/__pycache__/" in rel:
            continue
        yield rel, path.read_text(encoding="utf-8")


def test_no_business_module_reimplements_authorization():
    problems = []
    for name, (rx, allowed) in RULES.items():
        for rel, text in _files():
            if rel in allowed:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                code = line.split("#", 1)[0]
                if rx.search(code):
                    problems.append(f"[{name}] {rel}:{i}: {line.strip()[:120]}")
    assert not problems, "authorization internals used outside core:\n  " + "\n  ".join(problems)


def test_allow_list_entries_still_exist():
    """A stale exemption is a licence nobody reviews: an allowed file that no
    longer touches the internal must leave the list."""
    files = dict(_files())
    stale = []
    for name, (rx, allowed) in RULES.items():
        for rel in allowed:
            if rel in CORE:
                continue
            text = files.get(rel)
            if text is None or not rx.search(text):
                stale.append(f"[{name}] {rel}")
    assert not stale, "stale allow-list entries:\n  " + "\n  ".join(stale)


def test_system_principal_is_never_built_in_a_route():
    """System authority may only be created in trusted scheduler/worker code."""
    hits = [rel for rel, text in _files()
            if rel.startswith(("api/", "routers/")) or "/api.py" in rel
            if re.search(r"\bSystemPrincipal\(|\bSystem\(", text)]
    assert not hits, hits


# ── Dataset policy port (core -> services by registration, fail closed) ──────

def test_dataset_policy_port_fails_closed_when_unregistered(monkeypatch):
    """Core reaches the Dataset policy only through core.authz.dataset_policy.
    With no provider registered it must REFUSE, never answer with a default."""
    import pytest
    from app.core.authz import dataset_policy as port
    from app.core.dependencies import can_publish, get_effective_permission

    monkeypatch.setattr(port, "_provider", None)

    class Dataset:  # matched by type name in core.dependencies
        id = 1
        owner_id = 1

    class _User:
        id = 1
        permissions = {"datasets": "edit"}

    with pytest.raises(port.DatasetPolicyNotRegistered):
        port.dataset_policy()
    with pytest.raises(port.DatasetPolicyNotRegistered):
        get_effective_permission(None, _User(), Dataset(), "datasets")
    with pytest.raises(port.DatasetPolicyNotRegistered):
        can_publish(None, _User(), Dataset(), "datasets")


def test_dataset_policy_port_is_wired_by_services_package():
    """Any import of app.services (every entrypoint does) registers THE Dataset
    policy, so the fail-closed branch above is never the runtime path."""
    import app.services  # noqa: F401
    import app.services.dataset_grants_service as dgs
    from app.core.authz.dataset_policy import dataset_policy

    assert dataset_policy() is dgs
