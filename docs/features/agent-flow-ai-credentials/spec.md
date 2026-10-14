# Agent Flow AI credentials — spec

What the system does once this is built. Decisions D1–D3 and open question Q4 are in
`intent.md`.

## Behaviour

### A. Managing keys (the AI Keys modal)

1. The author opens **AI Keys** from the Agent Flow catalogue header (next to "New flow")
   or from the builder header (next to Test / Save / Publish).
2. The modal lists every key the author may use: their own and those shared with them.
   Each row: name · provider logo/label · `••••` + last 4 · "Mặc định" badge · owner (when not
   me) · last tested (ok / failed + when) · "Đang dùng ở N bước" · actions.
3. **Add key:** name (required, unique per owner), provider (OpenAI / Anthropic / Gemini),
   secret (password field with show/hide while typing). Save encrypts and stores it; the
   secret is not returned. The first key of a provider becomes that provider's default
   automatically.
4. **Test:** calls the provider with a one-token request on the key and records
   `last_test_ok` / `last_test_at` / a short error (e.g. "401 — key không hợp lệ",
   "429 — hết quota"). Never echoes the key.
5. **Edit:** rename; replace the secret (blank = keep, as for datasources); set / unset default.
6. **Share:** the standard share dialog (users / teams). A shared key may be *used* by the
   recipient in their own steps; only the owner (or `full`) may edit, share or delete it.
7. **Delete:** if the key is used by any step, the confirm dialog lists the flows and steps
   that will lose their key. Deletion is soft (`deleted_at`); those steps show "Key đã bị
   xoá" and fail at run time until reassigned.

### B. Choosing the AI for a step (Agent and Coordinate)

