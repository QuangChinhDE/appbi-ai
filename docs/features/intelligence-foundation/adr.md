# AppBI Intelligence — Architecture Decision Records

These are the decisions that bind every Intelligence PR.

**Status values:**
- `ACCEPTED (PO)`: decided by the Product Owner in the program mandate of 2026-10-19.
- `ACCEPTED (eng)`: an engineering decision inside a PO decision.
- `PROPOSED`: needs approval.
- `OPEN`: blocked on evidence.

Each ADR ends with:
- an **anti-drift rule**: what an implementing agent must not do;
- its **enforcement**: the check that holds the rule. `PROPOSED` enforcement does not
  exist yet. Until it lands, the rule is review-only, and must be named so.

The source-of-truth order of `AGENTS.md` still applies: an executable check beats this
file.

---

## ADR-001 — One governed execution boundary for analytical reads

**Status:** ACCEPTED (PO)

Every NEW analytical data read goes through the Governed Query Service (GQS). That covers:
- AI tools;
- the Analyst;
- profiling;
- any new preview.

GQS owns:
- authorization;
- governed relation resolution;
- compilation through the existing semantic engine;
- the execution policy;
- bounds;
- audit;
- cancellation;
- evidence;
- refusals.

Existing chart, preview and `/semantic/query` paths migrate onto it one path at a time,
each behind tests. There is no single rewrite PR.

GQS is a service in the monolith (`backend/app/services/governed_query/`). It reuses this
existing sequence:

```
compile_from_semantic_request → SemanticQueryEngine.run
  → refuse_foreign_live_sources → verify_key_probes
  → DataSourceConnectionService.execute_query
```

That sequence is in `routers/semantic.py:880-914`.

- **Anti-drift:**
  - No AI tool or Analyst code calls `DataSourceConnectionService.execute_query`, a
    connector, or a warehouse client directly.
  - No second SQL generator.
  - No GQS "fast path" that skips policy.
- **Enforcement:**
  - PROPOSED: an import-boundary check in `scripts/ci/`. Under
    `services/agent_flows/**`, `services/intelligence/**` and `services/dashboard_ai_bot/tools*`,
    importing `DataSourceConnectionService` or `connectors.*` fails, except through
    `governed_query`.
  - The same rule as a `guardrail_rules.yaml` layer.

## ADR-002 — Effective principal; policy that cannot be enforced refuses

**Status:** ACCEPTED (PO). The mechanism per datasource is OPEN (intent Q1).

Every Analyst/GQS execution carries one `EffectivePrincipal` (see `spec.md` §1). Rules:
- **No owner-borrowing.** It is never widened to the rights of a flow owner, a link
  assigner or a datasource owner.
  - The effective scope is one formula, intersection only (`spec.md` §1, I-1):
    the asker's live rights ∧ the surface ceiling ∧ policy constraints.
  - **No delegation term in GQS or the default Analyst.** Agent Flow's existing explicit
    delegation (`agent_flow_delegations`, `permissions.run_scope`) can lend an owner's
    resource beyond the grantee's own rights. GQS does not honour it. Any mechanism
    that acts beyond the asker's rights needs its own ADR (proposed ADR-018), threat
    model, grant lifecycle and tests first.
- **Metadata, aggregates and raw rows are distinct grants:**
  - `datasets: view` = metadata, plus aggregated reads through charts the caller may
    read;
  - `explore` = governed queries and raw rows;
  - datasource metadata access is a separate decision, and never implies querying.
- **Row/column restrictions are part of the target model.** An adapter that cannot
  enforce a restriction that applies to the principal refuses the query
  (`policy_unenforceable`). It does not run it unrestricted.
- **App-layer row policy over a shared service credential is NOT declared safe** until
  it has a threat model and adversarial tests (PR-1F).

- **Anti-drift:**
  - No `getattr(ctx, "<capability>", True)`-style defaults.
  - No `except: return set()` on a policy lookup.
  - No run that recomputes scope without the caller.
  - (SEC-03, SEC-04, SEC-05 are exactly these.)
- **Enforcement:**
  - The ledger tests SEC-03/04/05/09 in
    `backend/tests/test_intelligence_phase0_security_repro.py`.
  - PROPOSED: a static rule forbidding a truthy default on capability `getattr`.

## ADR-003 — Source Catalog: discovery separate from execution

**Status:** ACCEPTED (PO)

A persisted, ACL-filtered metadata catalog. It holds:
- sources, schemas, tables and columns, with types;
- source comments;
- estimated row counts;
- schema-drift state;
- links to the Dataset, semantic and governance assets that already reference them.

Profiling and sample values are a SEPARATE capability. They need a read grant and a
budget, and run through GQS.

