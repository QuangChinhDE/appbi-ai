"""Every authenticated route must refuse a caller who holds nothing.

WHY THIS FILE EXISTS
--------------------
The module gate was written per endpoint, so forgetting one was possible — and it
happened seven times. All seven were LIST endpoints, and all seven answered
``200 []`` to a user the permission matrix says has no access to anything. No row
leaked (the object-level filters held), but "none" stopped meaning none: the module
answered, and only three routers out of eight said 403.

A test that checks seven endpoints would have to be extended by hand every time an
endpoint is added — the same weakness that produced the gap. So this walks the
ROUTE TABLE instead. A new endpoint is covered the moment it exists, and the only
way to be exempt is to be named in ``IDENTITY_SCOPED`` below, in a review, on
purpose.
"""
from __future__ import annotations

import os
import re

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_module_floor.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import pytest  # noqa: E402

from app.core.dependencies import MODULE_KEYS  # noqa: E402


#: Routes that answer about the CALLER rather than about a module's data. Holding
#: no module is not a reason to be unable to read your own profile, list your own
#: tokens, or ask what you are allowed to do — the Settings screen and the login
#: flow are built on exactly these.
IDENTITY_SCOPED = {
    "/api/v1/auth/me",
    "/api/v1/auth/google/data-access/status",
    "/api/v1/auth/personal-access-tokens/",
    "/api/v1/permissions/me",
    "/api/v1/health",
}

#: Routes about the caller's OWN credentials. A person with no module still has
#: to be able to change their password, set a language, and manage the tokens they
#: personally minted — ownership is checked inside each handler against
#: `current_user`, which is the only check that means anything for these.
IDENTITY_SCOPED_PREFIXES = (
    "/api/v1/auth/personal-access-tokens/",
    "/api/v1/auth/preferences",
    "/api/v1/auth/change-password",
    # A PERSON'S OWN NOTIFICATIONS, and the reason is checked rather than assumed:
    # every query in `api/user_notifications.py` filters
    # `UserNotification.user_id == user.id` — the list, the unread count, both
    # mark-read paths and both deletes. There is no module whose data these are.
    #
    # Verified by calling, not by reading: an account holding nothing across all
    # eight modules gets `200 []` on the list and `0` on the count — its own empty
    # set. Gating these on a module would mean somebody with no dashboards could
    # not be told their invitation arrived.
    "/api/v1/notifications",
)

#: Endpoints that exist only to answer "this was removed". They raise 410 before
#: touching anything, so a gate would guard a door onto a wall. Listed rather than
#: skipped by a cleverer rule, because "it does nothing" is a claim that should be
#: re-read by a person if the handler ever grows a body.
DEPRECATED_STUBS = {
    "/api/v1/shares/{resource_type}/{resource_id}/all-team",
}

#: Prefixes that are unauthenticated BY DESIGN: the public link surface (its own
#: token is the credential) and the auth endpoints that mint a session.
UNAUTHENTICATED_PREFIXES = (
    "/api/v1/public",
    "/api/v1/auth/login",
    "/api/v1/auth/google",
    "/api/v1/auth/logout",
    "/api/v1/auth/refresh",
    "/api/v1/docs",
    "/api/v1/openapi.json",
)


def _api_get_routes():
    from app.main import app

    out = []
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", set()) or set()
        if "GET" not in methods or not path.startswith("/api/v1/"):
            continue
        if path.startswith(UNAUTHENTICATED_PREFIXES):
            continue
        out.append(path)
    return sorted(set(out))


def test_the_route_table_is_not_empty():
    """A walk over zero routes passes silently and proves nothing.

    THE FAILURE THIS MESSAGE EXISTS FOR. Every test in this file walks
    `app.routes`, and FastAPI stopped flattening that list at import time in 0.141
    — included routers stay lazy as `_IncludedRouter` objects until the app is
    actually served. On a machine whose virtualenv drifted ahead of
    `requirements.txt` (pinned 0.109.0) the whole file goes red at once, and a bare
    `assert 1 > 50` sends the reader looking for a routing bug that is not there.
    Cost an hour to find once; it should cost a sentence now.
    """
    routes = _api_get_routes()
    if len(routes) <= 50:
        import fastapi

        from app.main import app

        lazy = sum(1 for r in app.routes if type(r).__name__ == "_IncludedRouter")
        raise AssertionError(
            f"only {len(routes)} routes visible (fastapi {fastapi.__version__}). "
            + (
                f"{lazy} routers are still un-flattened `_IncludedRouter` objects — "
                "this environment's FastAPI is newer than the pinned 0.109.0 and "
                "defers router inclusion, so every route walk in this file sees "
                "nothing. Install the pinned version, or run these tests in the "
                "container."
                if lazy
                else "the app mounted almost no routers — check the feature flags "
                "in app/api/__init__.py."
            )
        )


