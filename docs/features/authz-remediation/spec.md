# Authorization remediation — spec

Behaviour once built. Names below are proposals; the invariants are the contract.

## Behaviour

### 1. Principals (`app/core/authz/principals.py`)

Every request resolves to exactly one typed principal. Anything that does not resolve is DENY.

| Principal | Created by | Carries |
|---|---|---|
| `HumanSession(user)` | access JWT (`type=access`, `aud=appbi.api`) | live user, normalized entitlements |
| `PatPrincipal(user, caps, token_id)` | PAT | owner's live entitlements ∩ caps; decision ⊆ owner's decision |
| `PublicCapability(link)` | public link token / public session | bound dashboard id + locked filters; no user |
| `EmbedGrant(grant, link, pat)` | `emb_` grant | as above + minting PAT liveness + minting owner liveness |
| `AppUser(workspace, app_user, role, context)` | workspace session (`type=ws_session`) | RLS identity; role is re-read from the DB each request |
| `StaffInWorkspace(user, workspace)` | AppBI access token presented on a workspace route | a HumanSession; **no** implicit workboard rights |
| `Delegated(actor, on_behalf_of, grant)` | Agent Flow run | actor = caller, authority = per flow mode (see §6), audit tag |
| `System(job_name)` | scheduler/worker entrypoints only | constructed only in `app/core/authz/system.py`; a CI check forbids constructing it in `api/**` |

### 2. Decision API (`app/core/authz/`)

```text
authz.can(principal, action, resource, ctx=None)      -> Decision(allowed, reason, via, obligations)
authz.require(principal, action, resource, ctx=None)  -> resource | raises 403/404
authz.scope(principal, action, Model, query)          -> query  (SQL-side filter, same policy)
authz.require_all(principal, [(action, resource), …]) -> cross-resource
```

- **Obligations** carry field visibility: `mask_secrets`, `mask_capability_tokens`.
- Serializers consume the obligations instead of re-deciding them.
- **Error semantics:**
  - 401 when there is no principal;
  - 404 when the caller has no read relation (existence hiding);
  - 403 when the caller can read but not perform the action;
  - 400 for malformed authorization input (e.g. revoke target).

### 3. Actions (business verbs, `app/core/authz/actions.py`)

`read, explore, build, edit, delete, share, grant, publish, manage, manage_public_surface, trigger_compute, use_secret, manage_secret, reveal_secret, export, export_credentials, runtime_read, runtime_write, upload_media, admin_module, admin_global, delegate`.

Rules:
- An unknown action string raises at import or registration time, and is a DENY at runtime.
- Each resource policy declares which actions it supports. An action not declared for a resource is DENY.

### 4. Entitlements and relations (removes the ambiguity of `full`)

- **Entitlement (module ceiling)** comes from `users.permissions`, normalized once:
  - levels are `none < view < edit < admin`;
  - the stored string `"full"` is read as `admin`;
  - `settings: full` = superuser;
  - the admin back-fill of absent keys stays;
  - explicit `none` is respected;
  - the PAT cap is applied after.
- **Relation (per object)** is one of `none | viewer | editor | owner`, with resource-specific verbs for Dataset.
- **Decision** = the action's required relation **and** the action's minimum entitlement.
  - `admin` entitlement satisfies any relation requirement inside its module. It is an explicit `via=module_admin` in the decision and in audit logs, not a disguised owner.
  - Owner does not exceed the module ceiling: an owner with entitlement `view` can only perform view-class actions.

### 5. Dataset policy (single path)

Storage: `dataset_grants` (user or team target), plus ownership. ResourceShare(DATASET) rows are migrated into it and are no longer read.

| Verb held | Capabilities |
|---|---|
| view | read (metadata, aggregated chart reads through a chart the caller can read) |
| explore | + raw rows, preview, query, export |
| build | + create/rebind charts, dashboards, workboards, compositions, agent-flow attachments on this dataset |
| reshare | + grant/revoke ≤ own verbs, excluding `reshare`/`edit`/`manage` (decision Q1) |
| edit | view + explore + build + model/table/dictionary edits |
| manage | everything incl. publish, destination, delete, grant any verb |

Owner = manage. Module admin = manage (`via=module_admin`). All capped by entitlement:

