> **SUPERSEDED (2026-10-27)** by [the unified AI Chat contract](../unified-ai-chat/contract.md). AppBI has one AI Chat; the data core answers, and an Agent Flow is an optional extension. This document is kept as historical design evidence, not as current authority.

# AI Analyst as an official module — spec

## Behaviour

- **Session:** an owned conversation. Creating one is implicit: the first question asked
  without a session creates one, titled from the question.
- **Turn:** one question and the server's response, stored as returned, with rows capped
  at `ANALYST_MAX_ROWS`. Clarify-choice tokens are stripped before storing.
- **Follow-up:** the previous plan is read from the session's last answered turn **on the
  server**. A client `previous_plan` is ignored inside a session. `service.ask` then
  re-validates the plan against the caller's current catalog, as before.

### Who may do what

| Action | Who |
|---|---|
| Read a session | owner, a `view`/`edit` share (user or team), or `analyst: full` |
| Ask in a session | owner or `edit` share. Runs as the **caller**: their grants, quota and ledger rows |
| Rename, delete | owner, or `analyst: full` (delete) |
| Share, revoke | `/shares`: owner holding `analyst ≥ edit`, or `analyst: full` |
| Save a chart | the caller, through the chart API's own rule (`can_save`) |

Every route also requires the module gate: `analyst: view` and `explore_charts: view`.

### Redaction (the security contract)

Every turn stores the Dataset ids it read (`dataset_ids`) and the field refs it used
(`refs`). On **every** read, for every viewer (the owner included), a turn is returned in
full only when:

1. each id in `dataset_ids` is in the viewer's *current* Analyst catalog (EXPLORE relation,
   reporting purpose, source type), **and**
2. each ref in `refs` is visible to the viewer in that explore (GovernAIScope).

Otherwise the response is `{question, status, redacted: true}`, with no answer, rows,
columns, evidence, plan, options or chart draft. A share therefore never reveals a number
the viewer could not read, and a revoked grant hides the owner's own stored answers too.

Turns that read no Dataset (an unsupported answer before planning) keep only their
message.

### Staleness

Each stored answer carries `asked_at` and the `semantic_epoch` from its evidence. The UI
shows "Kết quả lúc …", and a stored answer is never re-run silently.

## Data

Migration `20261026_0001`, additive:

- **`analyst_sessions`**
  - Columns: `id` PK, `user_id` UUID FK users ON DELETE CASCADE, `title` varchar(255),
    `created_at`, `last_active_at`, `deleted_at` (soft delete, the only lifecycle state,
    as in chat threads).
  - Index on (user_id, last_active_at).
- **`analyst_session_turns`**
  - Columns: `id` PK, `session_id` FK ON DELETE CASCADE, `seq` int, `turn_id` varchar(32)
    unique (= the GQS run id), `asked_by` UUID, `question` varchar(1000), `status`
    varchar(16), `dataset_ids` JSONB, `refs` JSONB, `response` JSONB, `created_at`.
  - Unique on (session_id, seq).
- **`resourcetype`** gets the value `analyst_session` via `ADD VALUE IF NOT EXISTS`.
  Postgres cannot drop it on downgrade, so the downgrade leaves it in place.

Nothing is backfilled: Analyst had no stored exchanges.

`response` never holds credentials, SQL text or choice tokens. It holds only what
`/analyst/ask` already returned to the same person.

## API

All routes are under `/api/v1/analyst` behind the router gate.

| Method | Path | Gate | Notes |
|---|---|---|---|
| GET | `/sessions` | module | Own sessions plus shared ones (all of them for `full`), each with `access` |
| POST | `/sessions` | module | `{title?}` → session |
| GET | `/sessions/{id}` | read access | Session plus turns, redacted per viewer. 404 when no access (no enumeration) |
| PATCH | `/sessions/{id}` | owner | `{title}` |
| DELETE | `/sessions/{id}` | owner / full | Soft delete |
| POST | `/sessions/{id}/ask` | owner / edit share | Same body as `/ask` minus `previous_plan`. Stores the turn and returns the redacted view |
| POST | `/ask` | module | Unchanged (backward compatible, not stored) |

Sharing uses the existing `/shares/analyst_session/{id}` routes.

## Module levels

| Level | Meaning |
|---|---|
| `none` | No Analyst |
| `view` | Ask questions about the Datasets you may EXPLORE. Own sessions, read shared ones |
| `edit` | Additionally share your own sessions |
| `full` | Module administration and oversight: read and delete any session. Data is still redacted per the viewer's own grants, so this is **never** a data grant |

Presets are unchanged except that admin moves `view` → `full`; editor, viewer and minimal
stay `none`. `ANALYST_PILOT_ALLOWLIST`: empty means no extra restriction (module
permission decides); non-empty restricts to the listed e-mails. `ANALYST_ENABLED=false`
still unmounts every route (operator kill switch).

## UI

- **Sidebar:** a new "AI" group holds "Trợ lý AI" (`/chat`) and "Phân tích dữ liệu"
  (`/analyst`), each gated by its own module.
- **Analyst page:**
  - Session list beside the conversation, plus a session header with rename, share
    (`ShareDialog resourceType="analyst_session"`) and delete.
  - Built on tokens, `Button`, `Badge`, `EmptyState` and `Select`.
  - A short description of the difference from AI Chat, with a link to it.
- **States:** loading, empty (no sessions), 404/no-access, redacted turn ("Bạn chưa có
  quyền với nguồn dữ liệu của câu trả lời này"), and error/cancel.
