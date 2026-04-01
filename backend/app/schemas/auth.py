"""
Pydantic schemas for authentication, users, and sharing.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional, Dict, Literal
from pydantic import BaseModel, EmailStr, Field, field_validator, ConfigDict

from app.models.user import UserStatus
from app.models.resource_share import ResourceType, SharePermission

import re

_COMMON_PASSWORDS = frozenset([
    "password", "123456", "12345678", "qwerty", "abc123", "monkey", "master",
    "dragon", "111111", "baseball", "iloveyou", "trustno1", "sunshine",
    "princess", "welcome", "shadow", "superman", "michael", "football",
    "password1", "password123", "admin", "letmein", "1234567", "123456789",
    "12345", "1234567890", "0987654321", "000000", "654321", "qwerty123",
    "admin123", "admin1234", "passw0rd", "p@ssw0rd", "p@ssword",
])


def _validate_password_strength(password: str) -> str:
    """Enforce enterprise password policy."""
    errors: list[str] = []
    if len(password) < 8:
        errors.append("at least 8 characters")
    if not re.search(r"[A-Z]", password):
        errors.append("at least 1 uppercase letter")
    if not re.search(r"[a-z]", password):
        errors.append("at least 1 lowercase letter")
    if not re.search(r"\d", password):
        errors.append("at least 1 digit")
    if not re.search(r"[^A-Za-z0-9]", password):
        errors.append("at least 1 special character")
    if password.lower() in _COMMON_PASSWORDS:
        errors.append("must not be a commonly used password")
    if errors:
        raise ValueError("Password must contain: " + ", ".join(errors))
    return password


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

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        return _validate_password_strength(v)


class UserUpdate(BaseModel):
    full_name: Optional[str] = Field(None, min_length=1, max_length=255)
    status: Optional[UserStatus] = None
    preferred_language: Optional[Literal["en", "vi"]] = None


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    preferred_language: Literal["en", "vi"] = "en"
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

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        return _validate_password_strength(v)


class UserPreferencesUpdate(BaseModel):
    preferred_language: Literal["en", "vi"]


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