The AI may DISCOVER catalog assets outside Datasets within the metadata the principal may
see. It may QUERY only governed relations.

Ephemeral governed relations, built from catalog tables without a published Dataset, are
designed but disabled until ADR-002's mechanism is validated.

- **Anti-drift:**
  - The catalog never stores sample rows.
  - A catalog search result is never executable by itself.
  - No AI path queries a table because the catalog found it.
- **Enforcement:**
  - PROPOSED: a catalog contract test asserts the persisted schema has no row-value
    columns.
  - PROPOSED: a GQS test asserts that a catalog-only table is refused
    (`not_a_governed_relation`).

## ADR-004 — The semantic engine is the analytical compiler; it is protected, not frozen

**Status:** ACCEPTED (PO)

Tier 1 is the existing engine. GQS calls it and does not wrap it with a parallel SQL
builder. Extensions go through the protected-change process:
- plan approval;
- golden gates;
- BigQuery and Postgres structure checks.

- **Anti-drift:**
  - No SQL string assembly outside the engine for governed reads.
  - No flipping of symmetric or propagation defaults.
- **Enforcement:**
  - `guardrail_rules.yaml: protected.semantic_layer`.
  - The golden suites.

## ADR-005 — Analytical tiers; advanced SQL is in the target, gated by measured gaps

**Status:** ACCEPTED (PO). The thresholds are PROPOSED.

The tiers are:
- **T1:** governed semantic query.
- **T2b:** governed extract plus deterministic compute (the existing compute tools over
  a bounded GQS result).
- **T3:** guarded advanced SQL.

T3 is not built in Phase 0–1. It is enabled per capability class only when ALL of these
hold:
1. On the sealed holdout and on production question logs, ≥ X% of failures are
   classified "expressiveness". Knowledge, data or reasoning failures do not count.
2. Extending T1/T2b for that class is shown to cost more than T3.
3. T3 does not reduce accuracy on questions T1 already answers.
4. AST-level relation/column policy, a read-only warehouse role, a cost estimate, and
   row/byte/time bounds are all tested.

X and the observation window are calibrated in the benchmark (Phase 3), not now.

- **Anti-drift:** no raw-SQL tool, flag or "temporary" path for the AI before this ADR
  is satisfied.
- **Enforcement:**
  - The ADR-001 import check.
  - PROPOSED: a registry test that no tool declares `data_exposure="sql"`.

## ADR-006 — Business Context Graph with provenance, authority and lifecycle

**Status:** ACCEPTED (PO). The schema is PROPOSED (Phase 4).

The existing governance entities are the graph's nodes:
- GovernMetric + Binding;
- GlossaryTerm;
- Rule;
- Playbook;
- VerifiedQA;
- Caveat;
- AIScope;
- KnowledgeDoc.

New edges are typed and carry:
- provenance (`authored`, `imported`, `observed`, `proposed`);
- `authority_tier` (`certified`, `authored`, `observed`, `proposed`);
- lifecycle;
- evidence.

A Business Domain is a thin entity: owner, policy scope, and `member_of_domain` edges.
There is no second Knowledge Hub.

- **Anti-drift:** no new store for knowledge that duplicates a governance entity.
- **Enforcement:**
  - `KNOWLEDGE_DOMAIN_MODEL.md` ownership.
  - PROPOSED: a check that any new knowledge table is registered in that file.

## ADR-007 — Only certified knowledge is presented as authoritative; the AI never promotes itself

**Status:** ACCEPTED (PO)

