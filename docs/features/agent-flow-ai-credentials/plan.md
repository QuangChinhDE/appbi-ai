# Agent Flow AI credentials — implementation plan

## Guardrail scoping

```bash
python scripts/ci/guardrail_check.py --plan "Replace Agent Flow per-node api_key with stored AI provider credentials" \
  --files backend/app/services/agent_flows/contract.py backend/app/services/agent_flows/registry.py \
          backend/app/modules/agent_flows/api.py backend/app/models/ai_provider_credential.py --json
python scripts/ci/guardrail_check.py --plan "flow-bound public bot never asks viewer for key" \
  --files backend/app/api/public.py backend/app/services/agent_flows/dispatch.py --json
```

- Verdict: **warn** (first run) · **ok** (second run), with `public_link_security` marked as touched.
- Features touched: `agent_flows` (Agent Flow Studio: authoring, runtime, node model).
- Out-of-scope finding: `backend/app/models/ai_provider_credential.py` belongs to no existing
  feature. Expected, because it is a new resource. Record it in the guardrail rules
  (`agent_flows.owner_files`) in the same change so the next scoping run knows about it.
  That rules edit is a declared, deliberate protection-file change.
- Protected subsystems: **public_link_security** (`api/public.py`, only if Q4 = yes).
- Required tests named: `agent_flow_container`, `agent_flow_contract`, `agent_flow_evidence`,
  `agent_flow_replay`, `agent_flow_surface`, `tier1_oracles_execute`. For the `public.py` part
  it also names `layered_merge`, `distinct_cascade_bq` and `galaxy_golden`; the last two need
  a warehouse and will be reported as NOT VERIFIED if they cannot run here.

## Files and layers, in order

The tree stays importable and green after each phase. Each phase is one commit.

### Phase 1: credential store (backend, additive, nothing uses it yet)

| # | File | Layer | Change |
|---|---|---|---|
| 1 | `backend/app/models/ai_provider_credential.py` (+ export in `models/__init__`) | model | `AiProviderCredential` table from spec §Data; no service imports |
| 2 | `backend/app/models/resource_share.py` | model | `ResourceType.AI_CREDENTIAL = "ai_credential"` |
| 3 | `backend/app/core/permissions.py` | core | map `AI_CREDENTIAL → agent_flows` |
| 4 | `backend/alembic/versions/20261001_0001_ai_provider_credentials.py` | migration | create table + indexes + `ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS 'ai_credential'`; `down_revision = "20260930_0001"`; checked by the `migration-checker` agent |
| 5 | `backend/app/services/agent_flows/credentials.py` (new) | service | CRUD, `usable_by(user)`, `resolve(db, credential_id, *, author_email) -> ResolvedCredential(provider, secret, name)`, `test_key()`, `usage(credential_id)` (walks bodies via `all_nodes`), error-text sanitizer; fails closed when `not is_encryption_configured()` |
| 6 | `backend/app/modules/agent_flows/credentials_api.py` (new router) + register in `api/__init__.py` inside the `METADATA_CATALOG_ENABLED` block, **before** the studio router's `/{id}` routes | api | endpoints from spec §API, each gated |

### Phase 2: providers and catalogue

| # | File | Layer | Change |
|---|---|---|---|
| 7 | `services/dashboard_ai_bot/providers/openai_provider.py` | service | optional `base_url` kwarg; default stays `https://api.openai.com/v1`, so current callers are unchanged |
| 8 | `services/agent_flows/runtime/handlers/agent.py` `_stream` | service | `gemini` → `stream_openai(base_url=GEMINI_OPENAI_COMPAT)`, which gives Gemini tool calling; `anthropic` → `stream_anthropic`. The single-shot Gemini adapter is left in place for its other callers. |
| 9 | `services/agent_flows/models_catalogue.py` | service | three vendors; delete `INHERIT`, `_deployment_has_key`, `has_key`; `effective_model` becomes the node's own provider and model |

### Phase 3: contract and runtime replacement (the actual "replace, not parallel")

