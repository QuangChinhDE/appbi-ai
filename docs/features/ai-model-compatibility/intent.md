# AI model & provider compatibility — intent

**Status:** in progress (PR stacked on #14)
**Date:** 2026-10-12

## Problem

An author picks a provider, a key and a model for an Agent step, and the step can still die with an unclear API error. This happens even though the key is valid and the model is in the list. Examples measured on the branch before this change:

- **No current models.** The catalogue offered `gpt-4o-mini`, `gpt-4o`, `gpt-4.1`, `gpt-5`, `claude-haiku-4-5`, `gemini-2.5-flash` and `gemini-2.5-pro`. None of OpenAI's current GPT-6 models was listed, and nothing said which entries are previous generation.
  - `claude-haiku-4-5` has a vendor retirement floor of 2026-10-15.
  - Google now restricts `gemini-2.5-*` to past users.
- **GPT-6 could not call tools.** GPT-6 calls tools only through the Responses API, and the OpenAI adapter spoke only Chat Completions.
- **Claude 5.x broke in tool loops.** Claude 5.x thinks on every turn. The adapter dropped the thinking blocks a tool loop must send back unchanged, and it rewrote tool history into text on the final round.
- **Gemini 3 thought signatures were dropped.** Signatures on tool calls weren't carried, so the next round of a tool loop is rejected.
- **The key test proved too little.** It listed the vendor's models. It never checked that the chosen model is available to the key, or that it runs a tool loop.
- **Silent model swap.** A 429 on `gpt-4o`/`gpt-4.1`/`gpt-5` switched the call to `gpt-4o-mini`, process-wide and across tenants, for 45 seconds.
- **Cut-off answers looked like answers.** Output cut by the token limit was treated as a finished answer. Agent Flow sent no token budget, so the adapters' 2048 default applied, and reasoning can spend all of it.
- **Every failure read the same.** All errors read "API key bị từ chối" or showed a raw status.

## Goal

An author chooses a model and can trust it. The picker shows four things for each model:

- the vendor's lifecycle
- whether it calls tools
- its price, with source and date
- whether AppBI certified it against the real vendor

One action checks the chosen model with the step's key, up to a real tool call. A certified model runs tool loops correctly. Any failure is named for what it is.

## Out of scope

- New Agent roles, or any change to how Agent Flow orchestrates steps.
- Adding providers. The analysis of xAI, DeepSeek and Mistral is in `spec.md`; no adapter is added, because no credential exists to certify one.
- Automatic migration of stored or published flows to new models.
- Changing the default model for new or legacy steps.

## Constraints

- **One adapter per protocol.** Extend the shared adapters with opt-in parameters; other callers keep identical behaviour. This applies to the dashboard AI bot, the brief and the prompt drafter.
- **Stored and published flows run what they ran.** An empty `model` keeps meaning what it meant.
- **Credentials stay as they are.** Keys stay encrypted, owned and shared as today, and never reach a flow body, a trace or a response.
- **Reasoning stays private.** No vendor reasoning or thinking content is shown to the reader.

## Acceptance criteria

1. Every offered model carries its lifecycle, endpoint, tool capability, a sourced price and a certification status. "Certified" requires live evidence.
2. GPT-6 models run text, streaming, tool calls, dependent multi-round tool loops and answer-only rounds through the Responses API, live.
3. Claude thinking blocks and Gemini thought signatures are carried unchanged between rounds. This is proven by protocol tests; live runs are blocked, see risks.
4. No Agent Flow call switches model on a 429, and a cut-off answer is an error.
5. Errors carry a classified code, such as `invalid_credentials`, `quota_exhausted` or `truncated`.
6. Checking a model reports four levels: credential, availability, compatibility and a real tool call. "Ready" requires the real tool call.
7. Legacy flows and published versions keep their model, and the author can list which flows use which model.
8. Browser journeys M01–M12 pass with retries 0, or are reported with the reason they cannot be exercised.
