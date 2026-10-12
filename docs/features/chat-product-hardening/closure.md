# AI Chat product hardening — closure (T1–T6) and Agent Flow handoff

Scope of this round: Chat-owned lifecycle, persistence, authorization and transport.
**Not** in scope (owned by Agent Flow Product Acceptance): live-model quality, BI
answer correctness, runtime/tools/coordinator, Builder, Public Report. No billable
model call was made in this round.

## Decisions

| ID | Contract |
|---|---|
| T1 Retention | A live thread keeps the conversation (question, answer, citations, reader notices, reader projection of the envelope with its blocks) for as long as the thread exists. Past the run-content window (`AGENT_FLOW_CONTENT_RETENTION_DAYS`, 180 d) the author copy — input envelope, trace, usage, memory delta, author notices — is dropped. Per-node trace keeps its own 30-day window. Deleting a thread clears its runtime memory (`ai_chat_sessions`) immediately and releases its content to the normal window. No new retention period was introduced. |
| T2 Rating | One verdict per answer (`agent_flow_runs.rating`), held by the **conversation owner**. `edit` sharees continue the conversation but cannot overwrite it; `view`, oversight and outsiders cannot rate. Authors read it in Runs (chat runs are listed by brain). Limitation: a run does not record which participant asked a turn, so "the asker" cannot be the holder without a schema change. |
| T3 Concurrency | One active turn per conversation, enforced at the API by a Postgres session advisory lock `(0x43484154, thread_id)` on its own NullPool connection, taken before the stream and released after the turn is recorded. A second turn gets **423** before anything runs or is recorded; the client says so inline. Cancel before the request leaves records nothing; cancel after records `failed` + `turn_abandoned`. |
| T4 Management | `owner`: everything. `edit`: read + continue. `view`: read. `chat: full`: read + **manage** (rename/delete — AppBI-wide meaning of `full`) but never speak or rate. `can_manage` on thread rows drives the UI. |
| T5 Transport | SSE terminal/timeout/disconnect fixed in round 1 (still covered). Quota sentence corrected: the window is the last 24 hours, not a calendar day. |
| T6 Docker | See below. |

## T6 — Docker DNS incident (2026-10-12, 12:13–12:53 UTC)

- Cause: `docker-compose.yml` pins `networks.appbi-net.name: appbi-net`, so a second
  compose project joins the shared network and its service aliases (`appbi-db`, `db`,
  `backend`, `frontend`) resolve round-robin across stacks.
- Observed: the rig backend's connections to `appbi-db` sometimes reached
  `appbi-ai-db-1` and failed authentication; `appbi-afspec-backend` datasource queries
  reached the rig DB (172.20.0.7) and failed authentication — 51 errors, 12:33:41–12:35:57
  UTC. No requests from shared containers appeared in the rig backend log.
- Why no successful cross-read/write is believed to have happened: the rig DB used a
  non-default password, the shared DBs the default; every observed cross-connection was
  an authentication failure. The afspec log lines have since rotated, so this rests on
  the evidence captured at the time — it is not proven beyond it.
- Now: every rig run uses an override renaming the network (`chathard-net`); membership
  and DNS resolution are checked before tests run (only the three rig containers).
- Residual risk for everyone else: unchanged until the compose file stops pinning the
  name. **Handoff to the infrastructure owner** (not changed here — shared infra).

## Agent Flow handoff

| ID | Surface | Finding | Owner | Blocks Chat merge? | Blocks product release? |
|---|---|---|---|---|---|
| AF-1 | `direct_chat.py`, `test_flow_type.py` | **Duplicate fix in flight.** The Agent Flow worktree (`feat/agent-flow-product-acceptance`, uncommitted as of 2026-10-13) adds `direct_chat.chat_reachable_brains` for the same defect PR #16 fixes with `permissions.chat_usable_brains` (a reader with only `chat` sees no assistants). Same semantics (owner-or-shared, gated on `chat`, `agent_flows: full` sees all). Two functions for one contract would drift. Proposed: keep one — whichever lands first; the other side rebases onto it. The PG test `test_a_chat_only_reader_sees_and_uses_what_was_shared_with_them` pins the contract either way. | both, coordinate | no | no (once one copy) |
| AF-2 | runtime notices | Engine notices are composed in Vietnamese regardless of `request.locale`; Chat words eight integrity codes client-side on the EN UI, the rest stay Vietnamese. | Agent Flow runtime | no | i18n quality |
| AF-3 | `AnswerBlocks.tsx` (shared) | Changed in PR #16: with no `onOpenChart`/`onAskFollowup` the blocks render static instead of as disabled buttons; optional `labels` prop. Dashboard bot / Studio unchanged when they pass handlers. Re-run answer-parity after integration. | shared | no | no |
| AF-4 | runs record | `agent_flow_runs` does not record which participant asked a turn; needed for per-asker rating or per-asker quota (today the quota counts runs in threads the user owns). | Agent Flow / data | no | no (V1 limitation) |
| INF-1 | `docker-compose.yml` | Fixed network name (T6). | infrastructure | no | no |

## Cross-branch evidence

- Valid only on PR #16 code: all Chat Playwright journeys, the Chat PG suite.
- Reusable after integration: none automatically — re-run the Chat PG suite, the Chat
  Playwright project, answer-parity and the agent-flow golden suites on the integrated
  commit.
