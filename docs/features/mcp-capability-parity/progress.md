# MCP Capability Parity — progress (resume file)

Branch `feat/mcp-capability-parity` (worktree `D:/Appv2/wt-mcp-parity`, base `demo` b423ab2b).
Owner authorization 2026-11-05: implement M1→M5→Final continuously; commit/push this branch;
NO merge to demo/master, NO production deploy, NO recreate/reconfigure of the running appbi-ai Core.

## DoD (every mutating capability)
Plan → real Preview (AppBI renderer) → human Approval (browser, CSRF, same user) → Execute
(idempotent, conflict/version checked) → Verify (read back) → separate approval for publish/share/delete.
Runs as the connected user's own PAT; audit row per call. E2E evidence = real MCP client + browser + real AppBI.

## Matrix status
| # | Area | Status |
|---|---|---|
| M1 | AI Vibe / Report-as-Code | tools + offline tests + live in-process journey PASS; OPEN: tsc, browser ?revision preview, real OAuth/MCP client, browser approval, real permission levels, AI proposal preview BEFORE write |
| M2 | Manual Dashboard Builder (edit existing) | not started |
| M3 | Dataset / Data Model edit parity | not started |
| M4 | Source + Human Handoff | not started |
| M5 | Remaining modules audit | not started |
| F | Final E2E (MCP client + browser + BigQuery) | not started |

## Evidence log
- 2026-11-05 M1: offline 212/212; live (backend 127.0.0.1:8000, dataset 222, reports 68-70): blank create,
  source edit, stale_plan keeps co-author edit, AppBI 409 base_number, compare, restore, approved publish
  (published_number=4), one real AI edit (1 call, rev5, published untouched). Bug found+fixed: regions are objects.

## Next action
M1 closure (see OPEN above).
