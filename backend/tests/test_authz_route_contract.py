"""Every API route declares its authorization KIND (route contract, CI-enforced).

backend/app/core/authz/route_contract.json is the lockfile of "what kind of
authorization does this route perform": resource / scope / cross /
public_capability / identity / global (see scripts/ci/authz_route_contract.py).

A NEW endpoint that nobody classified fails here, so adding a route forces a
person to say which authorization it performs - the gap behind every
module-gate-only finding of the authz review. A classified route that no longer
exists also fails (no stale licences). The walk runs with every module mounted
and must see the real application (see test_authz_route_inventory).
"""
from __future__ import annotations

import json
import os
import pathlib

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_authz_route_contract.db"

from tests import test_module_floor as floor  # noqa: E402

CONTRACT = pathlib.Path(__file__).resolve().parents[1] / "app/core/authz/route_contract.json"
KINDS = {"resource", "scope", "cross", "public_capability", "identity", "global"}
PUBLIC_PREFIXES = ("/api/v1/public", "/api/v1/auth/login", "/api/v1/auth/google",
                   "/api/v1/auth/logout", "/api/v1/auth/refresh")


def _routes():
    from app.main import app

    out = {}
    for r in app.routes:
        p = getattr(r, "path", "")
        if p.startswith("/api/v1/"):
            for m in sorted(getattr(r, "methods", None) or []):
                out[f"{m} {p}"] = r
    return out


def test_every_route_is_classified_and_no_entry_is_stale():
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    routes = _routes()
    assert len(routes) >= 450, f"walk saw only {len(routes)} routes"
    missing = sorted(set(routes) - set(contract))
    stale = sorted(set(contract) - set(routes))
    bad = sorted(k for k, v in contract.items() if v not in KINDS)
    assert not missing, ("routes without an authorization kind - classify them in "
                         "route_contract.json (scripts/ci/authz_route_contract.py --write):\n  "
                         + "\n  ".join(missing))
    assert not stale, "classified routes that no longer exist:\n  " + "\n  ".join(stale)
    assert not bad, "UNCLASSIFIED / invalid kinds:\n  " + "\n  ".join(bad)


def test_public_capability_only_on_public_surfaces():
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    wrong = [k for k, v in contract.items()
             if v == "public_capability" and not k.split(" ", 1)[1].startswith(PUBLIC_PREFIXES)]
    assert not wrong, "public_capability declared on an authenticated surface:\n  " + "\n  ".join(wrong)
    unflagged = [k for k, v in contract.items()
                 if k.split(" ", 1)[1].startswith("/api/v1/public") and v != "public_capability"]
    assert not unflagged, unflagged


def test_every_non_public_route_is_actually_gated():
    """A declared kind is not a check: every route that is not public, identity
    or a deprecated stub must also carry a real gate (dependency or body)."""
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    ungated = []
    for key, route in _routes().items():
        kind = contract.get(key)
        path = route.path
        if kind in ("public_capability", "identity") or path in floor.DEPRECATED_STUBS:
            continue
        dep = getattr(route, "dependant", None)
        gated = dep is not None and bool(floor._dependency_qualnames(dep) & floor.GATE_QUALNAMES)
        gated = gated or floor._body_is_gated(getattr(route, "endpoint", None))
        if not gated:
            ungated.append(f"{key} ({kind})")
    assert not ungated, "classified but ungated:\n  " + "\n  ".join(ungated)
