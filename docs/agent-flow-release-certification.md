# Agent Flow — release certification

One question: **what have we actually proven about every tool, and about the
model's use of those tools?**

Not an architecture plan and not a re-audit. Nothing here was fixed while it was
being certified — the same pass must not invent the criterion, change the
implementation and then certify its own change. Confirmed failures are recorded
with the evidence that produced them and left for a remediation session.

Raw evidence (gitignored, local to the certifying machine):
`.artifacts/cert/` — `tool_inventory.json`, `valid_call_raw.json`,
`negative_raw.json`, `live_eval.json`, `tool_pressure.json`, `matrix.json`, and
the probes that produced them.

---

---

## AUTHORITATIVE CURRENT RELEASE REGISTER

**This section is the current truth. Everything from §11b down is audit history,
labelled HISTORICAL / SUPERSEDED where a later session moved it.**

Current HEAD: `088e064de6f926c1ea032dc7d927cc081d69e23c` (branch `feat/agent-flow-chat-rework`)

Why this section exists: §11b recorded B1/B3/B5 as closed while §12 still listed
them as open blockers, and the final verdict still counted five open failures.
Three statements, one repository. A release decision read off any one of them is
a decision read off a document disagreeing with itself.

### Correctness blockers

**B1 — a partial period reported as a collapse. CLOSED.**
`_trim_partial_edges` no longer asserts a calendar fact from magnitude. A
business that genuinely collapsed produces the identical value series, so the
first fix would have hidden a real collapse and reported a calm figure between
the two healthy months before it. `partial_last` now means PROVEN, from a
declared filter ceiling that stops before the bucket's period ends; an
unexplained low edge reports `edge_completeness: suspected_incomplete` and
offers the reader both readings; `observed_latest` is unconditional, so a low
final value cannot leave the payload by being low.
Locked by `test_partial_period_comparison.py` — 30 cases, 22 red against the
previous commit.
Live D1 on this HEAD: compares 1,003,308.47 against 1,058,728.03 (−5.23%) and
states "có một giá trị bất thường thấp là 166.46 … không thể so sánh đáng tin
cậy". The edge is preserved, described, and not the headline.

**B2 — a category answered as a state. OPEN. Tool contract closed; live
behaviour still reproduces.**
Fixed and locked at the tool layer: `discover._fields()` serialises `field_kind`,
`resolve_chart_candidates` accepts `dimension` as an independent concept,
candidates report `measure_match` / `dimension_match` / `complete`, `exact` means
"satisfied everything that was asked", and the resolver resolves the PAIR rather
than sending a dimension in as a measure.
Locked by `test_dimension_is_not_a_measure.py` — 13 cases, 11 red against the
previous commit.
Live D2 on this HEAD still answers: "Bang có doanh thu cao nhất là
**health_beauty**". See open item 1 for why the fix does not reach it.

**B3 — two definitions of "time-like field". CLOSED.**
One definition in `packs/_timefield.py`, shared by `coverage` and
`project_ahead`. The two had drifted apart in BOTH directions — coverage still
carried the "nam" inside "name" substring bug AND had never learned
`month|quarter|week|year`, so it did not recognise `year_month`. 5 of 16 corpus
columns were classified differently.
Locked by `test_time_axis_contract.py`. A third definition survives on purpose —
open item 3.

**B4 — unrelated evidence becomes the answer. CLOSED.**
`_note_capability_gap`: a capability skipped as unavailable, plus no step that
resolved the question, plus an answer citing figures, produces a reader notice
naming which step could not run and downgrades the run from `ok` to `partial`.
Built entirely from records the run already keeps — `state.skipped` and the
report-read selection mode — with no relevance judge and no reading of the
question text.
Locked by `test_capability_serviced_the_intent.py` — 10 cases, half of them for
what must survive: web off while the report genuinely answered, one step
servicing when another did not, a branch skipped for a condition rather than a
capability, and an answer that states no figures.
Stated cost: a pure overview flow carrying a Web node is marked `partial` when
web is off, because its read never matched the question either.

**B5 — a dead retry drains the budget. CLOSED.**
The guard held and the budget was spent anyway: `spend_tool()` sat two lines
above the refusal check, so a request the runtime had already declined still
cost a call. Spending now happens inside the executor handed to the retry policy,
so a call that does not reach `tool_registry.execute` does not reach the budget.
And making the repeat free removed its cost, not its loop — after two ignored
recoveries the tools come off the table and the model is asked to answer with
what it has.
Locked by `test_dead_retry_costs_nothing.py` — 9 integration cases asserting
registry execution count, tool budget spent, model rounds and final answer;
3 red against the previous commit.

