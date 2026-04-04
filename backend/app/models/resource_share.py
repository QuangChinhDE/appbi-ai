"""
ResourceShare model — per-resource access control.
"""
import enum

from sqlalchemy import Column, Integer, String, DateTime, Enum, ForeignKey, UniqueConstraint
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


class SharePermission(str, enum.Enum):
    VIEW   = "view"
    EDIT   = "edit"


class ResourceShare(Base):
    __tablename__ = "resource_shares"

    id = Column(Integer, primary_key=True, index=True)
    resource_type = Column(Enum(ResourceType, values_callable=lambda obj: [e.value for e in obj]), nullable=False)
    resource_id = Column(String, nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    permission = Column(Enum(SharePermission, values_callable=lambda obj: [e.value for e in obj]), nullable=False, default=SharePermission.VIEW)
    shared_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("resource_type", "resource_id", "user_id", name="uq_resource_shares"),
    )

    # Relationships
    user = relationship("User", back_populates="shares_received", foreign_keys=[user_id])
    shared_by_user = relationship("User", back_populates="shares_given", foreign_keys=[shared_by])
