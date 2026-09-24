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
| `LAST_PRODUCT_COMMIT` before session C | `e7db7207aa1646d1bbfb8d5e42caaef15bd53f46` |
| session C | **launch closure** — P1-4 and P1-5 closed at the root; reader golden E2E, feedback verified, pilot funnel, operator runbook |
| next | **push, then independent review.** The candidate is code-complete and verified locally; the push is blocked on git credentials (see HANDOFF). |

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
| report/context binding | **PASS** (B2) | walked end to end through product behaviour, nothing seeded: strip `attention` → CTA → `/dashboards` → Public links → AI Bot tab → enable → pick the flow → grant charts → preflight → *Gán flow vào link* → back in the builder, `live` · `AI design parity check`. One gap fixed on the way: the list view had no Public-links control at all (grid 20, list 0), so the CTA could land on a page with no way to act |
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

**One surface deliberately left alone.** The activation CTA hands the author to
the Dashboards module, whose own list, share dialog and public-link manager are
largely English regardless of locale. That is a different catalogue and a far
wider surface than the V1 author journey, and translating it is the English/VI
parity project V1 policy defers. Recorded, not started.

**Observed at 1280×800 and 1440×900, locale `vi`.** Create dialog, builder chrome,
canvas cards, validity badge, activation strip and Test panel all Vietnamese, no
horizontal overflow, no zero-sized control.

### P1-4 — reader notices — **CLOSED** (session C)

**What was wrong, and where it really was.** A correct answer carried
`Đã đọc 3 bước · 3 lỗi · xem chi tiết`. None of the three was a failure.

The count came from `DashboardAiBot`'s status line, which read
`l.ok === false || l.error`. `ok` is a TRANSPORT fact — the call returned no
payload — and says nothing about whether anything went wrong. So a link
correctly withholding an out-of-scope chart, a tool correctly declining a chart
with no date axis, and a warehouse that actually fell over were counted
identically. A product that reports its own governance working as three failures
teaches readers not to trust it, which is the opposite of what every guard in
this module is for.

**The classification was never missing.** `ErrorCode` in `tools/result.py`
already separates `chart_out_of_scope` / `not_granted` / `gated` / `no_data` /
`not_applicable` / `dimension_mismatch` from `query_failed` / `internal` /
`unknown_tool` — `no_data` even carries the comment *"ran fine, found nothing —
NOT an error to hide"*. And `reader_diagnostics.reader_error` was already
translating that same code into the sentence the viewer reads. The severity was
dropped one layer before the only consumer that needed it.

**Fixed at the boundary, not on the page.**

| layer | change |
|---|---|
| `reader_diagnostics.reader_outcome()` | the canonical `error_code` → `notice` / `limitation` / `error` map, beside the function that already owns the reader's translation of the same code |
| `wire.py` `tool_result` | carries `outcome` next to the unchanged `ok`. This is the ONE SSE format behind `/d`, `/embed` and Direct Chat, so one change serves all three |
| `lib/notices.ts` `tallyStatus()` | counts by meaning and deduplicates by `outcome + reader sentence`, so three refusals of three charts for the same reason are one thing to a reader |
| `DashboardAiBot` status line | reads the tally; a limitation gets a neutral icon and its own wording, never a red triangle over a sentence that says "this is outside what the link shares" |

An unrecognised code maps to `error` deliberately. This module says less when
unsure about TEXT; severity fails the other way, because quietly downgrading an
unknown failure would hide real breakage.

**Observed on the public reader, logged out.** Same question, same report, before
and after: `Đã đọc 1 bước · 1 lỗi` → `Đã đọc 1 bước · 1 giới hạn dữ liệu`. The
author's trace keeps the full technical message.

**Locked by** `backend/tests/test_reader_outcome_is_not_ok_flag.py` — the three
classes, the fail-closed default, that the wire carries it, and that `ok` keeps
its old meaning.

### P1-5 — the deployment can say which commit it is — **CLOSED** (session C)

**What was wrong.** `/api/v1/health` returned `git_sha: "unknown"`. The commit
was injected at RUN time from the host's working copy by one launch wrapper, so
an image moved to another machine, a `docker compose up` typed by hand, or a
restart on a box without the repo all produced a running service that could not
say what it was. That is the thing that makes a rollback unknowable.

**Fixed by giving the artifact its own identity.** `APPBI_BUILD_SHA` is baked
into the backend image at build time (`ARG` → `ENV`, last layer, no cache cost),
compose passes `GIT_SHA` as that build arg, and `main.py` consults it AFTER the
explicit run-time values — so a deployment that knows its own identity still
wins, and `ok`-path behaviour for anyone setting `GIT_SHA` is unchanged.

