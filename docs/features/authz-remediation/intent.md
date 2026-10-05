# Authorization remediation — intent

**Status:** draft — awaiting approval before implementation
**Owner:** da_internal@base.vn
**Date:** 2026-10-05
**Base:** `origin/demo` @ `11473148f0bd8c19e1b4788eb1773982c5ac71f0` (re-fetched 2026-10-05; no drift since the review SHA, so every review finding still applies)
**Branch:** `security/authz-remediation` (worktree `D:/Appv2/wt-authz-remediation`)
**Input:** independent authorization review of the same SHA (`AUTHZ_REVIEW_demo_11473148.md`)

## Problem

Low-privilege but legitimate AppBI users can today:

- read and write every row of any Workboard published in an internal-mode Workspace with only `workboards:view` (staff path skips the object check and RLS), and read every workspace's portal token;
- make the backend send a Data Source's stored password / service-account key to a host they choose, holding only a **view** share (`POST /datasources/test`);
- redirect any global alert channel to their own webhook and receive every incident in the tenant; reach internal network addresses through "test channel";
- grant themselves `manage` on a Dataset from a `reshare` grant, or wipe every user grant with a parameterless revoke;
- see public-link capability tokens as a dashboard viewer; bind their own AI assistant to someone else's public link with view access;
- export a Workboard's app-user PIN hashes with view access;
- regain rights their PAT excludes through three code paths that read raw `user.permissions`;
- authenticate for 15 minutes with a captured Google OAuth `state` value.

And a fresh deployment that follows the repository's own default path creates `admin@appbi.io / 123456` with full rights.

Underneath: ~10 independent authorization engines. Dataset alone has two that give opposite answers for the same user. New modules (Workspaces, alert channels, Govern caveats) repeatedly shipped with module gates and no object check, because nothing makes the object check unavoidable.

## Goal

1. Every confirmed P1/P2 finding is closed and locked by an HTTP-level regression test.
2. One authorization contract — *principal + action + resource + context → decision* — is the only way business code asks "may this caller do this", for single objects, lists and cross-resource operations. Adding a resource or route without declaring its policy fails CI.

## Out of scope

- Redesigning the public/embed token model. It reviewed as sound; only the specific leaks (viewer sees token, publish level, assistant binding) are fixed.
- RBAC custom roles, ABAC attributes, external IdP / SSO.
- Rewriting semantic-layer SQL generation. The semantic layer is a protected subsystem and is touched only where authorization calls into it.
- Production deployment or a merge into `demo` (merging needs a separate go-ahead after the DoD evidence).
- Frontend redesign. The frontend changes only where the backend contract changes (permission schema, masked tokens, new levels).

## Constraints

- **Protected subsystems involved:**
  - public-link security (`api/public.py`);
  - semantic layer (`routers/semantic.py` object access only);
  - engineering infrastructure (`scripts/ci/**`, `.github/workflows/**`, `guardrail_rules.yaml`, `.gitignore` test allow-list).
  - Every change to these is declared in the change description and must never weaken an existing gate.
- **Migrations:** additive, single head, parent committed; historical migrations untouched; must be correct on Postgres (prod metadata DB).
- **Existing data:**
  - existing `users.permissions` rows, `resource_shares`, `dataset_grants`, public links, embed grants, workspaces and app users must keep their legitimate meaning;
  - any narrowing of existing access is reported, never silent.
- **Behaviours to preserve (they reviewed as correct):**
  - module ceiling;
  - explicit `none`;
  - PAT HMAC + live cap;
  - public/embed binding and expiry;
  - credential non-serialization;
  - last-admin guard;
  - Govern 404-unmapped;
  - scoped Observability reads.
- **Two run modes:** prod-style (`run.sh`, baked image) vs dev override. Runtime verification is done on a stack built from this branch, not on an image built from older code.
- **Test environment drift is a blocker:** local FastAPI 0.141.1 vs pinned 0.109.0 makes the route-walk test vacuous. All security gates run against the pinned versions (container or a pinned venv).

## Acceptance criteria

1. With `ENVIRONMENT=production`, the backend refuses to start (and the entrypoint refuses to seed) if `ADMIN_PASSWORD` is unset, empty, a placeholder, or on the weak-password blocklist. In development the seed still works, but the account must change its password at first login.
2. A user with `workboards:view` and a workspace token, but no relation to Workboard W, gets 403/404 on every `/public/workspaces/{token}/…/W/…` row read/write. A user with object `edit` on W can write. App users keep their RLS-scoped access unchanged.
3. Workspace list/get return only workspaces the caller has a relation to. `token` is only present for callers with `manage` on that workspace. Update/rotate/delete/preview-session require `manage` on the workspace, and adding a Workboard to a workspace menu requires `edit` on that Workboard.
4. `POST /datasources/test` with a stored `data_source_id` never sends stored secrets to an endpoint that differs from the stored one (host/port/project/account). Changing the endpoint requires supplying new secrets. Using stored secrets at all requires `use_secret` (= edit) on the data source. Outbound connector targets pass the shared egress policy.
5. Global alert channels (an explicit `scope = global`, not `dataset_id IS NULL`) can only be created, updated, tested, deleted or revealed by an Observability admin. Dataset channels need `edit` on the dataset, and owner-or-admin to change another user's channel. Webhook targets pass the egress policy (no private, loopback, link-local or metadata addresses; no redirects), and test errors do not echo internal details.
6. `POST /observability/scan` with no dataset scope is a system-admin action. A non-admin can scan only datasets they can `trigger_compute` on, and that is rate limited. Scheduler scans keep running as an explicit system principal.
7. **Dataset has a single decision function** used by list, detail, explore, build, publish, grant, revoke and every cross-module caller. A property test asserts list-scope ≡ per-object `read` for generated states. ResourceShare(DATASET) rows are migrated into DatasetGrant and no longer consulted.
8. Grant rules:
   - A grant can never exceed the grantor's own delegable verbs; self-grant upgrades are refused.
   - Revoke needs exactly one valid target (400 otherwise) and deletes at most one row.
   - Team grants resolve through `TeamMembership` and are equivalent to the same direct grant.
