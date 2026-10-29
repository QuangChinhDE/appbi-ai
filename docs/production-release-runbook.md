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

1. **Confirm the release tag.**
   - It must be an annotated tag on `origin/master`.
   - CI must be green on that exact commit.
2. **Identify the deployment model.** Run `docker ps` and `grep -c '^DATABASE_URL=.\+' .env`.
   - **Bundled `local-db`** (a `<project>-db-1` container, `DATABASE_URL` empty):
     the scripts back up and restore it themselves.
   - **Managed / external Postgres** (`DATABASE_URL` set): the app account is
     usually *not* superuser and lacks CREATEDB/CREATEROLE (two earlier production
     incidents came from exactly that). Plan a **provider snapshot** for the window.
     The upgrade refuses to run without `APPBI_PROVIDER_SNAPSHOT=<id>`, unless you
     explicitly pass `APPBI_ACCEPT_NO_PROVIDER_SNAPSHOT=yes`.
   - **Managed Postgres: prepare a backup credential.** `govern_doc_block` and
     `govern_doc_chunk` use `FORCE ROW LEVEL SECURITY`. If the app role is neither
     superuser nor `BYPASSRLS`, `pg_dump` refuses those tables. The upgrade
     detects this **before** the freeze and requires `APPBI_BACKUP_DATABASE_URL`.
     - The credential is used only for `pg_dump`, and only via environment
       variables.
     - The rehearsed role:
       ```sql
       CREATE ROLE appbi_backup LOGIN BYPASSRLS PASSWORD '…';
       GRANT pg_read_all_data TO appbi_backup;
       ```
     - Take it from the secret store, never from `.env`.
     - Never work around this with `pg_dump --enable-row-security`. It "works" by
       dumping only the rows the policy shows, so the backup is silently
       incomplete.
3. **Read the behaviour changes for this release** (section 5) and make the
   decisions they require.
4. **Prepare `.env` by hand. Never replace it.**
   - `ADMIN_PASSWORD` must be at least 12 characters, or the release refuses to start.
   - `ALLOWED_PRIVATE_SOURCE_CIDRS`: Postgres/MySQL sources on private addresses
     are **refused by default** in this release. Add the **narrowest** range
     covering each internal source host, ideally `/32` per host. Run the inventory
     below to get the list.
   - Do **not** use `SOURCE_ALLOW_PRIVATE_NETWORK=true`. It opens every private
     range to any user-chosen source host.
   - **Never allowlist the application's own metadata database** (`appbi-db`, or
     the managed DB host). Sources pointing at it let any source author read
     AppBI's internal tables. In the rehearsal copy, 13 legacy sources pointed
     there. Repoint each such source at its real host, or accept that it stops,
     by listing its id in `APPBI_ACCEPT_BLOCKED_SOURCES`.
   - Cloud metadata, link-local and other hard-denied ranges stay refused whatever
     you list.
   - Never put `APPBI_MIGRATE_APPROVED` in `.env`; the script refuses it.
5. **Run the source inventory early**, on the release image, read-only. The
   upgrade runs the same check as a hard gate (section 1, step GATE).
   ```bash
   # from a checkout of the tag on any host that can reach the production DB:
   docker compose build backend
   docker compose run --rm --no-deps backend source-inventory --probe
   ```
   - Every line must read `ALLOWED`.
   - `BLOCKED` means a CIDR is missing (or the host is hard-denied).
   - `UNREACHABLE` means it is allowed, but this host cannot reach it.
6. **Check disk space.** Free space must be at least 2× (DB size + file-storage
   volume size). Backups go to `../appbi-backups/` (override with `APPBI_BACKUP_DIR`).
7. **Announce a write-freeze window.**
   - Allow about 10 minutes of downtime. The build runs *before* the freeze, while
     the old version still serves.

## 1. Upgrade

The production checkout is still on the **old** commit, which does not contain
these scripts. Take them from the release tag. Do not check the tag out by hand;
the script does that itself.

```bash
cd /path/to/appbi-ai                     # the checkout production is served from
git status                               # must be clean (untracked files are fine)
git fetch --tags origin
mkdir -p ../appbi-release-tools
git show <tag>:scripts/deploy/prod-upgrade.sh  > ../appbi-release-tools/prod-upgrade.sh
git show <tag>:scripts/deploy/prod-rollback.sh > ../appbi-release-tools/prod-rollback.sh
bash ../appbi-release-tools/prod-upgrade.sh <tag>              # local-db
APPBI_PROVIDER_SNAPSHOT=<id> bash ../appbi-release-tools/prod-upgrade.sh <tag>   # managed DB
```

The current production build reports `git_sha: "unknown"`. The deploy record
therefore stores `old_checkout` and the exact pre-upgrade image IDs, and the
rollback checks the image IDs.

What it does, in order:

| Step | What happens | If it fails |
|---|---|---|
| Identity | `<tag>` must be annotated and on `origin/master`; the tree must be clean. | Nothing changed. |
| Discovery | Compose project from `APPBI_COMPOSE_PROJECT`, else `COMPOSE_PROJECT_NAME` in `.env`, else the directory name. The **running** backend container must exist. The file-storage volume is read from its actual `/app/.data` mount, and other mounts are listed. For local-db, the `db` container must exist. For managed DB, the server version is read and a matching `postgres:<major>` dump client is chosen. | Nothing changed. |
| Environment | Required secrets present and real. Fingerprints (never values) of `SECRET_KEY`, `DATASOURCE_ENCRYPTION_KEY`, `DB_PASSWORD`, `DATABASE_URL` and `APP_DB_PASSWORD` are recorded. | Nothing changed. |
| Schema | Reads the live revision and computes the tag's single head. | Nothing changed. |
| Build | The old images are tagged `<project>-<svc>:rollback-<sha12>`. The tag is checked out and built with `GIT_SHA=<commit>`, while the old service is still serving. The image's own `alembic heads` must equal the computed head. | **Auto-recovery**: the old checkout and images are restored and the service keeps running. |
| Source gate | `source-inventory --probe` runs in the new image with the production `.env`. Every Postgres/MySQL source must be `ALLOWED`; the only exception is ids listed in `APPBI_ACCEPT_BLOCKED_SOURCES`. The result is saved as `source-inventory.json`. | Auto-recovery. Fix `ALLOWED_PRIVATE_SOURCE_CIDRS` and re-run. |
| Freeze | Stops backend, frontend and pdf-worker. The DB stays up. | Auto-recovery. |
| Backup | `pg_dump -Fc` produces `db.dump`, the discovered volume is tarred, and `.env` is copied (mode 600). A record is written and checksums go to `SHA256SUMS`. | Auto-recovery. |
| Restore test | `db.dump` is restored into a throwaway `pgvector` container of the server's major version, and row counts are compared. | Auto-recovery. A backup that does not restore is not a backup. |
| Migrate | `docker compose run --rm backend migrate` with `APPBI_MIGRATE_APPROVED=<head>`. This is the **only** runner. | Rolled back by Postgres: auto-recovery. Part-applied: stop and run the rollback. |
| Start + Post | Starts the services, then checks: serving SHA equals the tag, alembic equals the head, secret fingerprints are unchanged, `/login` returns 200, one public link returns 200, containers are running, and the logs are clean. | Fix forward or roll back (section 3). |

"Auto-recovery" means: check out the old commit, re-tag the rollback images as
`latest`, start backend and frontend, and print what is serving. The schema was
never touched.

**Why the backend refuses to migrate on its own.** `entrypoint.sh` applies
pending migrations to an existing database only when `APPBI_MIGRATE_APPROVED`
names the exact head. So a plain `docker compose up` or `./run.sh` on a database
that is behind **stops**, and the schema is untouched.

Two more cases:
- A database that has tables but **no `alembic_version`** (a partial restore, or
  a wrong `DB_NAME`) is refused even with approval. It is never treated as a
  fresh install.
- Fresh installs, and restarts with nothing pending, are unaffected.

`./run.sh --migrate` approves `auto` for dev and one-command installs.

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
bash ../appbi-release-tools/prod-rollback.sh ../appbi-backups/<stamp>-<tag>
```

1. Verifies `SHA256SUMS` and restores `.env`.
2. **Database:**
   - **local-db:** restores into a *staging* database, then swaps names. The
     upgraded database is kept as `<db>_failed_<time>`.
   - **Managed Postgres:** runs in ONE transaction: `DROP OWNED BY` the app role,
     then replays the dump (extensions and ownership excluded).
     - It needs no CREATEDB, rename or superuser privilege.
     - Any error rolls the whole transaction back and leaves the database
       unchanged. In that case, restore the provider snapshot named in
       `deploy-record.txt`, which is preferred anyway when it is available.
3. Restores the recorded file-storage volume.
4. Re-tags the pre-upgrade images, checks out the old commit and starts it.
5. Requires all of the following:
   - the serving SHA equals the one recorded before the upgrade;
   - **each container runs the exact pre-upgrade image ID**;
   - the schema is the old revision.

**Data-loss implications.** The rollback restores the moment of the backup.

- Everything written after it is discarded: dashboards, grants, chat and agent
  runs, uploads, and synced data.
- If the release was live for hours, weigh that loss against fixing forward.
- Roll back for data corruption, failed migrations, or a broken login or public
  surface.
- Fix forward for a single broken feature.

**Reverting git alone is not a rollback.** Several migrations in this release
cannot be reversed by `alembic downgrade` (section 5).

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

## 6. Operator actions and accepted residual risks

**Do once, on every environment where it exists:**

- **Revoke the eval public link.** Before this release, the public-link token of
  the eval fixture dashboard ("Olist Public", link id 39 on the dev database) was
  committed in `gold_olist.py`. It was live and unprotected there.
  - The code now reads `APPBI_EVAL_OLIST_TOKEN`, but the old value stays in git
    history.
  - On production, check `SELECT id, dashboard_id FROM dashboard_public_links
    WHERE token = '<value from git history>'`.
  - If that returns a row, deactivate the link and issue a new one.

**Accepted residual risks:**

| Risk | Why it is not changed in this release | Follow-up |
|---|---|---|
| The backend and pdf-worker containers run as root. | Existing `appbi_data` volumes hold root-owned files. Switching to a non-root `USER` makes the upgraded backend unable to write to them, so an ownership migration step would be needed. That is not a release-time change. | A separate change: add a `USER` together with a one-off `chown` job, and rehearse it on a volume copy. |
| Base images use floating tags, and about half of `requirements.txt` is range-pinned. | The deployed artifact is whatever gets built on the host, so a later rebuild can drift from the image that was tested. | Generate a constraints/lock file from the certified image and build with it. |
| The CSP allows `'unsafe-inline' 'unsafe-eval'` (`nginx.conf`). | Removing it needs a full browser regression over every chart type and export path. That was not done in this release. | Remove `'unsafe-eval'` in a dedicated change, with the E2E suite and the PDF/PPTX exporters as the gate. |
| The scheduler lock fails open (`app/core/scheduler_lock.py`). | If the advisory-lock query itself errors, a scheduled job runs unguarded on every worker. In that state the job's own database work is very likely to fail too. The scheduled jobs use `single_run` / `job_lock` (13 call sites). | Make it fail closed for jobs that write data. |