| Entitlement | Verbs allowed |
|---|---|
| none | ∅ |
| view | view, explore |
| edit | all verbs |

**Grant rules:**
- The grantor must hold `grant`. The granted verb must be ≤ the grantor's delegable set.
- Self-targeted grants are refused.
- The target is exactly one valid UUID; anything else is 400.
- Revoke deletes by `(dataset_id, user_id)` or `(dataset_id, team_id)`. It cannot revoke a grant above the revoker's delegable level unless the revoker holds `manage`.
- Team resolution goes through `TeamMembership`. Membership changes take effect on the next request (no cache).

**Cross-module:**
- Charts, Dashboards, HTML import, report-starter, Workboard bind/rebind/publish/import, composition and agent-flow attach all call `authz.require(p, "build", dataset)`.
- `explore` gates preview, query, export and profile.
- The parent-ref preview additionally requires `explore` on the parent.

### 6. Agent Flow delegation

- **Run authority** = caller's live decision ∩ resources explicitly attached to the flow (owner must still be able to attach them).
- **Delegation** is a row in `agent_flow_delegations`, created only by the flow owner who holds the delegated action on that resource; it names grantee, resource and action; revocable; consulted per turn; audited as `Delegated(actor=caller, authority=owner, delegation_id)`. Absent/revoked ⇒ caller authority only.
- Revoking the share, or the owner losing access, takes effect on the next turn (already re-checked per turn).
- Metric names are filtered by the effective authority.

### 7. Workboard / Workspace

**Workspace**
- Resource with owner plus ResourceShare (viewer/editor). `manage` is held by owner or module admin.
- List is scoped. `token` is only returned when `can(manage)`.

**Menu entries**
- Adding a workboard slug requires `edit` on that Workboard.
- Removing one requires `manage` on the workspace.

**Runtime**

| Caller | Read | Write |
|---|---|---|
| `AppUser` | RLS as today | RLS as today |
| `StaffInWorkspace` | object `runtime_read` = Workboard `view` | `runtime_write` = Workboard `edit` |

- Staff are **not** RLS-exempt by default. Staff with Workboard `edit` see all rows, which matches the builder's own preview. The decision is explicit, not a `_internal` flag.
- App-user role/context and active state are re-read from the DB each request.
- Sessions get a `jti` and a per-app-user `session_epoch`. Logout, PIN change and deactivation bump the epoch.

**Actions and requirements**

| Action | Requirement |
|---|---|
| media upload | `upload_media` = edit (authed); public runtime requires a write-capable screen role; per-workspace quota |
| miniapp-share flag | dataset `manage` |
| export | `export` = edit |
| credential export | `export_credentials` = manage, plus an audit row |
| OCR key | `layout_json` is exported with OCR keys removed; import strips any OCR ciphertext |
| default PIN | new owner app user gets a random 8-digit one-time PIN shown once; PIN schema min length 6 |

### 8. Data Source

| Action | Requirement |
|---|---|
| read | masked config |
| `use_secret` (test with stored id, query, schema discovery) | edit |
| `manage_secret` | owner/admin |

- `test`/`update` with a stored id: if any endpoint field (host, port, database/project, account, url, dsn) differs from the stored value, stored secrets are **not** rehydrated; the caller must supply them.
- All connector egress goes through `app/core/egress.py`:
  - resolve once, pin the IP;
  - deny loopback, link-local, private, metadata and multicast addresses (allow-list via `EGRESS_ALLOW_PRIVATE_CIDRS` for on-prem warehouses, default empty in prod and permissive in dev);
  - no redirects;
  - errors are sanitized.
- `POST /datasources/query` requires `explore` on the data source (= edit) and stays select-only.

### 9. Observability

- **Alert channel `scope`:** `global | dataset`, explicit column; backfilled from `dataset_id IS NULL`.
  - Global channels: `admin_module(observability)` for every lifecycle action and to see the target.
  - Dataset channels: create requires dataset `edit`; update/delete/test requires channel owner (with dataset edit) or module admin.
  - Targets are masked unless `manage_secret` on the channel.
- **Scan:**
  - `POST /scan` with no ids → `admin_global`.
  - With `dataset_ids` → `trigger_compute` (= dataset edit) on each.
  - Rate limit: 1 per user per 5 minutes per dataset set.
  - The scheduler uses `System("observability.scan")`.
