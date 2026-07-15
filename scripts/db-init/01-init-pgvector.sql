-- Provision the pgvector extension for the BUNDLED local-db container only.
-- Files in /docker-entrypoint-initdb.d run once, on first initialisation of an
-- empty data volume, as the Postgres SUPERUSER. This keeps extension creation a
-- DB-provisioning concern — the application account stays use-only and never
-- creates extensions itself. Managed/external Postgres provisions it separately
-- (an admin runs `CREATE EXTENSION vector;` once).
CREATE EXTENSION IF NOT EXISTS vector;
