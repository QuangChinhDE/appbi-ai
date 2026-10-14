# Source core hardening — approved spec

Baseline `origin/demo` 2e143e17. Branch `feat/source-core-hardening`. Approved by the owner
2026-10-06 after audit F1–F17.

## Permission mapping (module levels unchanged: none < view < edit < full)

| Action | Required |
|---|---|
| list/open/metadata/health/schema+table discovery | object `view` |
| saved-source retest (`POST /datasources/{id}/test`) | object `edit` |
| draft config test (`POST /datasources/test-draft`) | module `edit`; reuse of a stored secret only with object `edit`, same type, identical destination fields |
| raw SQL (`/query`, `/validate-sql`) | object `edit` |
| update config / rotate credential | object `edit` |
| delete / share | object `full` |
| direct upstream Sheets mutation under `/datasources/{id}/gsheets/*` | object `full` |
| Workboard operational writes | Workboard/Dataset authorization, via an internal service — never the public Source endpoints |

## Security invariants
- Saved retest takes type, destination and secret ONLY from the persisted row.
- Draft test never pairs a stored secret with a changed destination.
- Outbound policy (PG/MySQL): `SOURCE_ALLOW_PRIVATE_NETWORK=false` default; `ALLOWED_PRIVATE_SOURCE_CIDRS`
  allow-list (empty = nothing). Loopback, link-local, metadata (169.254.169.254, fd00:ec2::254,
  metadata.google.internal), unspecified, multicast, reserved: hard deny. Resolve every A/AAAA
  candidate; any disallowed candidate = refuse; connect via the checked IP (`hostaddr` for libpq,
  resolved IP for pymysql) to defeat rebinding.
- PG identifiers only through one helper using `psycopg2.sql.Identifier`.
- Ad-hoc query path: validator (literals stripped before comments; single statement; no INTO,
  COMMIT/ROLLBACK, dangerous functions) + PG `READ ONLY` transaction + server row cap (clamp, report
  truncation) + bounded timeout. BigQuery: dry run required, `maximum_bytes_billed` on the job, no
  free bypass when the dry run fails.
- Platform GCP credential: disabled unless `PLATFORM_GCP_ALLOWED_PROJECTS` set (or admin); a project
  outside the list is refused.
- Encryption: production fails at startup if the key is missing/invalid; no plaintext fallback.
- Logs: no full SQL, no raw provider errors; everything through `source_errors` redaction.

## Domain invariants
- `type` immutable after create.
- Update = load → merge → restore masked secrets ONCE → auth-mode rules → validate FINAL merged config
  → (test) → persist → invalidate. One chokepoint in the service.
- Name unique per owner (`owner_id, name`).
- Delete dependency check lives in the service; blockers: non-draft Datasets, Knowledge Docs,
  `host_datasource_id`; ResourceShare + manual assets cleaned.
- `config_version` incremented on connection-affecting change; `invalidate_source()` is the only
  invalidation entry point (DatasetTable caches, query cache, BQ client, Sheets cache) — this source only.
- `DataSource.sync_config` / `sync_jobs` retired (Dataset owns sync).
- Provider capability model; google_docs is non-tabular and refused by tabular paths.
- Structured connection test: `{status, provider, checks{auth,reachable,queryable,discoverable},
  error_code, message, warnings, duration_ms, success}`.

## Manual ingestion
- `.csv` and `.xlsx` only. Named limits in settings: 50 MB, rows, columns, cell size, sheets,
  total cells, decompressed-size guard. Deterministic unique headers.
- Upload → staged asset (Parquet, storage abstraction under `DATA_DIR`, server-generated keys,
  atomic write) → bounded preview; `DataSource.config` holds only asset references.
- Legacy configs with inline rows migrate idempotently to assets.