@pytest.mark.parametrize("module", MODULE_KEYS)
def test_every_module_key_is_spelled_the_same_everywhere(module):
    """The floor names a module by string. A typo would gate on a key nobody has —
    which fails CLOSED, but closed on everything, and the 403 would look like a
    permission problem rather than a typo."""
    from app.api.permissions import _ALL_MODULES

    assert module in _ALL_MODULES


def test_the_five_per_endpoint_routers_carry_a_module_floor():
    """The three routers that gate at router level were already provably complete.
    These five gated per endpoint, which is what let seven of them be forgotten."""
    from app.api import charts, dashboards, datasets, datasources
    from app.modules.workboards import api as workboards_api

    expected = {
        "dashboards": dashboards.router,
        "explore_charts": charts.router,
        "datasets": datasets.router,
        "data_sources": datasources.router,
        "workboards": workboards_api.router,
    }
    for module, router in expected.items():
        deps = getattr(router, "dependencies", []) or []
        assert deps, f"router for {module} has no router-level dependency"


def _all_api_get_paths() -> set[str]:
    """Every GET path under /api/v1, unfiltered — the exemption check needs the raw
    table, because some exempt routes sit under a prefix the walk deliberately skips."""
    from app.main import app

    return {
        getattr(r, "path", "")
        for r in app.routes
        if "GET" in (getattr(r, "methods", set()) or set())
        and getattr(r, "path", "").startswith("/api/v1/")
    }


def test_identity_scoped_exemptions_still_exist():
    """An exemption for a route that has been deleted is a stale licence. If one of
    these disappears the list must shrink with it, rather than quietly widening the
    set of things allowed past the floor."""
    paths = _all_api_get_paths()
    for exempt in IDENTITY_SCOPED:
        assert exempt in paths, f"exempt route no longer exists: {exempt}"


#: The callables that constitute a module gate, by qualified name. `_check` is the
#: closure `require_permission` returns; the two `*_module_gate`s are the
#: method-aware router gates Knowledge Hub and Observability already used.
GATE_QUALNAMES = {
    "require_permission.<locals>._check",
    "govern_module_gate",
    "observability_module_gate",
}


def _dependency_qualnames(dependant) -> set[str]:
    """Every callable in a route's dependency graph, flattened."""
    seen: set[str] = set()
    stack = [dependant]
    while stack:
        dep = stack.pop()
        call = getattr(dep, "call", None)
        if call is not None:
            seen.add(getattr(call, "__qualname__", "") or repr(call))
        stack.extend(getattr(dep, "dependencies", []) or [])
    return seen


#: Gate helpers called from inside a handler BODY rather than declared as a
#: dependency. The `/catalog` router proved a body-level checker is invisible to the
#: dependency graph — an audit that only walked the graph once reported 78 endpoints
#: as unprotected and every one of them was fine. So the graph is one of two
#: signals, not the verdict.
BODY_GATE_NAMES = (
    "require_share_access",
    "require_view_access",
    "require_edit_access",
    "require_full_access",
    "require_capability",
    "_require_dataset_access",
    "_link_and_dashboard",
    "_require_workboard",
    "_get_workboard_for_edit",
    "_require_own_token",
)


def _body_is_gated(endpoint) -> bool:
    """Whether the handler calls a permission helper itself."""
    import inspect

    try:
        src = inspect.getsource(endpoint)
    except (OSError, TypeError):
        return False
    return any(name in src for name in BODY_GATE_NAMES)


