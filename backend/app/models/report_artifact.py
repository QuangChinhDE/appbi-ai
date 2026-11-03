"""Report-as-Code: a full-page HTML/CSS/JS report bound to governed AppBI data.

A report is a row plus an append-only list of revisions. Every save, AI generation,
AI edit or restore adds a revision; nothing rewrites one. The draft and the published
report are POINTERS to revisions, so publishing is one pointer move and rolling back
is pointing at an older revision — the published content can never be edited in place.

The code itself never holds data or queries: `bindings` names saved charts (the same
Chart Configuration + Query Core every dashboard uses) and `filters` names the semantic
dimensions a viewer may filter by. Both are resolved server-side on every data request.
"""
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.core.database import Base


class ReportArtifact(Base):
    __tablename__ = "report_artifacts"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True, index=True)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    draft_revision_id = Column(
        Integer, ForeignKey("report_artifact_revisions.id", ondelete="SET NULL", use_alter=True,
                            name="fk_report_artifacts_draft_revision"), nullable=True)
    published_revision_id = Column(
        Integer, ForeignKey("report_artifact_revisions.id", ondelete="SET NULL", use_alter=True,
                            name="fk_report_artifacts_published_revision"), nullable=True)

    public_token = Column(String(64), nullable=True, unique=True, index=True)
    public_enabled = Column(Boolean, nullable=False, default=False, server_default=text("false"))

    # The AI job in flight ({kind, state, step, started_at, error, revision}); in the
    # row, not in memory, because any of the API workers may answer the poll.
    job = Column(JSONB, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    last_published_at = Column(DateTime(timezone=True), nullable=True)


class ReportArtifactRevision(Base):
    __tablename__ = "report_artifact_revisions"
    __table_args__ = (UniqueConstraint("artifact_id", "number", name="uq_report_artifact_revision_number"),)

    id = Column(Integer, primary_key=True, index=True)
    artifact_id = Column(Integer, ForeignKey("report_artifacts.id", ondelete="CASCADE"), nullable=False, index=True)
    number = Column(Integer, nullable=False)

    html = Column(Text, nullable=False, default="")
    css = Column(Text, nullable=False, default="")
    js = Column(Text, nullable=False, default="")
    # [{id, chart_id, title, kind}] — the only data this revision can ever receive.
    bindings = Column(JSONB, nullable=False, default=list)
    # [{key, label, kind, fieldKey, field, datasetId}] — the only filters a viewer may set.
    filters = Column(JSONB, nullable=False, default=list)

    source = Column(String(32), nullable=False, default="manual")
    note = Column(Text, nullable=True)
    content_hash = Column(String(64), nullable=False)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ReportArtifactPublicLink(Base):
    """A named public link of a Report-as-Code report — the same security model as a
    dashboard's DashboardPublicLink: its own token, password, expiry, on/off switch,
    locked/hidden filters and appearance. A link only ever serves the PUBLISHED
    revision. Deleting or disabling a link revokes its URL; there is no other lookup."""
    __tablename__ = "report_artifact_public_links"

    id = Column(Integer, primary_key=True, index=True)
    artifact_id = Column(Integer, ForeignKey("report_artifacts.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    token = Column(String(64), nullable=False, unique=True, index=True)
    # [{field: <report filter key>, operator, value, hidden}] — locked server-side.
    filters_config = Column(JSONB, nullable=False, default=list)
    appearance_config = Column(JSONB, nullable=False, default=dict)
    is_active = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    expires_at = Column(DateTime(timezone=True), nullable=True)
    password_hash = Column(String(255), nullable=True)
    # Security generation: bumped by every security-changing edit; a password session
    # carries the generation it was minted at (services/public_link_session).
    auth_version = Column(Integer, nullable=False, default=0, server_default="0")
    access_count = Column(Integer, nullable=False, default=0, server_default="0")
    last_accessed_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    @property
    def has_password(self) -> bool:
        return bool(self.password_hash)
