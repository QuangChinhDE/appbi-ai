"""
Module-level permission matrix — admin assigns per-user access to each module.
"""
import enum

from sqlalchemy import Column, Integer, String, DateTime, Enum, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.core.database import Base


class Module(str, enum.Enum):
    DATASOURCE = "datasource"
    DATASET = "dataset"
    WORKSPACE = "workspace"
    CHART = "chart"
    DASHBOARD = "dashboard"
    CHAT = "chat"
    EXPLORE = "explore"


class ModulePermissionLevel(str, enum.Enum):
    NONE = "none"
    VIEW = "view"
    EDIT = "edit"


class ModulePermission(Base):
    """
    Each row = one cell in the permission matrix:
    user_id × module → permission level (none / view / edit).
    If no row exists for a (user, module) pair, the role default applies.
    """
    __tablename__ = "module_permissions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    module = Column(
        Enum(Module, values_callable=lambda obj: [e.value for e in obj], name="module_enum"),
        nullable=False,
    )
    permission = Column(
        Enum(ModulePermissionLevel, values_callable=lambda obj: [e.value for e in obj], name="module_permission_level_enum"),
        nullable=False,
        default=ModulePermissionLevel.NONE,
    )
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "module", name="uq_module_permission"),
    )
