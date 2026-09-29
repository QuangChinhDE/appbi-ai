# AppBI operator runbook

Everything here was run against this repository and this compose stack. Nothing
in it is generic Docker advice, and nothing is written from the YAML alone —
where a command's effect is a claim (persistence survives a restart, the deploy
path does not drop data), the claim was checked by doing it.

Service names below are the ones `docker compose` creates in this project:
`appbi-ai-backend-1`, `appbi-ai-frontend-1`, `appbi-ai-db-1`. Confirm with
`docker ps` before assuming.

---

## Prerequisites

- Docker and the Compose plugin, with the daemon running.
- The repository checked out. `run.sh` resolves the commit from the working copy,
  so start from the commit you intend to serve.
- `.env`. `run.sh` syncs it against `.env.example` and generates missing secrets
  on the way up; you do not hand-write it.

---

## Start, and update

```bash
./run.sh                 # sync env, build, start, wait until healthy
./run.sh --pull          # fast-forward the current branch first, then the above
./run.sh --no-build      # start without rebuilding
./run.sh --recreate      # force-recreate containers
./run.sh --logs          # follow logs once it is up
./run.sh --down          # stop the stack
```

`run.sh` exits **non-zero** if any service fails to become healthy — it does not
report a false success. It is the supported path; `docker compose up` by hand
works but skips the env sync and the health validation.

**`--down` stops containers and keeps data.** It runs `docker compose down`
without `-v`, and no supported path in this repository passes `-v` or drops the
database. Removing `db_data` or `appbi_data` is a deliberate act you have to type
yourself — see *Emergency stop* for the one that is safe.

---

## Migrations

Alembic runs from the backend entrypoint on every start, before uvicorn. There is
nothing to run by hand for a normal deploy.

```bash
docker exec appbi-ai-backend-1 sh -c 'cd /app && alembic heads'
docker exec appbi-ai-backend-1 sh -c 'cd /app && alembic current'
```

`heads` must print exactly one line. Two heads means two migration branches
exist and the next start will fail; that is a repository problem, not a
deployment one.

**There is no automatic migration rollback, and this runbook does not promise
one.** Rolling the application back to an earlier image is safe when the schema
that image expects is a subset of the schema now present — which is the case for
an additive migration, and this repository's migrations are additive by policy.
It is *not* safe when a migration dropped or renamed something the older code
still reads. Check what the migrations between the two commits did before rolling
back across them.

---

## Health, and which commit is serving

```bash
curl -s http://localhost:8000/api/v1/health
```

```json
{"status":"healthy","git_sha":"<40 hex>","code_version":"…","features":{…}}
```

`git_sha` answers in this order, most authoritative first:

1. `GIT_SHA` in the container environment — a deployment stating its own identity.
   `run.sh` sets it from `git rev-parse HEAD` **after** any `--pull` and only
   when it is building, so it always names the code it just built. An
   externally supplied `GIT_SHA` is never replaced. With `--no-build` it sets
   nothing, so the existing image's own baked value (3) answers.
2. `SOURCE_COMMIT` / `COMMIT_SHA`, for build systems that set those.
3. `APPBI_BUILD_SHA`, **baked into the image at build time** from the same
   `GIT_SHA`. This is what answers when the stack is started by any route that
   did not export anything.
4. `"unknown"` — nobody said, and the image predates the baked value.

To confirm the running service is the commit you think it is:

```bash
[ "$(curl -s http://localhost:8000/api/v1/health | sed -E 's/.*"git_sha":"([^"]*)".*/\1/')" \
  = "$(git rev-parse HEAD)" ] && echo MATCH || echo MISMATCH
```

`MISMATCH` with a real SHA on both sides means the running image is a different
commit from your working copy — usually a `--no-build` start after a pull,
which now truthfully reports the OLD commit the image was built from. That is
the signal to rebuild, not a fault in the report.
`unknown` means the image was built before the SHA was baked in; rebuild.

`features` are **code constants**, not configuration. A flag being present proves
that source is the running process, which is what makes this an objective test of
whether a deploy took effect rather than a report of what someone intended.

---

## Logs

