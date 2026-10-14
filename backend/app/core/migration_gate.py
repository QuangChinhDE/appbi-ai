"""Fail-closed gate in front of `alembic upgrade head` at container start.

Run by `backend/entrypoint.sh` as `python -m app.core.migration_gate`. Exit 0 lets
the entrypoint migrate; exit 3 stops the container before anything touches the
schema.

* A fresh database (no ``alembic_version``) is a first install: allowed.
* A database already at head: nothing to do, allowed (restarts are never gated).
* An EXISTING database with pending revisions: allowed only when
  ``APPBI_MIGRATE_APPROVED`` names the exact target head (the release runbook sets
  it after a verified backup) or is ``auto`` (``run.sh --migrate``, dev compose).
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass

BLOCKED_EXIT = 3


@dataclass(frozen=True)
class GateDecision:
    allowed: bool
    message: str


def decide(*, has_version_table: bool, current: list[str], heads: list[str], approved: str) -> GateDecision:
    target = ",".join(sorted(heads))
    if not has_version_table:
        return GateDecision(True, f"Fresh database: initialising schema to {target}.")
    if sorted(current) == sorted(heads):
        return GateDecision(True, f"Schema at head {target}; no migration pending.")
    approved = (approved or "").strip()
    now = ",".join(sorted(current)) or "(none)"
    if approved in ("auto", target):
        return GateDecision(True, f"Migration approved ({approved}): {now} -> {target}")
    return GateDecision(False, (
        f"STOP: this database is at {now} and this release needs {target}.\n"
        "Pending migrations are not applied automatically to an existing database.\n"
        "Back up the database (and the appbi_data volume), verify the backup, then\n"
        f"start once with APPBI_MIGRATE_APPROVED={target}\n"
        "(see docs/production-release-runbook.md). Schema untouched."
    ))


def main() -> int:
    from alembic.config import Config
    from alembic.script import ScriptDirectory
    from sqlalchemy import create_engine, inspect, text

    heads = list(ScriptDirectory.from_config(Config("alembic.ini")).get_heads())
    with create_engine(os.environ["DATABASE_URL"]).connect() as conn:
        has_table = inspect(conn).has_table("alembic_version")
        current = [r[0] for r in conn.execute(text("SELECT version_num FROM alembic_version"))] if has_table else []
    d = decide(has_version_table=has_table, current=current, heads=heads,
               approved=os.environ.get("APPBI_MIGRATE_APPROVED", ""))
    if d.allowed:
        print("==> " + d.message)
        return 0
    sys.stderr.write("\n" + "=" * 72 + "\n" + d.message + "\n" + "=" * 72 + "\n")
    return BLOCKED_EXIT


if __name__ == "__main__":
    sys.exit(main())