**B6 — unit/time/scope asserted without provenance. CLOSED for UNIT, TIME,
SCOPE and AGGREGATION.**
One rule rather than five: a qualifier may be stated only if it appears in the
evidence. `qualifiers.py` plus one correction round at the answering node, in the
same place and with the same "only if actually better" acceptance as
`_retry_figures`, because there the tool results are still in the message history.
Locked by `test_qualifier_provenance.py` — 21 cases, half for the false
positives. DIMENSION is deliberately not enforced here — open item 2.

### Open, with the exact next step

1. **B2 live path.** The tool contract is correct and locked; the live failure is
   upstream of it. On `revenue_v2` / link 39 the `overview` step reads by REPORT
   ORDER, not by question, so `_charts_for_question` — and with it the paired
   measure+dimension resolution — never runs. The answering agent then calls
   `rank_values` on a category chart and the answer labels the result "Bang".
   Next step: route the direct-agent path through the same resolution, so an
   agent ranking on a chart whose dimension is not the one asked about is refused
   or caveated. This is a selection-time fix. A text rule at answer time would be
   a second, weaker opinion about the same thing.

2. **DIMENSION qualifier.** Excluded from `qualifiers.py` on purpose. The evidence
   blob contains the governed field's label whenever `search_business_assets`
   ran, so "does the word appear in the evidence" cannot separate *mentioned*
   from *measured*. It belongs with item 1.

3. **A third definition of "time-like field".**
   `dashboard_ai_bot.thinking.advanced_tools._looks_like_datetime` is a substring
   test over a different token list: it does not recognise `created_at`, and it
   carries `day` / `tuan` / `quy`, which the canonical one does not. It gates
   `compare_periods`, so folding it in would change that tool's acceptance in the
   same pass that changed its edge handling. Recorded rather than merged quietly.

4. **`dashboard_ai_bot` has no guardrail feature mapping.**
   `guardrail_check.py --files backend/app/services/dashboard_ai_bot/thinking/advanced_tools.py`
   returns `ok` with no features touched and no required tests. The file that
   produces every analytical number is `unknown` coverage, which is not safe
   coverage. The `agent_flows` feature globs cover `services/agent_flows/` only,
   while the tool BODIES still live in `dashboard_ai_bot` behind the `_source.py`
   seam — the same shape as the answer-renderer gap already fixed in that file
   with a comment explaining it.

### Live eval on this HEAD

Two runs of the SAME code, so the spread is the model and not the build:

    run 1    PASS 10  ·  WARN  8  ·  FAIL 0   of 18        (balanced)
    run 2    PASS  6  ·  WARN 12  ·  FAIL 0   of 18        (balanced)

Auto invariants 18/18 clean in both: no scope violation, no ungranted tool, no
withheld capability called, no run blocked, no figure without a source.

**Seven of eighteen cases changed verdict between the two runs.** A single live
run is therefore evidence, not a release verdict, and the accounting fix in §7
does not change that — it makes each run internally consistent, not repeatable.
Anything decided from one run should be decided from the case's own answer text
as well.

**And a PASS from this harness does not settle a human-read judge.** `auto_score`
sees the trace: capability, scope, budget, traceability. It cannot see a
substituted concept. Run 2 marked `out_of_scope_measure` PASS while the answer
read "Danh mục có doanh thu cao nhất là health_beauty" — a different question
answered without a caveat, which that case's own judge calls a FAIL. This is why
B2 below is OPEN despite a green row.

The WARNs are the engine reporting its own distrust, which is what these fixes
added: `figures_unverified`, `qualifier_unverified`, and runs ending `partial`.

Reviewing the first run found TWO FALSE POSITIVES in the B6 qualifier rule, both
fixed and locked:

  - `no_data` answered "Báo cáo không chứa bất kỳ dữ liệu nào cho tháng 12 năm
    2030" — the CORRECT refusal — and was flagged, charged an LLM correction
    round, and given a reader notice about a figure it never stated. Naming a
    period is not claiming it: the rule now needs a number in the same sentence
    that is not part of the period's own digits.
  - `coverage` wrote "tháng 09 năm 2016" where `describe_time_coverage` had
    returned "2016-09-04". Same month, two spellings, reported as unsourced.
    Comparison is on the canonical `YYYY-MM` now, and a quarter matches any of
    its three months.

