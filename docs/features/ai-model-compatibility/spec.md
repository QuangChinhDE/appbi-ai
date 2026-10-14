# AI model & provider compatibility — spec

## Sources

All sources are official vendor pages, read on 2026-10-12.

- **OpenAI:**
  - [models](https://developers.openai.com/api/docs/models), [latest model guide](https://developers.openai.com/api/docs/guides/latest-model), [changelog](https://developers.openai.com/api/docs/changelog), [pricing](https://developers.openai.com/api/docs/pricing)
  - [function calling](https://developers.openai.com/api/docs/guides/function-calling), [reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- **Anthropic:**
  - [models overview](https://platform.claude.com/docs/en/models/overview), [deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations), [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- **Google:**
  - [models](https://ai.google.dev/gemini-api/docs/models), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations/), [pricing](https://ai.google.dev/gemini-api/docs/pricing)
  - [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- **xAI:** [models](https://docs.x.ai/developers/models)
- **DeepSeek:** [pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- **Mistral:** [inference](https://docs.mistral.ai/inference)

## Protocol facts the code depends on

| Vendor | Fact | Consequence |
|---|---|---|
| OpenAI GPT-6 | Tool calling uses the Responses API. Astra and 6.1 Sol do not accept `none` effort. `temperature`/`top_p` are refused when reasoning is on. `max_output_tokens` includes reasoning. | New Responses adapter, `reasoning.effort = low`, no sampling parameters, 16k output budget. |
| OpenAI GPT-6 | Reasoning items must be passed back with tool outputs. Stateless requests (`store: false`) return them with `encrypted_content`. | The round's output items are replayed verbatim. |
| OpenAI | `status: incomplete` with `incomplete_details.reason = max_output_tokens`. | Reported as `truncated`. |
| Anthropic 5.x | Adaptive thinking is always on. Thinking and redacted_thinking blocks must come back complete and unmodified within a tool turn; modified blocks get a 400. `temperature` is refused on 4.7 and later. | Blocks are captured with signatures and replayed. An answer-only round declares the used tools with `tool_choice: none` instead of rewriting history. |
| Gemini 3 (OpenAI-compatible endpoint) | `extra_content.google.thought_signature` on a tool call must be echoed back unchanged. | The vendor's per-call `extra_content` is kept and replayed on that call. |

## Model support matrix

**OpenAI**

| Model | Lifecycle | Endpoint | Tools | Certification | Price $/1M in / out |
|---|---|---|---|---|---|
| gpt-6-luna | active | responses | yes | **certified (live)** | 0.10 / 0.50 |
| gpt-6.1-sol | active | responses | yes | **certified (live)** | 2 / 10 |
| gpt-6-astra | active | responses | yes | **certified (live)** | 10 / 50 |
| gpt-4o-mini | legacy → gpt-6-luna | chat_completions | yes | **certified (live)** | 0.15 / 0.60 |
| gpt-4o | legacy → gpt-6.1-sol | chat_completions | yes | unverified | 2.5 / 10 |
| gpt-4.1 | legacy → gpt-6.1-sol | chat_completions | yes | unverified | 2 / 8 |
| gpt-5 | legacy → gpt-6-astra | chat_completions | yes | unverified | 1.25 / 10 |

**Anthropic**

| Model | Lifecycle | Endpoint | Tools | Certification | Price $/1M in / out |
|---|---|---|---|---|---|
| claude-haiku-5-5 | active (retirement floor 2027-10-07) | messages | yes | unverified: no key | from 0.10 / 0.50 |
| claude-sonnet-5-5 | active | messages | yes | unverified: no key | 2 / 10 |
| claude-opus-5-5 | active | messages | yes | unverified: no key | 4 / 20 |
| claude-fable-5-1 | active | messages | yes | unverified: no key | 10 / 50 |
| claude-haiku-4-5 | legacy, floor 2026-10-15 → claude-haiku-5-5 | messages | yes | unverified: no key | 1 / 5 |

**Gemini**

| Model | Lifecycle | Endpoint | Tools | Certification | Price $/1M in / out |
|---|---|---|---|---|---|
| gemini-3.8-flash | active | openai_compat | yes | unverified: key rejected | 0.75 / 3.75 (to 2026-12-31; then 1.50 / 7.50) |
| gemini-3.5-flash-lite | active | openai_compat | yes | unverified: key rejected | 0.30 / 2.50 |
| gemini-2.5-flash / 2.5-pro | legacy, past users only → gemini-3.8-flash | openai_compat | yes | unverified: key rejected | 0.30 / 2.50; 1.25 / 10 |

**Not offered** (not text/tool agent models): realtime, TTS, transcription, image, video, embedding and specialised models (gpt-5.6-cyber, Gemini Live/TTS/Deep Research, and similar).

## Providers evaluated, not added

| Provider | Models (official) | Protocol | Decision |
|---|---|---|---|
| xAI | grok-4.7 (500k ctx, $2/$6) and others | OpenAI-compatible Chat and Responses; `grok-4.7` always returns `reasoning.encrypted_content` on Responses | The Responses adapter fits structurally. **Not added:** no credential to certify. |
| DeepSeek | deepseek-flash (V4.1-Flash), deepseek-v4-pro; thinking by default; legacy `deepseek-v4-flash` aliases retired | OpenAI-compatible, Responses, Anthropic-compatible | Same. **Not added:** no credential. Thinking-mode replay semantics are unverified. |
| Mistral | Mistral Large 4 (v26.10) | Chat completions | **Not added:** exact API id and tool-call format not verified on the docs landing page, and no credential. |

Adding one means:

1. A provider value in the catalogue, the credential provider list and the DB CHECK (one migration).
2. Its endpoint mapped to an existing adapter.
3. Live certification with `eval/certify_models.py`.

The Agent runtime does not change.

## Contract changes (all additive)

- **Catalogue** (`GET /agent-flows/models`): every model gains `purpose`, `lifecycle`, `retire_after`, `replacement`, `endpoint`, `tools`, `reasoning`, `price{…, source, as_of}`, `certification{status, as_of, evidence|reason}`, `selectable` and `lifecycle_warning`.
- **`POST /agent-flows/credentials/{id}/check-model`** `{model, smoke}` returns `{verdict: ready|available_untested|not_ready, levels[credential, availability, compatibility, smoke]}`.
- **`GET /agent-flows/models/usage`** returns, for the flows the user may use, the steps per model with lifecycle and replacement.
- **`POST /credentials/{id}/test`** gains `code`.
- **Run traces:** each step's capability record gains `model {provider, model, error_code?}`.
- **Adapters** gain `strict` (Agent Flow only), a `provider_state` event, and `code`/`retryable` on errors.
- **Save rule:** a step with tools on a model catalogued `tools: false` is refused.
