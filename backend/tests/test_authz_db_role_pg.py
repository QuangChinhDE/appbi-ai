"""Postgres row-level security only holds for a role that cannot bypass it.

AppBI's RLS (``govern_doc_chunk`` / ``govern_doc_block``: drafts unreadable unless
the transaction opts into ``appbi.chunk_scope = 'authoring'``) is DEFENCE IN DEPTH
behind the application checks. It protects nothing when the application connects
as the schema owner or a superuser, which is what happens when
``DATABASE_URL_APP`` is unset. These tests run on real Postgres with the real
``appbi_app`` role the migrations provision, and prove:

* the role the request path uses is neither superuser nor BYPASSRLS;
* ``SessionLocal`` actually connects as that role when ``DATABASE_URL_APP`` is set;
* the draft-chunk policy hides drafts from that role, and the explicit authoring
  opt-in is the only way to see them;
* the owner role does see them — so a deployment on the owner role has NO row
  security, which is why production startup must refuse it.

SQLite cannot answer any of this, so the file refuses to run anywhere else. In the
CI Postgres job ``AUTHZ_PG_REQUIRED=1`` turns a missing database into a failure
instead of a skip.
"""
from __future__ import annotations

import os

import pytest

OWNER_URL = os.environ.get("AUTHZ_PG_OWNER_URL", "")
APP_URL = os.environ.get("AUTHZ_PG_APP_URL", "")

if not (OWNER_URL and APP_URL):
    if os.environ.get("AUTHZ_PG_REQUIRED") == "1":
        raise RuntimeError("AUTHZ_PG_OWNER_URL / AUTHZ_PG_APP_URL are required in this job")
    pytest.skip("Postgres security suite needs AUTHZ_PG_OWNER_URL and AUTHZ_PG_APP_URL",
                allow_module_level=True)

from sqlalchemy import create_engine, text  # noqa: E402

pytestmark = pytest.mark.pg


@pytest.fixture(scope="module")
def owner():
    eng = create_engine(OWNER_URL)
    yield eng
    eng.dispose()


@pytest.fixture(scope="module")
def app_role():
    eng = create_engine(APP_URL)
    yield eng
    eng.dispose()


@pytest.fixture(scope="module")
def chunks(owner):
    """One draft and one published chunk. The fixture bypasses the FK to
    govern_doc (disposable CI database) so the test owns exactly two rows."""
    with owner.begin() as c:
        c.execute(text("SET LOCAL session_replication_role = replica"))
        ids = c.execute(text(
            "INSERT INTO govern_doc_chunk (doc_id, content, content_hash, model_version, doc_status) "
            "VALUES (-424242, 'draft secret', 'h1', 't', 'Draft'), "
            "       (-424242, 'published fact', 'h2', 't', 'Published') RETURNING id"
        )).scalars().all()
    yield ids
    with owner.begin() as c:
        c.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = -424242"))


def _visible(engine, ids, authoring: bool = False) -> set[str]:
    with engine.begin() as c:
        if authoring:
            c.execute(text("SET LOCAL appbi.chunk_scope = 'authoring'"))
        rows = c.execute(
            text("SELECT content FROM govern_doc_chunk WHERE id = ANY(:ids)"), {"ids": list(ids)}
        ).scalars().all()
    return set(rows)


def test_app_role_cannot_bypass_row_security(app_role):
    with app_role.connect() as c:
        name, sup, bypass = c.execute(text(
            "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        )).one()
    assert name == "appbi_app"
    assert sup is False, "the application role is a superuser: every RLS policy is void"
    assert bypass is False, "the application role has BYPASSRLS: every RLS policy is void"


def test_session_local_uses_the_app_role(monkeypatch):
    """The request path's SessionLocal binds DATABASE_URL_APP, not the owner URL."""
    import importlib

    monkeypatch.setenv("DATABASE_URL", OWNER_URL)
    monkeypatch.setenv("DATABASE_URL_APP", APP_URL)
    from app.core import config, database

    importlib.reload(config)
    db_mod = importlib.reload(database)
    s = db_mod.SessionLocal()
    try:
        assert s.execute(text("SELECT current_user")).scalar() == "appbi_app"
    finally:
        s.close()


def test_drafts_are_invisible_to_the_app_role(app_role, chunks):
    assert _visible(app_role, chunks) == {"published fact"}


def test_authoring_opt_in_is_the_only_way_to_drafts(app_role, chunks):
    assert _visible(app_role, chunks, authoring=True) == {"draft secret", "published fact"}
    # SET LOCAL ends with the transaction: the next one is back to published-only.
    assert _visible(app_role, chunks) == {"published fact"}


def test_owner_role_sees_drafts_which_is_why_prod_must_not_use_it(owner, chunks):
    assert _visible(owner, chunks) == {"draft secret", "published fact"}
