"""Team and membership models for settings-managed user grouping."""

from __future__ import annotations

import uuid

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.database import Base


class Team(Base):
    __tablename__ = "teams"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(120), unique=True, nullable=False, index=True)
    description = Column(String(500), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    memberships = relationship(
        "TeamMembership",
        back_populates="team",
        cascade="all, delete-orphan",
        order_by="TeamMembership.created_at",
        overlaps="users,teams,team_memberships,user",
    )
    shares = relationship(
        "ResourceShare",
        back_populates="team",
        cascade="all, delete-orphan",
        foreign_keys="ResourceShare.team_id",
    )
    users = relationship(
        "User",
        secondary="team_memberships",
        viewonly=True,
        order_by="User.full_name",
        overlaps="memberships,team_memberships,team,user,teams",
    )


class TeamMembership(Base):
    __tablename__ = "team_memberships"

    team_id = Column(UUID(as_uuid=True), ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    team = relationship("Team", back_populates="memberships", overlaps="users,teams,team_memberships,user")
    user = relationship("User", back_populates="team_memberships", overlaps="users,teams,memberships,team")