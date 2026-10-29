"""Fail-closed gate in front of `alembic upgrade head` at container start.

Run by `backend/entrypoint.sh` as `python -m app.core.migration_gate`. Exit 0 lets
the entrypoint migrate; exit 3 stops the container before anything touches the
schema.

* A fresh database (no ``alembic_version`` AND no tables at all) is a first
  install: allowed.
* A database that HAS tables but no ``alembic_version`` is never "fresh": it is a
  populated database whose migration history is missing (a partial restore, a
  dump taken without that table, a different application). Running the whole
  chain on it could corrupt it, so it is refused even with approval.
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


def decide(*, has_version_table: bool, current: list[str], heads: list[str], approved: str,
           existing_tables: int = 0) -> GateDecision:
    target = ",".join(sorted(heads))
    if not has_version_table and existing_tables:
        return GateDecision(False, (
            f"STOP: this database has {existing_tables} table(s) but no alembic_version.\n"
            "It is not a fresh install, and its schema revision is unknown, so no\n"
            "migration is applied (not even with APPBI_MIGRATE_APPROVED). Check that\n"
            "DATABASE_URL/DB_NAME point at the right database; if this IS the AppBI\n"
            "database, restore it from a complete backup. Schema untouched."
        ))
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
        insp = inspect(conn)
        has_table = insp.has_table("alembic_version")
        tables = [t for t in insp.get_table_names() if t != "alembic_version"]
        current = [r[0] for r in conn.execute(text("SELECT version_num FROM alembic_version"))] if has_table else []
    d = decide(has_version_table=has_table, current=current, heads=heads,
               approved=os.environ.get("APPBI_MIGRATE_APPROVED", ""), existing_tables=len(tables))
    if d.allowed:
        print("==> " + d.message)
        return 0
    sys.stderr.write("\n" + "=" * 72 + "\n" + d.message + "\n" + "=" * 72 + "\n")
    return BLOCKED_EXIT


if __name__ == "__main__":
    sys.exit(main())
