# Agent Flow V3 — Final Core Stabilization & Pilot Release Report

**Verdict: NOT RELEASE READY.** Gate A (zero leakage) and Gate C (critical journeys
100%, supported analytics ≥95%) fail on the live model. Gates B, D and E are partial.
Gate F holds: every piece of evidence below comes from one build.

Date: 2026-09-29 · Branch `feat/agent-flow-v3-capabilities` · PR #4 (Draft, stacked on PR #3)

---

## 1. Verdict and why

| Gate | Requirement | Result | Status |
|---|---|---|---|
| A | Zero leakage: no wrong or withheld figure reaches a reader | Withheld drafts and withheld values no longer reach any reader channel (verified live). Wrong figures still reach readers in up to 61 of 799 live runs: an upper bound (§8), and some of those visible numbers are correct but beside the point. | **FAIL** |
| B | No false withholding of correct figures | Largest classes fixed (drilldown ledger, members, periods, absent). `refusal_wrong` and "figure missing" failures remain in 7–15% of runs. | **PARTIAL** |
| C | Critical journeys 100%; supported analytics ≥95% | Critical 29–32/45 on holdout, 29–31/39 on the main set; overall 66–77%. | **FAIL** |
| D | Security and operations | Security: 135 checks, all three failures fixed and re-verified. Concurrency, timeout and disconnect were not run. | **PARTIAL** |
| E | Usability | VI/EN answer language fixed. The Runs UI does not show tool arguments or intent. Backend notices are Vietnamese-only. | **PARTIAL** |
| F | One release identity | All live, security and browser evidence and CI at `a2d2e68b`; backend and frontend rebuilt from it | **PASS** |

## 2. Release identity

- Runtime SHA under test: **`a2d2e68b04d9e347497850eb904b6e3fae8ff901`**. `/api/v1/health` reported it before, during and after every live run.
- The backend and frontend images were built from that SHA on the isolated stack (`appbi-af`, 127.0.0.1:8190/3190).
- Remote CI at that SHA is all green: Product gate, Preflight ×2, Change guardrail, Backend semantic-contract tests, E2E (Playwright, full stack).
- The commit that adds this report is documentation only; it does not change the runtime.

## 3. What changed this cycle (root causes, not symptoms)

| Commit | Layer | Root cause fixed |
|---|---|---|
| 822b8191, f20431fb | Publication boundary | Raw draft tokens streamed before verification; the fallback answer was unchecked |
| ee2c85d8, 422b8fd2 | Question Intent Contract | One bounded model call per turn resolves measures, dimension, members and periods against the report's own vocabulary ([intent-contract.md](intent-contract.md)) |
| c515188e | Tools / intent / claim check | Qualified vs bare column names refused as `query_failed`; a filter on an unknown column silently ignored; members without codes; a share treated as absent; a month outside the asked year not compared |
| a1a5fe98 | Reader boundary (security) | **F1** author trace, including the withheld draft, sent to public readers; **F2** a session re-homed to another link; **F3** binding read without report access |
| 0b1fef8a | Intent | "Absent" came from the model; it is now decided deterministically against the vocabulary (VI syllable pairs, EN stems) |
| e98d1b8d | Tools | `compare_periods` needed labels to match byte for byte; wrong error codes |
| 0beabf5d, 716f1867, ea81142f | Tools / trace | Filters ignored the resolved member ("Rio de Janeiro" vs "RJ", "…(RJ)"); a zero-row match was read as 0; `share_of` did its own matching; the trace had no call arguments |
| ce6d6313 | Tools | On multi-measure charts, the last numeric column was measured instead of the asked measure |
| a2d2e68b | Reader boundary / claim ledger / language | **F1 residual**: withheld values in reader notice facts (live and stored threads); `smart_drilldown` figures never described, so correct answers were withheld; English questions answered in Vietnamese |

Each fix has a regression test that fails on the previous code (mutation control).

## 4. Architecture now in place

- **One publication boundary.** Nothing reaches a reader before the claim check. This covers:
  - SSE text is not streamed from drafts;
  - typed blocks are checked in place;
  - the fallback answer is checked;
  - the Skill relay goes through the same path.
