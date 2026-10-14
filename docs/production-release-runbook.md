# Production release runbook — upgrading an existing install

For the operator upgrading the production host (the one serving
`report.base-datateam.com`) from an older `master` to a tagged release. It
complements [ops-runbook.md](ops-runbook.md), which covers day-to-day operation.

The procedure is scripted:

- `scripts/deploy/prod-upgrade.sh <tag>` does the upgrade.
- `scripts/deploy/prod-rollback.sh <backup-dir>` undoes it.

Both scripts stop at the first failed step. The sections below explain what they
do, and list the decisions a script cannot make for you.

**Never** use any of these during a release:

- `./run.sh --pull`;
- `docker compose down -v`;
- `docker system/volume prune`;
- deleting or regenerating `.env` secrets.

---

## 0. Before the maintenance window (no downtime)

1. **Confirm the release tag exists and is verified.**
   - It must be an annotated tag on `origin/master`.
   - CI must be green on that exact commit.
2. **Read the behaviour changes for this release** (section 5) and make the
   decisions they require.
3. **Prepare `.env` for the new release.**
   - Edit the production `.env` by hand. **Do not** replace it.
   - Check every key in the "Environment changes" table in section 5.
   - In particular:
     - `ADMIN_PASSWORD` must be at least 12 characters. The release refuses to
       start in production otherwise.
     - `ALLOWED_PRIVATE_SOURCE_CIDRS` must cover the network of any
       Postgres/MySQL source on a private address.
4. **Check disk space.** Free space must be at least 2× (database size +
   `appbi_data` volume size). The backup is written next to the checkout in
   `../appbi-backups/` (override with `APPBI_BACKUP_DIR`).
5. **Announce a write-freeze window.**
   - Allow about 15 minutes, plus the build time on the host.
   - During the window, backend and frontend are stopped. The database stays up.

## 1. Upgrade

```bash
cd /path/to/appbi-ai                     # the checkout production is served from
git status                               # must be clean (untracked files are fine)
scripts/deploy/prod-upgrade.sh <tag>     # interactive confirm; --yes for unattended
```

What it does, in order. A failure at any step stops the script.

| Step | What happens | If it fails |
|---|---|---|
| Identity | Requires `<tag>` to be annotated and on `origin/master`, and the tree to be clean. Records the checked-out commit and the commit currently serving. | Nothing has changed. |
| Environment | Checks that `SECRET_KEY`, `DATASOURCE_ENCRYPTION_KEY` and `ADMIN_PASSWORD` are present and real. Records a **fingerprint** (sha256 prefix) of each secret, never the value. Warns about CORS and the source CIDR policy. | Nothing has changed. |
| Schema | Reads `alembic_version` from the live database and computes the release's single head from the tag. | Nothing has changed. |
| Write-freeze | Stops `backend`, `frontend` and `pdf-worker`. | Nothing has changed; start them again with `docker compose up -d`. |
| Backup | Writes four things to the backup directory: `pg_dump -Fc` as `db.dump`, a tar of the `appbi_data` volume as `appbi_data.tgz`, `.env` as `env.backup` (mode 600), and the current images under `<project>-<svc>:rollback-<sha12>`. Records checksums in `SHA256SUMS`. | Services are down and nothing is migrated. Fix the cause and re-run, or start the old stack again. |
| Restore test | Restores `db.dump` into a throwaway `pgvector:pg16` container and compares row counts. | Same as above. A backup that does not restore is not a backup. |
| Build | Checks out the tag commit and builds with `GIT_SHA=<commit>`, so `/api/v1/health` reports the commit it actually runs. | Old images are still tagged; run the rollback. |
| Migrate | `docker compose run --rm backend migrate` with `APPBI_MIGRATE_APPROVED=<head>`. This is the **only** runner that migrates. | Services stay down. Run the rollback (restores the DB). |
| Start | `up -d --no-build backend frontend`. | — |
| Post | Checks that the serving SHA equals the tag commit, alembic equals the head, the secret fingerprints are unchanged, containers are running, the frontend `/login` page returns 200, one public link returns 200, and the last 5 minutes of logs are free of tracebacks and 5xx responses. | Decide whether to fix forward or roll back (section 3). |