After the fix `coverage` and `out_of_scope_chart` are clean and `no_data` is
still flagged — correctly: that run's answer claimed the charts "chỉ ghi lại dữ
liệu đến tháng 2 năm 2017", which is false and appears in no tool result.

### Pre-release hardening — all 13 carried forward

24 of 36 tools with no semantic oracle · 6 of 36 with no `output_schema` ·
certification machinery gitignored · `agent_flow_eval` manual · Tool-node
identity on the canvas · raw node keys shown to authors · Vietnamese in the
English author surface · answer language vs question language · the green unit
tier hiding counts · PR-only gates that never run on this branch ·
`search_knowledge` relevance floor · internal tool vocabulary leaking to readers ·
live-eval one-verdict-per-case (now CLOSED — see above).

### Deferred to Wave 3 — all seven carried forward

Binding-aware logical asset selection · reusable Subflow/Specialist · safe
parallel fan-out · durable checkpoint/background execution · human-in-the-loop ·
agentic builder · MCP/plugin boundary.

### Current verdict

    NOT READY FOR RELEASE — READY FOR UAT

B1, B3, B4, B5 and B6 are closed, each with a test that fails against the commit
before it. B2 is closed at the tool layer and open at the live path, and the rule
for this session was that B2 does not close until live D2 stops returning a
category as a state. It still does.

---

## 1. Exact SHA certified

    97db3f90313691e8f98f0f3fe0132a771868f97d

Branch `feat/agent-flow-chat-rework`, working tree clean at freeze.
Merge-base with `demo` is demo's own tip `f58cc63588c4f9f2a67b592ca0f44df2fd86d813`
— behind 0, ahead 62. Everything below belongs to that SHA or to the
certification-only commit that adds this document, one failing regression and one
Playwright journey.

## 2. Tool inventory count

**36 tools**, read from `all_tools()` rather than from any second list. The
documentation's "36 tools" is accurate — no finding.

| property | value |
|---|---|
| packs | compare, diagnose, discover, external, knowledge, measure, project, read |
| risk | `read_only` × 36 — no tool declares anything else, so the `unknown` fail-closed default is currently unexercised in production |
| data_exposure | derived 28, metadata 6, **raw_rows 2** (`get_chart_data`, `smart_drilldown`) |
| reaches_outside | 5 |
| non-deterministic | 8 — the 5 external ones plus `describe_time_coverage`, `forecast_measure`, `project_to_period_end`, `benchmark_compare` |
| `output_schema` present | **6 / 36** |
| `self_sufficient` | 20 (latent: only `inspect_filters` has a node that calls it directly) |

Two inventory observations, neither blocking:

- **30 of 36 tools have no `output_schema`.** `returns` is prose for a human;
  `output_schema` is what a ToolNode needs to wire one step's output into the
  next without a model in between. Six tools can be wired that way today.
- **12 tools are named in no backend test file.** They are not uncovered — the
  generic suites parametrise over `all_tools()` — but nothing addresses them by
  name: `benchmark_compare`, `browse_ai_answer`, `compare_segments`,
  `compare_to_target`, `compute`, `correlate_charts`, `describe_distribution`,
  `detect_seasonality`, `get_chart_glossary`, `project_to_period_end`,
  `research_web`, `segment_compare`.

## 3. The 36-tool certification matrix

Generated by `.artifacts/cert/build_matrix.py`, whose keys are
`set(all_tools())` **by construction** — a registered tool with no entry aborts
the build. 36 entries, 0 missing, 0 extra.

Layers: **A** declaration/registry · **B** valid call · **C** negative ·
**D** scope/capability · **E** result boundedness · **F** semantic correctness ·
**G** real-fixture · **H** live-model.
States: `V` verified · `M` manual-required · `n/a` not applicable · **FAIL**.

| layer | V | M | n/a | FAIL |
|---|---|---|---|---|
| A declaration | 36 | — | — | — |
| B valid call | 30 | 6 | — | — |
| C negative | 36 | — | — | — |
| D scope/capability | 36 | — | — | — |
| E result ceiling | 36 | — | — | — |
| **F semantic** | **10** | **24** | — | **2** |
| G real fixture | 30 | 6 | — | — |
| H live model | 10 | 21 | 5 | — |

**A, C, D and E hold for all 36 by construction, not by diligence** — the suites
that establish them parametrise over `all_tools()`:
`test_agent_tool_registry.py`, `test_tool_output_contract.py`,
`test_tool_authorization_metadata.py` (A); `test_tool_argument_contract.py` (C);
`test_tool_capability_gates.py` (D). **E is a mechanism test**, not a per-tool
one: `test_tool_result_ceiling.py` drives synthetic oversized payloads through
the trimmer, which covers the ceiling for every tool that returns through it and
covers no tool's own payload size. That distinction is why E is not evidence
about any individual tool's output volume.

