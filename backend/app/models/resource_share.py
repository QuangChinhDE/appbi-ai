"""ResourceShare model — per-resource access control for users and teams."""

import enum

from sqlalchemy import CheckConstraint, Column, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base


class ResourceType(str, enum.Enum):
    DASHBOARD = "dashboard"
    CHART = "chart"
    DATASET = "dataset"
    DATASET_MODEL = "dataset_model"
    DATASOURCE = "datasource"
    CHAT_SESSION = "chat_session"
    WORKBOARD = "workboard"
    KNOWLEDGE_DOC = "knowledge_doc"


class SharePermission(str, enum.Enum):
    VIEW   = "view"
    EDIT   = "edit"


class ResourceShare(Base):
    __tablename__ = "resource_shares"

    id = Column(Integer, primary_key=True, index=True)
    resource_type = Column(Enum(ResourceType, values_callable=lambda obj: [e.value for e in obj]), nullable=False)
    resource_id = Column(String, nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), nullable=True)
    permission = Column(Enum(SharePermission, values_callable=lambda obj: [e.value for e in obj]), nullable=False, default=SharePermission.VIEW)
    shared_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "((user_id IS NOT NULL AND team_id IS NULL) OR (user_id IS NULL AND team_id IS NOT NULL))",
            name="ck_resource_shares_single_target",
        ),
        UniqueConstraint("resource_type", "resource_id", "user_id", name="uq_resource_shares_user"),
        UniqueConstraint("resource_type", "resource_id", "team_id", name="uq_resource_shares_team"),
    )

    # Relationships
    user = relationship("User", back_populates="shares_received", foreign_keys=[user_id])
    team = relationship("Team", back_populates="shares", foreign_keys=[team_id])
    shared_by_user = relationship("User", back_populates="shares_given", foreign_keys=[shared_by])

    @property
    def target_type(self) -> str:
        return "team" if self.team_id is not None else "user"
