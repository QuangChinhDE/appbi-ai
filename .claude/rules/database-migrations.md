---
name: database-migrations
description: Alembic migration rules for AppBI. Load when editing backend/alembic or backend/app/models.
globs:
  - "backend/alembic/**"
  - "backend/app/models/**"
---

# Migration rules

Revisions live in `backend/alembic/versions/` (a long single chain — `alembic_chain.py`
prints the current count and head). Migrations run automatically in the backend entrypoint
on every boot, so a broken chain is a production 502, not a local annoyance.

## Hard rules

1. **Single head.** `python scripts/ci/alembic_chain.py` must pass. It is in preflight,
   the pre-push hook, and CI on every push.
2. **The parent must be committed.** A revision whose `down_revision` points at a file
   left uncommitted boots to an Alembic `KeyError`. This has caused prod outages here; the
   chain check exists because of it.
3. **Additive.** Add columns/tables; backfill in the migration when needed. Do not drop or
   rename a column that running code still reads — ship the code change first, drop later
   in a separate migration.
4. **Model and migration change together.** A new field on a SQLAlchemy model with no
   migration passes every local test and fails on a fresh database.
5. **No privileged operations.** `CREATE ROLE`, extension installs and other superuser
   statements crash-loop the backend against a managed Postgres. Provisioning belongs in
   `scripts/db-init/`, not in a revision.

## Before writing one

Read the current head and a recent revision to match the file's style, naming and
`down_revision` wiring. Generate with Alembic rather than hand-writing the header.

## After writing one

```bash
python scripts/ci/alembic_chain.py     # parent present, one head
```

and, if the environment has a database, apply it and roll it back once.

Destructive change (drop, rename, type narrowing, data deletion): say so explicitly in
your report, name what becomes unreadable by older code, and do not bundle it with an
unrelated feature.
