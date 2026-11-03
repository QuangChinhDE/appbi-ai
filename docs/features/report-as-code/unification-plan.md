# Report-as-Code ↔ Dashboards unification — intent, spec, plan

Status: **PROPOSED — waiting for approval** (medium/large: protected subsystem
`public_link_security`, new table, cross-layer). Guardrail verdict for the plan: `unknown`
(no rule covers it) — treated as "more care", not "safe".

## 1. Intent

- `/dashboards` is the ONE place to manage reports: Manual Dashboards and AI Vibe Reports
  in the same list, with a type filter **Tất cả | Build Manual | AI Vibe Report** (default
  Tất cả). No second management list.
- An AI Vibe Report is shared through the SAME Public Modal as a dashboard: many named
  links, preview, link/embed, appearance, password, expiry, filter scope, on/off, access
  stats — same component, same security semantics.

Non-goals: changing the dashboard public lifecycle or any `api/public.py` behaviour;
an AI bot / snapshot / Limit-mode for reports (dashboard-only features stay dashboard-only
and are hidden for reports); rewriting the report runtime.

## 2. What exists (inspected)

| Area | Today |
|---|---|
| List | `app/(main)/dashboards/page.tsx` (642 l.) — `useDashboards()` → `PageListLayout` with stats, search, client pagination, grid/list. Reports are listed only at `/dashboards/code/new`. |
| Dashboard links | `DashboardPublicLink` (`dashboard_public_links`): name, token, filters_config, appearance_config, is_active, expires_at, password_hash, auth_version, access_count, last_accessed_at, created_by, source, stage. Auth in `api/public.py` (`_create_public_session` / `_verify_public_session`, per-link rate limit, auth_version invalidation). |
| Share UI | `PublicLinksManager.tsx` (1,946 l.) — calls `dashboardApi.*PublicLink*` directly, builds filter rows from the dashboard's charts, plus snapshot info and the AI-bot editor. `PublicLinkAppearanceEditor.tsx` is generic. |
| Report sharing | ONE token per artifact (`report_artifacts.public_token`, `public_enabled`), no password/expiry/filters/appearance; `/d/r/{token}`, `/embed/r/{token}`; `api/public_reports.py`. |

## 3. Spec

### 3.1 Unified list (frontend only — no new list endpoint)
- The page loads both lists it already has access to: `useDashboards()` and
  `reportCodeApi.list()` (each already permission-filtered by its backend). Rows are
  merged into one `ReportRow = { kind: 'dashboard' | 'vibe', … }` and fed to the
  existing `PageListLayout` — search, sort, pagination and grid/list work over the merged
  set unchanged.
- Type filter (segmented control in the toolbar), state kept in the URL `?type=`.
- Badge per row: `LayoutDashboard` "Build Manual" / `Wand2` "AI Vibe Report" (design-system
  tokens, same chip style as existing status chips). Draft/Published chip uses the same
  component for both kinds (report: `published_number`, `has_unpublished_changes`).
- Stats count the filtered set (total, published, per kind).
- Row actions: dashboard → unchanged; vibe → open Studio, Public links, delete (only if the
  user has full permission, as returned by the API). Click opens `/dashboards/{id}` or
  `/dashboards/code/{id}`.
- `/dashboards/code/new` keeps the create card; its own list becomes a link back to
  `/dashboards?type=vibe` (not a second manager).

### 3.2 Report public links (backend)
- New table `report_artifact_public_links` mirroring the dashboard link's security columns:
  `id, artifact_id FK CASCADE, name, token UNIQUE, filters_config JSON (locked values keyed by
  the report's declared filter keys), appearance_config JSON, is_active, expires_at,
  password_hash, auth_version, access_count, last_accessed_at, created_by, created_at,
  updated_at`. Additive migration, single head.
- Data migration: every artifact with `public_enabled AND public_token` gets one link row
  carrying THE SAME token → every URL already shared keeps working. Old columns stay
  (read-only, retired) — no destructive change.
- Endpoints (under `/report-artifacts/{id}/public-links`, gate `full` like publish):
  list / create / update / delete / preview — same request/response shape as the dashboard
  ones (so the shared component's contract is identical).
- Public side (`api/public_reports.py`): token resolves through the link table; enforces
  is_active, expiry, password (session bound to link + auth_version, per-link attempt rate
  limit — reusing the dashboard helpers by extracting them, not copying them), and applies
  the link's locked filters SERVER-SIDE in `B.clean_state` (a viewer can neither clear nor
  override a locked filter; hidden filters are not sent to the viewer). Only the PUBLISHED
  revision is ever served.
- Appearance: the public page reads `appearance_config` (header / title / logo / theme
  options the editor offers that make sense for a full-page report).

### 3.3 Shared Public Modal (frontend)
- `PublicLinksManager` gains a `target` adapter prop:
  `{ kind, list, create, update, remove, preview, filterFields, publicUrl, embedUrl, features }`.
  The dashboard adapter wraps today's `dashboardApi` calls verbatim (default when only
  `dashboardId` is passed → existing callers do not change). The report adapter wraps the
  new endpoints; `filterFields` = the report's declared filters + their values endpoint.
- `features` hides dashboard-only sections for reports (snapshot info, AI bot, page scope).
- The Studio's current Share modal is replaced by this modal; the list's row action opens
  the same modal.

## 4. Tests / gates (decided before coding)

| Layer | Test |
|---|---|
| Backend contract (new, wired in `.gitignore` + workflow) | link CRUD needs `full`; expired / inactive / wrong password → refused; session dies when password changes (auth_version); locked filter cannot be overridden or cleared by the viewer; hidden filter not in the public payload; only published revision served; migrated legacy token still resolves; rate limit on password attempts |
| Existing gates | `public_link_security` gates, `galaxy_golden`, `pair4_surfaces`, `public_authoritative_bounds_pg` — run with `APPBI_VERIFY_WITH_DB=1` on an isolated test PG (never the shared app DB) |
| Frontend | `tsc`, `npm run qa`, `qa:report-code` protocol check (public pages use `publicClient` only) |
| Migration | migration-checker: single head, additive, safe on a DB with data |
| Browser (localhost, rebuilt images) | list shows both kinds; filter + search + pagination + stats; click opens the right builder; modal on a dashboard = unchanged (regression); modal on a report: create link with password + expiry + locked filter → open logged-out → password prompt → locked filter enforced; disable → 404; embed; old shared token still works |

## 5. Plan (order)

1. Backend: model + migration (+ legacy token carry-over) → extract the password-session
   helpers into a shared service used by both → link endpoints → public enforcement.
2. Contract tests (fail first on the enforcement cases) → green.
3. Frontend: adapter in `PublicLinksManager` (dashboard path byte-for-byte behaviour) →
   report adapter → replace Studio Share modal → public pages read link appearance/password.
4. Unified list in `/dashboards`.
5. Isolated-DB `verify.py task`, image rebuild, browser verification, report.

Risks: (a) touching `api/public.py` to extract helpers — kept to a move + import, no
behaviour change, covered by the existing public-link gates; (b) `PublicLinksManager` is
large — the adapter only replaces its 6 API call sites and gates 3 sections; (c) list
merge is client-side, so very large tenants page over two lists (same as today's
client-side pagination).

Git: nothing is committed/pushed/merged/deployed.
