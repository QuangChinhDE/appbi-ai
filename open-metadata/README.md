# OpenMetadata — hardened, hidden backend for AppBI Catalog

OM runs as an **independent, hidden, hardened** service behind AppBI. Users never touch it —
the AppBI backend proxies everything under `/api/v1/catalog/*` and the AppBI frontend renders
the catalog in AppBI's own style. OM is never exposed to the browser.

Architecture + data contract: [`INTEGRATION-PLAN.md`](./INTEGRATION-PLAN.md).

## Security posture (why this is prod-safe)

| Control | How |
|---|---|
| No public exposure | OM server has **no host port**; only the AppBI backend reaches it on `appbi-net`. |
| Search isolated | `opensearch` is on an **`internal: true`** network — no inbound/outbound except OM. |
| No source credentials in OM | **No ingestion/Airflow container** (`PIPELINE_SERVICE_CLIENT_ENABLED=false`). AppBI *pushes* metadata; OM never connects to your data sources. |
| Fresh signing keys | JWT RSA keypair generated locally (`gen-secrets.sh`), mounted read-only. The image's **public default keys are not used**. |
| Secrets off-repo | Strong DB password + key id live in `open-metadata/.env` (**gitignored**); keys in `secrets/` (**gitignored**). |
| DB isolation | OM uses its **own** database `openmetadata_db` with a least-privilege role; optional step 02 blocks that role from the `appbi` database entirely. |
| Resource caps | `mem_limit` on OM (2g) + opensearch (1.5g) so they can't starve the core. |
| Privilege drop | `no-new-privileges:true` on every container. |
| Core unaffected if OM down | Backend never calls OM at startup; `/catalog/*` degrades to 502/503; flag-gated + inert when off. |

## First-time bring-up

> Prereq: core stack running so `appbi-net` + `appbi-db` exist.

```bash
# 1) secrets (RSA keys + strong DB password + key id) → gitignored .env / secrets/
bash open-metadata/gen-secrets.sh
# 2) set a verified STABLE image tag in open-metadata/.env (NOT 2.0.0-SNAPSHOT):
#    OPENMETADATA_VERSION=1.7.6   (verify: docker manifest inspect docker.getcollate.io/openmetadata/server:1.7.6)

# 3) create OM's role + database inside appbi-db (additive; never touches `appbi`)
OM_PW=$(grep '^OM_DB_PASSWORD=' open-metadata/.env | cut -d= -f2-)
docker exec -i appbi-ai-db-1 psql -U appbi -d postgres \
  -v om_user="openmetadata_user" -v om_password="$OM_PW" \
  < open-metadata/init-db/01-create-openmetadata-db.sql

# 4) (recommended, deliberate) lock the appbi DB so OM's role can never connect
docker exec -i appbi-ai-db-1 psql -U appbi -d postgres \
  -v appbi_db="appbi" -v appbi_owner="appbi" \
  < open-metadata/init-db/02-harden-appbi-isolation.sql

# 5) bring up (first pull is several GB; migrate runs before the server)
docker compose -f open-metadata/docker-compose.openmetadata.yml --env-file open-metadata/.env up -d

# 6) watch health (server needs ~1–2 min after migrate)
docker logs -f appbi-om-server
docker exec appbi-om-server wget -qO- http://localhost:8586/healthcheck
```

## Bot token (server-to-server auth)

The AppBI backend authenticates to OM with the **ingestion-bot JWT** (signed by your fresh key).
Once OM is healthy, fetch it and put it in the **core** `.env` (repo root, gitignored):

```
METADATA_CATALOG_ENABLED=true
OPENMETADATA_API_URL=http://openmetadata-server:8585/api
OPENMETADATA_BOT_TOKEN=<ingestion-bot JWT>
```

Then rebuild/restart the AppBI backend. Until `METADATA_CATALOG_ENABLED=true`, the catalog
module is completely inert and the core app behaves exactly as today.

## Production go-live checklist
- [ ] `OPENMETADATA_VERSION` pinned to a **verified stable** tag (ideally by `@sha256:` digest).
- [ ] `gen-secrets.sh` run **on the prod host** (don't copy dev secrets to prod).
- [ ] Step 02 (appbi DB isolation) applied + verified (OM role connect to `appbi` → denied).
- [ ] `openmetadata_db` added to your Postgres **backup** scope.
- [ ] OM + opensearch containers confirmed to have **no published host ports** (`docker ps`).
- [ ] Core `.env` holds the bot token; `METADATA_CATALOG_ENABLED=true` only after smoke test.
- [ ] Image scanned (e.g. `trivy image`) and pull restricted to your internal registry mirror if required.
- [ ] Monitoring/alert on `appbi-om-server` health + memory.

## Tear down (never touches the `appbi` database)
```bash
docker compose -f open-metadata/docker-compose.openmetadata.yml down        # keep data
docker compose -f open-metadata/docker-compose.openmetadata.yml down -v     # also drop OM search volume
```