- Incident resolve requires dataset edit. `accept_schema_baseline` requires dataset `manage`.
- Webhook and SMTP targets go through the egress policy.

### 10. Govern

- `metric-usage`, `asset-docs`, `caveats` list, `managed-metrics`, `change-log`: results are filtered through `authz.scope` on charts, dashboards, docs and datasets. Global items stay listable, but dataset names the caller cannot read are masked.
- Caveat write/delete: `edit` on the caveat's dataset. Updating an existing caveat id also checks that the id's current dataset is editable.
- Managed metric / glossary / classification / tag writes: `admin_module(govern)`. Certify: `admin_module(govern)`.

### 11. Dashboard / Public / Embed

- `publish` (alias `manage_public_surface`) = owner or dashboard module admin, or an explicit future publish grant; shared `edit` never implies it. It gates public-link create/update/delete/rotate, embed mint and assistant binding.
- Public-link list masks `token` unless `manage_public_surface`.
- Snapshot refresh requires `trigger_compute` (= edit) and is rate limited.
- Embed grant liveness additionally checks that the minting user is active and still holds `manage_public_surface`.

### 12. Auth tokens

- **Domain keys:** derived via HKDF from `SECRET_KEY` with labels `access`, `refresh`, `public_session`, `ws_session`, `oauth_state`. PAT HMAC keeps its current key under label `pat_hmac_v1` (no PAT invalidated).
- **Decoding:** every decoder is `decode(token, domain)`, which checks key, `type`, `aud` and `exp`. A missing `type` is rejected.
- **Security stamp:** `users.security_stamp` is embedded in access/refresh tokens and bumped on password change, deactivation and permission demotion of `settings`. A mismatch gives 401.
- **OAuth state** is signed under its own domain, is single-use (jti stored), and is never accepted by `get_current_user`.
- **`public.py` staff bearer** uses `decode(token, access)`.
- **PAT:**
  - expiry required (max 365d) for new tokens; existing non-expiring tokens are reported, not broken;
  - admin reveal and admin-rotate-returning-plaintext removed; admin force-invalidate added (owner must rotate to get a new token);
  - owner reveal removed; `secret_enc` cleared by migration; plaintext only in create/rotate responses;
  - empty-scope rows are denied.

### 13. Bootstrap / startup

- **Production** (`ENVIRONMENT=production`):
  - The entrypoint seed refuses when `ADMIN_PASSWORD` is missing, blocklisted or shorter than 12 characters, and exits non-zero.
  - `validate_security_settings` checks the same, plus: `DATABASE_URL_APP` set and its role is non-superuser and not BYPASSRLS (queried at startup), secure cookies, no dev flags.
  - `bootstrap-env.sh` no longer writes `123456`.
- **Development:** a random password is generated, printed once, and `must_change_password` is set.

### 14. Registry and CI gates

- `app/core/authz/registry.py` is the single declaration of: modules, levels, flags, resource → (model, module, key column, owner columns, policy, share adapter, PAT eligibility).
  - Old maps are deleted.
  - `GET /api/v1/permissions/schema` exposes the registry to the frontend; `frontend/scripts/check-permission-schema.mjs` diffs it against `ModuleKey`.
- Each route declares its policy via a dependency `authz_route(kind=..., resource=..., action=...)`.
- **CI checks:**
  - **route coverage:** ≥ pinned route count; all modules mounted; zero routes = fail;
  - **forbidden imports/reads:** `user.permissions`, `ResourceShare`, `DatasetGrant` and `System(` outside `app/core/authz/**` and allow-listed adapters;
  - **registry ↔ models ↔ frontend** diff;
  - property tests;
  - Postgres RLS job.

## Data