- **One reader projection.** `FlowOutput.to_reader_dict()` keeps the answer, citations and reader notices, with notice facts scrubbed. It carries no trace, usage or memory state. It is used by every public-link and chat-thread send, and by the stored-thread replay. Author surfaces (`run_preview`, Runs) keep everything.
- **The backend owns the verdict.** The claim ledger and claim check judge every figure against structured evidence: measure, dimension, member, period and ratio. The intent contract says what was asked; it never grants scope.
- **Canonical resolvers** used by every row tool:
  - `resolve_column` (a bare field name → the qualified column);
  - `resolve_value` (case, accents, `_`, parentheses, resolved member aliases);
  - `_measure_idx` (explicit measure → the asked measure → the last numeric column);
  - `_period_label`.

## 5. Issue classification

| ID | Class | Issue | Status |
|---|---|---|---|
| F1 | P0 | Withheld draft and values reached readers (trace, notice facts, stored threads) | **Fixed, re-verified live** |
| L1 | P0 | SSE streamed drafts; JSON-block branch and fallback unchecked | Fixed |
| A-res | **P0 open** | Wrong figures still published: all-time value as a period's or member's ("4.0864 per month", "89.48% March 2018"), invented arithmetic ("188,772.83 per order over 72 orders", "1/99224 = 0.00101%"), unasked-scope totals for out-of-scope breakdowns | **Open** (§8) |
| F2 | P1 | Session transcript re-homed across links | Fixed, re-verified |
| B1 | P1 | False withholding: drilldown ledger, members, periods, absent, multi-measure | Fixed (largest classes) |
| B-res | P1 open | Correct figures still missing: `refusal_wrong`, `capability_not_found`, and budget exhausted on link 39 (6 model calls) | **Open** |
| E1 | P1 | English answered in Vietnamese | Fixed |
| F3 | P2 | Binding readable without report access | Fixed, re-verified |
| U1 | P2 | Runs UI shows neither tool arguments nor intent (the API returns both) | Deferred |
| U2 | P2 | Backend notices Vietnamese-only in English mode; the public page has no VI/EN control; mixed chrome | Deferred |
| U3 | P3 | Truncated budget line; "0 conversations" count; builder banner clipped at 390px (below the 1280px authoring minimum); EN wording ("show 1 steps", "1 AI calls") | Deferred |
| O1 | P3 | `/validate` accepts an unknown tool with a warning (the runtime refuses it) | Deferred |

## 6. Product decision requested

When a figure is withheld because it was given to one member, the answer can add a
labelled note restating the number as the whole report's total ("⚠️ Số của toàn bộ
báo cáo: 13,591,643.7 — … không phải số của một đối tượng cụ thể"). The figure is
correct and labelled correctly, so it is kept. The strict security scan counts it as
a leak. **Decide:** keep it, or never show a figure that was withheld from its sentence.

## 7. Static, regression and integration tiers

- **Backend Agent Flow CI list (local):** 2,431 passed. The 2 local-only failures (`test_module_floor` route table, FastAPI 0.141 vs the pinned 0.109) pass in CI.
- **Legacy bot suites on the shared tool bodies:** 1,275 passed.
- **Guardrail diff:** OK. Tier-1 oracles: all ran and passed.
- **Remote CI at `a2d2e68b`:** all green (§2).

## 8. Live model tier (`a2d2e68b`, 805 runs, one deployment)

| Set | Arm | Pass | Critical |
|---|---|---|---|
| Holdout (24 scenarios, never used for design) ×3 | full | 50/72 (69%) | 32/45 |
| | routed | 47/72 (65%) | 29/45 |
| P0 subset (14) ×5 | full | 44/70 (63%) | 6/10 |
| | routed | 44/70 (63%) | 9/10 |
| Main (71 + product flow) ×3 | full | 163/213 (77%) | 31/39 |
| | routed | 161/213 (76%) | 29/39 |
| | product | 12/18 | 4/9 |
| Stress ×1 | stress | 37/71 (52%) | 9/13 |

**Trend on the holdout set** (full / routed):

| Build | full | routed |
|---|---|---|
| 422b8fd2 | 31/72 | 32/72 |
| ce6d6313 | 46/72 | 47/72 |
| a2d2e68b | 50/72 | 47/72 |

On the P0 subset, a2d2e68b scored 88/140, against 60/140 at 422b8fd2 and 79/140 at 0abef689.

**Failure classes at `a2d2e68b`, first cause:**

