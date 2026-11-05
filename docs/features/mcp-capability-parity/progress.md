# MCP Capability Parity — progress (resume file)

Branch `feat/mcp-capability-parity` (worktree `D:/Appv2/wt-mcp-parity`, base `demo` b423ab2b).
Owner authorization 2026-11-05: implement M1→M5→Final continuously; commit/push this branch;
NO merge to demo/master, NO production deploy, NO recreate/reconfigure of the running appbi-ai Core.

## DoD (every mutating capability)
Plan → real Preview (AppBI renderer) → human Approval (browser, CSRF, same user) → Execute
(idempotent, conflict/version checked) → Verify (read back) → separate approval for publish/share/delete.
Runs as the connected user's own PAT; audit row per call. E2E evidence = real MCP client + browser + real AppBI.

## Matrix status (UI capability -> Core API -> MCP tool -> permission -> preview/approval -> test)
| # | Area | MCP tools | Preview before accept | Approval | Offline tests | Live E2E |
|---|---|---|---|---|---|---|
| M1 | AI Vibe / Report-as-Code | list/get/compare_vibe_*, plan_vibe_report/source_edit/ai_edit/restore, request_publish(vibe_report) | Core PROPOSAL (no revision) rendered by Studio `?proposal=`; revision links `?revision=` | plan + separate publish; AI = run approval + apply approval | test_vibe (19) | test_vibe_journey (rig) |
| M2 | Manual Builder, existing dashboard | plan_dashboard_edit (layout/title/page, remove/restore, widget, edit_chart fork, swap, responsive, remove_filter), plan_dashboard(dashboard_id, filters) | chart dry-run numbers; Builder renders the author's draft; publish approval links it | edit plan + separate publish | test_dashboard_edit (5) | test_parity_journeys |
| M3 | Data Model, existing dataset | plan_model_edit (add_table, add_join, upsert/remove measure, update_dimension, add_calculated_column) | measure dry-run + value, key evidence, calculated-field preview on real rows | plan; dataset publish separate | test_model_edit (5) | test_parity_journeys |
| M4 | Sources | start/check_source_handoff, test_data_source (+ existing reads) | n/a (credentials stay in AppBI UI) | human completes in AppBI | — | test_parity_journeys |
| M5 | Sharing, shared charts | list_shares, plan_share/plan_unshare, plan_chart_edit | grantee + scope; affected reports + dry-run numbers | each its own approval | test_governance (4) | test_parity_journeys (share) |
| M5 | Not exposed (decision) | users/teams/permissions admin, PATs, public links, deletes, workboards/agent-flows/chat writes | — | — | allowlist contract | — |

## Evidence log
- 2026-11-05 M1: offline 212/212; live (backend 127.0.0.1:8000, dataset 222, reports 68-70): blank create,
  source edit, stale_plan keeps co-author edit, AppBI 409 base_number, compare, restore, approved publish
  (published_number=4), one real AI edit (1 call, rev5, published untouched). Bug found+fixed: regions are objects.

## Commits
cffdad1a M1 tools · ba82abda proposals (Core+Studio) · 7187a218 M2 · 3e66b0e9 M3 · 7885bb87 M4 · 3eb15537 M5

## Verification status
- tsc: PASS (2026-11-05, worktree, npm ci + tsc --noEmit)
- MCP offline: 243 PASS · backend test_report_code_contract: 72 PASS
- Live rig (isolated compose project appbi-mcprig, :18180): IN PROGRESS

## Next action
Bring up rig at HEAD, bootstrap users, run tests/live (vibe + parity + existing acceptance), fix failures.
