"""Generate / check the authorization ROUTE CONTRACT.

backend/app/core/authz/route_contract.json declares, for every API route, the
KIND of authorization it performs:

  resource           an action on ONE object (object check via the authz core)
  scope              a list/search: rows filtered by the caller's read scope
  cross              uses several resources; each dependency is checked
  public_capability  the request's own capability token is the authority
                     (/api/v1/public/*, embed, auth endpoints)
  identity           answers about the caller only (own profile, own tokens)
  global             a tenant-wide action: module or settings administrator

Usage:
  python scripts/ci/authz_route_contract.py --write   # add new routes as UNCLASSIFIED,
                                                     # drop routes that no longer exist
The enforcing check is backend/tests/test_authz_route_contract.py (CI): any
route missing from the file, any UNCLASSIFIED entry, or any stale entry fails.
New routes are classified by a PERSON (the generator's suggestion is a hint).
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "backend/app/core/authz/route_contract.json"
KINDS = ("resource", "scope", "cross", "public_capability", "identity", "global")


def api_routes() -> list[str]:
    sys.path.insert(0, str(ROOT / "backend"))
    for k, v in (("ENVIRONMENT", "test"), ("METADATA_CATALOG_ENABLED", "true"), ("GOVERN_ENABLED", "true"),
                 ("WORKBOARDS_ENABLED", "true"), ("OBSERVABILITY_ENABLED", "true")):
        os.environ.setdefault(k, v)
    os.environ.setdefault("DATABASE_URL", "sqlite:///./_route_contract.db")
    from app.main import app

    out = []
    for r in app.routes:
        p = getattr(r, "path", "")
        if p.startswith("/api/v1/"):
            for m in sorted(getattr(r, "methods", None) or []):
                out.append(f"{m} {p}")
    return sorted(set(out))


def suggest(key: str) -> str:
    method, path = key.split(" ", 1)
    if path.startswith(("/api/v1/public/", "/api/v1/auth/login", "/api/v1/auth/google",
                        "/api/v1/auth/logout", "/api/v1/auth/refresh")) or path == "/api/v1/public":
        return "public_capability"
    if path.startswith(("/api/v1/auth/", "/api/v1/notifications", "/api/v1/permissions/me",
                        "/api/v1/permissions/schema", "/api/v1/health")):
        return "identity"
    if path.startswith(("/api/v1/users", "/api/v1/teams", "/api/v1/permissions")) or path.endswith("/admin") \
            or "/admin/" in path or path in ("/api/v1/observability/scan",):
        return "global"
    if re.search(r"\{[a-z_]*id[a-z_]*\}|\{token\}|\{brain_key\}|\{name\}|\{fqn\}", path):
        return "resource"
    return "scope" if method == "GET" else "resource"


def main() -> int:
    current = api_routes()
    existing = json.loads(CONTRACT.read_text(encoding="utf-8")) if CONTRACT.exists() else {}
    if "--write" in sys.argv:
        merged = {k: existing.get(k, "UNCLASSIFIED") for k in current}
        if "--suggest" in sys.argv:
            merged = {k: (v if v != "UNCLASSIFIED" else suggest(k)) for k, v in merged.items()}
        CONTRACT.write_text(json.dumps(merged, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        print(f"wrote {len(merged)} routes; unclassified={sum(v == 'UNCLASSIFIED' for v in merged.values())}")
        return 0
    missing = [k for k in current if k not in existing]
    stale = [k for k in existing if k not in current]
    bad = [k for k, v in existing.items() if v not in KINDS]
    print(f"routes={len(current)} missing={len(missing)} stale={len(stale)} unclassified/invalid={len(bad)}")
    return 1 if (missing or stale or bad) else 0


if __name__ == "__main__":
    sys.exit(main())
