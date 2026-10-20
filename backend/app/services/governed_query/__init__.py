"""Governed Query Service (ADR-001, spec §1–§2).

The ONE execution boundary for analytical reads made for the AI Analyst and the
other new paths. This package is built in milestones (plan.md, Phase 1):

  1A  principal.py — EffectivePrincipal + AuthorizationContext
  1B  contracts.py, bounds.py, audit.py, service.py — request / result /
      evidence / refusals over the existing semantic engine sequence
  1C  budgets      1D  cancellation      1E  audit ledger (the AuditSink)

NOT LIVE: no route, tool or Analyst uses it, and `execute` refuses
`audit_unavailable` until the PR-1E ledger exists. A new query path must not go
live before its policy, audit, limits and refusal tests are in place (PO
mandate, step 10).
"""
from app.services.governed_query.principal import (  # noqa: F401
    AuthorizationContext,
    EffectivePrincipal,
    GovernedRefusal,
    SurfaceCeiling,
)
from app.services.governed_query.contracts import (  # noqa: F401
    ColumnMeta,
    CompiledQuery,
    Freshness,
    GovernedQueryRequest,
    GovernedQueryResult,
    QueryBounds,
    QueryEvidence,
    RelationRef,
    SemanticAsk,
)
from app.services.governed_query.service import AI_SURFACES, GovernedQueryService  # noqa: F401
