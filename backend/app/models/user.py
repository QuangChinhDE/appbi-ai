"""
User model — authentication and status.
"""
import enum
import uuid

from sqlalchemy import Column, String, DateTime, Enum, ForeignKey, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base


class UserStatus(str, enum.Enum):
    ACTIVE = "active"
    DEACTIVATED = "deactivated"


class AuthProvider(str, enum.Enum):
    PASSWORD = "password"
    GOOGLE = "google"


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=True)
    auth_provider = Column(String(32), nullable=False, server_default=AuthProvider.PASSWORD.value, default=AuthProvider.PASSWORD.value)
    google_sub = Column(String(255), unique=True, nullable=True, index=True)
    avatar_url = Column(String(1024), nullable=True)
    google_oauth_email = Column(String(255), nullable=True)
    google_oauth_credentials = Column(String, nullable=True)
    google_oauth_scopes = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    google_oauth_connected_at = Column(DateTime(timezone=True), nullable=True)
    full_name = Column(String(255), nullable=False)
    preferred_language = Column(String(8), nullable=False, server_default="en")
    status = Column(Enum(UserStatus, values_callable=lambda obj: [e.value for e in obj]), nullable=False, default=UserStatus.ACTIVE)
    invited_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    permissions = Column(
        JSONB,
        nullable=False,
        server_default=text(
            '\'{"data_sources":"none","datasets":"none",'
            '"explore_charts":"none","dashboards":"none","ai_chat":"none","ai_agent":"none","settings":"none"}\''
            '::jsonb'
        ),
    )
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    # Relationships
    invited_by_user = relationship("User", remote_side=[id], foreign_keys=[invited_by])
    shares_received = relationship("ResourceShare", back_populates="user",
                                   foreign_keys="ResourceShare.user_id",
                                   cascade="all, delete-orphan")
    shares_given = relationship("ResourceShare", back_populates="shared_by_user",
                                foreign_keys="ResourceShare.shared_by")

    @property
    def has_password(self) -> bool:
        return bool(self.password_hash)

    @property
    def google_connected(self) -> bool:
        return bool(self.google_sub)
