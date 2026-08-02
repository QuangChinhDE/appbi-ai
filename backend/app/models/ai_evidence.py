"""Evidence ledger — one row per tool call the assistant made.

This is what turns "the answer sounds right" into "the answer is checkable".
Every number the assistant prints must be traceable to a row here, and through
it to the chart, the filter set and the moment the data was read.

Deliberately NOT a copy of the tool payload: `numbers` holds the flattened
numeric values (what the verifier compares against) and `payload_digest` holds
a scrubbed, image-free summary. A raw copy would blow the table up with base64
chart PNGs and make retention unmanageable.

Scope columns are `dashboard_id` / `link_token` / `session_key`, not a tenant
id — AppBI is single-tenant and the real isolation unit is the shared link.

Rows are disposable: a retention pass drops anything older than
INTELLIGENCE_EVIDENCE_TTL_DAYS. Evidence supports the answer at the time it was
given; it is not a permanent audit of the warehouse.
"""
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    JSON,
    String,
)
from sqlalchemy.sql import func

from app.core.database import Base


class AiEvidence(Base):
    __tablename__ = "ai_evidence"

    id = Column(Integer, primary_key=True, autoincrement=True)

    # Correlates every row produced by one question→answer turn. Kept as an
    # opaque string so it works before the flow runtime lands (where it becomes
    # the ai_runs UUID) and after.
    run_ref = Column(String(64), nullable=False, index=True)
    node_key = Column(String(64), nullable=True)

    dashboard_id = Column(Integer, nullable=False, index=True)
    link_token = Column(String(200), nullable=True)
    session_key = Column(String(64), nullable=True)

    tool_name = Column(String(64), nullable=False)
    # sha256 of the canonicalised args — identical calls collapse in analysis
    # without storing arguments that may carry filter values.
    args_hash = Column(String(64), nullable=False)

    # {"chart_id": 120, "metric_ids": [...], "dimension_ids": [...]}
    source_ref = Column(JSON, nullable=True)
    # Hash of the merged public filters in force. A number is only "the same
    # number" under the same filter scope, so the verifier keys on this.
    filter_hash = Column(String(64), nullable=True)

    # Flattened numeric values found anywhere in the tool result. This is the
    # set the deterministic verifier matches the answer's figures against.
    numbers = Column(JSON, nullable=False, default=list)
    # Scrubbed summary of the result (no images, no base64, capped).
    payload_digest = Column(JSON, nullable=True)

    row_count = Column(Integer, nullable=True)
    truncated = Column(Boolean, nullable=False, default=False)
    ok = Column(Boolean, nullable=False, default=True)

    created_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )

    __table_args__ = (
        # Verifier reads every row of one turn.
        Index("ix_ai_evidence_run", "run_ref"),
        # Retention sweep + per-dashboard analytics.
        Index("ix_ai_evidence_dash_created", "dashboard_id", "created_at"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "run_ref": self.run_ref,
            "node_key": self.node_key,
            "tool_name": self.tool_name,
            "source_ref": self.source_ref or {},
            "numbers": self.numbers or [],
            "row_count": self.row_count,
            "truncated": bool(self.truncated),
            "ok": bool(self.ok),
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