| Migration | Change | Existing rows |
|---|---|---|
| M1 | `users.security_stamp` (uuid, default random), `users.must_change_password` (bool, default false) | backfilled random → one forced re-login |
| M2 | `alert_channels.scope` (enum global/dataset) + CHECK (scope='global') = (dataset_id IS NULL) | backfill from dataset_id |
| M3 | ResourceShare(DATASET) → `dataset_grants`: VIEW→`explore` (view+explore), EDIT→`edit` (view+explore+build+edit); ON CONFLICT keep the higher verb; never publish/grant/manage; source rows copied to `resource_shares_archive`; impact report of VIEW holders who lose build (user/team, dataset, downstream charts/dashboards/workboards they built) | narrowed by design (Q1) |
| M4 | `workboard_workspaces` share support (ResourceShare type WORKSPACE, no column change if owner_id exists) | owners unchanged; non-owner users who could manage via module edit lose it → reported |
| M5 | `workboard_app_users.session_epoch` int default 0; `oauth_state_nonces(jti, exp)` | — |
| M6 | `agent_flow_delegations(brain_key, grantee user/team, resource_type, resource_id, action, created_by, revoked_at)`; no backfill; report of shared flows whose answers depended on owner-only resources | narrowed by design (Q2) |
| M7 | drop `module_permissions` after copying rows to `authz_legacy_archive(json)` | archived |
| M8 | `audit_log` gains `principal_kind`, `via`, `on_behalf_of` columns (nullable) | — |

All migrations are additive except M7 (drop after archive) and the ResourceShare move in M3 (rows archived). Downgrades restore from the archive tables.

## API

| Method | Path | Change |
|---|---|---|
| POST | `/datasources/test` | stored secrets only with unchanged endpoint + `use_secret`; egress policy |
| POST | `/datasources/query` | requires explore (edit) |
| GET/POST/DELETE | `/datasets/{id}/grants` | canonical policy; 400 on bad target; anti-escalation |
| * | dataset explore/build endpoints | `explore` / `build` verbs |
| GET | `/dashboards/{id}/public-links` | token masked unless manage_public_surface |
| POST/PATCH/DELETE | public links, embed mint, `/agent-flows/bindings` | manage_public_surface |
| POST | `/observability/scan` | body `dataset_ids?`; global = admin_global |
| * | `/observability/alert-channels*` | scope model; egress |
| GET | `/govern/metric-usage`, caveats, managed metrics, asset-docs, change-log | scoped |
| PUT/DELETE | caveats | dataset edit |
| * | `/workboard-workspaces*` | object model; token masked |
| GET | `/workboards/{id}/export` | edit; credentials = manage |
| POST | `/workboards/{id}/media`, miniapp-share | edit / dataset manage |
| DELETE | `/personal-access-tokens/admin/{id}/reveal` | removed (404) |
| GET | `/permissions/schema` | new, authenticated, registry for FE |

Error responses: 401 / 403 / 404 / 400 per §2. Security-relevant 4xx bodies are generic.

## UI

- **Settings → permissions matrix:** the level label `full` shows "Admin (module-wide)", read from the schema endpoint.
- **Dataset access panel:** the verb list and team targets work; errors from the anti-escalation rule are displayed.
- **Public links panel:** viewers see masked tokens and no create button.
- **Workboard:**
  - the export dialog hides "include credentials" unless the user holds manage;
  - the new-workboard flow shows the one-time PIN.
- **Workspace admin:** only manageable workspaces are listed; the token is shown only to managers.
- **Alert channels:** a global/dataset selector; global is only shown to admins.
- **Agent Flow settings:** a "Answers with owner's data" toggle (owner only) with disclosure text.

Public/embed pages keep using `publicClient` only (no change).

## Permissions

See §4–§11. Users losing access because of a narrowing are listed by the migration report:
- edit-sharees no longer publish;
- workspace module-edit users no longer manage others' workspaces;
- dataset VIEW sharees keep explore/build by migration.

## Edge cases

- Owner with module `none` → nothing, including on their own workspace.
- A team member removed mid-session → the next request is denied.
- A PAT minted before a demotion → capped by the live permissions.
- A Dataset grant to a deleted team → FK cascade.
- A revoke by a reshare holder of a `manage` grant → 403.
- A global channel created before the migration → `scope=global`, owner = creator. If the creator is no longer an admin, the channel still works and only admins can edit it.
- An internal workspace whose staff users relied on view-only write → write now denied (reported).
- On-prem warehouse on a private IP → must be allow-listed via `EGRESS_ALLOW_PRIVATE_CIDRS` in prod; startup logs the effective policy.
- BigQuery connector: the endpoint is Google's API host, so a project/credentials change is the "endpoint change" signal.

## Non-goals

- Per-column dataset security.
- Multi-tenant org isolation (single tenant today).
- Replacing the RLS model of Workboard app users.
- An ABAC policy language.