1. The step's "Model" section shows two selects: **Nhà cung cấp** (OpenAI / Anthropic /
   Gemini) → **Model** (that provider's list from the catalogue). That is the whole choice.
2. Under them, one line shows which key the step will use:
   `Key: OpenAI chính ••••a1b2` with a "Đổi" link when the author has more than one key for
   that provider. Changing the provider re-fills the key with the author's default for the
   new provider.
3. If the author has no key for the chosen provider, the line reads
   "Bạn chưa có key OpenAI — Thêm key" and the link opens the AI Keys modal with the
   provider preselected; on save the new key is filled in.
4. New steps are created with provider = OpenAI, model = the catalogue's first
   (`gpt-4o-mini`), key = the author's OpenAI default (or none).
5. A step whose key is missing, deleted or not usable by the current viewer of the
   builder shows a warning badge on its card on the canvas and in the validity panel.
6. When a key on a step belongs to someone else and was not shared with the current
   author, the line reads "Key của <owner> (không chia sẻ cho bạn)". The author may keep
   it (saving other edits leaves it untouched) or replace it with their own. They cannot
   select it for another step.

### C. Running

1. Every step that calls a model (Agent; Coordinate's planner) resolves
   `(provider, model, secret)` from its own `credential_id` through one resolver.
2. The flow-level intent pre-pass uses the answering step's credential; if the answering
   step is not an Agent, the first Agent step's.
3. A Skill (child flow) step's nodes resolve their own credentials the same way; nothing is
   passed down from the parent run.
4. A step whose key cannot be resolved raises
   `Bước “<name>” chưa có AI key` / `… key “<key name>” đã bị xoá`. The executor records
   the error and honours the step's `retry` / `on_error` as for any failure.
5. **No fallback exists**: not the link's `ai_bot_key`, not the viewer's `X-User-Ai-Key`,
   not `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`.
6. Test / preview endpoints refuse to start (409) when any step on the path lacks a usable
   key, listing the steps, instead of running and failing midway.
7. `last_used_at` of the credential is updated at most once per run (not per call).

### D. Publish, bind, share, export

- **Publish** and **bind to a link** are blocked while any step lacks a usable key
  (error code `missing_credential`, one entry per step). Draft save is allowed.
- **Sharing a flow** does not share its keys. Share disclosure lists providers/models used,
  never key names or ids.
- A run by a public viewer / chat reader bills the key the author assigned — the same
  delegation that sharing a flow already implies for data access.
- **Export** removes `credential_id` from every node. **Import** (and "duplicate") produces
  steps without keys; if the importing author has defaults, the builder offers
  "Gán key mặc định cho N bước" as a single click. (A convenience in the UI: it sets explicit
  ids, it is not a run-time fallback.)

### E. Existing flows (legacy bodies)

Read through `upgrade_body`:

| Stored node | Becomes |
|---|---|
| `provider: "inherit"`, `model: ""` | `provider: "openai"`, `model: "gpt-4o-mini"`, `credential_id: null` |
| `provider: "openai"`, `model: X` | unchanged provider/model, `credential_id: null` |
| any `api_key` / `api_key_enc` / `api_key_clear` / `has_api_key` | dropped (0 non-empty in the DB today) |

So every existing flow opens with "Chưa có key" on each step and runs only after keys are
assigned (D2).

## Data

### New table `ai_provider_credentials`

| Column | Type | Notes |
|---|---|---|
| `id` | `Integer` PK | referenced from node bodies |
| `name` | `String(120)` not null | unique per `(owner_id, name)` among non-deleted |
| `provider` | `String(20)` not null | `openai` \| `anthropic` \| `gemini` (check constraint) |
| `secret_enc` | `Text` not null | `encrypt_value(secret)`; must start with `_enc:` |
| `key_hint` | `String(8)` not null | last 4 chars only |
| `is_default` | `Boolean` not null default false | at most one true per `(owner_id, provider)` among non-deleted — partial unique index |
| `owner_id` | UUID FK `users.id` `ondelete=SET NULL` | like `DataSource.owner_id` |
| `created_at`, `updated_at` | timestamptz | |
| `last_used_at` | timestamptz null | |
| `last_test_at` | timestamptz null | |
| `last_test_ok` | Boolean null | |
| `last_test_error` | `String(200)` null | sanitized: no key, no URL query string |
| `deleted_at` | timestamptz null | soft delete |

Indexes: `(owner_id)`, partial unique `(owner_id, provider) WHERE is_default AND deleted_at IS NULL`,
partial unique `(owner_id, name) WHERE deleted_at IS NULL`.

### Enum

`resourcetype` gains `ai_credential` (`ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS`).
`core/permissions.py` maps `ResourceType.AI_CREDENTIAL → "agent_flows"`.

### Node contract (JSONB in `agent_brain_versions.body`, no migration)

`AgentNode` and `CoordinateNode`:

- **removed:** `api_key`, `api_key_enc`, `api_key_clear`; `provider` value `inherit`.
- **changed:** `provider: Literal["openai","anthropic","gemini"] = "openai"`,
  `model: str` required, validated against `MODELS[provider]`.
- **added:** `credential_id: int | None = None`, and `credential_granted_by: str` — who assigned the key,
  set by the server on save (a client value is discarded) and re-checked on every run.

`Flow.steps_missing_credentials()` → nodes (Agent + Coordinate, whole tree) whose
`credential_id` is `None`. Whether an id is *usable* needs the DB and is answered by the
service (below), not by the contract.

### Catalogue (`models_catalogue.MODELS`)

| Provider | Models (to be re-verified with a live test during implementation) |
|---|---|
| openai | `gpt-4o-mini`, `gpt-4o`, `gpt-4.1`, `gpt-5` (`gpt-4.1` added: the reader pilot's certified model; all four verified against the live `/v1/models`) |
| anthropic | `claude-haiku-4-5` only — see plan.md *Implementation notes* (Sonnet/Opus 5.5 need thinking-block replay the adapter does not do) |
| gemini | `gemini-2.5-flash`, `gemini-2.5-pro` |

`INHERIT`, `_deployment_has_key`, `has_key` and the `"Theo cấu hình của link"` entry are removed.
`effective_model()` collapses to "the node's provider and model".

## API

All under `/api/v1/agent-flows`, mounted in the `METADATA_CATALOG_ENABLED` block, before the
`/agent-flows/{id}` routes.

| Method | Path | Gate | Request | Response / errors |
|---|---|---|---|---|
| GET | `/credentials` | `agent_flows:view` | `?provider=` | `[{id,name,provider,key_hint,is_default,owner:{id,email,name},mine,permission,last_test_ok,last_test_at,usage_count}]` — own + shared; `full` sees all |
| POST | `/credentials` | `agent_flows:edit` | `{name,provider,secret,is_default?}` | 201 same shape · 400 empty/duplicate name, unknown provider · 409 encryption not configured |
| PATCH | `/credentials/{id}` | edit access on the resource | `{name?,secret?,is_default?}` (blank secret = keep) | 200 · 403 · 404 (also for deleted) |
| DELETE | `/credentials/{id}` | full access on the resource | — | 200 `{affected:[{brain_key,flow_name,step_key,step_name}]}` · 403 · 404 |
| GET | `/credentials/{id}/usage` | view access | — | `{affected:[…]}` (for the delete confirm) |
| POST | `/credentials/{id}/test` | view access (= may use) | — | `{ok, error?, latency_ms}` · 403 · 404 |
| — | share | existing share endpoints with `resource_type=ai_credential` | | |
| GET | `/models` | `agent_flows:view` | — | `{providers:[{provider,label,models:[{model,label,tier_hint}]}]}` (no `inherit`, no `has_key`) |

`PUT /brains` (save): validates every `credential_id` that is **new or changed** versus the
previous version of the same node key — must exist, not deleted, same provider as the node,
and usable by the saver — else 422/403 naming the step. Unchanged ids are carried as-is, with
their original grantor. `_carry_credentials` / `_redact_credentials` are removed (there is no
secret in the body any more). **No output-only `credential` field is added to bodies**: the
builder matches `credential_id` against the author's `/credentials` list instead, which needs
no body decoration and keeps `_AUTHORING_PASSTHROUGH` empty.

Publish / bind / test / chat: refused (409; bind: a `missing_credential` preflight error) with a
sentence per step naming the step and the reason (`none` | `deleted` | `provider_mismatch` |
`not_shared` | `undecryptable`). Node preview calls no model and needs no key. A public link
bound to a flow never asks the viewer for a key; a keyless flow answers the viewer with
"Trợ lý của báo cáo này chưa được cấu hình AI key…".

## UI

| Surface | Change | States |
|---|---|---|
| `AiKeysModal` (new, `AppModalShell`) | list + add/edit form + test + share + delete confirm | loading skeleton · empty ("Chưa có AI key nào — thêm key đầu tiên") · error toast · test running spinner · test ok/fail inline |
| `BrainList` header | "AI Keys" button beside "New flow" | — |
| `BrainBuilder` header | "AI Keys" icon button in the pinned action group | — |
| `inspector/editors/agent.tsx` | replace provider/model block with `<ModelPicker>` (Provider → Model + key line) | no key · several keys · key not shared with me · deleted key |
| `inspector/editors/coordinate.tsx` | add the same `<ModelPicker>` | same |
| Canvas node card + validity panel | "Chưa có key" / "Key đã bị xoá" badge | — |
| Test chat / publish / bind errors | render `missing_credential` list with a "Mở AI Keys" action | — |
| Import / duplicate | one-click "Gán key mặc định cho N bước" | shown only when defaults exist |

i18n: every new string in `frontend/src/i18n/catalog/agent-flows.ts` (vi + en).
Public / embed surfaces: no UI change; the viewer's key panel simply never appears for a
flow-bound link (server decides via `flow_supplies_credentials`).

## Permissions

- Module `agent_flows`: `view` lists keys and the catalogue; `edit` creates keys and saves
  flows; publishing is `edit` as today.
- Per key: owner = full. Shared `view` = may **use** it in steps and test it. `edit` =
  rename / replace secret / set default. `full` = delete / share.
- Users with module `agent_flows: none` get 403 on every credential endpoint (router gate).
- Run time does **not** re-check the viewer's access to the key — assigning a key to a
  step is the author delegating it, exactly like the data the flow reads. Deleting the key
  or unsharing it from the author stops that delegation.

Unsharing: a key unshared from user B stays on B's steps but is shown as "not usable by me"
and is refused at run time ("key không còn được chia sẻ cho tác giả"). The resolver checks
that the **flow version's author** (`owner_email` → user) still has use access, so an owner
can revoke delegated billing.

## Edge cases

- Owner account deleted → `owner_id` NULL. Steps whose GRANTOR no longer exists fail closed
  (`not_shared`); a module `full` user can still manage the key. (Changed from "keeps working":
  the run-time check is on the grantor, and an unknown grantor is not a usable one.)
- Two defaults for one provider → prevented by the partial unique index; setting a new
  default clears the old one in the same transaction.
- A key of the wrong provider set via API/MCP → 400 at save.
- Key replaced (rotated) while a run is streaming → that run keeps the secret it already
  resolved; the next run uses the new one.
- `DATASOURCE_ENCRYPTION_KEY` rotated → `decrypt_value` fails → resolver reports
  "key không giải mã được — nhập lại key" (never a traceback, never a fallback).
- Vendor error messages that echo the key or a `?key=` URL (Gemini) are sanitized before
  being stored in `last_test_error` or run records (see memory: httpx logs leak `?key=`).
- Flows produced by the authoring prompt / MCP with no `credential_id` → valid draft,
  blocked at publish.
- A node in a Loop / Branch / Coordinate specialist / fallback lane → covered by the one
  shape-driven traversal (`map_raw_children` / `all_nodes`), locked by
  `test_nested_specialist_credentials`.
- Coordinate planner inherits the coordinator's `credential_id`, provider and model
  (`executor.py:1036-1051`).

## Non-goals

- A run-time "default key" fallback. Defaults only pre-fill the picker.
- Letting a public viewer supply a key for a flow-bound link.
- Choosing a key per link or per viewer.
- Migrating the other AI features off `.env`.