**B / G MANUAL (6):** `web_search`, `research_web`, `fetch_url`,
`browse_ai_answer`, `benchmark_compare` — they leave AppBI, so a deterministic
valid call is not this suite's job; and `read_document`, which needs a governed
document attached to the fixture report.

**H `n/a` (5)** is the external pack only, whose live behaviour depends on a third
party. The other 21 are **MANUAL_REQUIRED, deliberately not `n/a`**: those tools
can be driven by a model, the 18 live scenarios simply never granted or reached
them. Filing missing coverage as a property of the tool is exactly the implicit
UNTESTED state this matrix exists to prevent.

**F is the honest gap.** 24 tools returned a well-formed result of the right
`result_kind` on real data and have **no known-answer oracle**. They are not
green; they are `MANUAL_REQUIRED` with that reason recorded per tool in
`matrix.json`.

Per-tool table: `.artifacts/cert/matrix_table.md` (36 rows, same states).

## 4. Deterministic valid-call results

One producer-backed fixture, not mocks: **dashboard 67 "Olist E-Commerce"**, 70
real charts — categorical (686), geographical (687, 701), monthly (684) and
quarterly (696) time axes, KPI scalars, a share-shaped donut (685), a
target-shaped percentage (683), a knowledge document (25), and a known-empty
out-of-scope id. Every call went through `registry.execute()` with a real
`ToolContext.from_dashboard`.

**30 of 30 exercisable tools returned `ok=True`. That is not the finding.** Ten
were checked against a known answer:

| tool | property checked | result |
|---|---|---|
| `rank_values` | top item `health_beauty` = 1,258,681.34, `group_count` 72 | V |
| `total_measure` | grand total 13,591,643.70, `rows_counted` 72, aggregation named | V |
| `share_of` | numerator/denominator agrees with `total_measure` (9.26%) to 0.05pp | V |
| `describe_time_coverage` | exact range 2016-09-01 → 2018-10-01, grain month | V |
| `get_chart_data` | 5 of 72 returned, `truncated: true`, and the note forbids a highest/lowest claim | V |
| `compare_segments` | the dimension compared is the dimension requested | V |
| `compare_to_target` | actual 91.8873 vs caller target 90, attainment 102.1% | V |
| `analyze_trend` | excludes edge periods; refuses a chart with no time axis | V |
| `forecast_measure` | refuses a chart with no time axis | V |
| `read_document` | refuses a document not attached to this report | V |
| **`compare_periods`** | partial final period treated as a real latest period | **FAIL — see §5 D1** |
| **`detect_seasonality`** | accepts a categorical column as its `time_dimension` | **FAIL — F2 below** |

Negatives, all correct: out-of-scope chart id → `chart_out_of_scope` on all four
tools tried; the call-time allowlist → `not_granted`; an unattached document →
`not_granted` naming the rule; a dimension the chart does not have → refused by
both `rank_values` and `compare_segments`.

**F2 — `detect_seasonality` calls a product category a time dimension.**
Asked for seasonality on chart 686 it returns `ok=True` with
`"time_dimension": "dataset_table_445.product_category_name_english"` and tests
cycles of 4, 7 and 12 "periods" over what is alphabetical order. Its three
siblings refuse the same chart with an explicit reason. The contract is therefore
already settled inside its own pack, which is what makes this unambiguous enough
to lock: `backend/tests/test_time_axis_contract.py` fails on it today, with two
controls — the siblings still refuse, and seasonality still works on a real time
axis — so the lock cannot be satisfied by loosening the pack.

## 5. D1–D5 — verdict on current HEAD

Each re-run on this SHA. None fixed here.

