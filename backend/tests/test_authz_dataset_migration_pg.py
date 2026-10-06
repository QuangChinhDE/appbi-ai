"""Migration 20261008_0001: legacy ResourceShare(DATASET) -> DatasetGrant.

Runs the REAL alembic migration on a throwaway Postgres database:
upgrade to the revision before it, seed legacy shares and existing grants,
upgrade, assert the result and the impact report, downgrade, assert recovery.

Contract (decision Q1): VIEW -> explore (no build), EDIT -> edit; never
broadened (no publish / reshare / manage); an existing grant that already
covers a legacy capability is kept; incomparable pairs keep the existing grant
and are reported; narrowing (VIEW losing build) is reported with the assets.
"""
from __future__ import annotations

import os
import pathlib
import uuid

import pytest

OWNER_URL = os.environ.get("AUTHZ_PG_OWNER_URL", "")
if not OWNER_URL:
    if os.environ.get("AUTHZ_PG_REQUIRED") == "1":
        raise RuntimeError("AUTHZ_PG_OWNER_URL is required in this job")
    pytest.skip("needs AUTHZ_PG_OWNER_URL", allow_module_level=True)

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

pytestmark = pytest.mark.pg
BACKEND = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def db_url():
    name = f"mig_{uuid.uuid4().hex[:8]}"
    admin = create_engine(OWNER_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    url = OWNER_URL.rsplit("/", 1)[0] + "/" + name
    yield url
    with admin.connect() as c:
        c.execute(text(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{name}'"))
        c.execute(text(f'DROP DATABASE "{name}"'))
    admin.dispose()


def _alembic(url, fn, rev):
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        fn(cfg, rev)
    finally:
        if old is not None:
            os.environ["DATABASE_URL"] = old


def test_legacy_dataset_shares_become_canonical_grants(db_url):
    _alembic(db_url, command.upgrade, "20261007_0002")
    eng = create_engine(db_url)
    u = {k: uuid.uuid4() for k in ("owner", "viewer", "editor", "resharer", "team_member")}
    team = uuid.uuid4()
    with eng.begin() as c:
        for k, uid in u.items():
            c.execute(text("INSERT INTO users (id, email, full_name, status, permissions) "
                           "VALUES (:i, :e, :n, 'active', '{}'::jsonb)"), {"i": uid, "e": f"{k}@m.test", "n": k})
        c.execute(text("INSERT INTO teams (id, name) VALUES (:i, 'T')"), {"i": team})
        ds = c.execute(text("INSERT INTO datasets (name, owner_id) VALUES ('D', :o) RETURNING id"),
                       {"o": u["owner"]}).scalar()
        tbl = c.execute(text("INSERT INTO dataset_tables (dataset_id, display_name, source_table_name) "
                             "VALUES (:d, 't', 't') RETURNING id"), {"d": ds}).scalar()
        c.execute(text("INSERT INTO charts (name, chart_type, config, dataset_table_id, owner_id) "
                       "VALUES ('c', 'BAR', '{}'::jsonb, :t, :o)"), {"t": tbl, "o": u["viewer"]})
        for target, perm in (("viewer", "view"), ("editor", "edit"), ("resharer", "view")):
            c.execute(text("INSERT INTO resource_shares (resource_type, resource_id, user_id, permission, shared_by) "
                           "VALUES ('dataset', :r, :u, :p, :o)"),
                      {"r": str(ds), "u": u[target], "p": perm, "o": u["owner"]})
        c.execute(text("INSERT INTO resource_shares (resource_type, resource_id, team_id, permission, shared_by) "
                       "VALUES ('dataset', :r, :t, 'edit', :o)"), {"r": str(ds), "t": team, "o": u["owner"]})
        # an existing grant incomparable with the legacy one (reshare vs explore)
        c.execute(text("INSERT INTO dataset_grants (dataset_id, user_id, verb) VALUES (:d, :u, 'reshare')"),
                  {"d": ds, "u": u["resharer"]})

    _alembic(db_url, command.upgrade, "20261008_0001")
    with eng.connect() as c:
        grants = {(str(r.user_id or r.team_id)): (r.verb, r.source) for r in c.execute(text(
            "SELECT user_id, team_id, verb, source FROM dataset_grants WHERE dataset_id = :d"), {"d": ds})}
        assert grants[str(u["viewer"])] == ("explore", "legacy_share")
        assert grants[str(u["editor"])] == ("edit", "legacy_share")
        assert grants[str(team)] == ("edit", "legacy_share")
        assert grants[str(u["resharer"])] == ("reshare", None)  # kept, never broadened
        assert not any(v in ("manage", "reshare") for v, s in grants.values() if s == "legacy_share")
        assert c.execute(text("SELECT count(*) FROM resource_shares WHERE resource_type='dataset'")).scalar() == 0
        rep = c.execute(text("SELECT payload FROM authz_impact_reports WHERE name='dataset_single_authority'")).scalar()
        assert rep["counts"]["incomparable"] == 1
        losing = {x.get("user_id"): x for x in rep["view_shares_losing_build"]}
        assert losing[str(u["viewer"])]["owned_downstream_assets"]["charts"]

    _alembic(db_url, command.downgrade, "20261007_0002")
    with eng.connect() as c:
        assert c.execute(text("SELECT count(*) FROM resource_shares WHERE resource_type='dataset'")).scalar() == 4
        verbs = [r[0] for r in c.execute(text("SELECT verb FROM dataset_grants WHERE dataset_id = :d"), {"d": ds})]
        assert verbs == ["reshare"]
    eng.dispose()