| # | File | Layer | Change |
|---|---|---|---|
| 10 | `services/agent_flows/contract.py` | service | `AgentNode` / `CoordinateNode`: drop `api_key*` and `resolved_api_key`, add `credential_id`, provider without `inherit`, model required; `upgrade_body` maps legacy nodes (spec §E); `steps_missing_credentials` covers Agent **and** Coordinate; `_AUTHORING_PASSTHROUGH` = `{"credential"}` |
| 11 | `services/agent_flows/registry.py` | service | delete the secret handling in `_carry_credentials` / `_redact_credentials`; add `validate_credential_changes(db, user, prev, new)` and `decorate_credentials(body, user)` (the output-only `credential` field); strip `credential_id` on export |
| 12 | `services/agent_flows/runtime/agent_runtime.py` | service | `self.provider, self.model, self.api_key = rctx.credentials.for_node(node)`; delete `rctx.api_key` usage |
| 13 | `services/agent_flows/runtime/executor.py` | service | `RunContext.api_key` is replaced by a `credentials` resolver (injectable, which is the harness seam); the intent pre-pass uses the answering step's credential; the Coordinate planner passes `credential_id` |
| 14 | `services/agent_flows/skills.py` | service | child flow gets the resolver, not a key |
| 15 | `services/agent_flows/dispatch.py` | service | `run_for_link` / `run_preview` / `run_for_chat_thread` drop the `api_key` / `provider` / `model` params and build the resolver from `(db, flow version author)`; `_runtime_model` deleted; `flow_supplies_credentials` answers "every model step has a usable key" |
| 16 | `services/agent_flows/binding.py` | service | `provider_mismatch` warning replaced by a blocking `missing_credential` error; `_slowest_model` reads node models only |
| 17 | `modules/agent_flows/api.py` | api | test / test-on-report / test-as-chat / preview: delete `_link_credentials` + `deployment_key()`, return 409 `missing_credential`; publish is blocked with the same error |
| 18 | `modules/agent_flows/chat_api.py` | api | delete the `deployment_key()` branch; 409 `missing_credential` |
| 19 | `backend/app/api/public.py` (**protected, only if Q4 = yes**) | api | for a flow-bound link, skip `resolve_public_ai_credentials` and never require `X-User-Ai-Key`; if the flow is not self-sufficient, return the "chưa được cấu hình AI key" block. No other line changes. Reviewed by the `semantic-guard` agent before commit. |
| 20 | `services/agent_flows/authoring_prompt.py`, MCP flow tools if they document `provider` / `api_key` | service | describe `provider` / `model` / `credential_id` instead |

### Phase 4: frontend

| # | File | Layer | Change |
|---|---|---|---|
| 21 | `frontend/src/lib/agentFlows.ts` | client | `Provider` without `inherit`; node types with `credential_id` + output-only `credential`; remove `api_key*` / `has_api_key`; `ProviderGroup` without `note`; new `aiCredentialsApi` (list / create / update / delete / usage / test); `blankNode` / `starterFlow` defaults |
| 22 | `frontend/src/components/agent-flows/AiKeysModal.tsx` (new) | UI | spec §UI; `AppModalShell`, `ConfirmDialog`, `ShareDialog` (the password field follows the OCR key field pattern in `FormScreenEditor.tsx:1629-1659`) |
| 23 | `frontend/src/components/agent-flows/inspector/ModelPicker.tsx` (new) | UI | Provider → Model + key line; fills in the author's default key; "Thêm key" opens the modal with the provider preselected |
| 24 | `inspector/editors/agent.tsx`, `inspector/editors/coordinate.tsx` | UI | use `ModelPicker`; drop `void providers` |
| 25 | `BrainList.tsx`, `BrainBuilder.tsx` | UI | "AI Keys" entry points; `missing_credential` handling for test / publish; "Gán key mặc định cho N bước" after import / duplicate; canvas badge |
| 26 | `frontend/src/i18n/catalog/agent-flows.ts` | i18n | vi + en strings |

No public or embed file changes. The viewer key panel is decided server-side.

### Phase 5: rules and docs

| # | File | Change |
|---|---|---|
| 27 | `scripts/guardrail/guardrail_rules.yaml` | add the new files to `agent_flows` owner files and the new test to its registry (declared protection-file change) |
| 28 | `docs/features/agent-flow-ai-credentials/*` | keep in step with what was built |

## Risks

