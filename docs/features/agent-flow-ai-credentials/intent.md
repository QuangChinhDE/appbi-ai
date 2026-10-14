# Agent Flow AI credentials — intent

**Status:** implemented on `feat/agent-flow-ai-credentials` (approved 2026-09-30). What changed from this intent during implementation is in `plan.md` → *Implementation notes*.
**Owner:** chinh.bui02@base.vn
**Date:** 2026-09-30
**Branch / worktree:** `feat/agent-flow-ai-credentials` · `D:/Appv2/wt-af-credentials` (from `48d3eaae`)

## Decisions already taken (2026-09-30)

| # | Question | Decision |
|---|---|---|
| D1 | Who owns a key | **Per user, shareable.** The creator owns it and may share it to other users/teams, the way datasources are shared. |
| D2 | The server's `.env` keys (`OPENAI_API_KEY`, …) | **Cut, no import.** Agent Flow stops reading them. Existing flows show "missing key" until an author assigns one. |
| D3 | How a node picks its AI | **Simple: choose the provider, then choose one of that provider's models.** Nothing else to understand. The key is filled in automatically from the author's default key for that provider. |

## Problem

Today an Agent step does not choose where its credential comes from — the server does,
and it does so five different ways.

- **There is no way to enter a key.** `AgentNode` carries `api_key` / `api_key_enc` /
  `api_key_clear` (`contract.py:325-337`) and the save path encrypts them
  (`registry.py:190-236`), but no component in `frontend/src/components/agent-flows/**`
  reads or writes those fields. Measured on the running DB: 55 flows, 315 versions,
  **0 nodes with their own key, 0 nodes pinning a provider**. Every flow runs on
  `OPENAI_API_KEY` from the server environment.
- **Only OpenAI can be chosen.** `models_catalogue.MODELS` lists one vendor, although the
  runtime already dispatches to Anthropic and Gemini adapters (`handlers/agent.py:1300`).
- **Five entrypoints resolve the key five ways.**
  `POST /brains/{k}/test` → link key, else deployment (`api.py:1777`);
  `/test-on-report`, `/test-as-chat`, `/nodes/{k}/preview` → deployment only, and they drop
  the model (`model=""`); Direct Chat → deployment only when a step lacks its own key
  (`chat_api.py:311`); public link → viewer header, else link, else deployment
  (`public_link_config.py:101`).
- **A step can be handed the wrong vendor's key.** `agent_runtime.py:402` is
  `node.resolved_api_key() or rctx.api_key`. A node pinned to Anthropic without its own
  key receives the link's OpenAI key and fails in front of the viewer; the binding
  preflight only warns (`binding.py:370`).
- **A Coordinate node cannot hold a key at all.** `_carry_credentials` encrypts only
  `type == "agent"`, so a key sent for a `coordinate` node is popped and discarded
  (`registry.py:224`). The Coordinate editor has no model picker either
  (`inspector/editors/coordinate.tsx:28`, `void providers`).
- **Gemini cannot use tools.** `stream_gemini_singleshot` ignores `tools`, so a Gemini
  Agent step would silently lose every capability it was granted.
- **Keys cannot be reused.** Even if the per-node field had a UI, every node of every flow
  would need the token pasted again, and sharing/exporting a flow would carry it along —
  the reason `models_catalogue.py:15-29` already says the right shape is "a stored
  credential resource — encrypted, permissioned, referenced by id".

## Goal

An author keeps their AI keys (OpenAI, Gemini, Anthropic) in one **AI Keys** manager inside
the Agent Flow module, and every Agent / Coordinate step picks a provider and a model; the
step then runs on a key from that store and on nothing else. The node-level token, the
`inherit` option and every deployment/link/viewer key fallback are **removed** from Agent
Flow — one way, not two in parallel.

## Out of scope

- Other AI features that read the `.env` keys: embeddings (`embedding_service.py`),
  `llm_client.py` users (auto-tagging, govern drafts, HTML import, presentation critic…),
  `quality_ai_suggest.py`, figure vision, the non-flow Dashboard AI bot endpoints
  (briefing, exploration, prompt suggestion). They keep working exactly as today.
- The public link's own `ai_bot_key` / `ai_bot_provider` / `ai_bot_model` settings in
  `PublicLinkAiBotEditor`. They still serve the non-flow bot endpoints. **Separate finding:**
  that key is stored in plaintext (`api/dashboards.py:3310-3330`) — tracked as its own
  security task, not fixed here.
