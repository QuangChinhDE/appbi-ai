"""The authorization route walk must walk REAL routes.

WHY THIS FILE EXISTS
--------------------
``test_module_floor`` proves that every authenticated route sits behind a gate by
walking ``app.routes``. On FastAPI 0.141 that list is no longer flattened at import
time, so locally the walk saw one route and passed — a security gate that is green
because it checked nothing. CI pins 0.109.0 and was fine, but nothing made "the
walk saw the application" an asserted fact rather than a lucky one.

This file makes it one:

* the installed FastAPI must be the version ``requirements.txt`` pins;
* the walk must discover at least ``MIN_API_ROUTES`` API routes, and every router
  prefix in ``REQUIRED_PREFIXES`` — including the feature-flagged ones, so a job
  that forgot to enable Workboards fails here instead of skipping its surface;
* every API route is classified, and the inventory is printed so a reviewer of a
  green run can read what was actually covered.

The classification here is the Gate-T one (unauthenticated / identity-scoped /
module-gated). Object-level declarations are added by the authz core; this file is
then tightened to require them.
"""
from __future__ import annotations

import os
import pathlib
import re

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_authz_route_inventory.db"
if not os.environ.get("DATA_DIR"):
    os.environ["DATA_DIR"] = ".testdata"

import pytest  # noqa: E402

from tests import test_module_floor as floor  # noqa: E402

#: 505 routes are mounted with every module flag on (fastapi 0.109.0, 2026-10-06).
#: The floor sits below that so deleting a few endpoints does not fail the build,
#: and far above the single route an un-flattened router table exposes.
MIN_API_ROUTES = 450

#: Every router whose security this suite asserts about. A missing prefix means the
#: module was not mounted in this process — usually a feature flag the job forgot.
REQUIRED_PREFIXES = (
    "/api/v1/agent-flows",
    "/api/v1/auth",
    "/api/v1/catalog",
    "/api/v1/charts",
    "/api/v1/dashboards",
    "/api/v1/datasets",
    "/api/v1/datasources",
    "/api/v1/observability",
    "/api/v1/permissions",
    "/api/v1/public",
    "/api/v1/semantic",
    "/api/v1/shares",
    "/api/v1/users",
    "/api/v1/workboards",
    "/api/v1/workspaces",
)


def _pinned_fastapi() -> str:
    req = pathlib.Path(__file__).resolve().parents[1] / "requirements.txt"
    m = re.search(r"^fastapi==([\w.]+)\s*$", req.read_text(encoding="utf-8"), re.M)
    assert m, "requirements.txt no longer pins fastapi exactly"
    return m.group(1)


def _api_routes():
    from app.main import app

    return [
        r for r in app.routes
        if getattr(r, "path", "").startswith("/api/v1/") and getattr(r, "methods", None)
    ]


def _classify(route) -> str:
    path = route.path
    if path.startswith(floor.UNAUTHENTICATED_PREFIXES):
        return "public_or_auth"
    if path in floor.IDENTITY_SCOPED or path.startswith(floor.IDENTITY_SCOPED_PREFIXES):
        return "identity_scoped"
    if path in floor.DEPRECATED_STUBS:
        return "deprecated_stub"
    dependant = getattr(route, "dependant", None)
    if dependant is not None and floor._dependency_qualnames(dependant) & floor.GATE_QUALNAMES:
        return "module_gated"
    endpoint = getattr(route, "endpoint", None)
    if endpoint is not None and floor._body_is_gated(endpoint):
        return "body_gated"
    return "unclassified"


def test_installed_fastapi_is_the_pinned_version():
    import fastapi

    pinned = _pinned_fastapi()
    assert fastapi.__version__ == pinned, (
        f"fastapi {fastapi.__version__} is installed but requirements.txt pins {pinned}. "
        "The route walk is not meaningful on another version (0.141 hides every "
        "included router). Run the suite in the pinned environment."
    )


def test_route_walk_discovers_the_application():
    routes = _api_routes()
    assert routes, "the route walk discovered ZERO routes"
    assert len(routes) >= MIN_API_ROUTES, (
        f"only {len(routes)} API routes discovered (minimum {MIN_API_ROUTES})"
    )
    paths = {r.path for r in routes}
    missing = [p for p in REQUIRED_PREFIXES if not any(x.startswith(p) for x in paths)]
    assert not missing, (
        f"routers not mounted in this process: {missing}. Enable the module flags "
        "(WORKBOARDS_ENABLED, METADATA_CATALOG_ENABLED, GOVERN_ENABLED, "
        "OBSERVABILITY_ENABLED) for security suites."
    )


def test_every_api_route_is_classified(capsys):
    from collections import Counter

    routes = _api_routes()
    kinds = Counter()
    unclassified = []
    routers = set()
    for r in routes:
        kind = _classify(r)
        kinds[kind] += len(r.methods)
        routers.add("/".join(r.path.split("/")[:4]))
        if kind == "unclassified":
            unclassified.extend(f"{m} {r.path}" for m in sorted(r.methods))
    with capsys.disabled():
        print(
            "\nroute inventory: "
            f"routes={sum(len(r.methods) for r in routes)} routers={len(routers)} "
            + " ".join(f"{k}={v}" for k, v in sorted(kinds.items()))
        )
    assert not unclassified, "unclassified routes:\n  " + "\n  ".join(sorted(unclassified))
