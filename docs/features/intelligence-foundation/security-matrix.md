# Security reproduction matrix and threat model — Phase 0

**Baseline:** `origin/demo` @ `1bac25e8`.

**Ledger:** `backend/tests/test_intelligence_phase0_security_repro.py`. CI step "Phase 0
security reproduction ledger" in `backend-contract-tests.yml`.

## Status semantics (ADR-015)

| Status | Meaning |
|---|---|
| `REPRODUCED` | An executable test fails at the assertion that states the safe behaviour. It is held as `xfail(strict=True, raises=AssertionError)`, so a setup error cannot pose as a reproduction. The level is stated: structural / unit / handler. |
| `REFUTED` | The test shows the read-from-code risk does not hold. It is kept as a guard against a "fix" that would open it. |
| `NOT VERIFIED` | No test exercised it. A reason is given. Never reported as coverage. |

"Handler-level" means the route function was called on in-memory SQLite with the real
authorization code. No HTTP server, no warehouse, no production system and no customer
data were involved in any test. **The warehouse half of every exploit chain is NOT
VERIFIED.**

Run on 2026-10-19, pinned deps (`fastapi==0.109.0`, SQLAlchemy 2.0.25, Python 3.12
locally, 3.11 in CI): **8 passed, 11 xfailed (all at their assertion; confirmed with
`--runxfail`)**. A mutation control for SEC-06 (forcing `text()` on the metadata session)
makes its guard fail, as intended.

## Matrix

Severity = impact × likelihood, adjusted by evidence. The values are an engineering
proposal for PO review.

| ID | Finding | Location (baseline) | Status / level | Impact | Likelihood | Severity | Containment PR |
|---|---|---|---|---|---|---|---|
| SEC-01 | A calculated field may embed a scalar subquery over any table the datasource credential can read. The guard is a DDL/DML substring list. | `semantic_query_engine.py:3870-3880` | REPRODUCED, unit | Read beyond dataset and AI scope, up to the whole credential | Medium: needs a query surface that accepts `calculated_fields` (see SEC-09) | **High** | PR-0C (protected → plan approval) |
| SEC-01b | The same list rejects valid fields (`updated_at` contains `UPDATE`) | same | REPRODUCED, unit | Correctness | High | Low (security) | PR-0C |
| SEC-02 | Schema-browser table preview has no row ceiling; `data_sources: view` reads whole tables, including tables in no Dataset | `api/datasources.py:559-573`, `datasource_service.py:3947-3972` | **FIXED in PR-0B3** (was REPRODUCED, handler). `preview_rows` is clamped server-side to `TABLE_PREVIEW_MAX_ROWS = 100`; the default of 5 is unchanged. Whether `data_sources: view` should preview raw rows at all is policy, deferred to PR-2B (ADR-002/003) | Bulk read outside every Dataset grant | Medium: needs view on the datasource | **High** | PR-0B3 |
| SEC-03 | Studio "test as chat" recomputes scope without `caller`, overwriting the caller-bounded scope. A shared **editor** reaches the **owner's** data, more than in live chat. | `dispatch.py:855-860` vs `:1092-1098`; gate `modules/agent_flows/api.py:1508` | **FIXED in PR-0B1** (was REPRODUCED, structural). Locks: AST, a behavioural `run_preview` test, a required `caller`. The HTTP-level shared-editor test is NOT VERIFIED (needs the PG HTTP fixture) | Privilege escalation to the owner's reach | Medium: needs `agent_flows: edit` plus a shared editable flow | **Medium** | PR-0B1 |
| SEC-04 | `getattr(ctx, "web_search"/"read_rows", True)` admits web or raw-row tools on a context that never declared them (the studio preview context is one) | `tools/registry.py:986-993` | **PARTIALLY CONTAINED in PR-0B1**: Studio Test now declares the binding's capabilities. The default flip is still REPRODUCED and **BLOCKED**: `test_tool_capability_gates.py::test_a_context_that_never_heard_of_the_capability_is_not_punished` locks "absent means permitted" (2 fixtures in `test_requested_dimension_is_not_substituted.py` and 1 Tier-1 oracle rely on it too). Replacing it needs an explicit decision | Raw rows into model context; outbound calls | Medium | **Medium** | PR-0B1 |
| SEC-05 | A failed GovernAIScope lookup returns "nothing excluded" | `tools/context.py:656-697, 700-724` | **FIXED in PR-0B1** (was REPRODUCED, unit). The lookup raises, which sets `ai_scope_unavailable`, so every chart read refuses with `policy_unavailable`. Such a context is never cached | Hidden columns reach the AI (and public viewers through it) | Low to medium: needs a lookup failure | **Medium** | PR-0B1 |
| SEC-06 | Pivot value discovery executes on the metadata session | `semantic_query_engine.py:1104-1143` | **REFUTED** as exposure (unit guard): SQLAlchemy 2 refuses the raw string; the error is swallowed | None today | n/a | Info | Guard kept |
| DEF-06 | Same code: pivots never receive values (correctness) | same | NOT VERIFIED (reachability of the pivot path from charts not traced) | Wrong or empty pivots | Unknown | n/a | Triage in PR-0C plan |
| SEC-07 | A Draft KPI is injected under "ĐỊNH NGHĨA CHÍNH THỐNG"; only `Deprecated` is filtered. New metrics default to `Draft`. | `knowledge_context.py:420-437`; `models/governance.py:102` | **FIXED in PR-0B2** (was REPRODUCED, unit). Only `Approved` appears under the official header. A `Draft` appears in a separate block labelled `[NHÁP]`, "chưa duyệt" (spec §4) | Integrity: unreviewed definition presented as official | High | **Medium** | PR-0B2 |
| DEF-07b | The RAG source loop references an undefined name `c`; the NameError is swallowed and document citations are dropped | `knowledge_context.py:466` | **FIXED in PR-0B2** (was REPRODUCED, unit). The citation carries the source's `doc_id` | Provenance loss | High (on every RAG hit) | Low to medium | PR-0B2 |
| SEC-08 | A bot finding seen twice becomes `validated` and is injected into later turns for everyone. The public stream feeds it. | `knowledge.py:173-186, 275-322, 425`; trigger `api/public.py:5362` | **FIXED in PR-0B2** (was REPRODUCED, unit). Machine sources (`bot_finding`, `ai`) never auto-promote: not by recurrence, not by thumbs-up, not by the daily pass. They are never recalled as facts, including rows promoted before the fix. Human approval (`_approve_memory` → `user_taught`) is the one door. The public capture call is unchanged (protected); what it writes can no longer become a fact | Knowledge poisoning by anonymous viewers | Medium: needs a public link with the bot | **Medium to high** | PR-0B2 (the public trigger stays; the promotion rule changes in `knowledge.py`) |
| SEC-09 | `/semantic/query` (warehouse rows, calculated fields) is gated at "any relation"; a dataset grant of verb `view` passes. The Dataset policy reserves query for `explore`. | `routers/semantic.py:110-117, 800-805` | **FIXED in PR-0B3** (was REPRODUCED, handler). Running `/semantic/query` requires `explore` (`authz.require`, the same as `/charts` preview). A `view`-only grant gets 403. A stranger still gets 404 | Query and raw rows without `explore`; with SEC-01, the whole credential | Low to medium: `view`-only grants exist via the grants API (the ShareDialog writes `explore`) | **High** (chain) | PR-0B3 |
| SEC-10 | Approved rules, playbooks, QA, instructions and AI scope are injected (`knowledge_context.py:497-593`) while no route can edit or revoke them (`metadata_catalog/api.py:46-60`) | static | NOT VERIFIED: needs an inventory against a real database (PR-0D) | Ungoverned instructions in every prompt | Unknown until inventoried | Medium (provisional) | PR-0D |
| SEC-11 | Principal propagation: every warehouse read runs on the datasource's one stored credential; no per-user warehouse identity exists | `datasource_service.py:1057+` | OBSERVED, a design fact, not a defect | Row/column policy cannot be warehouse-enforced today | n/a | Architectural (ADR-002) | PR-1F threat model |
| SEC-12 | Public stream writes memory | `api/public.py:5362` | Structural (call site read) | See SEC-08 | n/a | Folded into SEC-08 | PR-0B2 |

