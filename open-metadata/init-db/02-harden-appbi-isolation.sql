-- ============================================================
-- 02 — (OPTIONAL, RECOMMENDED for ATTT) Lock the `appbi` core database so the
-- OM role can NEVER connect to it. Run this DELIBERATELY after step 01.
--
-- WHY this is safe for the running core:
--   • The AppBI app connects as the role that OWNS the appbi database; database
--     OWNERS and SUPERUSERS bypass the CONNECT privilege check, so revoking
--     CONNECT from PUBLIC does NOT lock out the app.
--   • It DOES stop every non-owner role (incl. openmetadata_user) from connecting.
--
-- BEFORE running, confirm the core app's DB role is the OWNER of `appbi`
-- (default deploy: role `appbi` owns database `appbi`). If other non-owner roles
-- legitimately connect to `appbi`, GRANT CONNECT back to each of them.
--
--   docker exec -i appbi-db psql -U appbi -d postgres \
--     -v appbi_db="appbi" -v appbi_owner="appbi" \
--     < open-metadata/init-db/02-harden-appbi-isolation.sql
--
-- VERIFY afterwards (must FAIL for openmetadata_user, SUCCEED for the app):
--   docker exec appbi-db psql "postgresql://openmetadata_user:<pw>@localhost/appbi" -c "select 1"   # expect: permission denied
-- ============================================================

\set ON_ERROR_STOP on

-- Only the owner (and superusers) may connect to the core database.
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'appbi_db')\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'appbi_db', :'appbi_owner')\gexec

-- Belt-and-suspenders: explicitly deny the OM role on the core DB.
SELECT format('REVOKE ALL ON DATABASE %I FROM openmetadata_user', :'appbi_db')\gexec