**Proven, not reasoned.** Rebuilt, then started with `env -u GIT_SHA docker
compose up -d backend` — the exact invocation that used to yield `"unknown"` —
and health reported `e7db7207aa1646d1bbfb8d5e42caaef15bd53f46`, matching
`git rev-parse HEAD`.

---

## OPERATIONS — verified by doing it

| | state |
|---|---|
| health SHA | **correct on a fresh start with nothing exported** (P1-5) |
| deploy path | `./run.sh`; exits non-zero if any service is unhealthy |
| destructive commands on the normal path | **none** — `--down` is `docker compose down` with no `-v`, and no supported path drops the database |
| restart persistence | **verified**: draft versions, published versions, active bindings, runs and a reader's rating all read back unchanged after `docker compose restart` |
| migrations | alembic, applied at the entrypoint, **single head** (`20260914_0002`) |
| migration rollback | **not automatic and not promised.** Application rollback is safe across additive migrations; a drop or rename needs a decision, not a command |
| logs and support | `docs/ops-runbook.md` — user complaint → run row → flow version → deployed SHA, using records the product already keeps |
| pilot funnel | `scripts/ops/pilot_funnel.sql`, read-only, run through the db service |
| runbook | `docs/ops-runbook.md` |

**One operability fact worth knowing.** `entrypoint.sh` derives `DATABASE_URL`
from the `DB_*` variables and exports it into the server process only, so a shell
opened with `docker exec` sees an empty `DATABASE_URL` and any Python importing
`app.core` dies on `create_engine('')`. Backend tooling either runs through the
entrypoint or is handed a URL. The funnel avoids the question by talking to the
database service directly. Recorded rather than changed: the derivation has one
home today, and giving it a second one at freeze time would be the duplication
this document keeps warning about.

---

## P2 — deferred, recorded not queued

36/36 `output_schema` · broad deterministic ToolNode composition · full English
author parity · wider reader-vocabulary sweep · Knowledge retrieval hardening ·
`ai_feedback` (a second, unused feedback table) · visual polish.

---

## FEEDBACK AND PILOT OBSERVABILITY — closed (session C)

**No new platform was built, and none was needed.** `agent_flow_runs` already
carries everything per run: `brain_key`, `version`, `binding_id`, `link_token`,
`dashboard_id`, `session_key`, `status`, `trigger`, `is_test`, `latency_ms`,
`llm_calls`, `tool_calls`, token counts, `usd`, `blocked_reason`,
`missing_requirements`, `question_norm`, **`rating`**, `created_at`,
`chat_thread_id`.

### The reader's thumb, and the bug that was swallowing it

The affordance was never missing: *Đánh giá tốt* / *Đánh giá chưa tốt* sit under
every answer, on the public link, with no sign-in. What was missing was the
second half of the trip.

A rating arrives inside the session blob and `runs.apply_rating` attaches it to
the run by matching the answer TEXT within the caller's own session — narrow on
purpose, because it means a public page can only rate words the server produced.
The server stored `Answer.plain_text()`. The browser, holding only `blocks`,
rebuilt the text with `blocksToText` — a second implementation of the same
rendering, and **it dropped metric blocks**. So every KPI-shaped answer, the
common case and the one with figures in it, produced two different strings, the
match found nothing, and the thumb was recorded in a JSON column nobody reads and
absent from the one an operator opens.

Reproduced on a public link before it was fixed: the answer rated in the UI, the
run row unrated in the database.

**Fixed by publishing, not by synchronising.** `Answer.text` is that same
`plain_text()`, serialised, so the client quotes the server instead of guessing.
One rendering again. Additive — `blocks` is untouched.

Locked by `test_answer_text_is_published_not_rederived.py` (including that the
frontend actually prefers it — a cross-language pair no type checker spans) and
`test_reader_rating_reaches_the_run.py` (the matcher's real contract: attaches
within the session, refuses text the server never produced, never raises into the
save it arrives inside).

**Verified end to end, logged out, on a public link**: the thumb pressed, the run
row rated, and the rating visible in the funnel's feedback line.

### The public trust boundary, closed after independent review (session D)

Two root issues were found in the path above and are closed.

**The run match had no link scope.** `runs.apply_rating` matched session key +
exact stored answer. Session keys are client-chosen, so a caller on link X could
reach a run served on link Y by reusing a key. It now also requires the run's
`link_token` to equal the link the caller is on, and returns whether it attached
— the only verified result a caller may act on.

**A public rating also rewrote institutional Knowledge — from the client's text,
fuzzily, on every save.** The same endpoint called
`dashboard_ai_bot.knowledge.apply_feedback` with the CLIENT-POSTED content,
matching knowledge rows by 50% token overlap and able to promote, penalise,
count contradictions and retire. It trusted the payload, it was fuzzy, and it
replayed: the session is saved as a whole snapshot after every turn, so one thumb
was re-applied on every later save. Anyone could retire a validated fact by
posting overlapping text with "down" a few times.