**Severity is not a ranking of urgency alone.** SEC-01 with SEC-09 is the one
cross-dataset read chain. It is contained in two places: the router gate (PR-0B3, not
protected) and the engine validator (PR-0C, protected). The gate goes first because it
does not need the protected-change approval.

## Threat model (data access, AI tools, knowledge, public, sharing)

**Assets:**
- warehouse rows (via the datasource credential);
- hidden columns (GovernAIScope);
- KPI definitions and instructions (integrity);
- the metadata store;
- cost (warehouse bytes, LLM tokens).

**Principals:**
- human session;
- PAT;
- shared-flow editor;
- delegated caller;
- anonymous public viewer;
- embed grant;
- system job.

| Boundary | Threat (STRIDE) | Existing control | Gap (this matrix) | Foundation control |
|---|---|---|---|---|
| Caller → governed read | Elevation: borrow the owner's rights | `run_scope` ∩ caller (live chat) | SEC-03 | EffectivePrincipal; GQS refuses a scope without a principal |
| Caller → governed read | Elevation: verb confusion (view vs explore) | Dataset policy | SEC-09 | GQS requires `explore` per relation |
| Query text → warehouse | Information disclosure: subquery or injection in user expressions | Identifier quoting; substring guard | SEC-01 | AST allow-list in the engine (PR-0C); GQS refuses `calculated_fields` from AI tools until then |
| Query → warehouse | DoS / cost: unbounded rows, bytes or time | Query Runner bounds; BQ `maximum_bytes_billed` | SEC-02; no cancel | GQS bounds + cancel (PR-1C/1D) |
| Policy lookup | Tampering by failure: fail-open | Logging | SEC-05, SEC-04 | Fail closed (`policy_unavailable`) |
| Knowledge → prompt | Spoofing authority: draft/observed as official | Status column | SEC-07, SEC-08, SEC-10 | Authority contract (spec §4) |
| Public viewer → memory | Tampering: poisoning via repeated questions | `forced_candidate` for anonymous teaching | SEC-08 (bot findings not forced) | No auto-promotion |
| Artifact → viewer | Disclosure through a shared snapshot | n/a (no Analysis artifact yet) | Design | ADR-012 re-evaluation |
| AI → outside | Exfiltration via web tools | Pack gating; `reaches_outside` | SEC-04 | Fail-closed capability default |

**Out of scope for Phase 0 tests (stated, not hidden):**
- live-warehouse exploitation;
- timing and side channels;
- LLM prompt-injection robustness of the Analyst (Phase 3 benchmark: "unauthorized
  data access", "knowledge conflicts");
- embed/public flows beyond SEC-12.
