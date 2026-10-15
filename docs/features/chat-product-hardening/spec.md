# AI Chat product hardening — spec

## Behaviour

| # | Behaviour | Was |
|---|---|---|
| H1 | Only `owner` and an `edit` sharee may add a turn or rate. `view` and `chat: full` (oversight) read only — refused with 403 before the stream and again at the engine entry. | `full` could append while the UI said read-only |
| H2 | A stream's updates apply only to its own thread. Leaving the thread (open another, new, back, unmount) stops the turn; the server records it `failed` + `turn_abandoned`. Double submit cannot create two threads. | thread A's answer written into thread B |
| H3 | The transcript returns the reader-safe typed `blocks` of each recorded answer (same `to_reader_dict` boundary as the live stream). Blocks-only answers are kept and feed follow-up history. | blocks lost; a metric-only answer vanished on reload |
| H4 | Run-content prune skips runs whose chat thread still exists; deleting the thread releases them to the normal window. | live conversations lost their words after 180 days |
| H5 | Reader rating: `POST /chat/threads/{id}/runs/{run_id}/rating`, scoped by the conversation. Restored with the transcript; author sees it in Runs. | no reader rating in Chat |
| H6 | Conversation list is a drawer below `lg`; row actions visible on touch. | `display:none` on phones |
| H7 | Follow-ups fill the composer; `chart_ref`/follow-ups with no handler render as static content. | dead disabled buttons |
| H8 | `lang` is sent per turn; server refusals, stream errors and quota are worded in it; client words read-only reasons, HTTP refusals and key integrity notices by code. | locale hardcoded `vi` |
| H9 | Conversation search; distinct "Untitled conversation" label; owner-only rename/delete; stale links say so and drop the id. | — |
| H10 | `available` / `unavailable_reason` on assistants and the thread's `readonly_reason` report pilot/reader-mode/missing-key up front. | refusal only after typing |
| N1 | A reader granted only `chat` sees and uses flows shared with them (`chat_usable_brains`). | empty catalogue unless `agent_flows` ≠ none |
| N2 | SSE pump cancels, waits, then closes; a timeout ends with `error` + `done`. | `RuntimeError`, no `done` |
| N3 | Non-document sources (chart/metric/dataset/term/web) are listed under an answer. | dropped — figures had no visible source |
| N4 | A failed send keeps its bubble, says why inline in product words (never raw server detail), no toast over Send. | bubble lost / toast covered Send |

## Data

No schema change. `agent_flow_run_content.output_envelope` (already written) is now
read back for blocks. `agent_flow_runs.rating` is written by the reader route.

## API

Additive only: `Ask.lang`, `GET /threads/{id}?lang=`, `is_owner` on thread rows,
`available`/`unavailable_reason` on brains, `blocks` on assistant messages, new
rating route (classified `resource` in `route_contract.json`).

## UI

`ChatModule` (turn ownership), `ConversationView` (drawer, search, status labels,
copy, rating, sources, follow-ups), `AnswerBlocks` (no-handler rendering, labels).

## Permissions

Read: owner, any share, `chat: full`. Write (turn, rating): owner, `edit` share.
Rename/delete/share: owner (`chat: full` may rename/delete as before). Running the
flow still requires the flow's own share, re-checked every turn.

## Edge cases

Stop before the request leaves (nothing recorded, question stays in the box);
quota exhausted (inline, localised, figures kept); revoked share (next load 404,
link dropped); assistant unpublished (read-only banner); IME Enter.

## Non-goals

Background continuation of left turns; regenerate/edit; export; server-side
localisation of all engine notices.
