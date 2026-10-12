# AI model & provider compatibility — plan and results

## Order

1. Audit, then verify against official sources.
2. Catalogue.
3. Error vocabulary.
4. Adapters (Responses; strict Chat Completions; Anthropic thinking; Gemini signatures).
5. Runtime replay of `provider_state`.
6. Model check and model usage.
7. Picker.
8. Tests.
9. Live certification.
10. Browser journeys.

## Branching

This work is stacked on PR #14 (`feat/agent-flow-specialized-agents`, which already contains the latest `demo`). It touches the same Agent runtime files, so branching from `demo` would conflict with #14. Merge #14 first; this PR's diff is then only the model work.

## Results

### Live certification (`evidence/live_certification.json`)

This runs AppBI's own runtime path against the real vendor APIs.

| Model | text | tool | multi-round | answer-only | usage | Result |
|---|---|---|---|---|---|---|
| gpt-6-luna | ✓ | ✓ | ✓ | ✓ | ✓ | **certified** |
| gpt-6.1-sol | ✓ | ✓ | ✓ | ✓ | ✓ | **certified** |
| gpt-6-astra | ✓ | ✓ | ✓ | ✓ | ✓ | **certified** |
| gpt-4o-mini | ✓ | ✓ | ✓ | ✓ | ✓ | **certified** |
| gemini-3.8-flash / 3.5-flash-lite | — | — | — | — | — | **BLOCKED**: Google rejects the environment's key (`invalid_credentials`) |
| claude-sonnet-5-5 / haiku-5-5 | — | — | — | — | — | **BLOCKED**: no key (`invalid_credentials`) |

Two negative checks also passed live:

- An unknown model ID returns `model_unavailable` from the adapter, and `unknown_model` from the model check.
- A 16-token budget on gpt-6-luna returns `truncated`.

### Protocol tests

`backend/tests/test_model_compatibility.py` has 33 tests, all mocked transport. They pin:

- dispatch per endpoint
- Responses parse and replay
- truncation and error codes
- no 429 model swap in strict mode
- Gemini signature replay
- Anthropic thinking capture, replay and the answer-only round
- runtime carry of `provider_state`
- the layered check verdicts
- the text-only tool refusal

### Browser (`e2e/tests/agent-flow-models.spec.ts`, retries 0)

| Journey | Result |
|---|---|
| M01 picker grouped by provider, facts | PASS |
| M02 key stored, never echoed | PASS |
| M03 rejected key named | PASS |
| M04 picker checks model with the step's key (real tool call) | PASS (live) |
| M05 switch model, save, reload | PASS |
| M06 GPT-6 real tool call | PASS (live) |
| M07 multi-round | PASS (live) |
| M08+M09 specialists on three models | PASS (live) |
| M10 unknown model refused and named | PASS |
| M11 text-only model refused with tools | Server-side test only. No catalogued model is text-only, so there is nothing to select in the UI. |
| M12 published flow keeps its model | PASS (live) |
