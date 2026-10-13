# MCP integration — Core findings handoff (F1–F4)

Status 2026-10-13, branch `feat/mcp-integration-layer` reconciled with `origin/demo` `799c84de`.
For each finding: evidence, owner, the smallest fix, and what the MCP does meanwhile.
None of these needs Core redesign.

| # | Finding | Owner | Status in this branch | Blocks |
|---|---|---|---|---|
| F1 | Postgres table-detail route 500s for every stored source | Source Core | MCP works around it; **Core fix still needed** | — (UI bug) |
| F2 | PAT survives the owner's password change | Security / authz | Documented and asserted as current behaviour; **Core fix needed** | public release |
| F3 | AppBI ignores `X-Request-ID` | Backend platform / Observability | MCP-side audit is enough for the pilot; small Core change proposed | — |
| F4 | Semantic view / dictionary saves are last-write-wins | Semantic layer (Dataset model) | **Contract added** (separate commit), MCP fails closed; FE adoption handed off | — |

## F1 — `GET /datasources/{id}/tables/{schema}/{table}` fails for stored Postgres sources

- **Evidence:**
  - Reproduced on the rig twice: on `d4cf98da`, and on `799c84de` (rebuilt image).
  - Any user with view access gets `500 Failed to retrieve table details`.
  - The backend log shows `password authentication failed`.
- **Cause:** `DataSourceConnectionService.get_table_detail` passes the stored, still
  encrypted `config` to `_pg_table_detail` → `_pg_connect`. `get_schema_browser`
  calls `decrypt_config(config)` first (`backend/app/services/datasource_service.py`).
  The non-PG branch goes through `execute_query`, which decrypts.
- **Impact:** the data-source table detail panel in the UI
  (`frontend/src/lib/api/datasources.ts`, `/datasources/${id}/tables/${schema}/${table}`).
- **Existing fix:** none. Checked every remote branch for a decrypt in
  `get_table_detail`; `feat/source-core-hardening` is merged and still has the bug.
- **Smallest fix (Source Core):**
  - `config = decrypt_config(config)` as the first line of `get_table_detail`
    (`from app.core.crypto import decrypt_config`).
  - A regression test: a stored, encrypted PG config reaches `_pg_connect` with the
    plaintext password. Monkeypatch `_pg_connect` to capture its kwargs.
- **MCP:**
  - Columns come from `GET /datasets/datasources/{id}/tables/columns`.
  - The preview from the broken route is best-effort and reported as
    `preview_unavailable` with AppBI's status.
  - No MCP change is needed when Core fixes it: previews simply start appearing.

## F2 — PAT lifecycle vs. account security events

Verified on the rig (`tests/live/test_security_lifecycle.py`). Behaviour of the
current AppBI contract:

| Event | AppBI session (JWT) | PAT (and therefore the Claude connection) |
|---|---|---|
| Owner revokes the token in Settings | — | 401 at once → MCP `credential_revoked`, grant revoked, refresh `invalid_grant` |
| Admin revokes (`/auth/personal-access-tokens/admin/{id}`) | — | same |
| Admin deactivates the user | ended (security stamp) | 401 (`user.status` checked) → same |
| Revocation **during** `execute_plan` | — | the step's 401 ends the run as `credential_revoked`; nothing further executes (fixed in this branch, was reported as `blocked`) |
| **Owner changes their password** | ended (security stamp) | **still valid**: the PAT path does not compare `security_stamp` (`core/dependencies.py` `_authenticate_personal_access_token`) |
| Admin password reset | — | not a feature in AppBI (no endpoint) |

- **Required policy:**
  - A Claude connection is created by the user's interactive consent. It is a
    delegated session, so it must end whenever AppBI ends the user's sessions.
  - Today that holds for revocation and deactivation, but **not for a password
    change**.
- **Smallest Core fix (Security / authz):**
  1. Add a nullable `personal_access_tokens.bound_security_stamp` column (additive
     migration).
  2. Let the PAT create API accept `bind_to_session: true` and store the creator's
     current `security_stamp`. Only a session can create a PAT, so the stamp is
     the session's.
  3. In `_authenticate_personal_access_token`, reject (401) when
     `bound_security_stamp` is set and differs from `user.security_stamp`.

  Existing PATs are unaffected (NULL). The connect page then sends
  `bind_to_session: true`, a one-line front-end change. The live test
  `test_password_change_does_not_end_the_connection_yet` flips deliberately.
- **Pilot mitigations:**
  - Connections expire (default 30 days, at most 90).
  - Users and admins can revoke "Claude MCP · …" tokens.
  - Deactivation is enforced.

## F3 — request-id correlation

- **Today:**
  - The MCP generates `request_id`, returns it as `X-Request-ID`, and sends it to
    AppBI.
  - It writes one audit row per tool call: user, client, grant, tool, argument
    hash, outcome, AppBI status, resource ids and duration.
  - AppBI's own audit log records the same user and resource ids with timestamps.
- **Pilot sufficiency:** an incident is reconstructable by joining on user +
  resource id + time window. Every MCP-created resource id is in the MCP audit.
  This is adequate for an internal pilot; there is no Observability refactor.
- **Smallest Core change (optional, before public release):** a backend middleware
  that does three things:
  - accepts `X-Request-ID` only if it matches `^[A-Za-z0-9_-]{8,64}$`;
  - puts it on `request.state`;
  - adds it to `audit()`'s `details` and the access-log line.

  That is about 20 lines plus a test. Owner: backend platform / Observability.

## F4 — concurrent semantic-view and dictionary writes

- **Reproduced:**
  - Offline: `tests/test_dataset_executor.py::test_concurrent_view_edit_is_not_overwritten`.
  - Backend: `backend/tests/test_semantic_view_version.py`.
  - Without a version, the second whole-list `PUT .../model/views/{vid}` silently
    removes the first writer's measures.
- **Change in this branch (separate, declared Core commit):** the view gets the same
  optimistic-concurrency contract explores already have for joins:
  - `GET /datasets/{id}/model` returns `view_version` per view: a content hash of
    dimensions, measures and description.
  - `PUT /datasets/{id}/model/views/{vid}` accepts an optional
    `expected_view_version`. When it is stale the result is `409
    {code: view_stale, view_version}` and nothing is written.
  - The check and the write run under a row lock.
  - Without the field, behaviour is unchanged, so every existing caller works as
    before.
  - A mutation test proves the regression test fails without the check.
- **MCP:**
  - Every view save quotes the version it read; the client refuses to send one
    without it.
  - On `view_stale` it re-reads and merges onto the newer state once, then reports
    `conflict`. It never overwrites.
  - Against an AppBI without `view_version` it refuses to write measures
    (`blocked`): it fails closed.
  - The dictionary is sent **with dataset creation**, and `PUT /dictionary` is on
    the MCP's forbidden list.
- **Residual (FE adoption, semantic owner):**
  - The Visual Model editor (`frontend/src/hooks/use-dataset-model.ts`
    `useUpdateModelView`) still saves without a version. A stale editor tab can
    therefore replace measures added meanwhile, by the MCP or by a colleague.
  - The cascade guard already refuses a save that drops measures used by charts,
    which covers every measure behind an MCP-built dashboard.
  - Smallest fix: send `expected_view_version: view.view_version` from the cached
    model, and on `409 view_stale` show "this table changed; reload to continue",
    like the existing `shared_draft_stale` handling for dashboards.
  - The same contract could be applied to `PUT /datasets/{id}/dictionary`, which no
    MCP path uses.