| # | verdict | evidence |
|---|---|---|
| **D1** partial final period | **REPRODUCED** | `compare_periods` on chart 684, in **every** mode (default, auto, mom, yoy): `current = 2018-09 (166.46)` against `baseline = 2018-08 (1,003,308.47)` → `pct_change -99.98`, `verdict "worsening"`. `analyze_trend` on the SAME chart excludes edge periods (`excluded_periods[].edge`). The fix exists in one tool and not in its sibling. Reaches the reader: the live `compare` and `trend` answers both state "-99.98% … xu hướng xấu đi". |
| **D2** state answered with product category | **REPRODUCED** | Live scenario `out_of_scope_measure`, question "Bang nào có doanh thu cao nhất?" (which STATE). Answer: *"Bang có doanh thu cao nhất là **health_beauty**, với doanh thu là **1,258,681.34**"* — a product category named as a state, with a figure, no caveat, no refusal. Trace shows `rank_values` on the category chart after three `resolve_chart_candidates` calls. |
| **D3** no capability → unrelated summary | **REPRODUCED** (and separately CHANGED) | `web_denied` ("look up Vietnam's GDP", web withheld): instead of declining it summarised unrelated overview data — AOV 137.75, GMV 15,843,553.24, category revenue 13,591,643.7. That is the original D3 exactly. Separately, `trend` (no trend tool granted) no longer summarises overview data — it substitutes `compare_periods` and inherits D1's framing, which is a **changed failure**, not a fix. `forecast` declined honestly. |
| **D4** scalar without period provenance | **CHANGED FAILURE** | `total_measure` now carries `rows_counted`, `aggregation`, `filters_applied` and an explicit `unit_note`, and the live `total` answer did not attach an all-time figure to a month. But the same family recurs: `no_data` claimed coverage "từ tháng 9 năm 2016 đến tháng 2 năm 2017" and `out_of_scope_chart` claimed "… đến 1 tháng 9 năm 2018", both wrong (real: 2016-09-01 → 2018-10-01) — invented from truncated chart summaries instead of `describe_time_coverage`. And in `rows` the model printed `$72,530.47` while the tool's own payload says *"Unit is NOT declared … do NOT attach a currency"*. |
| **D5** non-recoverable error retried to exhaustion | **REPRODUCED** | Tool-pressure run, 3-tool grant without a discovery tool: `rank_values(chart_out_of_scope)` ×6 until "đã dùng hết số lượt gọi mô hình", status `failed`, on 2 of 3 questions. `chart_out_of_scope` can never become valid by retrying. The eval's own `budget` scenario retried `compare_periods(query_failed)` only twice and completed, which is why a single scenario reads as fixed — it is not. |

## 6. Live-model results

18 scenarios through `backend/scripts/agent_flow_eval.py` against link 39 /
`revenue_v2`, which is the flow a real link serves.

**Deterministic layer — 18/18 pass.** No scope violation, no ungranted or
withheld tool called, no budget breach, no untraceable figure, no raw-row leak,
no unauthorised external call. `web_denied` made no web call. `out_of_scope_chart`
produced `get_chart_data(chart_out_of_scope)` and stopped.

**Answer-quality layer — adjudicated, not word-matched.**

| pass | scenario | why |
|---|---|---|
| ✅ | `ranking`, `total`, `share` | right figure, right scope, traceable to a tool |
| ✅ | `rows` | said "5/72 hàng" rather than implying completeness |
| ✅ | `out_of_scope_chart` | refused chart 720 by name |
| ✅ | `off_topic` | declined; no figures |
| ✅ | `forecast` | declined for want of a forecast capability |
| ✅ | `coverage`, `multi_step`, `truncated` | correct and bounded |
| ❌ | `out_of_scope_measure` | **D2** — a category presented as a state |
| ❌ | `compare`, `trend` | **D1** — a partial period reported as a collapse |
| ❌ | `web_denied` | **D3** — unrelated overview instead of a decline |
| ❌ | `no_data` | wrong coverage window stated as fact |
| ❌ | `rows` | `$` attached to a measure the tool says has no declared unit |
| ⚠ | `ambiguous` | declined, but the answer names an internal function (`list_charts`) to the reader and says "0 biểu đồ có thể đọc được", which is internal vocabulary on a reader surface |

## 7. Tool-choice pressure

Same three questions, same flow shape, three grants. Measured, not assumed.

| grant | tools | answered | calls (median) | prompt tokens |
|---|---|---|---|---|
| narrow, **no discovery tool** | 3 | **1 / 3** | 6 | ~5.2k |
| narrow + discovery | 6 | **3 / 3** | 3 | 5.4k – 13.1k |
| broad | 24 | **3 / 3** | **2** | 13.1k – 14.2k |

**Breadth is not the defect.** The 24-tool grant produced the *fewest* calls and
no wandering; it costs about 2.5× the prompt tokens per turn. The 3-tool grant
had no way to discover a chart id, guessed, and retried `chart_out_of_scope` to
exhaustion — which is D5's mechanism, not a tool-choice effect.

