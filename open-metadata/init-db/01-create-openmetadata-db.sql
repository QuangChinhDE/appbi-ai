-- ============================================================
-- 01 — Create OM's least-privilege role + its OWN database inside appbi-db.
-- ADDITIVE & SAFE: only adds a sibling role/database; never touches `appbi` data.
--
-- Run ONCE against appbi-db as a superuser, passing the password from .env:
--   docker exec -i appbi-db psql -U appbi -d postgres \
--     -v om_user="openmetadata_user" -v om_password="<OM_DB_PASSWORD>" \
--     < open-metadata/init-db/01-create-openmetadata-db.sql
-- (Git-Bash on Windows: prefix with MSYS_NO_PATHCONV=1.)
-- ============================================================

\set ON_ERROR_STOP on

-- 1) Dedicated, least-privilege login role for OM.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'om_user', :'om_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'om_user')\gexec

-- Keep the password in sync on re-runs (idempotent).
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'om_user', :'om_password')\gexec

-- 2) Separate database OWNED by that role (NOT the appbi database).
SELECT format('CREATE DATABASE openmetadata_db OWNER %I', :'om_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openmetadata_db')\gexec

-- 3) OM owns its database; no extra grants needed beyond ownership.
SELECT format('GRANT ALL PRIVILEGES ON DATABASE openmetadata_db TO %I', :'om_user')\gexec
