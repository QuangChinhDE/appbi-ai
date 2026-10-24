# AppBI Intelligence — Foundation (Phase 0–1) — intent

**Status:** in progress — Phase 0 started; Phase 1 awaiting plan approval
**Owner:** Product Owner (program GO, 2026-10-19); engineering by Claude Code
**Date:** 2026-10-19
**Baseline:** `origin/demo` @ `1bac25e8f68c5ff6e5ddeaf8c6ed0dbea4938676`

## Problem

AppBI has a working AI prototype. Its safety and correctness depend on the surface a
question happens to arrive through:

- A signed-in user cannot ask the AI anything until someone has published an Agent Flow
  for chat (`direct_chat.py:105-171`).
- The AI reads data in one way only: through existing charts (`tools/context.py:772`).
  It cannot answer a question no chart was built for.
- Each read path decides authorization, limits and audit for itself:
  - `/semantic/query` gates at dataset `view` (`routers/semantic.py:110-117`);
  - the schema-browser preview has no row ceiling (`api/datasources.py:559-573`);
  - the ad-hoc Query Runner is bounded (`datasource_service.py:1145-1175`);
  - the AI-scope column filter fails open (`tools/context.py:656-724`).
- Knowledge the AI is told to treat as official includes:
  - Draft KPIs (`knowledge_context.py:420-437`);
  - the bot's own repeated findings (`knowledge.py:181-186`);
  - Approved rules, playbooks and Q&A, which no route can edit or revoke any more
    (`metadata_catalog/api.py:46-60`).

The product direction is one governed AI Analyst as the default entry point. That
cannot be built on read paths that disagree about who may see what.

## Goal

Every analytical data read made for the AI goes through ONE Governed Query Service that:

- knows the effective principal;
- enforces policy, failing closed;
- bounds cost;
- records audit and evidence.

The known security findings are reproduced as tests and contained. The first AI Analyst
vertical slice can then be built on that seam, not around it.

## Out of scope (this foundation)

- **The AI Analyst runtime and its UI.** That is Phase 3. This foundation provides the
  seam and the contracts it consumes.
- **Advanced/guarded SQL.** It stays in the target architecture (ADR-005) but is not
  built.
- **Ephemeral governed relations over raw catalog tables.** They are conditional on the
  policy model (ADR-002) and are not enabled.
- **Public/embed Analyst.** Legacy public behaviour stays as it is and is protected.
- **Re-opening the 404'd governance routes.** A new, separately permissioned surface is
  Phase 4 (ADR-013).
- **Rewriting the semantic engine.** It is protected. Changes go through the
  protected-change process with golden gates.
- **Migrating every existing chart/preview path in one change.** Migration is
  per-path, behind tests.

## Constraints

- **Protected subsystems:**
  - semantic layer (`semantic_query_engine.py`, join resolver, `relationship_key_guard`,
    `execution_plan`);
  - public-link security (`api/public.py`, `app/d`, `app/embed`);
  - engineering infrastructure (`scripts/ci`, `.github`, guardrail, `.claude`).
- **One authorization contract already exists.** `app/core/authz/decision.py`
  (`can`/`require`/`scope`), with the Dataset verbs view ⊂ explore ⊂ build ⊂ edit ⊂
  manage (`dataset_grants_service.py:44-52`). The effective principal builds on it and
  does not create a second one.
- **Single-tenant, one stored credential per datasource.** Row-level policy cannot rely
  on warehouse identity today. Where a policy cannot be enforced, execution refuses
  (ADR-002).
- **Dialects.** SQL must stay valid on BigQuery and Postgres.
- **Modular monolith.** No microservice split.

## Acceptance criteria (foundation)

1. Each finding in `security-matrix.md` has a status (`REPRODUCED`, `REFUTED`,
   `NOT VERIFIED`) backed by an executable test or a stated reason. No finding is
   reported as an exploit without a runtime reproduction.
2. Each reproduced finding has a containment change. Its reproduction test flips from
   `xfail(strict)` to a passing regression lock in the same commit.
3. A caller with a dataset `view` grant and no `explore` is refused by the governed
   query path. An `explore` grant is served. Both are asserted.
4. A governed query that would drop a security or business filter is refused with a
   machine-readable reason. It is never silently answered.
5. Every governed execution writes an audit record that names:
   - the effective principal;
   - the resource;
   - the compiled-query fingerprint;
   - the bounds applied;
   - rows, bytes and duration;
   - the outcome.
6. Row, time and bytes bounds are enforced server-side. A request cannot lift them.
7. The semantic golden and protected-public suites stay green, unchanged.
8. Cancellation of a running governed query is demonstrated on Postgres. On BigQuery it
   is demonstrated only when a warehouse is available. Otherwise it is recorded as
   `NOT VERIFIED` with the reason.

## Open questions

- **Q1.** Per-datasource enforcement mechanism for row/column policy: a
  warehouse-native identity, or app-layer predicates over a shared credential? The PO
  ruled that app-layer plus a shared credential is not declared safe without a threat
  model and adversarial tests (ADR-002). Which adapters are in the pilot? The proposal
  is Postgres and BigQuery. Owner: PO + engineering.
- **Q2.** Disposition of the orphaned Approved knowledge. The policy is decided
  (inventory, then review/quarantine, ADR-014). The quarantine default — keep injecting
  with a "legacy, unreviewed" label, or stop injecting until reviewed — needs a PO
  call. Engineering recommendation: stop presenting it as authoritative immediately,
  and keep it visible to the AI only as "unreviewed legacy" until reviewed.
- **Q3.** Initial budget values (per run, per user, per datasource). These are an
  engineering proposal in `spec.md`, to be calibrated after benchmarks.
