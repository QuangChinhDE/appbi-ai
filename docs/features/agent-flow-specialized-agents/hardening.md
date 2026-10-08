# Agent Flow specialists — analytics hardening (round 2)

User feedback on a real BI report showed flows that ran green while answering a
different question: the wrong measure, the wrong period, or a sum that means
nothing. Each finding below was reproduced against the code and the SaaS fixture
(`backend/eval/seed_saas_fixture.py`, `build_saas_report.py`) before it was fixed.

## Findings

| # | Reproduced | Root cause | Fix | Lock |
|---|---|---|---|---|
| F01 | TABLE with `selectedColumns` [year_month, mrr_active, arr_active, cus_churned] listed no measures in `list_charts` | `extract_chart_field_semantics` put every selectedColumn in dimensions | classify by physical type and name: a numeric non-identifier is a measure (aggregation left undeclared), a date is a time dimension, a numeric code or id is a dimension; with no known types, the old behaviour | test_analytics_meaning F01 |
| F02 | `total_measure`/`rank_values` with no measure, and `compare_periods` with an unknown measure, picked a column by position | positional fallback in `_resolve`, `total_measure` and `advanced_tools._measure_idx` | one candidate is used; several give `measure_ambiguous` listing them; an unknown named measure is `bad_argument` | F02 tests + mutation check |
| F03 | ARR summed across 8 months (5,244). Live: August churn (40) published as the Jan–Aug total | `total_measure` summed rows with no notion of time | `period`, `period_from`/`period_to`, `across_periods`; an undeclared series is refused across periods; `periods_covered` always reported | F03 tests, live S1/H1 |
| F04 | Asked about August 2026 (72 after 864), `compare_periods` auto mode compared July | a low last edge was trimmed, and there was no way to name the asked period | `period` argument: the named period is the headline even when low, with "suspected" stated, never substituted. Auto mode is unchanged (`test_partial_period_comparison` locks it on purpose) | F04 tests |
| F05 | `measure` was described as "the chart's own measure"; `total_measure` had no time caveat | text did not match the code | contracts rewritten to match behaviour (`measure`, `period`, range, `across_periods`, compare `period`) | contract tests |
| F06 | `arr_active` in two tables: both candidates `complete/high` | bare-name match across tables | `confidence: ambiguous` plus `ambiguous_sources` (qualified field per source); qualified names and metric bindings are unaffected | F06 test |
| F07 | an earlier Agent's "… VNĐ" verified the answer's currency | qualifier evidence included every prior step's prose | `_trusted_prior_results`: recorded tool results plus deterministic steps only | F07 test |
| F08 | `{{}}` Switch, Loop and Filter published green; a Loop ran once over the text "{{}}" | a blank placeholder is not a template, so nothing checked it; `blankNode` seeded it | `incomplete_config_problems` (hard at publish), runtime `_require_expression`, empty defaults | F08 tests + e2e |
| F09 | no way to delete a path or case; case keys `case_<count+1>` could collide; a deleted answer step stayed `answer_node` | missing controls | Remove (respecting the 2-path / 1-case minimum), Add path, unique keys, `answer_node` cleared, all through undo | e2e F09 |
| F10 | follow-ups forced on every answer | hard-coded on the answering step | `followups` field (default on); off means the prompt says no and the lines are stripped | test + e2e F10 |

## Security triage (reported risks)

| Risk | Verdict | Owner |
|---|---|---|
| AI Explore uses a separate tool stack (`dashboard_ai_bot/thinking/explorer.py`) | (5) Out of scope. It does not run through Agent Flow's registry or role boundaries. | Thinking chat owner |
| Guard modes that only log (`INTELLIGENCE_GUARD_MODE` defaults to `log` in code) | (2) It gates prompt-abuse checks on the question, not data access. Agent Flow's data, scope and claim checks never read it. | Platform config |
| Raw rows / PII | Raw-row gate: (3) already protected (`read_rows`). Column-level PII masking: (2) absent platform-wide. | Dataset / semantic owner |
| Client-supplied history on public links | (2) Forged assistant turns are text only, so they cannot become evidence, scope or rights. They can steer the model only under `context_policy` `last_3`/`full` (the default is `question`). | Public AI bot owner |
| Knowledge ceiling | (3) Set on every executing entry point. The step-prompt preview (no execution) lacks it: cosmetic. | — |