- Per-key spending limits, usage dashboards, billing reports.
- A workspace / tenant concept. None exists in the data model; ownership is per user.
- Automatic key rotation or vault integration.

## Constraints

- **Encrypted or refused.** `encrypt_value` stores PLAINTEXT when
  `DATASOURCE_ENCRYPTION_KEY` is empty. The store must fail closed
  (`is_encryption_configured()` false → refuse to save a key).
- **No secret ever leaves the server** — not in list/detail responses, flow bodies,
  exports, run records (`runs._SECRET_CONFIG_FIELDS`), logs or error messages.
- **Permission model is the existing one.** `ResourceShare` + a new
  `ResourceType.AI_CREDENTIAL` mapped to module `agent_flows`; router gates via
  `require_permission`; per-resource via the `dependencies.py` helpers. No bespoke ACL.
- **Stored flow bodies are not rewritten.** Legacy nodes are brought forward on read by
  `contract.upgrade_body`, as every earlier schema change was.
- **Migration additive, single head.** Current head `20260930_0001` (a merge revision).
  Adding the enum member needs `ALTER TYPE resourcetype ADD VALUE IF NOT EXISTS`
  (precedent: `20260811_0041_agent_brains.py:51`).
- **Protected subsystem:** removing the viewer-key path for flow-bound links touches
  `backend/app/api/public.py` (public-link security). Smallest surgical change, and the
  `public_link_security` gates are required.
- Module is behind `METADATA_CATALOG_ENABLED`; new routes must be mounted inside that block.

## Acceptance criteria

1. In the Agent Flow module an author can open **AI Keys**, add a key (name, provider,
   secret), see it listed as `name · provider · ••••last4`, test it, rename it, replace its
   secret, mark it default for its provider, share it, and delete it. The secret is never
   shown again after saving.
2. `GET` on any credential or flow endpoint, a flow export, and a run record contain no
   secret and no ciphertext (asserted by a test that greps the serialized payloads).
3. With `DATASOURCE_ENCRYPTION_KEY` unset, adding a key returns 409 with an actionable
   message and nothing is stored.
4. In an Agent step and a Coordinate step the author picks **Provider → Model** (lists come
   from the catalogue: OpenAI, Anthropic, Gemini). The key is filled from the author's
   default key for that provider; if they hold several they may switch it; if they hold none
   the picker says so and opens "Add key" in place.
5. A step can only be saved with a key whose provider equals the step's provider; a key the
   saver may not use cannot be newly assigned (403 naming the step). A key already on the
   step that the saver cannot use is kept unchanged when they save other edits.
6. At run time a step uses exactly its own key. A step with no key, or a key that was
   deleted/unshared, fails with a message naming the step and the reason. There is no
   fallback to the link, the viewer or the server environment — verified with
   `OPENAI_API_KEY` set on the server and a flow whose key is missing.
7. All five entrypoints (test on link, test on report, test as chat, node preview, Direct
   Chat) and the public-link run path resolve credentials through the one resolver; none
   of them references `deployment_key()` or `_link_credentials` for Agent Flow.
8. A Gemini Agent step with tools granted actually calls those tools (e2e or a recorded
   adapter test), and a Claude step does too.
9. Every existing flow opens in the builder, shows its steps as **OpenAI · <model>** with a
   "Chưa có key" badge, and its test/publish/bind actions list the steps missing a key.
   After one key is assigned per step, the flow runs.
10. A flow bound to a public link never asks the viewer to paste a key. If the flow is not
    self-sufficient the viewer sees "Trợ lý chưa được cấu hình AI key" instead.
11. Exporting a flow strips `credential_id`; importing it marks every step "Chưa có key".
12. `python scripts/ci/verify.py task` passes, with every unverified gate named.

## Open questions

- **Q4 — resolved as "yes"** (the approval "triển khai luôn" took the stated default). Original text:
  confirm criterion 10. Should the viewer-pasted key be removed
  for **flow-bound** public links? This spec assumes **yes**, because keeping it would
  leave a second credential path running beside the new one. It requires a small change
  in `api/public.py`, a protected subsystem. Owner: chinh.bui02@base.vn.
- **D3 implementation detail:** to give Gemini tool calling without adding anything to the
  UI, Gemini steps will be sent through Google's OpenAI-compatible endpoint
  (`generativelanguage.googleapis.com/v1beta/openai/`) using the existing OpenAI adapter
  with a `base_url`. The author only sees "Gemini → model". Confirm this is acceptable.
- The model list per vendor (spec §Data) must be re-checked against each vendor with a
  live "Test key" call during implementation; names drift.
