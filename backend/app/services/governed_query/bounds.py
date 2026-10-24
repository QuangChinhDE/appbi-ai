"""Execution bounds for a governed read (spec §2.5, I-8).

The policy bound comes from deployment settings; a request can only lower it.
The BigQuery bytes bound for an AI query is its OWN hard limit
(`AI_BQ_MAX_BYTES_PER_QUERY`), never the warehouse ceiling inherited: the two are
compared and the smaller one is enforced on the job (`maximum_bytes_billed`).

Per-run and per-user-day BigQuery budgets need the ledger to count against
(PR-1C on top of PR-1E); they are not enforced here and nothing claims they are.
"""
from __future__ import annotations

from typing import Optional

from app.services.governed_query.contracts import QueryBounds


def policy_bounds() -> QueryBounds:
    from app.core.config import settings

    ai_bytes = int(settings.AI_BQ_MAX_BYTES_PER_QUERY)
    warehouse_ceiling = int(settings.BQ_MAX_BYTES_BILLED)
    return QueryBounds(
        max_rows=max(1, int(settings.GQS_MAX_ROWS)),
        timeout_seconds=max(1, int(settings.GQS_TIMEOUT_SECONDS)),
        bq_max_bytes=max(1, min(ai_bytes, warehouse_ceiling)),
    )


def effective_bounds(requested: Optional[QueryBounds]) -> QueryBounds:
    """min(policy, requested) per bound. A requested value below 1 is clamped up
    to 1, never read as "no bound"."""
    policy = policy_bounds()
    if requested is None:
        return policy

    def _low(p: int, r: Optional[int]) -> int:
        return p if r is None else max(1, min(p, int(r)))

    return QueryBounds(
        max_rows=_low(policy.max_rows, requested.max_rows),
        timeout_seconds=_low(policy.timeout_seconds, requested.timeout_seconds),
        bq_max_bytes=_low(policy.bq_max_bytes, requested.bq_max_bytes),
    )
