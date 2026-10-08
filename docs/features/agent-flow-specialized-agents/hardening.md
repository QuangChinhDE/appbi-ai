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

## Results (all on the isolated rig: own Postgres `appbi-afspec-db`, backend :8137 built from this branch, Next dev :3237)

### Live evaluation round 2: gpt-4o-mini, 144 runs, $0.25 (`evidence/live_eval_round2.json`)

| Architecture | Correct | Golden (S1–S5) | Holdout (H1–H3) | Wrong figure published as verified | LLM calls/q | Median latency | $/q |
|---|---|---|---|---|---|---|---|
| A one custom agent | 30/36 | **15/15** | 6/9 | **0** | 2.9 | 6.9 s | 0.0015 |
| B specialist chain | 29/36 | 10/15 | 7/9 | **0** | 8.9 | 16.9 s | 0.0038 |
| C coordinator | 27/36 | 11/15 | 4/9 | **0** | 5.1 | 7.0 s | 0.0015 |
| D Report Read + Knowledge + writer | 6/36 | 3/15 | 0/9 | 1 | 1.1 | 4.5 s | 0.0003 |

- **D's one wrong figure:** the writer quoted the report's own "ARR summed over all periods" KPI tile (5,244) as a total, beside the statement that it could not compare the two months. That figure is a deterministic chart value; D cannot fetch other charts.
- **Round 3** (`evidence/live_eval_round3_saas.json`, 48 runs): A 21/24, B 18/24, still 0 wrong-as-verified.
- **H1** (total churn over a range) remains hard for gpt-4o-mini: A 0/3, B 1/3. Every miss was a refusal or a number the claim check withheld ([đã ẩn]); none published a wrong total. The backend gives 60 when called with the range.

### Browser acceptance on 6934de0f, retries 0 (`evidence/browser_acceptance_6934de0f.json`)

- **Result:** 75 passed, 1 failed. The failure is the live range-total journey: an honest "no chart breaks churn down by month" refusal, the H1 limitation above. The test is deliberately left strict.
- **Coverage:** the specialist spec (security, authoring, builder F08–F10, live J1–J12 and SaaS analytics) plus every existing Agent Flow spec (builder, run inspector, open-in-builder, v1 golden ×2, AI keys, security-forged, canvas a11y, pointer drag).

### Cold start (`evidence/coldstart_j2_*.json`)

- **J2 right after a backend restart:** 33.0 s (Report Reader 21.5 s), ok.
- **Warm:** 9.7 s and 12.1 s.
- The earlier one-off J2 failure fits a cold run hitting the run time ceiling. That ends as `budget_exhausted`/`failed`, never as a healthy answer. It did not reproduce.

### Intermittent builder.spec abort: found and fixed

- **Symptom:** `builder.spec` "no failed requests" saw an aborted RSC navigation fetch: 3/6 runs on the branch, 1/6 on clean demo (so it also exists upstream).
- **Cause:** the branch fetched `/tools` twice (packs, then roles).
- **Fix and result:** one request for both, then 8/8 clean.
