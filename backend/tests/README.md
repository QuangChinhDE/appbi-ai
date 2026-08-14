# backend/tests — what runs, what is local-only, and what is missing

## Most of this directory is NOT in git

`.gitignore` blocks `test_*.py` everywhere and then re-includes an explicit
allow-list — the suites `.github/workflows/backend-contract-tests.yml` runs. The
team kept everything else local-only on purpose.

Two consequences worth knowing before you touch anything here:

- A test you add is invisible to CI and lost on a fresh clone unless you add it
  to **both** the allow-list in `.gitignore` and the workflow.
- Several files in this directory exist only on the machine that wrote them, so
  "it passes locally" can be true and mean nothing.

`test_agent_flow_golden.py` is allow-listed and CI-run, because a safety net that
does not survive a clone cannot protect a refactor.

---

# Coverage that is missing, and how it went missing

This records test coverage the repository *appeared* to have and did not, so the
gap is a decision rather than a surprise.

## What happened

Nine test modules could not be imported. They referenced modules and symbols that
had been removed by later restructures:

| Test module (deleted) | Lines | Targeted | Now |
|---|---:|---|---|
| `test_agent_brain_contract.py` | 174 | `contract.Brain`, `AgentStep`, `MAX_STEPS` | contract rewritten as `Flow` / typed nodes |
| `test_agent_brain_loop.py` | 239 | `runtime.loop`, `Brain` | runtime rewritten as tree executor |
| `test_dashboard_ai_bot_agent.py` | 330 | `dashboard_ai_bot.agent` | split into `normal/`, `thinking/` |
| `test_dashboard_ai_bot_tools.py` | 225 | `dashboard_ai_bot.tools` | split into `thinking/tools.py`, `govern_tools.py` |
| `test_dashboard_ai_bot_advanced_tools.py` | 400 | `dashboard_ai_bot.advanced_tools` | removed |
| `test_dashboard_ai_bot_briefing.py` | 124 | `dashboard_ai_bot.briefing` | removed |
| `test_dashboard_ai_bot_conversation_state.py` | 149 | `briefing`, `conversation_state` | removed |
| `test_dashboard_ai_bot_overview.py` | 271 | `dashboard_ai_bot.chart_renderer` | removed |
| `test_semantic_query_engine_measures.py` | 505 | `semantic_query_engine_v2` | `semantic_query_engine.py` |

None of them had run for as long as they had been broken. They were not
*failing* — they were **uncollectable**, and a tenth problem hid that: every test
in the repository died at import because `DATABASE_URL` is present-but-empty in
the application image and every test file used `os.environ.setdefault`. Running
`pytest tests` in the backend container produced 67 collection errors and zero
tests. The suite looked substantial and was not being run at all.

Fixed at the root in `tests/conftest.py`, which sets the fallback when the value
is *falsy* rather than absent. That alone took collection errors from 67 to 10;
the 10 were these stale modules, now deleted.

`test_public_dashboard_ai_config.py` was **repaired instead of deleted**: two of
its five tests covered a per-link cost cap that no longer exists in the codebase,
and those two took the other three down with them. The three live ones are back.

## What is genuinely uncovered now

Deleting an uncollectable test does not lose coverage — there was none. But it
does make the real gap visible, and this is it:

- **AI bot agent loop and tool dispatch** (`normal/`, `thinking/`). Adjacent areas
  are still covered — `test_dashboard_ai_bot_cost`, `_insight_pack`, `_providers`,
  `test_ai_budget_guard`, `_evidence_writer`, `_input_guard`, `_scope_data_filter`,
  `_verifier_numbers` — but the loop itself is not.
- **Semantic query engine, measures.** Partly covered by
  `test_phase3_per_measure_isolation` and `test_phase4_symmetric_aggregates`.

Agent Flow's runtime, which two of the deleted modules used to cover, is now
covered by `test_agent_flow_golden.py` — 35 cases over branch, loop, retry,
budget, cross-turn memory, binding, trace integrity and the frozen node list.

## The rule this suggests

A restructure that deletes a module should delete or move its tests in the same
change. Nothing enforced that, because a broken test module was indistinguishable
from the environment fault that was breaking every module. With collection now
working, a stale test fails loudly on the next run.