**Why the backend refuses to migrate on its own.**

- Since this release, `backend/entrypoint.sh` will not apply pending migrations
  to an existing database unless `APPBI_MIGRATE_APPROVED` names the exact target
  head.
- A plain `docker compose up` or `./run.sh` on a database that is behind
  therefore **stops** with a message, and the schema is untouched. Before this
  release, any restart after a pull migrated immediately, with no backup.
- Fresh installs, and restarts with nothing pending, are not affected.
- For a dev or one-command install, use `./run.sh --migrate` after taking a
  backup.

**External/managed Postgres** (`DATABASE_URL` set in `.env`):

- The upgrade script runs `pg_dump` and the backup in a throwaway container on
  the host network.
- The rollback expects you to restore `db.dump` with your provider's tooling,
  or use a provider snapshot, which is preferred.

## 2. Acceptance checklist (after the script reports `UPGRADE COMPLETE`)

Sign each item with your name and the time.

- [ ] `curl -s 127.0.0.1:8000/api/v1/health` → `git_sha` equals `git rev-parse <tag>^{commit}`.
- [ ] `alembic_version` holds exactly one row, equal to the release head.
- [ ] Log in as the administrator and as one ordinary user.
- [ ] Open three dashboards: the busiest one, one with filters/slicers, and one
      that was previously in Canvas mode, if any. Charts render and filters apply.
- [ ] Sources: open a BigQuery source and a Postgres/MySQL source and use
      *Test connection*. A private-host source that now fails needs
      `ALLOWED_PRIVATE_SOURCE_CIDRS`; this is not a regression.
- [ ] Datasets: explore one dataset. As a user who had only a *view* share,
      check whether they can still build (see section 5).
- [ ] Public link: open one `/d/<token>` in a private window, and one
      password-protected link.
- [ ] Embedded report: load one `/embed/...` integration. Embed grants issued
      before the upgrade are refused; the host must request a new one (see
      section 5).
- [ ] Export one dashboard to PDF and one to PPTX.
- [ ] Chat / Agent Flow: send one question.
- [ ] Observability page loads, and open incidents look sane.
- [ ] Error rate: `docker compose logs --since 30m backend | grep -cE '" 5[0-9]{2} '`
      stays near zero. 401/403 responses on embed in the first hour are expected.
- [ ] Persistence: `docker compose restart backend frontend`, then re-check health
      and one dashboard.

## 3. Rollback

```bash
scripts/deploy/prod-rollback.sh ../appbi-backups/<stamp>-<tag>
```

It does the following:

1. Verifies the backup checksums.
2. Restores `.env`.
3. Restores the database into a **staging** database first. It then swaps it in
   and keeps the upgraded database as `<db>_failed_<time>` for forensics.
4. Restores the `appbi_data` volume.
5. Re-tags the pre-upgrade images.
6. Checks out the old commit and starts it.
7. Requires the serving SHA to equal the one recorded before the upgrade.

**Data-loss implications.** The rollback restores the moment of the backup.

- Everything written after the upgrade started is discarded: new or edited
  dashboards, grants, chat and agent runs, uploads, and synced data.
- If the release was live for hours, weigh that loss against fixing forward.
- Fixing forward is usually right for a single broken feature. Roll back for
  data corruption, failed migrations, or a broken login or public surface.

**Reverting git alone is not a rollback.** Several migrations in this release
cannot be reversed by `alembic downgrade` (section 5). The database restore is
the rollback; the code checkout only matches it.

## 4. Restore drill (do this once before the window)

On any machine with Docker, restore a recent production dump into a scratch
container and run the release migration against it. This rehearses the
upgrade on real data:

```bash
docker run -d --name appbi-drill -e POSTGRES_USER=appbi -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=appbi pgvector/pgvector:pg16
docker exec appbi-drill psql -U appbi -d appbi -c "CREATE EXTENSION vector"
docker exec -i appbi-drill pg_restore -U appbi -d appbi --no-owner --no-acl < db.dump
# then, from a checkout of the release tag:
cd backend && DATABASE_URL=postgresql+psycopg2://appbi:drill@<host>:5432/appbi alembic upgrade head
docker rm -f appbi-drill
```

