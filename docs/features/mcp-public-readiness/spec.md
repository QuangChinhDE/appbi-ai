# MCP public readiness — spec

The evidence for each item is the read-only scoping done on demo `56c349ca` (2026-10-14).
File and line references are to that commit.

## W1. Security — F2: session-bound PATs (Security / authz owned)

Today `_authenticate_personal_access_token` (`backend/app/core/dependencies.py:108-153`)
checks revoked, expiry, scopes and `user.status`, but not `users.security_stamp`. The
stamp is rotated on:
- password change (`api/auth.py:477`);
- an admin status change (`api/users.py:254-260`);
- deactivation (`api/users.py:287`).

Contract (additive, backward-compatible):

- **Migration `20261014_0001`:** `personal_access_tokens.bound_to_session BOOLEAN NOT NULL DEFAULT false`
  and `bound_security_stamp VARCHAR(64) NULL`.
- **Creation:** `PersonalAccessTokenCreate.bind_to_session: bool = False`. When it is true,
  the create route stores `current_user.security_stamp or ""`, and rotate re-binds.
- **Authentication:** a bound PAT whose stored stamp differs from the user's current stamp
  gets 401. The `last_used_at` write moves after all checks.
- **Responses:** `bound_to_session` is exposed in the user and admin responses.
- **Connect page:** `/connect/mcp/[txn]` sends `bind_to_session: true`.
- **Scope of effect:** legacy PATs are unaffected, and no existing token is revoked.

**MCP side.** A 401 from AppBI already maps to `credential_revoked` and revokes the grant.
No MCP change is needed beyond a live test.

## W2. Semantic — F4: versioned editor saves (Semantic / Dataset model owned)

The backend contract already exists: `view_version` comes back on GET model, and PUT
accepts `expected_view_version` and returns 409 `view_stale`. The frontend never sends it.

- **Hook types:** in `use-dataset-model.ts`, `DatasetModelView.view_version` and
  `useUpdateModelView` gain `expected_view_version`.
- **Editor (`ModelViewEditPanel.tsx`):**
  - hold the version the editor was seeded from;
  - send it on save;
  - do not reseed it from a background refetch while the editor is dirty;
  - on 409 `view_stale`, show a reload/resolve message that keeps the user's draft, and
    never auto-force;
  - after a successful save, adopt the returned `view_version`.
- **Audited, and fixed only if needed:**
  - dictionary PUT (whole-list, no version);
  - measure DELETE followed by a stale PUT that resurrects the measure;
  - generate-model with `force`;
  - draft restore.

  Each one is either guarded or documented with a test.

## W3. MCP — P5 to P8 (MCP owned, `integrations/appbi-mcp/**`)

- **P5, cross-table filtered measures.** The engine already supports a measure filter on a
  related view: a qualified field such as `orders.order_status`, rendered as a correlated
  `EXISTS` with no fan-out. It refuses `UNREACHABLE_VIEW` and `AMBIGUOUS_ROUTE`. Only the
  MCP plan validator (`tools/dataset.py:211`) blocks it.

  Change:
  - accept `table.column` filter fields when the plan joins the two tables;
  - emit the field qualified with the semantic view name;
  - the existing dry-run stays the final check;
  - refusals are reported with their category.

  No raw SQL and no `where_sql`. The tool description stops Claude from suggesting source
  views.
- **P6, placed slicers.** A filter is visible to viewers only when a slicer control tile
  references it (`widget_config.slicerId`); see `slicer_control_service.py` and
  `slicer-placement.ts`.

  Change in `tools/dashboard.py`:
  - every filter entry gets `interactionType`: `dropdown`; `date_range` with
    `datePreset: "custom"`; or `slider`;
  - a new write step, `place_slicers`, does `POST /dashboards/{id}/widgets`
    `{widget_type: "slicer", widget_config: {slicerId, treatment: "auto", origin: "author"},
    layout: {x, y, w: 8, h: 3, gv: 2, pageId, draftOnly: true}}`, in a top band, with a
    reconcile on `slicerId`;
  - publish carries the new tiles in `tile_base_v`, plus `shared_ack_rev`.

  The allowlist adds `POST /dashboards/{id}/widgets`, with a guard of
  `widget_type == "slicer"` and `draftOnly` true.
- **P7, chart presentation.** ChartSpec gains a bounded `style` that is mapped into
  `config.styleConfig`. The renderer honours these keys:
  - `dualYAxis`, `yAxisRightSeriesKey`;
  - `chartSortRules`, `dataLimit`, `dataLimitDirection`;
  - `timeGranularity`;
  - `numberFormat`, `currencySymbol`, `decimalPlaces`, `chartTitle`.

  Planner defaults:
  - a time series with two measures whose scales differ by 5× or more uses a dual axis;
  - a single-dimension bar chart is sorted descending by value;
  - number formats come from the measure format.

  The chart dry-run's `_FE_STYLE_CONFIG_KEYS` list misses these keys and gives a false
  "won't render" warning. Adding them is a one-line Core change, owned by Chart.