**Do not impose a 6-tool limit.** The old "2–6 tools worked well" observation is
not supported for this catalogue. The evidence points to: a **curated pack/preset
that always includes a discovery tool**, plus a **builder warning when a grant
contains no way to resolve a chart id**. Token cost means "grant everything" is
not free either. No implementation in this session.

## 8. Pointer-drag result

**PASS.** `e2e/tests/pointer-drag.spec.ts` presses the real drag handle, moves
the pointer in six steps over the canvas, drops on a real `[data-drop]` insert
point, then **saves and reloads** — the order survives. Previously only the
keyboard path (`moveNode`) was covered.

One thing the first version of that test got wrong, recorded because it would
mislead the next reader: dropping on a **node card** is a no-op **by design** —
the canvas hit-tests `elementFromPoint(...).closest('[data-drop]')`, so the drop
target is the "+" an author can see. That was a test defect, not a product one.

## 9. Tool-node readability (release UX finding)

**An author cannot tell which tool a Tool node calls without opening the
Inspector.** On a saved draft with three Tool nodes bound to `rank_values`,
`total_measure` and `describe_time_coverage`, the canvas cards are byte-identical
apart from a name the author typed:

    title    "Call a tool"      subtitle  "Call a tool"      (all three)
    aria-label "Call a tool — Call a tool"

Choosing a tool does not change the node's default name (the Step name input
stays empty with the placeholder `Call a tool`). `FlowCanvas.describe()` has a
case for thirteen node types and none for `tool`, so Tool nodes also render no
body line at all while every sibling does. The data is present everywhere else —
run trace, the step's config tab, the Inspector dropdown all show the tool id.

Related: unnamed Tool nodes surface raw node keys to the author elsewhere —
`tool_2`, `tool_3` in the Runs step list and in Activity.

## 10. English author surface — i18n gaps

Verified with `document.documentElement.lang === 'en'`. The shape is consistent:
**wrappers are translated, payloads are not.** The frontend renders
`DIAGNOSTICS FOR YOU (THE VIEWER DOES NOT SEE THESE)` and then fills it with
Vietnamese from the backend.

Two different causes, and they need different remedies:

1. **Backend, by construction.** There is no i18n layer on the backend at all;
   `.claude/rules/backend.md` states the `ValueError` → Vietnamese contract
   deliberately. `contract.py` alone holds ~80 Vietnamese literals. Everything in
   §b below, plus the author diagnostics, the viewer notices, the Activity
   summaries, and all nine question-class labels in `coverage.py` — which also
   surface as the reader-facing capability chips on /chat.
2. **Frontend literals that bypass the catalogue.** `RunsTab.tsx` is the worst
   offender: 36 `t()` calls coexisting with roughly 40 hardcoded Vietnamese
   strings.

Observed rendering in English (not grep-derived): **~45 strings**, of which

- **Runs tab — 19**, 13 of them frontend literals (`Bước đã chọn`, `← Cả run`,
  `Cấu hình` next to English `INPUT`/`OUTPUT`, `Tải JSON cả run`, `chưa có giá`,
  `Vào`/`Ra`/`Model`/`Tool`/`lượt`, `(trống)`, …).
- **Validation — 5**, all backend, including two that render in the **blocking**
  red header banner (`bước công cụ phải chọn một công cụ`; the coordinator
  "KHI NÀO" sentence, which is additionally clipped by `max-w-[200px] truncate`).
  One of them (`Flow này không gắn tri thức nào…`) appears on every brand-new
  flow, so every author meets it immediately.
- **Builder chrome — 15**, including the **entire "Nhờ AI viết giúp" tab of the
  New-flow dialog**, which is 100% Vietnamese: one of the two flow-creation paths
  has no English at all.
- **Test panel — 14**, all backend: the coverage rail renders
  `Tra một con số — no tool granted for it (pack: measure)`, Vietnamese and
  English in one sentence.

Clean in English, checked programmatically: every per-node Inspector pane
(`report_read`, `agent`, `tool`), the add-step palette, canvas chrome, zoom and
minimap, the Feedback tab chrome, the Test panel chrome, and the Runs list chrome.

Behavioural, not a string: asked a question **in English**, the assistant answered
entirely in Vietnamese despite an answer-in-the-viewer's-language rule in the
system prompt.

Not fixed here, by instruction.

## 11. CI / coverage map