**V1 policy: that coupling is severed.** A public rating now changes exactly one
thing — `agent_flow_runs.rating` on the verified run — which is what the Runs
tab, the Feedback tab and the funnel read. The write is a value, not an
increment, so replaying a snapshot is idempotent. Knowledge is advanced and not a
V1 promise; learning from reader verdicts, if it returns, needs provenance to a
run and exactly-once transitions, not a re-read of the transcript.

Locked by `test_reader_rating_reaches_the_run.py` (now against a real database,
including the cross-link case) and `test_public_rating_trust_boundary.py` (the
endpoint itself, with spies: forged text and five replayed saves reach
Knowledge zero times). Both were run red against the previous code first.

### The funnel

`scripts/ops/pilot_funnel.sql` — read-only, bounded, three tables, no reader
content. It answers: flows created and published · bindings by status · reports
with an assistant · runs by outcome · author tests vs reader runs · last 7 days ·
ratings positive/negative/unrated · distinct reader sessions and authors · top
flows by run count · where failures concentrate · why runs were blocked.

Run through the database service (`docs/ops-runbook.md` has the command; it is
not `docker exec … python`, and the runbook says why).

Locked by `test_pilot_funnel_is_read_only.py`: every statement is a SELECT, no
mutating keyword survives, it reads only the pilot's own tables, no reader's
question or session key is ever listed, every grouped listing is bounded, and
every metric the launch contract named is still reported. Mutation-tested.

**`ai_feedback` stays P2**: a separate older table with 0 rows, not on the reader
path. It is not the mechanism and building on it would have been a second source
of truth for a fact the runs table already holds.

---

## ACCEPTANCE TESTS

Two launch gates, both walking a journey rather than a part.

**`e2e/tests/agent-flow-v1-author-golden.spec.ts`** — New flow → the starter is
offered first and selected → the dialog says what it will build → create → the
SAVED body is the three-step shape with no customer in it, no tools on the
answering step and nothing gated granted → validates with no further setup →
Test panel opens → edit → save → **hard reload** → the change survived →
publish → the activation strip turns `attention` and its CTA points at the
surface that owns the binding → a Tool step is named by its tool and an
unconfigured one says so → a run is inspectable and *Open in builder* returns to
the canvas.

**`e2e/tests/agent-flow-v1-reader-golden.spec.ts`** — in a logged-out browser,
against a link and binding the suite creates and deletes itself: the assistant is
reachable without signing in and the page calls **only** `/api/v1/public/…` ·
an unknown token renders no report and says so · nothing internal reaches the
reader, including inside the expanded details panel · a status line never calls a
refusal an error · a rating registers and survives a reload.

Both anchor "the turn finished" on the server's own run record rather than on a
DOM signal — three earlier versions of that wait passed in about a second each
against the greeting.

**What runs where.** CI seeds no model credential (`E2E_NO_MODEL=1`), on purpose:
a gate that spends money on every push is a gate somebody eventually turns off.
Without one the assistant correctly renders its key-entry view, so the three
reader tests that drive a real turn have nothing to drive and **skip with the
reason stated** — they do not fail, and they are not silent. Locally, with a
credential, all six run.

| skipped on CI | covered instead by |
|---|---|
| reader sees no internal identifiers | `test_reader_diagnostics_are_product_facing.py`, `test_notice_audience_boundary.py` |
| a refusal is not labelled an error | `test_reader_outcome_is_not_ok_flag.py` |
| a rating reaches its run | `test_reader_rating_reaches_the_run.py`, `test_answer_text_is_published_not_rederived.py` |

All three were also walked by hand on a public link. The skip is recorded here so
a green CI run is never read as "the reader journey ran there".

**Suite result locally, with a model credential: 69 passed, 0 failed, 0 skipped.**
**On CI: 66 passed, 3 skipped for the reason above, 0 failed.**

Where the reader-notice severity guarantee is locked, and why not in E2E: a
browser reproduction needs a refused tool call on a real turn, and the only path
that emits one to a reader is an agent choosing to make it — a model decision.
`test_reader_outcome_is_not_ok_flag.py` locks it deterministically instead, and
it was additionally observed live on a public link.

---

## KNOWN V1 LIMITATIONS

Stated so nobody discovers them as surprises.

- **Vietnamese-first, not bilingual.** The author journey is consistent in both
  locales. The Dashboards module the activation CTA hands an author to is largely
  English whatever the locale, as is the public "link unavailable" page.
