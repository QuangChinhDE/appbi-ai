"""
Audit log model — tracks security-relevant events for compliance and investigation.
"""
import enum
import uuid

from sqlalchemy import Column, DateTime, Enum, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.sql import func

from app.core.database import Base


class AuditAction(str, enum.Enum):
    LOGIN_SUCCESS = "login_success"
    LOGIN_FAILED = "login_failed"
    LOGOUT = "logout"
    TOKEN_REFRESHED = "token_refreshed"
    PASSWORD_CHANGED = "password_changed"
    PERMISSION_DENIED = "permission_denied"
    USER_CREATED = "user_created"
    USER_DEACTIVATED = "user_deactivated"
    USER_PERMISSIONS_CHANGED = "user_permissions_changed"
    PUBLIC_LINK_CREATED = "public_link_created"
    PUBLIC_LINK_ACCESSED = "public_link_accessed"
    PUBLIC_LINK_DELETED = "public_link_deleted"
    SHARE_CREATED = "share_created"
    SHARE_REVOKED = "share_revoked"
    DATASOURCE_CONNECTED = "datasource_connected"
    DATA_EXPORTED = "data_exported"


class AuditSeverity(str, enum.Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    ip_address = Column(String(45), nullable=True)  # IPv4 or IPv6
    user_agent = Column(String(512), nullable=True)
    action = Column(
        Enum(AuditAction, values_callable=lambda obj: [e.value for e in obj]),
        nullable=False,
        index=True,
    )
    resource_type = Column(String(64), nullable=True)
    resource_id = Column(String(64), nullable=True)
    details = Column(JSONB, nullable=True)
    severity = Column(
        Enum(AuditSeverity, values_callable=lambda obj: [e.value for e in obj]),
        nullable=False,
        server_default="info",
    )