| Risk | How it would show up | What catches it |
|---|---|---|
| All 55 existing flows stop answering (this is D2, by design) | public bots and Direct Chat reply "chưa được cấu hình AI key" right after deploy | intended; the release note must say so, and each owner needs one key per step. **The demo flows need keys assigned before any demo.** |
| A secret leaks through a serializer, log, run record or error | key shows up in JSON, logs or `last_test_error` | new leak test greps every serialized surface for a canary secret; Gemini `?key=` sanitizer test |
| The encryption key is unset in some environment, so the store would hold plaintext | — | fail-closed 409 + test |
| Replay fixtures drift because `inherit` is now `openai` / `gpt-4o-mini` | `agent_flow_replay` red | the harness supplies a stub resolver; snapshot changes, if any, are reviewed line by line and declared in the PR, never regenerated blindly |
| Gemini through the OpenAI-compatible endpoint behaves differently (tool-call deltas, `max_completion_tokens`) | Gemini step with tools returns no tool call, or 400 | adapter test with recorded responses + one live test in verification |
| Anthropic model names in the catalogue are wrong | 404 on first question | "Test key" plus a live call per model during verification |
| The `resourcetype` enum `ADD VALUE` runs in a transaction on managed PG | migration fails on deploy | `IF NOT EXISTS` precedent in `0041`; migration-checker agent; run against a copy |
| Router order: `/agent-flows/credentials` swallowed by `/agent-flows/{id}` | 404 / 422 on the new endpoints | register before the studio router; API test hits the real app |
| An author edits a shared flow whose key they cannot use | save 403, and a shared flow can no longer be edited | "unchanged id is carried" rule + test |
| MCP / authoring prompt still writes `api_key` / `inherit` | strict authoring rejects the body | `test_authoring_is_strict` updated + prompt text updated |

## Tests (decided now, not afterwards)

| Test | New or existing | What it locks |
|---|---|---|
| `test_ai_credentials_store.py` | new | CRUD; secret never in any response; fail-closed without an encryption key; unique name and default per provider; soft delete; `usage` walks nested lanes |
| `test_ai_credentials_permissions.py` | new | module gate on every endpoint; shared view = use + test only; edit / full split; unshare stops run-time use; unchanged foreign id is carried on save |
| `test_flow_credential_resolution.py` | new | one resolver for every entrypoint; no fallback even with `OPENAI_API_KEY` set; provider mismatch refused at save; deleted key → named error; Coordinate planner and intent pass use the step's key; skill child resolves its own |
| `test_flow_credential_legacy_upgrade.py` | new | `inherit` → `openai` / `gpt-4o-mini` / no key; `api_key*` dropped; export strips `credential_id` |
| `test_no_secret_leaves_server.py` | new | canary secret absent from the credential API, flow GET, export, run record, share disclosure, logs |
| `test_gemini_openai_compat_tools.py` | new | Gemini step dispatches through the OpenAI adapter with `base_url` and forwards tools |
| `test_nested_specialist_credentials.py` | **existing, must change** | it asserts `api_key_enc` redaction, a field that no longer exists. Rewritten to assert the same invariant on `credential_id` (nested lanes are walked for export stripping and usage). Declared in the PR. |
| `test_authoring_is_strict.py` | **existing, must change** | passthrough `has_api_key` → `credential`; `api_key` becomes an unknown field. Declared. |
| `test_agent_flow_golden.py`, `replay_harness.py` | **existing, harness change** | harness passes a stub resolver instead of `api_key="k"`. Declared. |
| Guardrail-named suites (above) | existing | unchanged behaviour of the rest of the runtime |
| `e2e/tests/agent-flow-ai-keys.spec.ts` | new | add a key in the modal → pick OpenAI → model on a step → save → reload shows the key line → test answers; delete the key → badge + 409 |
| public-link e2e (Q4) | existing + one case | flow-bound link shows no key panel, logged out |

- Every new backend test is added to the `.gitignore` allow-list **and**
  `.github/workflows/backend-contract-tests.yml`, then `git add -f`, and checked by the
  `test-wiring-auditor` agent.
- E2E is needed: new UI, save then reload, and the public-link behaviour.

## Verification

On this worktree's own build (isolated ports; not the containers another session built):

1. `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`, then `alembic upgrade head`.
2. In the browser (browser-verifier agent): open Agent Flow → AI Keys → add an OpenAI key and
   a Gemini key → Test both.
