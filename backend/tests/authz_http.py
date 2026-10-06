"""HTTP harness for authorization regression tests.

Every security regression in the authz remediation is asserted at the HTTP
boundary of the REAL application:

* the full FastAPI app (``app.main.app``) through ``TestClient`` — real routing,
  real dependencies, real permission helpers, nothing stubbed in the decision path;
* a real Postgres schema built by ``alembic upgrade head``;
* the request path bound to the non-superuser ``appbi_app`` role
  (``DATABASE_URL_APP``), exactly as production must be;
* callers authenticated with REAL bearer credentials minted by the product's own
  functions (access JWT, PAT), never with a dependency override.

Import this module BEFORE anything from ``app``: it points the engines at
Postgres. When ``AUTHZ_PG_OWNER_URL`` / ``AUTHZ_PG_APP_URL`` are absent the
importing test module is skipped — except in the CI security job, where
``AUTHZ_PG_REQUIRED=1`` makes that a hard failure.
"""
from __future__ import annotations

import os
import uuid

import pytest

OWNER_URL = os.environ.get("AUTHZ_PG_OWNER_URL", "")
APP_URL = os.environ.get("AUTHZ_PG_APP_URL", "")

if not (OWNER_URL and APP_URL):
    if os.environ.get("AUTHZ_PG_REQUIRED") == "1":
        raise RuntimeError("AUTHZ_PG_OWNER_URL / AUTHZ_PG_APP_URL are required in this job")
    pytest.skip("authz HTTP suite needs AUTHZ_PG_OWNER_URL and AUTHZ_PG_APP_URL",
                allow_module_level=True)

import sys as _sys

if "app.core.database" in _sys.modules:
    # The engines are built at import. If another suite in this process imported
    # the app first (e.g. against SQLite), these tests would silently run on that
    # database instead of Postgres - a green result proving nothing.
    _bound = str(_sys.modules["app.core.database"].engine.url)
    if not _bound.startswith("postgresql"):
        raise RuntimeError(
            f"authz HTTP suite must own its process: app already bound to {_bound!r}. "
            "Run Postgres security suites in a separate pytest invocation."
        )

os.environ["DATABASE_URL"] = OWNER_URL
os.environ["DATABASE_URL_APP"] = APP_URL
os.environ.setdefault("ENVIRONMENT", "test")
# Production refuses to start without an encryption key; secrets at rest must be
# real ciphertext here too, or every "is this encrypted?" path tests plaintext.
if not os.environ.get("DATASOURCE_ENCRYPTION_KEY"):
    from cryptography.fernet import Fernet

    os.environ["DATASOURCE_ENCRYPTION_KEY"] = Fernet.generate_key().decode()
for _flag in ("METADATA_CATALOG_ENABLED", "GOVERN_ENABLED", "WORKBOARDS_ENABLED", "OBSERVABILITY_ENABLED"):
    os.environ.setdefault(_flag, "true")

from fastapi.testclient import TestClient  # noqa: E402

from app.core.database import SessionLocal  # noqa: E402

ALL_NONE = {
    "data_sources": "none", "datasets": "none", "explore_charts": "none", "dashboards": "none",
    "workboards": "none", "govern": "none", "agent_flows": "none", "chat": "none",
    "observability": "none", "settings": "none",
}


def perms(**levels: str) -> dict:
    """A permission row that holds NOTHING except what is named."""
    out = dict(ALL_NONE)
    out.update(levels)
    return out


class Principal:
    """A real user plus the bearer headers a browser/API client would send."""

    def __init__(self, user, token: str):
        self.user = user
        self.id = user.id
        self.email = user.email
        self.headers = {"Authorization": f"Bearer {token}"}


def make_user(db, label: str, **levels: str) -> Principal:
    from app.api.auth import create_access_token
    from app.models.user import User, UserStatus

    u = User(
        id=uuid.uuid4(),
        email=f"{label}-{uuid.uuid4().hex[:8]}@authz.test",
        full_name=label,
        password_hash=None,
        status=UserStatus.ACTIVE,
        permissions=perms(**levels),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return Principal(u, create_access_token(u))


def set_permissions(db, principal: Principal, **levels: str) -> None:
    from app.models.user import User

    u = db.get(User, principal.id)
    u.permissions = perms(**levels)
    db.commit()


@pytest.fixture(scope="module")
def client():
    """The real app. Per-IP rate limits are switched OFF for these suites only
    (every TestClient request comes from one address, so a module that mints a
    dozen PATs would hit the 10/min limit and the authorization assertion would
    read a 429). The limits themselves are product behaviour tested elsewhere;
    this is the same switch tests/test_embed_integration_security.py uses."""
    import sys

    from app.main import app

    limiters = []
    for mod in list(sys.modules.values()):
        lim = getattr(mod, "_limiter", None) if mod and getattr(mod, "__name__", "").startswith("app.") else None
        if lim is not None and hasattr(lim, "enabled") and lim not in limiters:
            limiters.append(lim)
    state_lim = getattr(app.state, "limiter", None)
    if state_lim is not None and state_lim not in limiters:
        limiters.append(state_lim)
    saved = [(lim, lim.enabled) for lim in limiters]
    for lim in limiters:
        lim.enabled = False
    try:
        with TestClient(app, raise_server_exceptions=False) as c:
            yield c
    finally:
        for lim, was in saved:
            lim.enabled = was


@pytest.fixture()
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def share(db, resource_type: str, resource_id, who: Principal, level: str, by: Principal) -> None:
    """A share as the UI would create it. For a dataset that is a DatasetGrant
    (one storage since migration 20261008_0001; view -> explore, edit -> edit,
    exactly what POST /shares/dataset/... writes); otherwise a ResourceShare."""
    from app.models.resource_share import ResourceShare, ResourceType, SharePermission

    if resource_type == "dataset":
        from app.models.dataset import DatasetGrant

        db.add(DatasetGrant(dataset_id=int(resource_id), user_id=who.id,
                            verb={"view": "explore", "edit": "edit"}[level], granted_by=by.id))
        db.commit()
        return

    db.add(ResourceShare(
        resource_type=ResourceType(resource_type),
        resource_id=str(resource_id),
        user_id=who.id,
        permission=SharePermission(level),
        shared_by=by.id,
    ))
    db.commit()