- **Knowledge is advanced, not promised.** The V1 starter works completely
  without it, `check-starter-grants.mjs` refuses a starter that grants it, and
  nothing in the V1 UI presents it as required.
- **A Tool step is not narrated to the reader.** A ToolNode emits no
  `tool_result` to the reader stream, so when one is refused the reader is told
  nothing — they get an honest answer with no indication that a step was
  withheld. Not on the V1 starter path (the starter has no Tool node, and an
  agent's own tool calls ARE narrated), so it is recorded rather than changed at
  freeze.
- **No deterministic chaining guarantee across tools**; Switch, Loop, Coordinator
  and Filter are advanced blocks.
- **`AppModalShell` renders no `role="dialog"`**, so modals across the app are
  not reachable by role. An accessibility gap, not a V1 journey blocker.
- **Live Agent Eval** is implemented and has never run against a deployment
  serving this candidate — see below.

---

## LIVE AGENT EVAL

**NOT VERIFIED UNTIL DEPLOYMENT.** The code exists and its provenance gate
requires `deployment_sha == candidate SHA`. No environment is currently serving
this candidate, and calling a stale server and attributing the verdict to this
branch is precisely what that gate was built to prevent. It is a post-merge
certification step, not a blocker on the code candidate.

---

## V1 SCOPE — frozen

**Supported, and verified in the running product:** the Vietnamese-first author
journey · the `Trợ lý BI cho báo cáo` starter · publish and report activation ·
the grounded report reader on `/d` and `/embed` · Runs with per-step trace and
*Open in builder* · a reader rating that reaches the run · the pilot funnel · the
operator runbook.

**Advanced, present but not promised:** Knowledge · Switch, Loop, Coordinator,
Filter · ToolNode composition beyond a single configured step · Direct Chat.

**V2 and later:** full bilingual parity · 36/36 `output_schema` · broad
deterministic composition across tools · Knowledge retrieval hardening ·
app-wide accessibility work including modal roles · reader-vocabulary sweep ·
`ai_feedback` · Wave 3.

---

## HANDOFF — THE PUSH IS BLOCKED ON CREDENTIALS, NOT ON THE WORK

Everything below the line is done, verified and **committed locally**. The branch
could not be pushed, and therefore the final V1 PR could not be opened.

```
$ git -c credential.helper= push --dry-run origin HEAD:release/agent-flow-v1-candidate
remote: No anonymous write access.
fatal: Authentication failed for 'https://github.com/QuangChinhDE/appbi-ai/'
```

`git push` opened an interactive `git credential-manager get` prompt, which a
non-interactive shell can never answer — the push sat on it for thirty minutes
before it was diagnosed and stopped by PID. Read operations still work
(`git ls-remote`, the anonymous check-runs API) because the repository is public;
only writing needs the credential, and it has expired or been cleared on this
machine.

**Nothing was lost and nothing is half-applied.** The working tree is clean, all
sixteen commits ahead of `demo` are present, and the five stashes on this machine
all predate this session (July and August, belonging to the public-dashboard and
workboards work streams) — the pre-push hook stashed nothing, because the tree
was already clean when it ran.

**To finish, from a shell that can authenticate:**

```bash
git checkout release/agent-flow-v1-candidate
git log --oneline -1          # expect the session-C head recorded in the report
git push origin HEAD:release/agent-flow-v1-candidate
```

Then open ONE PR, `release/agent-flow-v1-candidate` → `demo`, titled
**Agent Flow V1 launch candidate**, and wait for `preflight`, `e2e`,
`backend-contract-tests` and the change-guardrail checks on the PR head. The
body should lead with what a V1 user can do, not with the diff.

CI on this branch has been green on every push so far, read through the
anonymous API:
`https://api.github.com/repos/QuangChinhDE/appbi-ai/commits/<sha>/check-runs`.
`gh` is not installed on this machine; that endpoint is the substitute, and a
commit polled seconds after a push legitimately reports zero runs because the
workflow has not started yet.

---

## NEXT — INDEPENDENT REVIEW

The candidate is frozen. The next step is review of the final V1 PR, not more
product development.

For a reviewer, the three things most worth checking are the ones where a fix
could have been a patch and was deliberately not:

1. **P1-4** — severity is classified once, in `reader_diagnostics`, and carried
   on the one SSE format all reader surfaces parse. The alternative was renaming
   a heading in one React component.
2. **P1-5** — the image carries its own commit, so it can say what it is however
   it is started. The alternative was documenting that you must use `run.sh`.
3. **Feedback** — the server publishes its own rendering of the answer, so there
   is one implementation. The alternative was making the client's copy match, and
   maintaining two.

Post-merge, and not blocking the code: run the Live Agent Eval against a
deployment actually serving the merged SHA.
