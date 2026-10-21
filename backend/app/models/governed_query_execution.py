"""The durable audit ledger of governed reads (spec §2.4, PR-1E).

One row per governed query the Governed Query Service is asked to run. The row
is written (status ``running``) and COMMITTED before anything reaches a
warehouse, and finalized afterwards. If that first write fails, the query is
refused (I-7). Refusals decided before execution get a terminal row of their own.

What it never holds: the SQL text, result rows, literal filter values, secrets.
Only fingerprints, ids, bounds, counters and outcomes.

Design decisions. The table contract (status/finish constraints, the primary
key, the app role's missing DELETE/TRUNCATE) is locked by
tests/test_intelligence_gqs_ledger_schema_pg.py; the write contracts below
(begin/finish/recovery/cancel requests) belong to the ledger service, which is
NOT yet implemented:

* ``query_id`` is the primary key, minted by GQS (uuid4 hex). ``begin`` is
  insert-only: a second ``begin`` for the same id is a conflict, never an
  overwrite, so a replayed request cannot rewrite history.
* Terminal states are final. ``finish`` moves a row from ``running`` to one
  terminal status with a conditional UPDATE; the first terminal write wins, a
  repeat of the SAME terminal status is idempotent, and a different terminal
  status after that is rejected (no flip from ``cancelled`` to ``ok``).
* ``user_id`` has NO foreign key on purpose: deleting a person must not delete
  (CASCADE) or anonymise (SET NULL) the record of what was read on their behalf.
* ``worker_id`` + ``heartbeat_at`` are the lease of a running row. A row whose
  worker stopped heart-beating is recovered to ``abandoned`` by
  ``recover_stale_running`` — never deleted, never silently re-run.
* ``cancel_requested_at`` / ``cancel_requested_by`` are how one worker asks the
  worker that OWNS a running query to cancel it (cross-worker cancel, PR-1D).
  The owner performs the cancel on its own connection; no worker ever signals a
  backend id it does not own (a reused pid would hit someone else's query).
* ``reserved_bq_bytes`` is the BigQuery bytes ceiling a query RESERVED at begin
  (its bound), so a per-user/per-run bytes budget is counted conservatively and
  atomically even though the executor does not report billed bytes.
"""
from __future__ import annotations

from sqlalchemy import BigInteger, CheckConstraint, Column, DateTime, Index, Integer, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.core.database import Base

TERMINAL_STATUSES = ("ok", "refused", "error", "cancelled", "timeout", "abandoned")
ALL_STATUSES = ("running",) + TERMINAL_STATUSES


class GovernedQueryExecution(Base):
    __tablename__ = "governed_query_executions"

    query_id = Column(String(64), primary_key=True)
    run_id = Column(String(64), nullable=True)
    user_id = Column(UUID(as_uuid=True), nullable=True)          # no FK: the record outlives the user
    principal_kind = Column(String(16), nullable=False)
    surface = Column(String(32), nullable=False)
    relation_kind = Column(String(32), nullable=True)
    relation_id = Column(Integer, nullable=True)
    dataset_ids = Column(JSONB, nullable=True)
    datasource_id = Column(Integer, nullable=True)
    dialect = Column(String(32), nullable=True)
    sql_fingerprint = Column(String(64), nullable=True)
    policy_fingerprint = Column(String(64), nullable=True)
    bounds = Column(JSONB, nullable=True)
    reserved_bq_bytes = Column(BigInteger, nullable=True)
    status = Column(String(16), nullable=False)
    refusal_code = Column(String(64), nullable=True)
    rows_returned = Column(Integer, nullable=True)
    bytes_processed = Column(BigInteger, nullable=True)
    worker_id = Column(String(128), nullable=True)
    started_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    heartbeat_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    duration_ms = Column(Integer, nullable=True)
    cancel_requested_at = Column(DateTime(timezone=True), nullable=True)
    cancel_requested_by = Column(UUID(as_uuid=True), nullable=True)

    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'ok', 'refused', 'error', 'cancelled', 'timeout', 'abandoned')",
            name="ck_gqe_status",
        ),
        CheckConstraint(
            "(status = 'running') = (finished_at IS NULL)",
            name="ck_gqe_terminal_has_finish",
        ),
        Index("ix_gqe_user_started", "user_id", "started_at"),
        Index("ix_gqe_run", "run_id"),
        Index("ix_gqe_running_worker", "worker_id", postgresql_where=text("status = 'running'")),
    )
