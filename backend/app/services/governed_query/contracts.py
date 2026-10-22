"""What a governed read is asked with and what it hands back (spec §2.1, §2.2).

Plain frozen dataclasses: GQS is a service, not an HTTP schema, and no route
exposes it yet (PR-1G decides that, after the ledger, bounds and cancel land).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from app.services.governed_query.principal import EffectivePrincipal

Purpose = Literal["answer", "explore_rows", "profile", "chart_render"]


@dataclass(frozen=True)
class RelationRef:
    """WHAT is queried: always a governed relation, never SQL text (I-5).
    `dataset_table` and `ephemeral` are reserved (ADR-003) and refused today."""

    kind: Literal["semantic_explore", "dataset_table"]
    id: int
    model_id: Optional[int] = None


@dataclass(frozen=True)
class QueryBounds:
    """Execution bounds. A request may only LOWER them (I-8)."""

    max_rows: int
    timeout_seconds: int
    bq_max_bytes: int

    def as_dict(self) -> dict:
        return {"max_rows": self.max_rows, "timeout_seconds": self.timeout_seconds,
                "bq_max_bytes": self.bq_max_bytes}


@dataclass(frozen=True)
class SemanticAsk:
    """The question in semantic terms: qualified refs only (`view.field`). It is
    compiled to the SAME `SemanticQuerySpec` chart and preview use. There is no
    field for SQL: calculated fields, window functions and aggregation overrides
    are not part of what GQS accepts in its first release (spec §2.3
    `unsupported_expression`)."""

    dimensions: tuple[str, ...] = ()
    measures: tuple[str, ...] = ()
    filters: dict = field(default_factory=dict)
    sorts: tuple[dict, ...] = ()
    time_grains: dict = field(default_factory=dict)
    limit: Optional[int] = None
    # Escape hatches, accepted as input ONLY so a caller that sends them is
    # refused by name instead of silently ignored.
    calculated_fields: tuple[dict, ...] = ()
    window_functions: tuple[dict, ...] = ()
    measure_agg_overrides: dict = field(default_factory=dict)


@dataclass(frozen=True)
class GovernedQueryRequest:
    principal: EffectivePrincipal
    relation: RelationRef
    ask: SemanticAsk
    purpose: Purpose = "answer"
    requested_bounds: Optional[QueryBounds] = None
    run_id: Optional[str] = None
    #: I-6: a server-issued consent token (governed_query.consent) by which the
    #: USER accepted that the named filters are dropped from THIS exact query.
    #: A bare list of filter ids is not accepted: the model cannot mint a token.
    drop_consent: Optional[str] = None


@dataclass(frozen=True)
class ColumnMeta:
    name: str
    ref: Optional[str]
    role: Literal["dimension", "measure", "unknown"]


@dataclass(frozen=True)
class Freshness:
    """How current the rows are. `mode` is the base table's query mode as stored
    (`synced`, `live`, ...); a snapshot generation is added when GQS reads one."""

    mode: str


@dataclass(frozen=True)
class QueryEvidence:
    query_id: str
    principal_ref: str
    relations: tuple[RelationRef, ...]
    datasets: tuple[int, ...]
    datasource_id: int
    semantic_epoch: str
    dialect: str
    sql_fingerprint: str
    policy_fingerprint: str
    filters_applied: tuple[str, ...]
    filters_dropped: tuple[dict, ...]          # empty unless the user accepted each one
    bounds: QueryBounds
    rows_returned: int
    truncated: bool
    bytes_processed: Optional[int]            # None: this adapter does not report it
    duration_ms: int
    freshness: Freshness
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class GovernedQueryResult:
    columns: tuple[ColumnMeta, ...]
    rows: list[dict[str, Any]]
    truncated: bool
    evidence: QueryEvidence


@dataclass(frozen=True)
class CompiledQuery:
    """Everything decided BEFORE anything reaches a warehouse. `plan()` returns
    it; `execute()` runs it. The SQL is kept off the evidence (only its hash)."""

    query_id: str
    request: GovernedQueryRequest
    sql: str
    dialect: str
    ds_type: str
    datasource: Any
    dataset_ids: tuple[int, ...]
    bounds: QueryBounds
    semantic_epoch: str
    sql_fingerprint: str
    policy_fingerprint: str
    filters_applied: tuple[str, ...]
    filters_dropped: tuple[dict, ...]
    columns: tuple[ColumnMeta, ...]
    freshness: Freshness
    key_probes: tuple = ()
    consent_nonce: Optional[str] = None
    warnings: tuple[str, ...] = ()