3. Open an existing flow: every step shows `OpenAI · gpt-4o-mini · Chưa có key`; Test is
   refused and lists the steps.
4. Pick the key on each step → save → reload → the key line persists → Test answers.
5. Switch one tool-using step to Gemini → `gemini-2.5-flash` → Test → the run inspector shows
   its tool calls.
6. Remove `OPENAI_API_KEY` from the server env and repeat 4. It still answers, which proves
   no dependency on `.env`. Put it back, delete the key in the modal → run fails, naming the step.
7. Logged out, open a public link bound to that flow → no key panel, the answer works.
8. `python scripts/ci/verify.py task --json` → report PASS / FAIL / NOT VERIFIED per gate.

## Implementation notes — where the build departs from this plan

Recorded as the plan asks: what changed, and why.

- **Anthropic offers `claude-haiku-4-5` only.** Claude Sonnet 5.5 / Opus 5.5 always think, and a
  tool loop on them must send each thinking block back unchanged and never rewrite earlier turns
  (preserved thinking). `stream_anthropic` drops thinking blocks and flattens tool history on an
  agent's final round, so those models would 400 on round two. No Anthropic key was available to
  verify a fix, so they are not offered. Follow-up: carry thinking blocks through the tool loop,
  then verify with a real key.
- **`gpt-4.1` added to OpenAI** so `AGENT_FLOW_DEFAULT_MODEL` (the pilot's certified model) still
  decides what legacy `inherit` steps are brought forward to.
- **Gemini** runs through `stream_gemini` (OpenAI-compatible endpoint, `base_url` + `vendor` on
  `stream_openai`; the gpt-4o-mini 429 failover is OpenAI-only). Tool calls without `index` are kept
  apart. The deployment's Gemini key was found **invalid** (Google: `API_KEY_INVALID`), so live
  Gemini generation is NOT verified; the adapter is covered by transport-mocked tests.
- **Grantor re-check.** A step stores `credential_granted_by`; every run checks that person may
  still use the key, so unsharing or deleting stops delegated spend without a republish.
- **No body decoration** (see spec §API). The builder resolves key names from `/credentials`.
- **Core layering.** `core/share_access.py` gained `register_share_resource()`; the AI Keys service
  registers `ai_credential` itself, because `be_core` may not import a feature's model.
- **Intent pre-pass** uses the answering step's key with that provider's fast model.
- **Builder UX found by browser verification:** the "N no key" chip scrolls to the step's picker;
  "Use my default keys" assigns the author's default per provider to every keyless step in one
  click (an explicit, saved edit — not a run-time fallback); the picker says "pick one of yours"
  when the author has keys but the step has none.
- **Out-of-scope fix, declared:** `runtime/nodes._load()` raced on first use after a restart
  (`node type 'agent' registered twice` → 500 on `/agent-flows/nodes`). Now locked and published
  in one step; locked by `test_node_registry_first_load_race.py` (fails on the old code).
- **Tests changed because the contract changed (declared):** `test_nested_specialist_credentials.py`
  and `test_authoring_is_strict.py` re-assert their invariants on `credential_id`;
  `test_one_rule_for_which_model_a_step_runs_on` and
  `test_every_agent_flow_path_runs_on_the_certified_default_model` re-assert on per-step models;
  15 engine test files pass `credentials=fixed_credentials("k")` instead of `api_key="k"`
  (`replay_harness.FixedCredentials`). Replay snapshots did not change.
- **E2E (declared CI change):** `e2e.yml` generates a throwaway `DATASOURCE_ENCRYPTION_KEY` per run;
  four specs give model steps a fake key through `_helpers.withE2eKey` (the agent step then fails
  at the vendor, as it did when CI had no key). New spec: `agent-flow-ai-keys.spec.ts`.
- **Guardrail rules (declared):** new files added to `agent_flows`; new required test
  `agent_flow_credentials`.

## Rollback

- Code: revert the merge. The new table and the enum value are left in place; both are
  additive and harmless unused. Postgres cannot drop an enum value, so the migration's
  downgrade drops only the table.
- Data: node bodies saved after the change hold `credential_id` instead of `inherit`.
  After a code revert, the old contract reads them with `extra="ignore"`: provider `openai`
  with a pinned model, running on the deployment key again. Nothing is unrecoverable.
- Stored secrets remain encrypted in the table until it is dropped by hand.
