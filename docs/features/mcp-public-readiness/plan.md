# MCP public readiness — implementation plan

## Guardrail scoping

`guardrail_check.py --plan "MCP public readiness" --files <W1-W5 paths>` on demo `56c349ca`:

- **Verdict:** `warn`.
- **Feature:** it matches `mcp_integration`.
- **Out of scope for that feature:** `core/dependencies.py`, `api/personal_access_tokens.py`,
  `components/datasets/ModelViewEditPanel.tsx`, `services/dashboard_html_import_service.py`.
  So every Core change ships in its **own PR**, owned by its area, and never inside an MCP PR.
- **Protected subsystems touched:** none reported. F4 is next to the semantic layer, so its
  PR still gets the semantic-guard review.
- **Required tests:** `mcp_integration_offline`, `mcp_integration_live`, `import_smoke`
  (for the backend auth path), plus the per-PR tests below.

## PRs, in merge order

| PR | Branch | Owner area | Files | Depends on |
|---|---|---|---|---|
| 1 | `security/pat-session-binding` | Security / authz | migration `20261014_0001`, `models/personal_access_token.py`, `schemas/personal_access_token*.py`, `api/personal_access_tokens.py`, `core/dependencies.py`, `connect/mcp/[txn]/page.tsx` (sends the flag), new `tests/test_pat_session_binding.py` (+ `.gitignore` allowlist + `backend-contract-tests.yml`) | — |
| 2 | `semantic/model-editor-view-version` | Semantic / Dataset model | `hooks/use-dataset-model.ts`, `components/datasets/ModelViewEditPanel.tsx`, an e2e for concurrent editors and `view_stale`; any dictionary or other whole-list guard found by the audit | — |
| 3 | `fix/chart-dryrun-style-keys` | Chart | `api/charts.py` `_FE_STYLE_CONFIG_KEYS` (+ the keys the renderer honours) and a unit test | — |
| 4 | `feat/dashboard-import-draft-build` | Dashboard | `dashboard_html_import_service.py` + `api/dashboards.py` (`draft_only`, `idempotency_key`, strict unresolved fields), backend tests for the routes and the v1 mismatch path | — |
| 5 | `fix/dashboard-pptx-export-budget` | Dashboard | `lib/export-pptx.ts` total wait cap with a loud failure; the spec aligned to the cap | — |
| 6 | `feat/mcp-ux-closure` | MCP | `tools/dataset.py` (P5), `tools/dashboard.py` (P6/P7), `oauth/bearer.py` + `tools/runtime.py` (P8), `appbi_client.py` (`/widgets` guard), offline and live tests, `spec.md` D11-D13 | 3 (for warning-free dry-runs) |
| 7 | `feat/mcp-html-import` | MCP | `tools/html_import.py`, allowlist entries + guards for the import routes, offline tests, live test with 4 HTML fixtures | 4 |
| 8 | `deploy/local-edge-overlay` | Infra (protected engineering) | `docker-compose.edge.yml`, `deploy/nginx.local-edge.conf`, `run.sh --with-mcp`, runbook | — |

PRs 1-5 and 8 are independent, so they can proceed in parallel. 6 waits on 3, and 7 waits on 4.

## Risks

- **F2 (PR 1).** A bug in the stamp comparison could lock out every PAT, including embeds
  and integrations.
  - *Mitigation:* the column defaults to `false`, and only the MCP connect page sets the
    flag. A test proves an unbound PAT survives a password change, and one proves a user
    with a NULL stamp can still bind.
- **F4 (PR 2).** Reseeding from a background refetch while the editor is dirty would
  silently defeat the guard.
  - *Mitigation:* an e2e with two browser contexts — the second save must be refused and
    the first edit must survive.
- **P6 (PR 6).** Publishing slicer tiles without `shared_ack_rev` would leave the controls
  pointing at unpublished filters.
  - *Mitigation:* a live test checks in view mode that changing the slicer changes the KPI
    to the SQL-checked number.
- **P8 (PR 6).** Passing calls through must not let a read-only grant reach a write.
  - *Mitigation:* the tool layer's scope check is unchanged and runs before any AppBI call.
    An offline test sends every author and publish tool with a read grant and asserts no
    backend request.
- **HTML (PRs 4 and 7).** Untrusted HTML or embedded instructions; oversize input; a build
  that appends to or overwrites a user's dashboard.
  - *Mitigation:*
    - MCP guards force `new_dashboard`, `draft_only` and an idempotency key;
    - the size cap is applied in MCP and in Core;
    - no URL fetching and no JavaScript;
    - an adversarial fixture (script, iframe, `javascript:` URL, external CSS/JS, "ignore
      previous instructions" text) must produce warnings and no executable or fetched
      content.
- **Deployment (PR 8).** Someone running the base compose file without the overlay takes
  port 3000 back from the edge.
  - *Mitigation:* `run.sh --with-mcp` is the documented path, the runbook describes it, and
    the edge has a healthcheck.

## Tests — decided now

- **PR 1:** `test_pat_session_binding.py` covers:
  - a bound PAT is valid, then 401 after a password change;
  - 401 after an admin status toggle;
  - 401 after deactivation;
  - an unbound PAT survives a password change;
  - a user with a NULL stamp can bind;
  - rotate re-binds;
  - the schema default is false.

  The live MCP test flips the documented-gap test for F2 to assert `credential_revoked`
  after a password change. This is a deliberate, declared change.
- **PR 2:** an e2e `dataset-model-concurrent-edit.spec.ts` — two contexts, a stale save
  refused with a visible message, both edits preserved after reload; plus the audit's
  dictionary test.
- **PR 3:** a unit test that each renderer-honoured key does not produce the warning.
- **PR 4:**
  - HTTP tests for analyze, validate, dry-run and build;
  - `draft_only` tiles are invisible to other users until publish;
  - the same idempotency key yields the same dashboard;
  - a v1 fingerprint mismatch gives 409;
  - unresolved fields are refused when strict.
- **PR 5:** the existing PPTX spec passes within the cap. A unit test forces a never-ready
  tile and expects a loud failure, not a hang.
- **PR 6:**
  - offline: P5 qualified filter accepted when joined and refused when unjoined, plus a
    pass-through of an `UNREACHABLE_VIEW` refusal;
  - offline: P6 slicer step idempotent on re-run, with the publish body carrying the tiles
    and `shared_ack_rev`;
  - offline: P7 style defaults;
  - offline: P8 read grant gets a tool-level `insufficient_scope` with zero backend calls,
    and a missing or invalid token is still a 401;
  - live: changing a slicer in view mode changes the KPI to the SQL value.
- **PR 7:** offline guard tests (`build_without_draft_only` refused, append refused, file
  parts refused, oversize refused), plus a live test with 4 fixtures:
  - a simple report;
  - a multi-section business report;
  - a skill-generated v1 plan;
  - an adversarial file.
- **Acceptance (after merges, on `appbi-ai`):** the real Claude Desktop journeys, run with
  natural-language prompts:
  - a Dataset with a cross-table measure;
  - a Dashboard with working slicers on desktop, tablet and phone;
  - each of the 3 HTML cases;
  - the read-only message;
  - revocation and password change.

  Every KPI is checked against direct SQL. A full E2E runs on the exact demo candidate.

## Not in this plan (needs separate authorization)

- Remote HTTPS connector (W7): a domain, TLS and ingress decision by the PO and ops.
- Any `master` merge or public exposure.