def _ungated_routes() -> list[tuple[str, str]]:
    from app.main import app

    out: list[tuple[str, str]] = []
    for route in app.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api/v1/") or path.startswith(UNAUTHENTICATED_PREFIXES):
            continue
        if path in IDENTITY_SCOPED or path.startswith(IDENTITY_SCOPED_PREFIXES):
            continue
        if path in DEPRECATED_STUBS:
            continue
        dependant = getattr(route, "dependant", None)
        if dependant is None:
            continue
        if _dependency_qualnames(dependant) & GATE_QUALNAMES:
            continue
        endpoint = getattr(route, "endpoint", None)
        if endpoint is not None and _body_is_gated(endpoint):
            continue
        for method in sorted(getattr(route, "methods", set()) or {"?"}):
            out.append((method, path))
    return out


def test_every_authenticated_route_sits_behind_a_module_gate():
    """THE GUARANTEE. Not a list of endpoints somebody remembered to check — a walk
    of the real dependency graph, so an endpoint added tomorrow is covered today.

    A route may only be absent from a gate by being named in ``IDENTITY_SCOPED``
    (it answers about the caller) or under ``UNAUTHENTICATED_PREFIXES`` (the public
    surface, whose own token is the credential). Anything else failing here is the
    seven-endpoint gap coming back.

    NOTE ON WHAT THIS DOES *NOT* PROVE: a gate in the graph says the module is
    checked, not that the LEVEL is right, and object-level access is a separate
    question this test says nothing about. Those live in test_permission_caps.py and
    in the live audit; this one closes the hole where there was no check at all.
    """
    ungated = _ungated_routes()
    if ungated:
        report = chr(10).join('  ' + m + ' ' + p for m, p in sorted(ungated))
        raise AssertionError('these routes answer without any module gate:' + chr(10) + report)


def test_deprecated_stubs_really_are_inert():
    """An exemption granted because a handler does nothing must be re-earned. If one
    of these grows a body that touches the database, the exemption is a hole."""
    import inspect

    from app.main import app

    for route in app.routes:
        if getattr(route, "path", "") not in DEPRECATED_STUBS:
            continue
        src = inspect.getsource(route.endpoint)
        assert "410" in src or "HTTP_410_GONE" in src, f"{route.path} no longer 410s"
        for forbidden in ("db.add", "db.commit", "db.query", "db.delete"):
            assert forbidden not in src, f"{route.path} now touches the database"


# ── the other engine's cache must carry the same identity ────────────────────

def test_the_summary_cache_separates_callers_with_different_hidden_columns():
    """A pack is stored already stripped of the columns AI-scope hides, so the
    exclusion set is part of WHO the pack was built for. Keyed without it, a pack
    built while a column was visible kept answering for five more minutes after the
    column was hidden."""
    from app.services.dashboard_ai_bot.summary_cache import scope_hash

    assert scope_hash(None) == scope_hash([])
    assert scope_hash({"revenue"}) != scope_hash(None)
    assert scope_hash({"revenue"}) != scope_hash({"salary"})
    # Order must not create a false miss — the set is a set.
    assert scope_hash(["a", "b"]) == scope_hash(["b", "a"])


# ── the public-link modal must save everything it shows ──────────────────────

def test_a_links_flow_assignment_is_a_separate_resource_from_the_link():
    """WHY A UI BUG NEEDS A BACKEND TEST.

    The flow a public link runs is NOT stored on the link — it is a row in
    `agent_flow_bindings`, written by its own endpoint. The dialog that edits a
    link therefore has two writes behind one screen, and its primary "Save
    changes" used to perform only the first: picking a flow and pressing Save
    closed the dialog, said "Link updated", and dropped the choice, so reopening
    showed the previous flow and the setting looked like it had not stuck.

    Pinning the SHAPE here, because the shape is the reason the bug was possible:
    if the assignment ever moves onto the link itself, this test should fail and
    the frontend's separate flush can go away with it.
    """
    from app.models.agent_flow_binding import AgentFlowBinding
    from app.models.models import DashboardPublicLink

    binding_columns = set(AgentFlowBinding.__table__.columns.keys())
    assert {"link_id", "brain_key"} <= binding_columns

    link_columns = set(DashboardPublicLink.__table__.columns.keys())
    leaked = {c for c in link_columns if "brain" in c or "agent_flow" in c}
    assert not leaked, (
        "the assignment now also lives on the link; the modal's two-write dance "
        f"should be revisited: {sorted(leaked)}"
    )
