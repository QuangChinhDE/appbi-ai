"""No universally known first administrator (authz review H1).

``backend/entrypoint.sh`` seeded ``admin@appbi.io`` / ``123456`` on an empty users
table whenever ADMIN_PASSWORD was unset, before the production validator ran.
The seed now lives in ``app.core.bootstrap_admin``; the entrypoint exits non-zero
when it raises BootstrapRefused. These tests run the real seed against a
throwaway Postgres database.
"""
from __future__ import annotations

import os
import uuid

import pytest

from app.core.bootstrap_admin import (
    BootstrapRefused,
    password_problem,
    resolve_bootstrap_password,
    seed_first_admin,
)

OWNER_URL = os.environ.get("AUTHZ_PG_OWNER_URL", "")

STRONG = "Sufficiently-Long-9-Password!"


@pytest.mark.parametrize("supplied", [None, "", "123456", "CHANGE_ME", "change_me_admin", "Admin123!", "password"])
def test_production_refuses_missing_placeholder_or_weak(supplied):
    with pytest.raises(BootstrapRefused):
        resolve_bootstrap_password("production", supplied)


def test_production_unknown_environment_is_production():
    with pytest.raises(BootstrapRefused):
        resolve_bootstrap_password(None, "123456")
    with pytest.raises(BootstrapRefused):
        resolve_bootstrap_password("staging", "123456")


def test_production_accepts_a_strong_password():
    assert resolve_bootstrap_password("production", STRONG) == (STRONG, False)


@pytest.mark.parametrize("supplied", [None, "123456", "CHANGE_ME"])
def test_development_generates_a_random_policy_compliant_password(supplied):
    pw, generated = resolve_bootstrap_password("development", supplied)
    assert generated and pw != supplied
    assert password_problem(pw, production=True) is None
    assert resolve_bootstrap_password("development", supplied)[0] != pw  # random each time


@pytest.fixture()
def empty_users_db():
    if not OWNER_URL:
        if os.environ.get("AUTHZ_PG_REQUIRED") == "1":
            raise RuntimeError("AUTHZ_PG_OWNER_URL is required in this job")
        pytest.skip("needs AUTHZ_PG_OWNER_URL")
    from sqlalchemy import create_engine, text

    name = f"bootstrap_{uuid.uuid4().hex[:8]}"
    admin = create_engine(OWNER_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    url = OWNER_URL.rsplit("/", 1)[0] + "/" + name
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text(
            "CREATE TABLE users (id uuid primary key default gen_random_uuid(), email text unique not null, "
            "password_hash text, full_name text not null, status text not null, permissions jsonb)"
        ))
    yield eng
    eng.dispose()
    with admin.connect() as c:
        c.execute(text(f'DROP DATABASE "{name}"'))
    admin.dispose()


def _users(eng):
    from sqlalchemy import text

    with eng.connect() as c:
        return c.execute(text("SELECT email, password_hash FROM users")).all()


def test_production_first_boot_without_password_creates_nobody(empty_users_db):
    with pytest.raises(BootstrapRefused):
        seed_first_admin(empty_users_db, {"ENVIRONMENT": "production"})
    with pytest.raises(BootstrapRefused):
        seed_first_admin(empty_users_db, {"ENVIRONMENT": "production", "ADMIN_PASSWORD": "123456"})
    assert _users(empty_users_db) == []


def test_production_first_boot_with_strong_password(empty_users_db):
    from passlib.context import CryptContext

    seed_first_admin(empty_users_db, {"ENVIRONMENT": "production", "ADMIN_PASSWORD": STRONG})
    [(email, hashed)] = _users(empty_users_db)
    ctx = CryptContext(schemes=["bcrypt"])
    assert email == "admin@appbi.io"
    assert ctx.verify(STRONG, hashed) and not ctx.verify("123456", hashed)


def test_development_first_boot_password_is_random_not_123456(empty_users_db):
    from passlib.context import CryptContext

    msg = seed_first_admin(empty_users_db, {"ENVIRONMENT": "development"})
    [(_, hashed)] = _users(empty_users_db)
    assert "DEVELOPMENT ONLY" in msg
    assert not CryptContext(schemes=["bcrypt"]).verify("123456", hashed)


def test_existing_users_never_block_startup(empty_users_db):
    seed_first_admin(empty_users_db, {"ENVIRONMENT": "production", "ADMIN_PASSWORD": STRONG})
    # A later boot with no password must not fail and must not add anyone.
    assert "already has rows" in seed_first_admin(empty_users_db, {"ENVIRONMENT": "production"})
    assert len(_users(empty_users_db)) == 1
