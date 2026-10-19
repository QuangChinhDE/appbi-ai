# AppBI Intelligence — Foundation contracts — spec

These are the engineering contracts Phase 0–1 builds and Phase 3+ consumes.

- **Names are proposals. The invariants are the contract.**
- Each contract names the existing code it reuses.
- A contract change goes through this file, in the same PR as the code.

---

## 1. EffectivePrincipal / AuthorizationContext

**Reuses:**
- `app/core/authz/decision.py`: `can`, `require`, `scope`, `Action`;
- the Dataset policy `services/dataset_grants_service.dataset_capabilities`;
- delegations `models/agent_flow_delegation.py` with `permissions.active_delegations`.

It does NOT introduce a second policy engine.

```python
# backend/app/services/governed_query/principal.py
@dataclass(frozen=True)
class EffectivePrincipal:
    user_id: UUID                     # the live user the decision is made for
    kind: Literal["human", "pat", "delegated", "system"]
    surface: Literal["analyst", "agent_flow", "studio_test", "chart", "preview", "profile"]
    delegation: Delegation | None     # only for kind="delegated"; see I-3
    request_id: str                   # correlation id carried into audit + evidence

@dataclass(frozen=True)
class Delegation:
    brain_key: str
    delegation_ids: tuple[int, ...]   # agent_flow_delegations rows consulted this turn
    resources: frozenset[tuple[str, int]]   # (resource_type, id) lent explicitly

class AuthorizationContext:
    """The ONE object GQS asks. Built per request, never cached across requests."""
    def __init__(self, db, principal: EffectivePrincipal): ...
    def decide(self, action: Action, resource) -> Decision: ...
    def require(self, action: Action, resource) -> None: ...   # raises GovernedRefusal
```

**Invariants:**

- **I-1** `decide(action, r)` = `authz.can(db, live_user, action, r)`, then:
  - **narrowed** by the surface ceiling (e.g. `studio_test` may not exceed the flow's
    attached resources);
  - **extended** only by I-3.
- **I-2** There is no constructor path from an owner, an assigner or a datasource owner
  identity. A `System` principal exists only for scheduler entry points (authz spec §1).
  It is refused by GQS for `surface="analyst"`.
- **I-3** Delegation:
  - authority = (caller's live decision) ∪ (resources the owner explicitly delegated to
    this caller, for this flow, not revoked, which the owner still holds);
  - each lent resource is audited as `via=delegation:<id>`;
  - **no implicit delegation** ("the flow owner may read it" is not a delegation).
- **I-4** A principal that cannot be resolved means refusal (`not_authenticated`). There
  is no anonymous principal in the first release (public/embed Analyst is out of
  scope).

**Verb mapping:**

| Purpose | Required action on each relation's Dataset |
|---|---|
| governed aggregate or row query | `explore` |
| metadata / schema / semantic definitions | `read` (= verb `view`) |
| promote result to a chart | `build` |

The datasource is a separate resource:
- metadata = datasource `read`;
- preview or profiling of a table that is in no Dataset requires a datasource-level
  read grant. PR-0B3 caps it; PR-2B makes it a distinct action.

## 2. Governed Query Service (GQS)

**Location:** `backend/app/services/governed_query/` (service layer; modular monolith).

**Reuses, in this order** (the sequence `routers/semantic.py:880-914` already runs):

```
semantic_query_compiler.compile_*  →  SemanticQueryEngine.run(spec)
  →  execution_plan.refuse_foreign_live_sources
  →  relationship_key_guard.verify_key_probes
  →  DataSourceConnectionService.execute_query(limit, timeout_seconds, max_rows, maximum_bytes_billed)
```

The bounding pattern is the Query Runner's (`datasource_service.py:1145-1175`):
- server-clamped rows;
- bounded timeout;
- READ ONLY transaction on Postgres and MySQL;
- `maximum_bytes_billed` on BigQuery.

### 2.1 Request

```python
@dataclass(frozen=True)
class GovernedQueryRequest:
    principal: EffectivePrincipal
    relation: RelationRef            # what is queried, never raw SQL
    spec: SemanticQuerySpec          # the SAME contract chart + preview use
    purpose: Literal["answer", "explore_rows", "profile", "chart_render"]
    requested_bounds: QueryBounds | None = None   # can only LOWER policy bounds
    run_id: str | None = None        # Analyst/flow run correlation

@dataclass(frozen=True)
class RelationRef:
    kind: Literal["semantic_explore", "dataset_table"]   # "ephemeral" reserved, disabled (ADR-003)
    id: int
    model_id: int | None = None
```

### 2.2 Result and evidence

