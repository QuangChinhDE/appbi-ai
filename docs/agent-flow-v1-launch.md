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
| next | **V1-B** (see the last section) |

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

Walked in the real UI on `V1_BASE_SHA`, logged in as a normal author.

| step | result | evidence |
|---|---|---|
| login | **PASS** | redirects to the requested page |
| Agent Flows list | **PASS** | stats, filters, one-line explainer, per-flow status and step count |
| create a flow | **CONFUSING** | good copy explaining the two surfaces and that the choice is irreversible — but mixed language, and no starter |
| first blank screen | **CONFUSING** | two default steps appear (Read report → Answer viewer); nothing says what to do next |
| configure steps | **PASS** | inspector is complete; node palette carries 14 types with plain-language descriptions |
| Tool node identity | **WRONG** | canvas card reads `Call a tool / Call a tool` with `total_measure` configured |
| report/context binding | **DEAD END** | see P0-1 |
| validation | **PASS** | substantive and actionable; server enforces the same rule the UI states |
| Test panel | **PASS** | picks a real report, runs, logs to Runs, marked as a test |
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

### P0-1 — a published flow has no in-product route to becoming usable

**Evidence.** The flow header shows `Bot on a report · 1 link`. That text is not a
link, not a button, and has no affordance; `[...document.querySelectorAll('button,a')]`
matching `/link/i` inside the builder returns an empty list. A flow becomes
reachable only by opening a *dashboard's* share/public-link settings and choosing
the flow there. Nothing in the builder says so.

**Journey.** Author: publish → *(nothing)*. The core job ends one step short of
value.

**Acceptance.** From a published flow, an author can reach the place that makes it
live, and the builder states what Publish does and does not do. Reusing the
existing binding mechanism — no second binding architecture.

**Session.** V1-B.

### P1-1 — no first-success path

**Evidence.** `New flow` offers exactly two routes. *Tự dựng* creates a
two-step flow with no guidance. *Nhờ AI viết giúp* asks the user to copy a system
description, paste it into ChatGPT or Claude, and paste JSON back. There is no
template, preset or starter.

**Journey.** A non-technical pilot author either stares at a canvas or leaves the
product to use a third-party model.

**Acceptance.** One product-native starter — a BI report assistant — that creates
the minimum structure needed to bind a report, answer grounded questions and run.
No hardcoded report or account. No marketplace.

**Session.** V1-B.

### P1-2 — a Tool node does not say which tool

**Evidence.** With `total_measure` selected, the canvas card reads
`Call a tool / Call a tool`. The Coordinator card beside it reads
`Coordinate specialists · LLM · One agent picks from 2 specialists · at most 3 per
question` and lists the specialists by name — so the rich-card pattern exists and
the Tool node simply does not use it. The inspector picker already shows
`Total a measure · total_measure`.

**Acceptance.** The canvas card names the selected tool in the product's words.

**Session.** V1-B.

### P1-3 — the first author screen is mixed-language

**Evidence.** The create dialog renders `Tự dựng` and `Nhờ AI viết giúp` beside
`Flow name*`, `What is this flow for?`, `Bot on a report`, `Description`, `Cancel`
and `Create and open`. The assisted-authoring branch is fully Vietnamese; the
build-it-yourself branch is English.

**Why it is P1 and not polish.** V1 is Vietnamese-first, and this is the first
screen a pilot author sees. Mixed language here reads as an unfinished product,
not as a language choice.

**Scope.** The create dialog and the builder chrome on the starter path only. Not
the whole backend, not every author surface.

**Session.** V1-B.

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

Existing E2E covers the builder surface, security contracts and the public
surfaces (58 specs). **There is no single golden V1 journey test yet.** V1-C adds
one: author create → configure → validate → test → save → publish → reload →
execute → Runs → reopen; reader ask → answer/refusal → citation → no internals;
feedback submit → durable.

---

## KNOWN V1 LIMITATIONS

Vietnamese-first, not bilingual · Knowledge is advanced, not a promise · no
deterministic chaining guarantee across tools · Switch/Loop/Coordinator are
advanced blocks · Live Agent Eval is implemented but has never run against a
configured deployment.

---

## NEXT SESSION — V1-B

Start from this branch at `736b71a7f4892b7e8b27664b94962827458b2cd6`.

Implement, in this order:

1. **P0-1** — a route from a published flow to making it live, reusing the
   existing binding mechanism.
2. **P1-1** — one product-native starter flow.
3. **P1-2** — the Tool node names its tool on the canvas.
4. **P1-3** — Vietnamese on the create dialog and the starter path.

Do not start P1-4 or P1-5; those are V1-C. Do not open the V2 list.
