"""The audit contract GQS executes against (I-7).

GQS writes the audit row BEFORE anything reaches a warehouse and finalizes it
after. If that first write fails, the query is refused (`audit_unavailable`).
With NO sink, nothing executes: the durable ledger (`governed_query_executions`)
is PR-1E, and until it exists `GovernedQueryService.execute` refuses by
construction. The best-effort `audit_service.audit` is not this ledger: it
swallows its own failures, which is exactly what I-7 forbids.
"""
from __future__ import annotations

from typing import Any, Optional, Protocol


class AuditSink(Protocol):
    def begin(self, compiled: Any) -> None:
        """Record `status=running` for `compiled.query_id`. MUST raise if the row
        was not durably written."""

    def finish(self, query_id: str, *, status: str, refusal_code: Optional[str] = None,
               rows_returned: Optional[int] = None, bytes_processed: Optional[int] = None,
               duration_ms: Optional[int] = None) -> None:
        """Finalize the row: ok | refused | error | timeout | cancelled."""

    def refused(self, *, query_id: str, principal_ref: str, relation: Any, code: str) -> None:
        """A refusal decided before execution (nothing ran)."""