- `--no-acl` is needed when the scratch server has no `appbi_app` role.
  Production has that role, created by migration 0048, so a restore *into
  production* keeps the grants.
- The dump contains customer data and stored (encrypted) credentials. Treat it
  like the production database: keep it on an encrypted disk, and delete it
  after the drill.

## 5. Release 2026-10-14 (master 972c4e96 → this tag): what changes for existing data

**Schema:** `20260914_0002` → `20261012_0001`. There are 23 revisions, all
covered by `prod-upgrade.sh`.

Intentional behaviour changes:

| Migration | Effect on existing data | Reversible by downgrade? | Decide before the window |
|---|---|---|---|
| `20261004_0001` | Legacy `dashboards.share_token` URLs (`/d/<old token>`) stop working. Public links that reached `max_access_count` become inactive. Embed grants issued earlier are refused (they live at most 1 h). | **No** for `share_token`: the value is not kept. | Export the old tokens first: `SELECT id, share_token FROM dashboards WHERE share_token IS NOT NULL`. Tell owners to share a new public link. |
| `20261008_0001` | Dataset shares move into `dataset_grants`. A legacy **view** share becomes **explore**: the user can no longer build charts on it. Edit stays edit. Original rows are archived in `resource_shares_dataset_archive`. The list of affected users is in `authz_impact_reports` (`dataset_single_authority`). | Yes, from the archive. | Review `view_shares_losing_build` and re-grant *build* where intended. |
| `20261008_0004` | Drops the unused `module_permissions` table. Rows are archived as JSON in `authz_impact_reports`. | Yes. | — |
| `20261008_0005` | Destroys the encrypted copy of each personal access token. Tokens keep working, but their secret can no longer be revealed. | **No.** | Tell PAT owners. |
| `20261006_0003` | `sync_jobs` is renamed to `sync_jobs_retired`, and `data_sources.sync_config` is archived and then dropped. Source names become unique per owner instead of globally. | Yes. | — |
| `20260928_0001`, `20260929_0001` | Canvas dashboards become grid dashboards. The slicer bar becomes grid controls. These are large JSON rewrites, with markers that make them reversible. | Yes. | Spot-check layouts on the busiest dashboards. |
| `20261008_0008` | Duplicate open incidents with the same key are merged. Extra copies are marked resolved and keep a `merged_into` field. | No; they stay resolved, but are traceable. | — |

Environment changes for an existing `.env`:

| Key | New behaviour | Action |
|---|---|---|
| `ADMIN_PASSWORD` | Production refuses a missing, placeholder or short (<12 characters) value. The compose default is no longer `123456`. | Set a strong value. It is used only for the first admin on an empty database, but it is still validated at every start. |
| `SOURCE_ALLOW_PRIVATE_NETWORK` / `ALLOWED_PRIVATE_SOURCE_CIDRS` | **New, closed by default.** Postgres/MySQL sources on private or loopback addresses are refused. | List the private source hosts and set the CIDRs. |
| `PLATFORM_GCP_ALLOWED_PROJECTS` | New, empty by default. The platform service account only serves sources an admin saved. | Set it if BigQuery sources relied on the platform account for other projects. |
| `TRUSTED_PROXY_CIDRS` / `TRUSTED_PROXY_HOPS` | New. The real client IP is taken from forwarded headers sent by trusted proxies. The default trusts RFC1918 networks and loopback, with 1 hop. | With a CDN or load balancer in front of nginx, raise `TRUSTED_PROXY_HOPS`. |
| `APPBI_MIGRATE_APPROVED` | New migration gate (see section 1). | Leave **unset** in `.env`. The upgrade script passes it for one run only. |
| `METADATA_CATALOG_ENABLED` / `GOVERN_ENABLED` / `OBSERVABILITY_ENABLED` | `run.sh` no longer forces an explicit `false` back to `true`. | None. A value you set now sticks. |
