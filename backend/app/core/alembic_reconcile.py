"""Revision IDs renamed after they were applied — re-labelled from the schema.

Called by `alembic/env.py` before Alembic resolves the recorded revision.
"""
from __future__ import annotations

#: A revision that was RENAMED after it had been applied somewhere, keyed by the
#: ID a database may have recorded: (the ID it has now, a schema fact only that
#: migration produces). The old ID now belongs to a different migration in another
#: stream, so the recorded row cannot be read by ID alone — the schema decides.
#:
#: 20260926_0001 — Agent Flow "skill lifecycle and step budget" (now 20260926_0101)
#:   collided with the Dashboard stream's "content proposal audit" migration. Only
#:   Agent Flow's adds agent_brain_versions.lifecycle; Dashboard's only adds
#:   auditaction enum values.
_RENAMED_REVISIONS = {
    "20260926_0001": ("20260926_0101", ("agent_brain_versions", "lifecycle")),
}


def reconcile_revision_ids(connection) -> None:
    """Re-label a recorded revision that was renamed, when the schema proves which
    migration it was. Touches only `alembic_version`; never data. Idempotent."""
    from sqlalchemy import inspect, text

    try:
        insp = inspect(connection)
        if not insp.has_table("alembic_version"):
            return
        recorded = {r[0] for r in connection.execute(text("SELECT version_num FROM alembic_version"))}
        for old, (new, (table, column)) in _RENAMED_REVISIONS.items():
            if old not in recorded or not insp.has_table(table):
                continue
            if new in recorded:
                # One migration cannot be recorded under both IDs, so the old-ID row
                # is the other stream's (both lines applied, their merge not yet) —
                # re-labelling it would collide with `new` on the primary key.
                continue
            if column not in {c["name"] for c in insp.get_columns(table)}:
                continue            # the other stream's migration under this ID — leave it
            connection.execute(
                text("UPDATE alembic_version SET version_num = :new WHERE version_num = :old"),
                {"new": new, "old": old},
            )
    finally:
        # ALWAYS END THIS TRANSACTION. Even a read auto-begins one; left open, Alembic
        # treats it as the caller's outer transaction and does not commit — every
        # migration after this would run and then roll back when the connection
        # closes. Found by the rollback-once check on a data copy.
        connection.commit()