```bash
docker compose logs -f backend            # follow
docker compose logs --tail=200 backend    # recent
docker compose logs --tail=200 frontend
docker compose logs --tail=100 db
```

**Never redirect a container's stderr into a pipeline that prints query strings.**
Datasource URLs can carry credentials in a query parameter, and `httpx` logs the
full URL at WARNING. If you are pasting logs into a ticket, read them first.

---

## Tracing a user's complaint

A reader says "the assistant got it wrong". The chain, using records the product
already keeps:

1. Get the report's public link (the `/d/<token>` URL they were on) or the
   dashboard.
2. Find the run:

   ```bash
   docker exec appbi-ai-db-1 psql -U appbi -d appbi -c "
     SELECT id, brain_key, version, status, is_test, rating, created_at
     FROM agent_flow_runs
     WHERE link_token = '<token>'
     ORDER BY id DESC LIMIT 20;"
   ```

3. Open that flow in the product: **Agent Flows → the flow → Runs**, and select
   the run. The per-step trace shows what each step was handed, what it produced,
   which tools it called and how each ended. *Open in builder* puts you on the
   node that produced a step.
4. `version` on the run is the flow version that answered — not necessarily the
   one open in the builder now.
5. `git_sha` from `/api/v1/health` is the code that ran it.

Steps 3–4 are the product's own surfaces. Use them before reaching for SQL: the
trace is richer than the table, and it is already written for this question.

---

## Pilot funnel

```bash
docker exec -i appbi-ai-db-1 psql -U appbi -d appbi -f - < scripts/ops/pilot_funnel.sql
```

Read-only, bounded, and it reads no reader's question text. It answers: flows
created and published, active bindings, runs by outcome, author tests vs real
reader runs, last 7 days, ratings, distinct reader sessions, top flows, and where
failures concentrate.

**Not `docker exec … python`.** `entrypoint.sh` derives `DATABASE_URL` from the
`DB_*` variables and exports it into the server process only, so a shell opened
with `docker exec` sees an empty `DATABASE_URL` and any Python importing
`app.core` dies on `create_engine('')`. Backend tooling that needs the database
either runs through the entrypoint or is handed a URL explicitly. The funnel
avoids the question by talking to the database service directly.

---

## Restart

```bash
docker compose restart backend
docker compose restart frontend
docker compose restart            # everything
```

Data survives: Postgres is a named volume (`db_data`) and uploaded/generated
files are `appbi_data`. **Verified by doing it**, not inferred from the compose
file — a draft flow, a published version, a binding, a run and a reader's rating
were all created, the stack restarted, and all five read back unchanged.

After a restart, confirm the commit did not change unintentionally:

```bash
curl -s http://localhost:8000/api/v1/health
```

---

## Rolling the application back

```bash
git checkout <known-good-sha>
./run.sh                                  # rebuilds and restarts at that commit
curl -s http://localhost:8000/api/v1/health   # git_sha must now be <known-good-sha>
```

Before doing it, read what changed to the schema in between:

```bash
git diff --name-only <known-good-sha>..HEAD -- backend/alembic/versions/
```

Nothing listed → the rollback touches no schema and is safe. Files listed → read
them. Additive migrations (new table, new nullable column) leave the older code
working. A drop or a rename does not, and rolling back across one needs a
decision, not a command.

**The database is not rolled back by this.** It stays at the newer schema.

---

## Backup, before you need it

The whole metadata database is one volume:

```bash
docker exec appbi-ai-db-1 pg_dump -U appbi -d appbi > backup-$(date +%F).sql
```

Take one before any rollback that crosses a migration, and before any deliberate
volume removal. Generated files (`appbi_data`) are not in that dump; they are
regenerable output, not source of truth.

---

## Emergency stop

```bash
./run.sh --down                     # stop everything, keep all data
docker compose stop backend         # stop one service
```

If a bad deploy is serving readers, `docker compose stop backend` takes the
assistant offline immediately while leaving the database and the frontend up.

**`docker compose down -v` destroys the database volume.** It is never part of a
deploy, an update or a rollback. The only reason to type it is to deliberately
discard a local environment, and you take a dump first.