```python
@dataclass(frozen=True)
class GovernedQueryResult:
    columns: list[ColumnMeta]        # name, semantic ref, type, unit, role (dim|measure)
    rows: list[dict]
    truncated: bool
    evidence: QueryEvidence

@dataclass(frozen=True)
class QueryEvidence:
    query_id: str                    # also the audit row key
    principal_ref: str               # user id + kind + surface (no PII beyond id)
    relations: list[RelationRef]
    datasets: list[int]
    semantic_epoch: str              # the cache epoch the registry already computes
    dialect: str
    sql_fingerprint: str             # sha256 of the compiled SQL; the SQL itself only for `explore`+
    filters_applied: list[AppliedFilter]   # each tagged security | business | user
    filters_dropped: list               # MUST be empty on success (I-6)
    bounds: QueryBounds              # what was actually enforced
    rows_returned: int
    bytes_processed: int | None      # BigQuery job stats; None where the engine cannot say
    duration_ms: int
    freshness: Freshness             # live | snapshot(as_of) | published(generation)
    policy_fingerprint: str          # hash of the policy inputs (grants, AI scope, delegation)
```

### 2.3 Refusals

Each is a typed `GovernedRefusal(code, message_vi, detail)`. The code is
machine-readable, and every refusal is audited.

| code | When |
|---|---|
| `not_authenticated` | no principal |
| `not_a_governed_relation` | catalog-only table; ephemeral relations disabled |
| `not_authorized` | a relation lacks the required action (§1) |
| `policy_unavailable` | a policy lookup (AI scope, grants, delegation) failed: **fail closed** (fixes the SEC-05 class) |
| `policy_unenforceable` | a row/column restriction applies, and this adapter cannot enforce it (ADR-002) |
| `column_excluded` | the spec references a GovernAIScope-excluded column for an AI surface |
| `filter_would_drop` | the engine reports a propagation drop for a security- or business-tagged filter |
| `unsupported_expression` | `calculated_fields` or window SQL from an AI surface, until PR-0C lands the AST allow-list |
| `budget_exceeded` / `cost_estimate_exceeded` | run, user or datasource budget; BQ dry-run estimate over cap |
| `foreign_live_source` / `key_probe_failed` | from `execution_plan` / `relationship_key_guard`, passed through unchanged |
| `timeout` / `cancelled` | execution bounds |
| `audit_unavailable` | the pre-execution audit row could not be written (I-7) |

**Invariants:**

- **I-5** GQS never executes caller-supplied SQL text. T3 is a future, separate contract
  (ADR-005).
- **I-6** A user-tagged filter the engine drops is returned in `filters_dropped`, and
  the answer layer must disclose it. A security- or business-tagged one is a refusal,
  never a silent answer.
- **I-7** Audit is written BEFORE execution (`status=running`) and finalized after. If
  the first write fails, the query is refused. That is why the existing best-effort
  `audit_service.audit` is not the GQS ledger.
- **I-8** Bounds are `min(policy, requested)`. Nothing in a request raises a bound.
- **I-9** Same spec + same principal + same epoch → same `sql_fingerprint`. This makes
  evidence reproducible.

### 2.4 Audit ledger (schema: PR-1E, migration, needs approval)

`governed_query_executions` holds:
- `query_id` (pk), `run_id`, `user_id`, `principal_kind`, `surface`;
- `relation_kind`, `relation_id`, `dataset_ids` (json), `datasource_id`;
- `sql_fingerprint`, `policy_fingerprint`;
- `bounds` (json);
- `status` (`running | ok | refused | error | cancelled | timeout`), `refusal_code`;
- `rows_returned`, `bytes_processed`;
- `started_at`, `finished_at`, `duration_ms`.

It is additive, single head, with no backfill. It never stores result rows or literal
filter values beyond their tags.

### 2.5 Bounds and budgets: engineering proposal, calibrate in the Phase 3 benchmark

| Bound | Proposed default | Existing anchor |
|---|---|---|
| rows per query (AI context) | 5,000 fetched; what reaches the model is still `max_rows_per_call` | `SOURCE_QUERY_MAX_ROWS`, binding `max_rows_per_call` |
| timeout per query | 60 s | Query Runner caps at 300 s |
| BigQuery bytes per query | `settings.BQ_MAX_BYTES_BILLED` | existing |
| queries per Analyst run | 12 | `BudgetContract` (12 LLM calls, 40 tools) |
| bytes per run | 5 × per-query cap | n/a |
| per user per day | 300 queries | n/a |
| concurrent queries per datasource | 4 | n/a |

These are configured per deployment and workspace (ADR-016). Exceeding one returns
`budget_exceeded`, with the bound named.

### 2.6 Cancellation (PR-1D)

A per-process registry `query_id → canceller`:
- **Postgres:** `pg_cancel_backend(pid)` on the backend pid captured at execution.
- **BigQuery:** `job.cancel()` on the job id.
- **MySQL:** `KILL QUERY <id>`.

