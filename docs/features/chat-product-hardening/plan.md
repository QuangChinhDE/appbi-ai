# AI Chat product hardening — implementation plan

## Guardrail scoping

`guardrail_check.py --diff --base 360aeaea` → **OK**. Unknown layer only for
`.gitignore` and `e2e/playwright.config.ts`. Required gates listed below all run.

## Files and layers, in order

1. Backend service: `direct_chat.py` (write predicate, blocks, history, messages),
   `permissions.py` (`chat_usable_brains`), `runs.py` (prune), `dispatch.py`
   (write gate, locale).
2. Backend API: `chat_api.py` (403 pre-stream, lang, availability, rating route,
   SSE close order); `route_contract.json` (new route).
3. Frontend: `directChat.ts`, `ChatModule.tsx`, `ConversationView.tsx`,
   `AnswerBlocks.tsx`, i18n catalogue.
4. Tests and CI: PG HTTP test, seed + Playwright chat project, workflow wiring.

## Risks

- `AnswerBlocks` is shared: with handlers it renders as before; without, static.
- `usable_brains` for builder surfaces is unchanged; only Chat uses the new scope.
- Prune now joins chat threads; content of live threads is retained indefinitely
  (by design — it is the conversation).

## Tests — decided now, not afterwards

- `backend/tests/test_chat_conversation_integrity_http_pg.py` (Postgres, real app):
  H1, H3, H4, H5, H8, H10, N1, N2, quota language, list ownership.
- `e2e/tests/chat/chat-hardening.spec.ts` (project `chat`, retries 0): 10 journeys,
  desktop + 390px + 820px.
- Existing: direct_chat contract, module floor, route inventory/contract, agent
  flow golden/contract suites, tier-1 oracles, `test_flow_type` (stub follows the
  new seam; assertion unchanged).

## Verification

Isolated rig (`compose -p chathard` + private network override), seeded with the
repo's own fixtures. Live-model acceptance not run: no provider credentials.

## Rollback

Revert the branch merge. No migration, no data rewrite; ratings written by readers
remain valid rows.