| layer | runner | trigger | gate? |
|---|---|---|---|
| A, C, D, E — the 6 generic tool suites | `backend-contract-tests.yml` job `unit` | push on `backend/**` | **yes** |
| `test_tool_node.py`, `test_govern_knowledge_tools.py`, `test_i5_hard_gate_stays_lowest.py` | same | push | **yes** |
| B, F, G — valid-call + semantic on real data | `.artifacts/cert/*_probe.py` | run by hand in the backend container | **no — certification evidence only** |
| `test_time_axis_contract.py` (the F2 lock) | tracked, allow-listed, in the workflow list | push | **SKIPS in CI** — no `dashboards` table in that tier. Local/manual evidence only until the fixture is seeded. See the correction below |
| H — live model | `backend/scripts/agent_flow_eval.py` | by hand, needs a model key | **no — referenced by no workflow** |
| tool-choice pressure | `.artifacts/cert/tool_pressure.py` | by hand, needs a model key | **no** |
| builder journeys, canvas a11y, pointer drag | `e2e.yml` | push on `frontend/**`, `e2e/**`, `backend/**` | **yes** |
| protection layer (`agent_sdlc_meta`, `stop_gate_decision`, `guardrail_diff_range`) | `preflight.yml` | every push | **yes** |
| `change-guardrail.yml`, `semantic-review.yml` | — | `pull_request` only | **NOT COVERED — never executed on this branch.** They will run for the first time when a PR is opened |

**Correction, recorded because CI caught it and this document had it wrong.**
The first version of that lock guarded with `db.get(Dashboard, 67) is None` and
this section claimed it would "run, then skip" in CI. It did neither: CI's unit
tier runs on `sqlite:///./ci_contract.db`, an empty file with no schema, because
that tier deliberately runs no migrations — so the SELECT raised
`OperationalError: no such table: dashboards` before `pytest.skip` was reached,
and three setup ERRORS turned a green tier red on a commit that changed no
product code. "Absent" has two shapes, no such ROW and no such TABLE, and the
guard only knew one. It now checks the table first. The claim in this document
was a prediction presented as a fact, which is the failure mode this whole
exercise exists to catch; it is fixed rather than quietly deleted.

**CI state of the certification commits.** `f38d9a9` — all three workflows green:
Preflight success, backend-contract **both** tiers success (`integration-golden`
ran, including the golden-replay and Explore/Dashboard parity gates), E2E
**58 passed / 0 failed / 0 skipped**. The E2E red on the previous commit was in
"Build and start the frontend" and is settled as transient: the same step passed
here with no frontend file changed between the two, and Preflight ran `npm ci`
and `tsc --noEmit` green on both SHAs.

**And a coverage gap found while reading that verdict, worth more than the
verdict.** The `unit` tier prints its pytest counts only from a step guarded by
`if: failure()`. On a GREEN run no annotation carries them, `output.summary` is
empty, and job logs need admin rights — so a green tier proves "nothing errored"
and proves nothing about **how many tests ran**. An accident that silently
deselected a whole file would read exactly like today's run. That is why the three
skips in `test_time_axis_contract.py` above are stated as INFERRED — from the
step's zero exit plus the fact that every path through the new guard ends in
`pytest.skip` — and not as a number anyone read.

Also on the record: 3 suites CI runs are named by no guardrail gate
(`test_filter_entry_schemas`, `test_non_fanning_reachability`,
`test_workboard_offline_relation_phase2`), and 29 committed backend suites are
referenced by no runner at all. Neither set is Agent Flow.

## 11b. Pre-release closure session — what moved, and two corrections (HISTORICAL / SUPERSEDED)

Certified SHA `97db3f9`; this section covers the fixes made after it.

| item | state | evidence |
|---|---|---|
| **B1** partial final period | **CLOSED** (`6023383`) | `compare_periods` now runs the same `_trim_partial_edges` its sibling `analyze_trend` already used. Real report, before → after: `2018-09 166.46 vs 2018-08 1,003,308.47 = -99.98%` → `2018-08 vs 2018-07 = -5.23%`, with `2018-09` named in `excluded_periods`. YoY -99.98% → +50.15%. 13 deterministic cases, including one asserting the two tools exclude the SAME labels. |
| **B3** categorical-as-time | **CLOSED** (`8428648`) | The cause was a substring match: `nam` (year) sits inside `name`, so `product_category_name_english` read as a time axis. `product_name_lenght` failed identically. Tokens are now bounded to whole segments of the column path. 13 deterministic cases run in the normal unit tier — the previous lock needed dashboard 67 and skipped. |
| **B5** non-recoverable retry | **CLOSED** (`dca4606`) | The agent loop now reads the `retryable` flag the error contract has always carried. A second identical call after a final refusal is answered without reaching the registry, naming the original reason. 19 cases; golden replay byte-identical. |
| B2, B4, B6 | **OPEN** | unchanged; see §12 |

