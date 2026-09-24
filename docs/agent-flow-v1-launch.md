# Agent Flow V1 — launch contract and current state

**This is the single current-truth document for the V1 launch program.** Every V1
session reads it first, verifies the SHA below against git, does its assigned
work, updates this file, commits, pushes, and stops at its boundary.

Historical audit detail lives in `docs/agent-flow-release-certification.md` and is
not repeated here.

---

## CURRENT STATE

| | |
|---|---|
| `V1_BASE_SHA` | `08d15e44b0f38fe79c43528132b7b7453f673d27` (demo, the PR #2 merge) |
| branch | `release/agent-flow-v1-candidate` |
| session A | complete — foundation merged, contract locked, journeys walked |
| session A commit | `736b71a7f4892b7e8b27664b94962827458b2cd6` |
| session B | **P0-1 closed**; P1-1, P1-2, P1-3 carried forward |
| `LAST_PRODUCT_COMMIT` before session B2 | `b7368b5cf680aed80628ce63199617a8e4a6e4d2` |
| session B2 | **author V1 complete** — P1-1, P1-2, P1-3 closed; golden E2E added |
| next | **V1-C** — reader and trust; see the last section |

**How a session records its own SHA.** It does not. A tracked file cannot contain
the id of the commit that contains it, and session B learned that the expensive
way: it wrote a SHA, amended, and had to spend a second commit correcting a
document that named a commit reachable from nothing. So this table records only
`LAST_PRODUCT_COMMIT` — a commit that already existed when the row was written —
and each session's own head is reported in its final message, not pretended here.
The next session does not need it: `git ls-remote origin
release/agent-flow-v1-candidate` is the authority on where the branch is, and this
file is then read at that commit.

PR #2 merged the platform foundation. Verified by content on demo, not by the
merge message: canonical time semantics, Product gate, Product gate
root-of-trust, Live Agent Eval provenance, exact-SHA protection approval, CI
green-run accounting.

---

## V1 PRODUCT CONTRACT

**Primary user.** A Vietnamese BI/report owner, analyst or operations person.
Comfortable with dashboards and business questions. **Not** expected to know what
a tool registry, a node key or a result envelope is.

**Core job.** Build and publish a governed BI assistant that answers questions
grounded in an authorised report, and inspect it when a run goes wrong.

**Author journey.** Agent Flows list → create a flow → configure the steps →
validate → test against a real report → save draft → publish a version → make it
reachable by readers → inspect Runs → reopen and edit → republish.

**Reader journey.** Open a published report surface → ask a BI question → get a
grounded answer or an honest refusal → see what it used → never see author or
debug internals.

### Included in V1

Agent Flows list · create/edit a flow · the Agent node with governed BI tools ·
validation · Test panel against a real report · save draft · publish and version ·
run history with per-step detail · reopen and edit after a run · report-grounded
Q&A · the dashboard/public reader surfaces the product already exposes · honest
refusal · lightweight feedback on an answer · operational diagnostics.

### Excluded from V1

Subflows · reusable Specialists · parallel fan-out · durable background execution ·
human-in-the-loop side effects · agentic flow builder · MCP/plugin ecosystem ·
template marketplace · deterministic composition across all tools · full bilingual
author UI · Knowledge as a headline feature.

### Definition of done

A pilot author who has never seen Agent Flow reaches a published, working flow
that a reader can actually ask questions of — without a developer, and without
reading documentation outside the product.

---

## SCOPE DECISIONS

**Language: Vietnamese-first.** English remains where it already works and is not
advertised as complete. The product must not *claim* bilingual support while the
launch journey is mixed. This is currently violated in one place — see P1-3.

**Knowledge: not a core V1 promise.** It must not be required by the starter path.
Inspected on the default binding: the `revenue_v2` flow that serves the pilot
public link reads the report only; it does not invoke Knowledge automatically.
No retrieval expansion in V1.

**ToolNode: not the centre of V1.** Existing deterministic use stays available. No
pursuit of 36/36 `output_schema`. But a Tool node that is visible must show what
it does — see P1-2.

**Wave 3: excluded entirely.**

---

## AUTHOR GOLDEN JOURNEY — observed

Walked in the real UI on `V1_BASE_SHA`, logged in as a normal author. Rows
marked **(B)** / **(B2)** were re-walked after that session's change, in the
running build, locale `vi`, at 1280×800 and 1440×900.

| step | result | evidence |
|---|---|---|
| login | **PASS** | redirects to the requested page |
| Agent Flows list | **PASS** | stats, filters, one-line explainer, per-flow status and step count |
| create a flow | **PASS** (B2) | `Trợ lý BI cho báo cáo` offered first and selected; the dialog names the three steps it will build; one language |
| first screen after create | **PASS** (B2) | a three-step flow that is already valid, with the activation strip saying what is left to do |
| configure steps | **PASS** | inspector is complete; node palette carries 14 types with plain-language descriptions |
| Tool node identity | **PASS** (B2) | `Tổng của một chỉ số / Gọi công cụ` + what the tool does; an unchosen tool reads `Chưa chọn công cụ.` |
| report/context binding | **PASS** (B) | activation strip + CTA to the surface that owns the binding |
| validation | **PASS** | substantive and actionable; server enforces the same rule the UI states |
| Test panel | **PASS** | picks a real report, runs, logs to Runs, marked as a test. Re-walked on the starter in B2: a supported question answered `10,748,221.50` and named its chart; `GDP của Việt Nam` was refused and the refusal listed what the report does cover |
| save draft | **PASS** | `Unsaved` clears; a genuinely invalid flow is refused by the server with a readable reason |
| publish | **PASS** | `Draft v1` → `Running v1` in the header |
| hard reload | **PASS** | version, steps, validity and tool selection all survive |
| execute / chat | **PASS** | via the Test panel and via a bound public link |
| Runs tab | **PASS** | counts, p95, tokens, errors; filters by outcome and by test-vs-viewer |
| inspect a step | **PASS** | the run opens onto the builder canvas with the route taken overlaid |
| reopen and edit | **PASS** | |
| republish | **PASS** | version increments |

Switch, Loop, Coordinator and Filter render correctly with their configuration
visible on the canvas. They are **advanced** blocks, not required by the starter
path, and are left as-is for V1.

---

## READER GOLDEN JOURNEY — observed

Walked unauthenticated on `/d/{token}` against the `revenue_v2` flow.

| check | result |
|---|---|
| wrong-dimension question | **PASS** — honest refusal; no product category presented as a state |
| reader notice | **PASS** — names the dimension by its business label (`Customer state`) |
| identifier leakage | **PASS** — zero tool ids, chart ids, column names anywhere on the page |
| unit provenance | **PASS** — flagged that the answer said `USD` while the data did not establish it |
| figure verification | **PASS** — flagged two figures that did not trace to what was read |
| citations | **PASS** — render the chart title, not an id |
| public scope | **PASS** — only `/api/v1/public/<token>/…`; authed endpoints 401; unknown token 404 |
| notice density | **CONFUSING** — see P1-4 |

---

## P0 / P1 LAUNCH WORK

### P0-1 — publish → live — **CLOSED** (session B)

**What was wrong.** The builder acknowledged the binding only as the text
`· 1 link` — not a link, not a button, hidden below 2xl. An author who had just
published had no way to learn they were one step short of a working product, or
where that step lives.

**What it now does.** A state strip sits under the builder header on report
flows, with three truthful states:

| state | shown |
|---|---|
| draft, never published | *Chưa xuất bản. Xuất bản trước khi gắn vào báo cáo.* |
| published, unattached | *Đã xuất bản · Chưa dùng trên báo cáo nào. Người xem chưa gặp được trợ lý này.* + **Gắn vào báo cáo** → `/dashboards` |
| attached | *Đang chạy trên N báo cáo* · the report's own name + **Mở báo cáo** → `/dashboards/{id}` |

Two qualifiers are added only because the backend can prove them: `đã gắn,
nhưng link hoặc trợ lý đang tắt` when `link_active` or `bot_enabled` is off, and
`bản nháp mới hơn bản đang chạy` when the draft has moved past the published
version. A flow bound to a switched-off link is neither live nor unattached, and
calling it live would be the kind of confident wrong answer this product exists
to avoid.

**No second binding system.** The dashboard's public link stays the source of
truth. The strip reads `GET /brains/{key}/impact`, which the builder already
fetched and then rendered as a word count, and routes the author to the surface
that owns the decision. It creates nothing and mutates nothing, so it cannot
drift from the real state and cannot be used to get round the permission checks
on that path.

**Observed.** Bound flow: `live` · `Olist Public` · CTA → `/dashboards/67`.
Unattached published flow: `attention` · CTA → `/dashboards`. Verified in the
running build at 1920 and 1280 with no horizontal overflow. No link id, binding
id or version id appears as a product label.

### P1-1 — first-success path — **CLOSED** (session B2)

**What was wrong.** `New flow` offered exactly two routes. *Tự dựng* created a
two-step flow with no guidance. *Nhờ AI viết giúp* asked the author to copy a
system description, paste it into ChatGPT or Claude, and paste JSON back. A
non-technical pilot author either stared at a canvas or left the product.

**What it now does.** A third route, **`Trợ lý BI cho báo cáo`**, is first in the
list and selected by default. The dialog states what will exist before it exists —
the three steps, by name — and that nothing else has to be configured. The other
two routes are untouched; the change is the hierarchy.

**The starter.** `starterFlow()` in `lib/agentFlows.ts`, saved through the same
`saveBrain` the blank path uses. It is a body, not a second creation mechanism:
from the first second it is an ordinary flow.

| step | why |
|---|---|
| `report_read` → `{{bao_cao}}`, `detail: 'index'` | the index of what the report holds — id, name, what each chart measures — with no rows. The contract documents this pairing: rows bought nothing when the next step can compute over all of them on demand |
| `agent` *Tìm số liệu*, 10 tools | find the chart, establish scope, measure |
| `agent` *Trả lời người xem*, **no tools** | writes the answer from figures that already passed through a step where they could be checked |

**Three steps, not two, and the reason is the product's own review.** A single
agent that both fetches and answers raises *"Bước trả lời … vẫn có công cụ"*.
Shipping the recommended starting shape with a standing review note is how authors
learn that notes are noise, so the shape was changed rather than the note. Measured
against `Flow.warnings('bot')`: the two-step shape raises two notes, this one
raises one — *"Flow này không gắn tri thức nào"*, which every report bot raises,
whose own text says the design is correct, and which cannot be removed without
making Knowledge a V1 dependency. Cost of the split: one model call per question.

**`match_question` is off, and that was found by running it.** With question
matching on, `tổng doanh thu` matched no chart on a real sales report, so the read
step handed over nothing and the author saw a confident answer beside the
diagnosis *"báo cáo này không có dữ liệu cho câu hỏi đó"*. The dimension truth
question mode was protecting is not lost: it lives in `resolve_chart_candidates`
and the dimension gate on `get_chart_data`, both granted here and both enforced
per tool call.

**What it does not grant.** Nothing from `external` (gated on
`web_search_enabled`), nothing from `knowledge` (not a V1 promise, and it would
make the starter depend on an attachment nobody has made), and not `list_charts`,
whose result scales with the report. `frontend/scripts/check-starter-grants.mjs`
enforces this against the registry on every `npm run qa`: a granted tool that no
pack declares, a granted tool from a gated pack, or tools on the answering step
each fail the build. Proven by mutation.

**No customer in it.** No dashboard id, no report name, no measure name, no
account. A bot flow is handed whichever report its link is showing.

### P1-2 — a Tool node says which tool — **CLOSED** (session B2)

**What was wrong.** With `total_measure` selected the canvas card read
`Call a tool / Call a tool`, and a flow with four Tool steps drew four
indistinguishable cards. `FlowCanvas` is handed `specs`, keyed by NODE TYPE; the
tool catalogue was not among them, and the Tool case in `describe()` did not
exist, so the body line was empty too.

**What it now does.** `BrainBuilder` passes the tool catalogue it already fetched
for the inspector into the canvas, and the card renders through the same
`toolLabel` the picker uses. Identity precedence: the author's own step name, then
the tool's product label, then the node-type label, then the raw key.

Observed in the running build: `Tổng của một chỉ số / Gọi công cụ / Cộng chỉ số
trên TOÀN BỘ dòng, kèm trung bình/nhỏ nhất/lớn nhất.` — `aria-label`
`"Tổng của một chỉ số — Gọi công cụ"`. A step with no tool chosen reads
`Chưa chọn công cụ.` and is not dressed up as configured; it cannot be saved at
all — the server refuses it — so the state exists only while the author is still
choosing.

**No second label map.** The registry stays the one source; a map in the canvas
would drift from the panel beside it the first time a tool was renamed. The same
`toolLabel` now names an unnamed Tool step in the Runs trace, read from the tool
the run recorded — no stored run is rewritten.

**Locked by mutation.** Removing the catalogue from the canvas reproduces the
original defect exactly: `["Call a tool — Call a tool", ×3]`.

### P1-3 — Vietnamese-first first-run — **CLOSED** (session B2)

**What was wrong.** The create dialog mixed hardcoded Vietnamese literals with
translated strings, so neither locale was internally consistent: `Tự dựng` and
`Nhờ AI viết giúp` sat beside `Flow name*`, `What is this flow for?` and
`Create and open`.

**What it now does.** Every literal on the first-success path goes through the
existing catalogue — the create dialog including its assisted-authoring branch,
the flow-opening states in `AgentFlowsPage`, and two strings in the Runs step
panel. No second translation mechanism; `en` and `vi` remain key-for-key equal.

**Scope held.** Not a repo-wide translation, not English author parity, not
backend i18n. Debug output, JSON field names, registry ids and raw traces stay as
they are.

**Observed at 1280×800 and 1440×900, locale `vi`.** Create dialog, builder chrome,
canvas cards, validity badge, activation strip and Test panel all Vietnamese, no
horizontal overflow, no zero-sized control.

### P1-4 — the reader sees a wall of caveats

**Evidence.** One answer carried three stacked notices (staleness, unit not
established, two unmatched figures) above the text, under a header reading
`Read 3 steps · 3 errors · view details`. Each notice is individually true and
each guards a different thing. `3 errors` describes refusals that were correct.

**Acceptance.** A reader can tell at a glance whether to trust the answer. Reduce
by hierarchy, not by removing a guarantee.

**Session.** V1-C.

### P1-5 — the deployment cannot say which commit it is

**Evidence.** `/api/v1/health` returns `git_sha: unknown`. The plumbing exists —
`run.sh` resolves `HEAD` and `docker-compose.yml` forwards `GIT_SHA` — but the
running container predates it, and a caller invoking `docker compose` directly
must supply the variable itself.

**Acceptance.** A pilot deployment reports its commit, and the runbook says how to
verify it.

**Session.** V1-C.

---

## P2 — deferred, recorded not queued

36/36 `output_schema` · broad deterministic ToolNode composition · full English
author parity · wider reader-vocabulary sweep · Knowledge retrieval hardening ·
`ai_feedback` (a second, unused feedback table) · visual polish.

---

## FEEDBACK AND TELEMETRY INVENTORY

**It exists and is durable.** No new platform is needed.

`agent_flow_runs` already carries, per run: `brain_key`, `version`, `binding_id`,
`link_token`, `dashboard_id`, `session_key`, `status`, `trigger`, `is_test`,
`latency_ms`, `llm_calls`, `tool_calls`, token counts, `usd`, `blocked_reason`,
`missing_requirements`, `question_norm`, **`rating`**, `created_at`,
`chat_thread_id`. `agent_flow_run_steps` and `agent_flow_run_content` hold the
per-step detail.

Current data on this environment: **692 runs — 524 ok, 104 partial, 36 failed, 32
blocked**; 262 of them reader runs rather than tests; 31 saved flow versions.

| funnel question | answerable today? |
|---|---|
| flows created / saved | yes — `agent_brain_versions` |
| flow published | yes — version rows and run `version` |
| validation failed | partly — server refusals are not counted as an event |
| run started / ok / partial / failed / blocked | **yes** — `status` |
| where failures concentrate | **yes** — `blocked_reason`, `missing_requirements`, run steps |
| reader question vs test | **yes** — `is_test`, `link_token` |
| answered vs refused | partly — `status` plus notices; no single refusal flag |
| feedback positive / negative | **yes** — `rating`, but only **2 of 692 runs are rated** |
| which users returned | yes — `session_key`, chat threads |

**The gap is adoption, not storage.** `ai_feedback` is a separate older table with
**0 rows** and is not on the reader path; treat it as P2, not as the mechanism.

V1-C should write the funnel as documented queries over these tables rather than
adding duplicate tracking.

---

## OPERATIONS INVENTORY

| | state |
|---|---|
| health endpoint | `/api/v1/health` — status, `git_sha`, `code_version`, feature flags |
| deployed SHA | plumbed in `run.sh` and `docker-compose.yml`; **reports `unknown` on the running container** (P1-5) |
| launch path | `run.sh`, with `run.ps1` as a thin wrapper — one implementation |
| DB persistence | Postgres in compose with a named volume; runs, versions and feedback survive restart |
| migrations | alembic, single head, applied by the backend entrypoint |
| restart | `docker compose up -d <service>` |
| rollback | **not documented** — and application rollback must be separated from migration rollback |
| runbook | **does not exist** |

V1-C: one concise operator runbook — deploy, verify the deployed SHA, smoke, read
logs, restart, roll back — and no automatic migration rollback.

---

## ACCEPTANCE TESTS

`e2e/tests/agent-flow-v1-author-golden.spec.ts` is the launch gate for the author
half, added in session B2. It walks the journey rather than the parts: New flow →
the starter is offered first and selected → the dialog says what it will build →
create → the saved body is the three-step shape, with no customer, no tools on the
answering step and nothing gated granted → validates with no further setup → Test
panel opens → edit → save → **hard reload** → the change survives → publish →
the activation strip turns `attention` and its CTA points at `/dashboards` →
a Tool step is named by its tool and an unconfigured one says so → a run is
inspectable and *Open in builder* returns to the canvas.

It spends nothing on a model: the run it inspects comes from a deterministic
`set_var`/`tool` flow through the same test endpoint the Test tab uses. It is
picked up automatically by `npx playwright test` in `e2e.yml`.

**Suite result on this branch: 64 passed, 0 failed, 0 skipped.**

Still to come in V1-C: the reader half — ask → answer or refusal → citation → no
internals; feedback submit → durable.

---

## KNOWN V1 LIMITATIONS

Vietnamese-first, not bilingual · Knowledge is advanced, not a promise · no
deterministic chaining guarantee across tools · Switch/Loop/Coordinator are
advanced blocks · Live Agent Eval is implemented but has never run against a
configured deployment.

---

## NEXT SESSION — V1-C

Start from `release/agent-flow-v1-candidate`. Read `git ls-remote` for its head,
then read this file at that commit.

**The author half of V1 is complete.** P0-1, P1-1, P1-2 and P1-3 are closed, the
golden journey was walked in the running build in Vietnamese at 1280×800 and
1440×900, and the golden E2E locks it. Do not reopen any of it without a
reproduced regression.

V1-C is the reader and trust half, and nothing else:

1. **P1-4** — notice density. One answer carried three stacked notices under a
   header reading `Read 3 steps · 3 errors`, where the `errors` were correct
   refusals. Reduce by hierarchy, never by removing a guarantee.
2. **Reader/public trust** — the `/d` and `/embed` surfaces against the starter,
   not only against `revenue_v2`.
3. **Feedback adoption** — `rating` exists and is durable; 2 of 692 runs are
   rated. The gap is adoption, not storage.
4. **Pilot funnel** — documented queries over `agent_flow_runs`, not new tracking.
5. **Knowledge V1 boundary** — state it; do not build it.

V1-D keeps: P1-5 deployed health SHA, operations, persistence, rollback, release
freeze, and the final V1 PR.

**One thing worth knowing before touching the starter.** Its read step is
`detail: 'index'` with `match_question` OFF, and both are load-bearing. Measured on
one report, one question, through the Test panel: question matching on, `compact`
elsewhere → 16,774 tokens, 8 model turns, 9 tool calls, and a confident answer
printed next to the diagnosis *"báo cáo này không có dữ liệu cho câu hỏi đó"* plus
two figures the verifier could not trace. Index + no question matching → the same
figure, **7,194 tokens, 3 model turns, 2 tool calls**, the source chart named, and
no diagnostics at all.
