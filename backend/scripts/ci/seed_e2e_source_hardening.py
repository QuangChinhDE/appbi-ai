#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Seed the fixtures for `e2e/tests/source-hardening.spec.ts`. CI only.

WHAT IT PROTECTS. The source-core-hardening browser journeys (spec:
docs/features/source-core-hardening/spec.md): a PostgreSQL source repointed
from one database to another shows the NEW columns, a view-only user is
refused every write (including Google Sheets mutations, which need object
`full`), a stored secret never reaches the page.

WHAT IT CREATES, in the job's own Postgres service (loopback; the job allows
127.0.0.0/8 + ::1/128 through ALLOWED_PRIVATE_SOURCE_CIDRS):

* role ``srhv_reader`` (LOGIN, read-only grants only);
* database ``srch_src_a`` with ``public.sales(id int, region text, amount numeric)``, 3 rows;
* database ``srch_src_b`` with ``public.sales(id int, customer_name text, total numeric, status text)``, 2 rows;
* a ``google_sheets`` data source named ``srch gsheets fixture`` owned by the
  E2E user, carrying a FAKE service account (it never reaches Google: the spec
  only checks that a view-only user is refused before anything is loaded).

GUARDED: refuses to run unless ``CI_FIXTURE_SEED=1`` (the e2e workflow sets
it; same opt-in as seed_snowflake_ci_fixture.py). It creates a LOGIN role with
a fixed, published password and new databases in whatever server
DATABASE_URL points at — a disposable CI database only, never dev/prod. The
role is further confined: read-only by default (``default_transaction_read_only``),
SELECT on the two fixture tables only, and no grants in the app database
(PUBLIC's default CONNECT still lets it log in there, which is why the script
itself is CI-only rather than relying on the role alone).

DETERMINISTIC (fixed names / rows) and IDEMPOTENT (re-running resets the two
tables, re-sets the role password and reuses the source). Names and the
password match the spec's defaults (SRC_* env vars override both sides).
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import sqlalchemy as sa  # noqa: E402
from psycopg2 import sql as pg_sql  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.crypto import encrypt_config  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.models.models import DataSource, DataSourceType  # noqa: E402
from app.models.user import User  # noqa: E402

EMAIL = os.environ.get("E2E_EMAIL", "admin@appbi.io")
ROLE = os.environ.get("SRC_USER", "srhv_reader")
PASSWORD = os.environ.get("SRC_PASSWORD", "Pw-Srhv-7731-secret")
DB_A = os.environ.get("SRC_DB_A", "srch_src_a")
DB_B = os.environ.get("SRC_DB_B", "srch_src_b")
GSHEETS_NAME = "srch gsheets fixture"

TABLES = {
    DB_A: ("CREATE TABLE public.sales (id int, region text, amount numeric)",
           "INSERT INTO public.sales VALUES (1,'North',100.50),(2,'South',200),(3,'East',50.25)"),
    DB_B: ("CREATE TABLE public.sales (id int, customer_name text, total numeric, status text)",
           "INSERT INTO public.sales VALUES (1,'Alice',300,'paid'),(2,'Bob',75.5,'open')"),
}

# Structurally a service-account JSON; the key is not a real key and the
# account does not exist. Never used to call Google in the spec.
FAKE_SA = {
    "type": "service_account", "project_id": "srch-fixture", "private_key_id": "0" * 40,
    "private_key": "-----BEGIN PRIVATE KEY-----\nTk9UQVJFQUxLRVk=\n-----END PRIVATE KEY-----\n",
    "client_email": "srch-fixture@srch-fixture.iam.gserviceaccount.com", "client_id": "1",
    "token_uri": "https://oauth2.googleapis.com/token",
}


def _admin_conn(database: str):
    import psycopg2

    url = sa.engine.make_url(settings.DATABASE_URL)
    conn = psycopg2.connect(host=url.host, port=url.port or 5432, dbname=database,
                            user=url.username, password=url.password)
    conn.autocommit = True
    return conn


def _role_and_databases() -> None:
    url = sa.engine.make_url(settings.DATABASE_URL)
    conn = _admin_conn(url.database)
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (ROLE,))
        verb = "ALTER" if cur.fetchone() else "CREATE"
        cur.execute(pg_sql.SQL(verb + " ROLE {} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                               "PASSWORD %s").format(pg_sql.Identifier(ROLE)), (PASSWORD,))
        cur.execute(pg_sql.SQL("ALTER ROLE {} SET default_transaction_read_only = on").format(
            pg_sql.Identifier(ROLE)))
        for db in TABLES:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db,))
            if not cur.fetchone():
                cur.execute(pg_sql.SQL("CREATE DATABASE {}").format(pg_sql.Identifier(db)))
    finally:
        conn.close()
    for db, (ddl, rows) in TABLES.items():
        c = _admin_conn(db)
        try:
            cur = c.cursor()
            cur.execute("DROP TABLE IF EXISTS public.sales")
            cur.execute(ddl)
            cur.execute(rows)
            cur.execute(pg_sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                pg_sql.Identifier(db), pg_sql.Identifier(ROLE)))
            cur.execute(pg_sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(pg_sql.Identifier(ROLE)))
            cur.execute(pg_sql.SQL("GRANT SELECT ON public.sales TO {}").format(pg_sql.Identifier(ROLE)))
        finally:
            c.close()


def _gsheets_source(db, user) -> int:
    ds = db.query(DataSource).filter(DataSource.name == GSHEETS_NAME,
                                     DataSource.owner_id == user.id).first()
    if ds is None:
        ds = DataSource(name=GSHEETS_NAME, type=DataSourceType("google_sheets"), owner_id=user.id,
                        config=encrypt_config({"spreadsheet_id": "srch-fixture-spreadsheet",
                                               "auth_mode": "service_account",
                                               "credentials_json": json.dumps(FAKE_SA)}))
        db.add(ds)
        db.commit()
    return int(ds.id)


def main() -> int:
    if os.environ.get("CI_FIXTURE_SEED") != "1":
        print("REFUSED: seed_e2e_source_hardening.py creates a LOGIN role with a published "
              "password and new databases — for a disposable CI database only. Set "
              "CI_FIXTURE_SEED=1 to proceed (the e2e workflow does).", file=sys.stderr)
        return 2
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == EMAIL).first()
        if user is None:
            print(f"seed_e2e_source_hardening: no user {EMAIL} — run seed_e2e_user.py first")
            return 1
        _role_and_databases()
        gs_id = _gsheets_source(db, user)
        print(json.dumps({"role": ROLE, "databases": list(TABLES), "gsheets_source_id": gs_id}))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
