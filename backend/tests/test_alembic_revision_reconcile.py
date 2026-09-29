# -*- coding: utf-8 -*-
"""A renamed revision is re-labelled from the schema, never guessed.

Agent Flow's "skill lifecycle and step budget" migration and the Dashboard stream's
"content proposal audit" migration were both shipped as 20260926_0001 with different
parents and payloads. Agent Flow's moved to 20260926_0101. A database that applied
it under the old ID must be re-labelled; one that applied Dashboard's must not.
"""
from __future__ import annotations

import os

if not os.environ.get("DATABASE_URL"):
    os.environ["DATABASE_URL"] = "sqlite:///./test_flow_replay.db"

import sqlalchemy as sa  # noqa: E402

from app.core.alembic_reconcile import reconcile_revision_ids  # noqa: E402


def _db(version: str, *, lifecycle: bool) -> sa.engine.Engine:
    eng = sa.create_engine("sqlite://")
    with eng.begin() as c:
        c.execute(sa.text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)"))
        c.execute(sa.text("INSERT INTO alembic_version VALUES (:v)"), {"v": version})
        cols = "id INTEGER" + (", lifecycle VARCHAR(16)" if lifecycle else "")
        c.execute(sa.text(f"CREATE TABLE agent_brain_versions ({cols})"))
    return eng


def _version(eng) -> set[str]:
    with eng.connect() as c:
        return {r[0] for r in c.execute(sa.text("SELECT version_num FROM alembic_version"))}


def test_agent_flows_migration_recorded_under_the_old_id_is_relabelled():
    eng = _db("20260926_0001", lifecycle=True)
    with eng.connect() as c:
        reconcile_revision_ids(c)
    assert _version(eng) == {"20260926_0101"}
    with eng.connect() as c:
        reconcile_revision_ids(c)            # idempotent
    assert _version(eng) == {"20260926_0101"}


def test_the_dashboard_migration_under_that_id_is_left_alone():
    eng = _db("20260926_0001", lifecycle=False)
    with eng.connect() as c:
        reconcile_revision_ids(c)
    assert _version(eng) == {"20260926_0001"}


def test_unrelated_versions_and_fresh_databases_are_untouched():
    eng = _db("20260929_0001", lifecycle=True)
    with eng.connect() as c:
        reconcile_revision_ids(c)
    assert _version(eng) == {"20260929_0001"}
    fresh = sa.create_engine("sqlite://")
    with fresh.connect() as c:
        reconcile_revision_ids(c)            # no alembic_version table: nothing to do


def test_the_revision_ids_in_the_tree_are_unique():
    import pathlib
    import re

    seen: dict[str, str] = {}
    root = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"
    for f in root.glob("*.py"):
        m = re.search(r'^revision(?::\s*str)?\s*=\s*"([^"]+)"', f.read_text(encoding="utf-8"), re.M)
        if m:
            assert m.group(1) not in seen, f"{m.group(1)} in {f.name} and {seen[m.group(1)]}"
            seen[m.group(1)] = f.name
    assert "20260926_0101" in seen


def test_no_transaction_is_left_open_for_alembic():
    """Rollback-once check on a data copy: a read auto-begins a transaction; left
    open, Alembic treats it as the caller's and never commits — every migration ran
    and silently rolled back. Every path must hand back a clean connection."""
    for eng in (_db("20260926_0001", lifecycle=True), _db("20260926_0001", lifecycle=False),
                _db("20260929_0001", lifecycle=False)):
        with eng.connect() as c:
            reconcile_revision_ids(c)
            assert not c.in_transaction()
