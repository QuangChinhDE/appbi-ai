"""
Pydantic schemas for authentication, users, and sharing.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional, Dict
from pydantic import BaseModel, EmailStr, Field, field_validator, ConfigDict

from app.models.user import UserStatus
from app.models.resource_share import ResourceType, SharePermission


# ── Auth ─────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1)


# ── Users ─────────────────────────────────────────────────────────────────────
# Defined before TokenResponse so Pydantic v2 can resolve the annotation
# immediately at class-definition time (no forward-ref needed).

class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=8)


class UserUpdate(BaseModel):
    full_name: Optional[str] = Field(None, min_length=1, max_length=255)
    status: Optional[UserStatus] = None


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    status: UserStatus
    permissions: Dict[str, str] = {}
    last_login_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


# ── Shares ────────────────────────────────────────────────────────────────────

class ShareCreate(BaseModel):
    user_id: uuid.UUID
    permission: SharePermission = SharePermission.VIEW


class ShareUpdate(BaseModel):
    permission: SharePermission


class ShareResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    resource_type: ResourceType
    resource_id: str
    user_id: uuid.UUID
    permission: SharePermission
    shared_by: uuid.UUID
    created_at: datetime
    user: Optional[UserResponse] = None


class ShareAllTeamRequest(BaseModel):
    permission: SharePermission = SharePermission.VIEW
