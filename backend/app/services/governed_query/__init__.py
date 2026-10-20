"""Governed Query Service (ADR-001, spec §1–§2).

The ONE execution boundary for analytical reads made for the AI Analyst and the
other new paths. This package is built in milestones (plan.md, Phase 1):

  1A  principal.py — EffectivePrincipal + AuthorizationContext (this module)
  1B  the service: request / result / evidence / refusals over the existing
      semantic engine sequence
  1C  bounds and budgets      1D  cancellation      1E  audit ledger

Nothing here executes a query yet, and no route uses it. A new query path must not
go live before its policy, audit, limits and refusal tests are in place (PO
mandate, step 10).
"""
from app.services.governed_query.principal import (  # noqa: F401
    AuthorizationContext,
    EffectivePrincipal,
    GovernedRefusal,
    SurfaceCeiling,
)