9. No business module reads `user.permissions`, `ResourceShare` or `DatasetGrant` directly; a CI check enforces this. A PAT's decision is a subset of its owner's live decision for every action (property test).
10. `GET /dashboards/{id}/public-links` returns tokens only to callers with `manage_public_surface` on the dashboard; viewers get masked entries. Creating, updating or deleting a public link, and binding an assistant to a link, require `manage_public_surface` (owner or dashboard admin).
11. Workboard export without credentials needs `edit`. Credential export (PIN hashes) needs `manage` on the Workboard plus an explicit `include_credentials` request, and is audit-logged. OCR ciphertext is never exported. New Workboards get no default PIN `123456`: a random one-time PIN is shown once to the creator.
12. Every JWT decoder checks the expected `type` and audience. A token without `type` is rejected everywhere. The OAuth `state` cannot authenticate any route. A refresh token cannot authenticate any route except `/auth/refresh`. A password change or deactivation invalidates outstanding access and refresh tokens.
13. Admins cannot reveal another user's PAT (rotate/revoke only). Owner reveal stays (session only, audited). A PAT row with empty scopes is denied.
14. Govern:
    - `metric-usage` returns only charts and dashboards the caller can read;
    - caveat create/update/delete require `edit` on the target dataset;
    - global Govern objects (managed metrics, glossary) require the Govern admin action.
15. Agent Flow run authority is explicit:
    - by default a run uses `owner ∩ caller`;
    - a flow may be marked "answers with owner's data" only by its owner, with `share_disclosure` shown and the delegation audit-logged;
    - binding to a public link needs `manage_public_surface` on the dashboard.
16. Every authenticated route is registered with a policy declaration (resource action, list scope, cross-resource, capability, system-only, global). The route-walk test fails if it discovers fewer routes than the pinned minimum, or any route without a declaration. It runs with Workboards and every flagged module enabled.
17. Postgres integration tests run in CI against a non-superuser app role, prove RLS denies for the app role, and cover grant constraints and revocation visibility.
18. `module_permissions` is dropped by a forward migration (data archived to a JSON column on the migration's audit row if any rows exist). Duplicate resource→module maps are generated from one registry. The frontend `ModuleKey` list is checked against the backend registry in CI.

## Decisions (FINAL for this phase — approved 2026-10-05)

| # | Decision |
|---|---|
| Q1 | Dataset `view`, `explore`, `build` are three separate capabilities (+ `edit`, `publish`, `grant`/`revoke`, `manage`). Legacy ResourceShare VIEW → `view+explore`; EDIT → `view+explore+build+edit`. No legacy row gains publish/grant/manage. Users who relied on VIEW→build get an impact report (user/team, dataset, before, after, affected downstream assets); no silent preservation. |
| Q2 | Agent Flow run authority = caller ∩ resources explicitly attached to the flow. Owner authority only via an explicit delegation record: resource-scoped, action-scoped, revocable, audited, fail-closed. Never inferred from owner/share/publish. Existing flows: inventory + report only, **no auto-delegation**. |
| Q3 | `publish` is its own action: owner or module admin, grantable explicitly later. Shared edit does not publish. Applies to dashboard public links, embed, Workboard publication, every public surface. Impact report for users losing legacy publish. |
| Q4 | PAT plaintext only at owner create and owner rotate. Admin: inspect metadata, disable, revoke, force-invalidate — never receives plaintext. Owner reveal-after-the-fact is also removed (stored ciphertext dropped). PAT ⊆ owner live authority. |
| Q5 | Workspace is a first-class resource (owner, shares, manage actions, token lifecycle). Workspace membership/token/read never grants Workboard data; staff need explicit Workboard authority. The `_internal ⇒ allow` semantics are removed. RLS = row filtering only. |
| Q6 | Production: no known/default/placeholder password, no silent bootstrap; invalid bootstrap credential ⇒ startup fails. Dev: random one-time credential, must-change-password, never active in production mode. Password policy applies to bootstrap. |
| Q7 | Token domains separated: strict type, issuer, audience, version; domain-separated keys (HKDF subkeys of the root). Typeless tokens rejected everywhere. One forced re-login documented. PAT HMAC key unchanged in this cutover. |
| Q8 | `full` no longer has a generic meaning. Legacy stored `full` → `module_admin` entitlement, translated only in the authz core. Internally: resource owner / resource manager / module admin / system admin are distinct. No business code compares a level to `"full"`. |

Release gates added by the approval: Playwright multi-principal E2E security suite on the real stack (real FE+BE+Postgres) is required, in addition to policy/unit, HTTP and Postgres/RLS tests. Manual scripts are never acceptance evidence.
