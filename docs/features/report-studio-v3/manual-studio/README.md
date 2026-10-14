# Report Studio V3: finalization and coordinated integration

**Audience.** The owner deciding on product acceptance and on merging the Report Studio stack (#5 → #6 → #7) into `demo`, and the reviewers of those PRs.

**Status: BLOCKED, not merged.**

- **Merge is blocked by BigQuery.** The supported production data path has not been verified on BigQuery. The BigQuery text-filter fix is in code, but it has never run on a warehouse, and this machine has no warehouse access (§5). No PR has been merged into `demo`, and none will be until that gate runs.
- **Everything else passes.** Every other executable gate listed below ran and passed at the SHAs given.
- **Human product acceptance is pending.** That is the owner's decision; no assistant may take it.

| PR | Branch | Head | CI |
|---|---|---|---|
| #5 | `feat/dashboard-design-engine-v2` | `35f78a6e` | 5/5 green |
| #6 | `feat/report-experience` | `fa180520` | 5/5 green |
| #7 | `feat/report-studio-v3` | `933ab8b2` (product), then docs and evidence | see §4 |

All three carry `demo` at `30a048f4`, which includes Agent Flow V3 (PR #3 and #4). All three are Draft, and auto-merge is off.

**Related documents.**

- [`release.md`](release.md): deploy order, the combined migration graph, rollback, and what is not verified.
- [`plan.md`](plan.md): the capability audit and the implementation order from the previous round.

## 1. What changed in this round

**Release closure** (`5e895d3b`, `97921bf1`, `beb5d723`, `024550f5`, `a7b39a70`):

| Gate | Change |
|---|---|
| A2: BigQuery text filters | The report WHERE clause, the live-query path and the distinct-value cascade emitted `LIKE … ESCAPE '\'`, which GoogleSQL rejects. One helper (`app/services/sql_pattern.py`) now gives BigQuery `STRPOS` / `STARTS_WITH` / `ENDS_WITH`. Postgres SQL is unchanged byte for byte. A measure's own text filter is deliberately unchanged, because changing it would move saved numbers (see `release.md` §7). |
| A4: Inspector save | An edit typed in the Inspector is settled before Save, Publish and a page switch, and cannot land after Discard. Leaving the page with an unsent edit asks first. |
| B3: split header on a phone | The header's aside stacks under the title through a container query on a wrapper. A container query cannot style its own container. |
| B4: KPI whitespace | A new KPI tile's default size is 4 columns × 7 rows. A lead KPI's figure is 1.25× the size of a normal one's, and a quiet KPI's is 0.85×. |
| B5: sections with locked members | A section whose header or any member is locked refuses to move and names the member, instead of moving around it. |
| C: time coverage | A report over independent datasets states each period, named by its section ("Marketplace: Sep 2016 – Sep 2018 · Sales: Jan 2024 – Dec 2025"). |
| C: chart readability | The last tick of a date axis is no longer clipped. A legend of up to 6 items wraps instead of scrolling. |
| C: phone and tablet heights | Text-like elements and KPI cards are measured as rendered and re-measured when their content arrives late. On phone the grid is re-laid; on tablet cells only grow. The public page measures the grid it actually renders; a dead duplicate grid block was removed. |
| C: PDF | Charts no longer print washed out. html2canvas restarted their fade-in in its clone; the clone now has no motion. |
| F: accessibility | Every Inspector field is associated with its label. Small labels no longer use the quaternary text colour (3.3:1 on white). axe-core runs in the acceptance spec. |

**Integration with `demo`** (`35f78a6e`, `3525eaa4`, `fa180520`, `924d2a93`, `8816979c`, `8ee77536`):

- `demo` at `30a048f4` was merged into #5, then #5 into #6, then #6 into #7. Every conflict was an addition on both sides and was resolved as a union:
  - the preflight pytest list;
  - the frontend `qa` chain;
  - `agent_flows/dispatch.py`, where this stack's `_disclosed` sits next to Agent Flow's `v3_capabilities` / `v3_blocked_for_readers`.
- Two no-op merge revisions give `demo` one head after each PR: `20260926_0201` in #6 and `20260930_0001` in #7.
- One fix to `app/core/alembic_reconcile.py` (`fa180520`), reviewed and adopted by the Agent Flow owner. Recording both lines before their merge no longer crashes startup on `alembic_version`'s primary key.
- The whole graph was rehearsed on real Postgres (`evidence/integration-migration-rehearsal.json`, summarized in `release.md` §4).

**Found reviewing the final evidence, and fixed** (`62abc63e`, `933ab8b2`):

- At tablet width a bar chart printed one stray value ("R$1M") over one bar. An upright bar series now labels every bar or none, judged on its widest label.
- Two bars of about the same height lost one label (the "housewares" bar in the M1 PDF). The colliding label now lifts just clear of its neighbour.
- The report header's meta line could open a wrapped line with "·".
- "Group by time" drew two chevrons.

## 2. Gates

| Gate | State | Basis |
|---|---|---|
| A1: public surface trust | TECHNICALLY VERIFIED | Semantic-guard review of the public surface: no authed call and no data outside the link's scope. Readiness R3 (tampering, scope, lock AND page, embed isolation) and R4 (disclosure) pass. `qa:public-bundle` passes. |
| A2: BigQuery compatibility | **BLOCKED** | Fixed in code and locked on the SQL shape by `test_dialect_structural.py` (33 tests), but never executed on BigQuery. §5. |
| A3: draft isolation | RUNTIME VERIFIED | M5: the public report never saw a discarded edit. Readiness R6: a failed report-only edit leaves nothing, a copy is a labelled draft, and Discard deletes it. |
| A4: Inspector save lifecycle | RUNTIME VERIFIED | M5: Publish right after typing ships the edit. After Discard and after a reload, only the published text remains. |
| A5: co-authoring | RUNTIME VERIFIED | Readiness R5: two accounts, the same tile and different tiles, shared draft revisions, Publish/Discard choices and concurrent writes. |
| B: manual builder | RUNTIME VERIFIED | M1–M4 driven through the UI, plus unified-grid and readiness. |
| B3/B4/B6 | RUNTIME VERIFIED | M2: the phone header has no clipped content, and KPI figures stay within bounds. Slicers on the grid: unified grid, and M3's filters stay intact. |
| B5: section with a locked member | TECHNICALLY VERIFIED | The contract check runs `moveSection` itself: a locked member refuses the move and is named. No UI benchmark locks a member. |
| B7: design quality | REVIEWED, not accepted | §3 has the reviewer's notes. Acceptance is the owner's. |
| C: reading surfaces | RUNTIME VERIFIED | 1440/820/390 in M1–M4 with clipped-tick, clipped-legend, clipped-content and band-intruder assertions. PDFs in M1 and M4. The multi-dataset period is asserted per dataset in M4. |
| D: AI uses native capabilities | RUNTIME VERIFIED | V3 S1–S8, smoke B, readiness R11 and unified-grid S7–S9 pass with the real model. Membership stamping is contract-checked. |
| E: M1–M4 on published output | RUNTIME VERIFIED | §4. Human acceptance is requested below. |
| F: checks | see §4 | Evidence is tied to SHAs. Skipped tests are NOT VERIFIED. |
| G: migrations and rollback | RUNTIME VERIFIED on copies | The rehearsal matrix in `release.md` §4. A production-size copy has not been migrated. |
| H: coordination with Agent Flow | DONE | Agent Flow landed first. Merge revisions and the reconcile fix are agreed with its owner. No force-push; `demo` is untouched by this stack. |
| I: merge into `demo` | **NOT DONE: BLOCKED by A2** | |
| Human product acceptance | **PENDING** | The owner's decision. |
| Deployment | not done | Not authorized in this task. |

## 3. Visual review of the final evidence

I opened every screenshot and read every PDF page at `933ab8b2`. These are a reviewer's notes, not an acceptance.

**Reads well:**

- The header states the title, description, per-dataset period and filter context on every surface, including the PDF sheets.
- Sections stay whole on every width and on paper. On a phone each heading is followed by its own charts.
- KPI figures print black, and charts print at full strength.
- Bar values read whole, or are left to the tooltip.

**Still weak, and not fixed:**

- On a phone, pie slice labels are truncated ("boleto (1…", "credit_car…"). This is the chart renderer.
- In lead + supporting, a KPI beside a chart takes the chart's height. The figure is centred with its context below; there is more space than content.
- M3 ends with the controls and KPIs under the moved section. That is what the benchmark did, not a product default.
- Axe whole-page findings outside the asserted surfaces, recorded rather than asserted:
  - builder: colour contrast (4), SVG images without alt text (4), one unnamed link, document title;
  - public pages: document title, SVG images without alt text (4).
  - They come from charts and app chrome.

## 4. Verification

| Check | SHA | Result |
|---|---|---|
| `npx tsc --noEmit` | `933ab8b2` | PASS |
| `npm run qa` (12 steps, including report-structure with 31 checks and unified-grid with 41) | `933ab8b2` | PASS |
| Backend CI unit list, run as the workflow runs it (110 paths) | `924d2a93` | 2651 passed, 3 skipped. 2 failed locally: `test_module_floor` needs the pinned FastAPI 0.109, and the local version is 0.141. CI runs them green. |
| Tier-1 semantic oracles | `924d2a93` | every oracle ran and passed |
| Guardrail-required pytest groups (Agent Flow container, contract, evidence, replay and surface; dialect; layered merge; measure render; the protection meta-tests) | `8816979c` | all pass. 3 skipped in `test_time_axis_contract`: they need a migrated `dashboards` table, so NOT VERIFIED in this tier. |
| Guardrail diff, `origin/demo...HEAD` | `8816979c` | WARN: protected subsystems touched; the named tests ran (row above) |
| `alembic_chain.py` | `8816979c` | single head `20260930_0001` |
| `verify.py task` | `933ab8b2` + this docs commit | PASS. Its scope is the working tree (docs and evidence), so it resolved no required gate. The stack-level gates come from the guardrail diff against `demo` (above), and their tests were run there. |
| Migration rehearsal matrix | `924d2a93` tree | all five starting states end at one schema; Agent Flow changes no report content |
| Acceptance: manual-studio M1–M5 + A11Y | `933ab8b2` | **7/7 PASS, twice** (M1 49 assertions, M2 22, M3 23, M4 25, M5 4, A11Y 6) |
| Acceptance: readiness R3–R11 | `933ab8b2` | **10/10 PASS** (including setup) |
| Acceptance: completion smoke A–C | `933ab8b2` | **4/4 PASS** (including setup) |
| Acceptance: unified grid | `933ab8b2` | **24/24 PASS** |
| Acceptance: Report Studio V3 S1–S8 | `933ab8b2` | **9/9 PASS** (including setup), with the real model |
| CI e2e (Playwright, full stack) | `933ab8b2` | 79 passed, 0 failed. 11 skipped: Agent Flow runtime tests (author/reader golden, run inspector, surfaces) that need a link with a flow binding, which this rig's database has none of. **NOT VERIFIED** here; not this stack's area. |
| Remote CI | `35f78a6e`, `fa180520`, `8816979c`, `6b0635be` | 5/5 success on each (backend semantic-contract tests, change guardrail, E2E full stack, preflight, product gate). `6b0635be` is the product at `933ab8b2` plus this document and its evidence. |
| BigQuery gates (`galaxy_golden`, `distinct_cascade_bq`, and a BigQuery run of the text filters) | none | **BLOCKED**: not run |

**Declared changes to tests, gates and CI in this round:**

- `check-unified-grid-contract.mjs`: the absent-control check read a dead code block. It now asserts on the one live public grid. It is stricter than before, and was mutation-tested.
- `check-report-structure-contract.mjs`: new checks for the rules of this round (31 in total). Each was mutation-tested where it asserts a rule.
- `test_alembic_revision_reconcile.py`: one test added for the both-lines-recorded state. The existing five are unchanged.
- `test_dialect_structural.py`: BigQuery and Postgres shapes for the text filters. Existing assertions are unchanged. One of them is reported as an open finding in `release.md` §7, not edited.
- `e2e/acceptance/manual-studio.spec.ts`: M5 and A11Y added; the public checks were extended. It is not in CI and is run explicitly.
- Merge unions: the preflight pytest list and the `qa` chain gained the other stream's entries. Nothing was removed.
- No assertion was removed or weakened. No gate was marked missing or manual.

## 5. The blocker, its owner, and what unblocks it

**Unmet gate: A2, BigQuery verification of the supported production data path.**

What exists: the SQL generator's BigQuery shapes, locked structurally by tests.

What does not exist:

- a run against BigQuery;
- the `galaxy_golden` and `distinct_cascade_bq` harnesses, which `guardrail_rules.yaml` declares `missing` because they were never committed.

This machine has:

- no service-account credentials (the `GCP_SERVICE_ACCOUNT_*` variables are empty);
- no gcloud application-default credential;
- no authorization for the BigQuery connector.

**Owner: the repository owner or data platform owner.** To unblock, one of these is needed:

1. **Provide a BigQuery project and credentials** for a test dataset through the environment (never committed), and the ds113 fixtures. The text-filter paths and the tier-1 harnesses can then run.
2. **Commit the `galaxy_golden` / `distinct_cascade_bq` harnesses**, so the gate is executable anywhere credentials exist.
3. **Explicitly accept** merging without BigQuery verification, recorded as the owner's decision. This task's instructions do not allow an assistant to make that call.

**Preserved state:**

- all three branches are pushed as above, with no force and no merge;
- `demo` is unchanged at `30a048f4`;
- the Agent Flow owner has a follow-up (`pilot.py`, which replaces `v3_capabilities`) that is not yet in `demo`. When it lands, the stack is re-merged and its gates are re-run.

## 6. Human acceptance requested

Please review, on a production build or from `evidence/`:

- M1–M4 at 1440, 820 and 390;
- the M1 and M4 PDFs;
- the §3 notes.

Then decide on product acceptance. The acceptance, and any decision on the BigQuery gate, are yours.