Cancel is idempotent. The state becomes `cancelled` in the ledger. Cross-process cancel
in multi-worker deployments goes through the ledger row (a worker polls its own running
ids). That is a PR-1D design decision, and it is tested on Postgres.

## 3. Source Catalog (metadata contract, PR-2A/2B)

Tables, all additive:
- `catalog_objects`:
  - `datasource_id`, `kind` (`schema | table | view`), `schema_name`, `name`,
    `source_comment`, `est_row_count`;
  - `fingerprint` (a hash of the column list and types);
  - `first_seen_at`, `last_seen_at`, `drift_state` (`ok | added | changed | removed`);
- `catalog_columns`:
  - `object_id`, `name`, `ordinal`, `physical_type`, `nullable`, `source_comment`;
  - `is_pk`, `fk_ref`.

Links to existing assets are a projection, not copies: `DatasetTable.source_table_name`
and `datasource_id`, semantic views, metrics via bindings.

**Invariants:**

- **C-1** No row values, samples, distinct values, min or max are ever persisted here.
  Profiling is a separate, GQS-routed capability.
- **C-2** Visibility = datasource `read` for the principal. A search result never
  carries execution rights (`not_a_governed_relation` until it is a governed relation).
- **C-3** A refresh is a metadata-only read through the existing connectors' schema
  calls (`get_table_detail(..., preview_rows=0)` pattern, `datasource_service.py:4119`).
  It is bounded and audited as a `catalog_refresh` principal action.
- **C-4** Search is by name, comment and synonym (from glossary/metric synonyms where
  linked). Embedding search is Phase 4 retrieval, not this contract.

## 4. Business knowledge authority contract (PR-0B2 now, the full graph in Phase 4)

There is one function every prompt builder uses. Nothing decides authority locally.

```python
def authority_of(entity) -> Literal["certified", "authored", "observed", "proposed", "excluded"]
```

Mapping onto the EXISTING statuses (no schema change for Phase 0):

| Entity | certified | authored | observed / proposed | excluded |
|---|---|---|---|---|
| GovernMetric | `Approved` | `Draft`, `provider=user` | `Draft`, `provider=ai` → proposed | `Deprecated` |
| GovernKnowledgeDoc | `Published` | `Draft` | n/a | `Archived` |
| Rule / Playbook / VerifiedQA / AIInstruction | `Approved`, **and** a governing surface exists (else quarantined, ADR-014) | `Draft` | n/a | `Deprecated` / `archived` |
| AiBotKnowledge | `validated` with a human source (`user_taught` by a signed-in user, or review-approved) | n/a | `bot_finding` (any status) → observed; `candidate` → proposed | `retired` |

**Injection rule:**
- only `certified` may appear under authoritative wording;
- `authored` may appear only with an explicit "chưa duyệt" label, in a separate block;
- `observed` / `proposed` are never injected as facts.

PR-0B2 implements:
- the rule for GovernMetric (SEC-07);
- the "no auto-promotion" rule for AiBotKnowledge (SEC-08).

The rest lands with ADR-014 (PR-0D).

## 5. Analysis artifact contract (shape now, storage in Phase 3)

```python
Analysis {
  id, created_by, created_at, question, locale,
  plan: [Step{kind: query|compute|verify, rationale, query_ref?}],
  queries: [ {query_id, relation, spec, evidence: QueryEvidence} ],   # GQS evidence, verbatim
  results: [ {result_id, from_query_ids, kind: table|series|scalar, snapshot_ref, tier: T1|T2b|T3} ],
  claims: [ {text, value?, unit?, grain?, filters, evidence_refs:[result_id], verified: bool} ],
  caveats: [...], security_provenance: {principal_ref, relations, policy_fingerprints},
}
```

**Promotion** (ADR-011):
- T1 result → `ChartService.create` with a config derived from `spec`, under the
  promoting user, requiring `build`;
- otherwise a snapshot artifact.

**Viewing a shared Analysis** re-evaluates the viewer per relation (ADR-012).

## 6. Sealed evaluation contract (PR-0E)

- **Store:** `backend/eval/cases/*.yaml`, version-controlled fixtures. It is NOT a DB
  table, so no runtime path can query it.
- Each case has `split: dev | holdout`, plus:
  - `question` (vi/en);
  - `fixture` (a reproducible seed dataset);
  - `expected` (a deterministic SQL-result oracle computed from the fixture, not an LLM
    answer);
  - `tags` (from the benchmark list in the mandate).
- **Leakage check:** normalized-token similarity between every holdout question and
  every trusted-asset trigger/question in the eval's knowledge snapshot. Above a
  threshold, the case is excluded and reported.
- **Isolation:** the eval runs against a dedicated knowledge snapshot with memory
  capture disabled. No runtime module imports `backend/eval/**`, and an import-boundary
  test enforces it.