| Class | What it means |
|---|---|
| budget | The step ran out of model calls; link 39 allows 6 |
| wrong_answer | Mostly an expected figure absent or withheld; some are wrong figures |
| refusal_wrong | The answer refused although the report has the figure |
| tool_semantics | A tool was used with the wrong meaning |
| capability_not_found | No matching tool or chart was found |
| model_calc | The model's own arithmetic was wrong |

**Failing runs that still show a figure:**

| Stage | Runs |
|---|---|
| holdout | 15 |
| P0 | 9 |
| main | 32 |
| stress | 5 |

This is an upper bound on Gate A leaks: some of these numbers are correct but beside the point.

**Representative published wrong figures still open (A-res):**
- `g7_review_month_oos`: an all-time average presented as monthly.
- `g4_ontime_mar18_r67` (routed): 89.48% given for March 2018.
- `g3_rev_per_order` (routed): an invented denominator.
- `h_one_star_rate`: 1/99224.
- `g7_seller_state_oos`: the grand total given as "by seller state".
- `t_neg_delay_r67`: a delivery-days figure given as the delay.

**Harness evidence:** `D:/Appv2/af-runtime/acceptance/run_a2d2e68b/` (local, not committed: raw traces).

## 9. Security (multi-account)

- **At 422b8fd2:** 135 checks, 124 PASS; three failures F1 (HIGH), F2, F3.
- **At ce6d6313:** F2 and F3 PASS; every other check held (the two flow-publish probes not run); F1 partly fixed (the notice residual).
- **At `a2d2e68b`:** F1 PASS on every reader path:
  - public links 171 and 39;
  - a new chat-thread turn;
  - the replay of a new thread and of an old stored thread.

  The owner's run detail still keeps the values. The only strict-scan FAIL is the product decision in §6.
- **Held throughout:**
  - flow access by role (owner, editor, viewer, outsider, no module access);
  - Skill unshare and disable refused at call time;
  - public link chart allowlist, including prompt-injection and forged-history attempts;
  - hidden locked filters enforced server-side;
  - raw rows gated;
  - forged and unknown tools refused;
  - cross-session isolation;
  - the author-only run audit.
- **Observation:** a single-tool-step flow shows the locked filter's value in `filters_applied`. The data is still restricted.

## 10. Browser E2E (real VI/EN control, `ce6d6313` with the later fixes smoke-verified at `a2d2e68b`)

- The public SSE `result` envelope has an empty trace, zero usage, and no claims or draft.
- The Test chat on a link: the freight figure was correct.
  - At ce6d6313 the RJ figure was falsely withheld, and English questions were answered in Vietnamese. Both are fixed in a2d2e68b; the smoke run gave RJ 1,824,092.67 and answered in English.
- **Not verified:** a public v3_phan_tich chat. Link 170 is password-protected with a random password nobody stored.
- Builder layout at 1440px is clean in VI and EN. At 390px the page itself doesn't scroll sideways, but the banner is clipped (P3).

## 11. Concurrency and operations

**NOT VERIFIED:** concurrent sessions, provider timeout, client disconnect mid-stream,
and audit completeness under load were not run this cycle. Stress mode ran (§8).

## 12. Gates that did not run

| Gate | Reason |
|---|---|
| Frontend `tsc` | No frontend code changed this cycle |
| Concurrency / timeout / disconnect | §11 |
| Public v3_phan_tich browser chat | §10 |

## 13. Backlog

- **P0:** A-res. Figures presented with the wrong period, member or measure scope, and model arithmetic over invented operands. Next root causes:
  - an all-time KPI given a period or member;
  - `compute` over values not in evidence;
  - out-of-scope breakdown totals.
- **P1:** B-res. `refusal_wrong` and `capability_not_found`, and budget exhaustion on the 6-call link. That budget is a binding contract, so the fix is fewer wasted calls, not a bigger budget.
- **P2:** U1 (Runs UI: arguments and intent), U2 (English backend notices, public VI/EN).
- **P3:** U3, O1.

## 14. Next steps

1. Attack A-res at the claim check and the tool layer, using the argument trace added this cycle, and lock each fix with a failing-first test.
2. Rerun the live matrix at one new SHA. Release only when Gate A shows zero and Gate C shows critical 100% and supported ≥95%.
3. Run the concurrency, timeout and disconnect tier.
4. Clean up test fixtures: public link 171, the `rc_sec_*` users and flows, and `rc_probe_tool`.