- Only certified knowledge may be injected with authoritative wording ("ĐỊNH NGHĨA
  CHÍNH THỐNG", "PHẢI"). Today, certified means `Approved` / `Published` by a human.
- Draft knowledge is never presented as official.
- Knowledge the AI observed may be stored as a candidate. Only a human approval moves it
  further; recurrence alone never does.
- **Playbooks distinguish two kinds of step:**
  - `recommendation`: the AI may deviate, and must say so;
  - `mandatory_check`: certified, and the verifier asserts it ran.
  - (Schema in Phase 4.)

- **Anti-drift:** no code path writes `validated` or `Approved` with an AI or bot actor.
- **Enforcement:**
  - Ledger tests SEC-07 and SEC-08.
  - PROPOSED: a static rule that `status = "validated"` assignments in `dashboard_ai_bot/`
    sit only behind a human-actor branch.

## ADR-008 — Evaluation is sealed from retrieval

**Status:** ACCEPTED (PO)

- `EvalCase` and its holdout split live in their own store. They are never readable by
  any retriever or prompt builder.
- A trusted asset (VerifiedQA, SQL example) is never also a holdout answer.
- A leakage check compares holdout questions against trusted-asset triggers.
- Eval runs on an isolated knowledge snapshot, and memory capture is off.
- Historical eval reports are baselines, not certification.

- **Anti-drift:**
  - `GovernVerifiedQA.as_test` must not become a holdout source.
  - No eval in the tenant's live knowledge.
- **Enforcement:** PROPOSED (PR-0E): an import-boundary test (no runtime module imports
  the eval store), plus the leakage-check test.

## ADR-009 — Playbook ≠ Reasoning Plan ≠ Workflow

**Status:** ACCEPTED (PO)

- **Playbook:** knowledge that informs a plan. It is never executed directly.
- **Analytical Reasoning Plan:** a per-question runtime artifact of the Analyst.
- **Workflow:** Agent Flow. It is durable and handles triggers and approvals. It calls
  the Analyst as a capability (`run_analysis`). It is not required to chat.

- **Anti-drift:**
  - The Analyst does not require a published flow.
  - Agent Flow does not reimplement analysis.
- **Enforcement:** PROPOSED (Phase 3): an Analyst test with zero flows and zero
  dashboards.

## ADR-010 — The Analyst runtime is decoupled from `AgentNode`

**Status:** ACCEPTED (eng), within ADR-009.

Reuse the tool-calling strategy, the claim/number verifier and the tool registry gates.
The binding is a new Analyst entry, not a patched Direct Chat.

- **Anti-drift:** no "default flow" auto-published so that Direct Chat appears to work
  without one.

## ADR-011 — Analysis is an artifact; promotion goes through the permission-checked services

**Status:** ACCEPTED (PO)

An `Analysis` holds:
- the question;
- the plan;
- the governed query specs;
- the result snapshots with security provenance;
- the claims with evidence;
- the caveats;
- the tier used.

Promotion to Chart, Dashboard or Report goes through `ChartService.create` /
`POST /dashboards/`, under the PROMOTING user's own rights. There are no direct row
inserts. The HTML-import direct insert at `dashboard_html_import_service.py:5638` is not
a model to follow.

| Result tier | Promotes to |
|---|---|
| T1 | a live chart |
| T2b | a snapshot, or a live chart if the computation is expressible as a measure |
| T3 | a custom-SQL chart (`require_custom_sql_authority`) or a snapshot |

- **Anti-drift:** no `Chart(...)` / `DashboardChart(...)` construction in Intelligence
  code.
- **Enforcement:** PROPOSED: a static rule in `scripts/ci/`.

## ADR-012 — Sharing re-evaluates the viewer

**Status:** ACCEPTED (PO)

An artifact containing data records its security provenance:
- the principal;
- the relations;
- the policy fingerprint.

Viewing it re-checks the viewer:
- live parts re-execute under the viewer;
- snapshot parts are shown only if the viewer passes the same policy for every relation
  in the provenance;
- otherwise they are withheld, with a reason.

An "author's scope" label alone is insufficient.

## ADR-013 — The 404'd governance routes stay 404

**Status:** ACCEPTED (PO)

`metadata_catalog/api.py:46-60` stays. A future Business Context Studio surface gets
its own module key and permission model (Phase 4). It is never mapped onto `govern` or
any wider key.

- **Enforcement:** existing (the route-contract test). PROPOSED: a regression test
  asserting the `_DELETED_PREFIXES` answer 404.

## ADR-014 — Orphaned Approved knowledge is inventoried and quarantined

**Status:** ACCEPTED (PO). The default is OPEN (intent Q2).

An inventory of Approved rules, playbooks, QA, instructions and AI scope that no surface
can edit (PR-0D). The quarantine policy is applied at injection time and is reversible.

## ADR-015 — Every security finding carries a verification status

**Status:** ACCEPTED (PO)

`REPRODUCED` / `REFUTED` / `NOT VERIFIED`, backed by a test or a reason. Severity
weighs impact, likelihood and evidence. Containment does not wait for a successful
exploit. No penetration attempts on production or customer data.

## ADR-016 — Cost is bounded per run, per user and per datasource

**Status:** ACCEPTED (PO). The values are PROPOSED (`spec.md` §2.5).

Bounds are configured per deployment and workspace. A request cannot raise them.

AI execution has its OWN hard limits (for example `AI_BQ_MAX_BYTES_PER_QUERY`). They are
always the minimum of the AI limit and the warehouse ceiling. The AI never inherits the
whole warehouse ceiling (`BQ_MAX_BYTES_BILLED`) as its budget.

## ADR-017 — Strangler migration; one reasoning engine in the end

**Status:** ACCEPTED (PO)

A legacy AI path retires only when its replacement has a parity test and acceptance.
Several reasoning engines may coexist during migration, each with a named retirement
milestone. They do not coexist indefinitely.