**Correction 1 — the authoring warning was already shipped.** §7 recorded "a
builder warning when a grant contains no way to resolve a chart id" as a product
action to take. It exists: the exact 3-tool grant that failed certification is
flagged today, and the note clears the moment any lookup tool is added. The
certification missed an existing mechanism and proposed rebuilding it.

**Correction 2 — and looking for it found a real defect.** That warning reads a
hand-written `_CHART_KEYED_TOOLS`, deliberately: `contract.py` is the schema layer
and importing the tool registry there would make a flow's shape depend on which
packs are installed. Sound, with one failure mode. A drift test comparing the list
against the registry immediately found `benchmark_compare` absent — a grant of
that tool alone was warned about by nothing. Added, and the lock now names any
future omission.

**Also closed from §12's hardening list:** "test_time_axis_contract does not
exercise its fixture in normal CI" — the contract now has 13 deterministic cases
that run on every push, with the real-dashboard control kept alongside.

## 12. Confirmed release blockers — HISTORICAL / SUPERSEDED

**Superseded by the AUTHORITATIVE CURRENT RELEASE REGISTER at the top of this
document.** Kept because it records how each blocker was first reproduced, which
is the evidence the fixes were later written against. As first recorded on SHA
97db3f9, where none of them was fixed:

1. **B1 — `compare_periods` presents a partial final period as a real latest
   period** (D1). Every mode. Reaches the reader as "-99.98%, worsening". The
   remedy is a product decision — exclude the partial period, or annotate it —
   which is why it carries evidence here and no test that presumes an answer.
2. **B2 — a wrong-dimension question is answered confidently with the wrong
   dimension** (D2). "Which state" → a product category, with a figure, no
   caveat. Worst of the five: it is indistinguishable from a correct answer.
3. **B3 — `detect_seasonality` accepts a categorical column as a time axis**
   (F2). Locked by a failing test; contract already settled by its siblings.
4. **B4 — no relevant capability produces an unrelated summary instead of a
   decline** (D3), on the `web_denied` path.
5. **B5 — a non-recoverable error is retried until the model budget is
   exhausted** (D5), reachable whenever a grant has no discovery tool.

## 13. Non-blocking backlog

- 24 of 36 tools have **no semantic oracle** (matrix layer F). Not a defect; the
  largest known gap in what has been proven.
- 30 of 36 tools have no `output_schema`, so ToolNode wiring is limited to six.
- Coverage/period claims invented from truncated chart summaries (D4 family).
- A currency symbol attached to a measure whose payload says the unit is
  undeclared.
- Internal vocabulary on a reader surface (`list_charts` named in an answer;
  "0 biểu đồ có thể đọc được").
- Tool-node canvas readability (§9) and raw node keys shown to authors.
- ~45 Vietnamese-only author strings in the English UI (§10), including a
  flow-creation tab with no English at all.
- The assistant answered an English question in Vietnamese.
- `test_time_axis_contract.py` skips in CI until dashboard 67 (or an equivalent
  fixture) is seeded there.
- `change-guardrail` and `semantic-review` have never executed on this branch.
- A green `unit` tier reports no test counts anywhere readable (§11), so
  silent deselection of a whole suite is indistinguishable from success.
- `search_knowledge` returns weak vector matches (similarity 0.27) for an
  unrelated query. Scope is correct — every hit was the report's own attached
  document — but relevance is not filtered.

## RELEASE VERDICT — HISTORICAL / SUPERSEDED

**Superseded by “Current verdict” in the register at the top of this document.**
This is the verdict as it stood on SHA 97db3f9, before any of the five was fixed.

    READY_FOR_UAT

Not `READY_FOR_RELEASE`: five confirmed correctness failures are open, two of
them in tools (`compare_periods`, `detect_seasonality`), and D1, D2, D3 and D5
are reproduced rather than resolved.

Not `NOT_READY`: the security and scope surface held under everything thrown at
it. Out-of-scope chart ids, ungranted tools, withheld capabilities and unattached
documents were refused every time; 18 live scenarios produced no scope violation,
no raw-row leak and no unauthorised external call; and certification coverage is
now known per tool rather than assumed — 36/36 entries, with every gap named and
reasoned instead of left implicit.

What UAT must be told: the assistant can state a confidently wrong dimension
(B2), can report a partial period as a collapse (B1), and can summarise unrelated
data instead of declining (B4).