- **P8, read-only UX.** `oauth/bearer.py` answers a `tools/call` above the grant's scope
  with HTTP 403 `insufficient_scope`. That is a step-up challenge, and the pinned bridge
  waits on it until it times out.

  Change:
  - when the grant's **own** scopes can never include the needed scope (the user chose
    read-only, or the account cannot write), pass the call through to the tool layer;
  - the tool layer (`runtime.py:162`) already refuses, before any AppBI call, with
    `insufficient_scope`;
  - its message becomes: "This AppBI connection has read-only access. You can inspect and
    plan, but you cannot create or publish. Connect with an appropriately authorized
    account if you need editing."

  401 handling is unchanged. The decision is recorded as deviation D11.

## W4. HTML report → native dashboard

**Reuse.** The existing AppBI pipeline in `dashboard_html_import_service.py` and the
`/dashboards/import-html/*` routes. MCP adds no parser.

**Findings that shape the design:**
- Server-side parsing is regex only. No JavaScript runs and nothing is fetched, and
  fragments are sanitised.
- A declared `appbi-import/v1` plan (`<script type="application/appbi-dashboard">`)
  short-circuits the server LLM. It is checked against the dataset's real
  `schema_fingerprint` (409 on mismatch).
- Generic HTML (Case B) needs a **browser-built** block summary, so the server cannot use
  that path alone.
- `build` creates **live** tiles immediately, can **append to an existing** dashboard, and
  is **not idempotent**.

**Design:**

- **Input.** Claude Desktop puts an attached file's text into the conversation. The tool
  takes `html` as a string argument, capped at 2 MB (the existing
  `MAX_HTML_IMPORT_SIZE`). There are no file paths and no URLs. Text inside the HTML is
  data, never instructions.
- **Case A** (HTML already carries a v1 plan): forwarded as is.
- **Cases B and C** (generic or unsupported HTML): Claude reads
  `GET /datasets/{id}/import-skill` (dataset-specific, built from the real columns) and
  writes a v1 plan bound to real fields. It embeds the plan with the user's original
  markup. The server then validates the plan exactly as for Case A. Unsupported
  interactions are listed as `ignored_blocks` and warnings, and reported to the user, never
  claimed as converted.
- **MCP tools:**
  - `get_import_skill`;
  - `plan_dashboard_from_html`: analyze, then validate-plans, then dry-run-build, then a
    human-readable approval card with each chart, field mapping and warning;
  - `execute_plan` (existing): runs the build;
  - publish through the existing `request_publish` / `publish`.
- **Core change (Dashboard owned):** `build` gains `draft_only=true`. Tiles, widgets and
  slicer controls are created as the caller's draft (`draftOnly`, draft owner stamped).
  Build also gains `idempotency_key`; a repeat with the same key returns the first result.
  The MCP guard requires:
  - `draft_only=true`;
  - `target_mode=new_dashboard`;
  - no `target_dashboard_id` or `prepared_dataset_id`;
  - `source_mode=existing_dataset`;
  - no file parts;
  - no `html_summary_json`.
- **Unresolved fields:** a plan whose fields don't resolve becomes an error for MCP builds,
  instead of today's "may fail at runtime" warning.
- **Visual certification:**
  - the source HTML is rendered in a sandboxed browser with JavaScript disabled and no
    network;
  - the resulting dashboard is captured on desktop, tablet and phone;
  - the comparison covers sections, KPI count and placement, chart types, relative sizes,
    theme and the presence of filter controls;
  - differences are listed. No pixel score.

## W5. Deployment

The local entry point is an nginx edge on `127.0.0.1:3000`, with the same `location`s as
production `nginx.conf`, and the frontend without a host port. It becomes version
controlled:

- **`docker-compose.edge.yml`:** a Core overlay. It sets `ports: !reset []` for the
  frontend and adds an `edge` service on `appbi-net` + `mcp-ingress` with
  `restart: unless-stopped`.
- **`deploy/nginx.local-edge.conf`:** the edge's config.
- **`run.sh --with-mcp`:** applies the overlay, so a plain `docker compose up -d` with the
  overlay never takes port 3000 back.

## W6. Regression

- **Demo tip `56c349ca`:** E2E never ran on it. Path filters skipped it because the diff
  was MCP-only.
- **PPTX failure on `7b03c95c`:** timing. The export's worst-case internal wait (per page,
  15 s + 30 s + 15 s tile retries, under 1.5 s of emulated latency) can exceed the test's
  240 s download wait. The same tree passed on `2bed579c`.
- **Fix (Dashboard owned):** cap the export's total wait and fail loudly, then align the
  test to that cap. The assertion is not loosened.
- **Release verdict:** a full E2E is run on the exact release candidate.

## W7. Remote HTTPS connector

Requires an approved AppBI domain, TLS, and public ingress for `/mcp` and `/mcp-oauth`. It
also requires a new issuer, so new consent: local grants are never migrated. **This is
blocked on PO and ops**, and cannot be certified locally.
