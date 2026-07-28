"""Pydantic schemas for personal access tokens."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.personal_access_tokens import PAT_MAX_EXPIRES_IN_DAYS


class PersonalAccessTokenCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    scopes: dict[str, str]
    expires_in_days: int | None = Field(default=None, ge=1, le=PAT_MAX_EXPIRES_IN_DAYS)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("Token name is required")
        return name


class PersonalAccessTokenUpdate(PersonalAccessTokenCreate):
    pass


class PersonalAccessTokenResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    token_hint: str
    scopes: dict[str, str] = {}
    revealable: bool = False
    last_used_at: datetime | None = None
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class PersonalAccessTokenCreateResponse(BaseModel):
    token: str
    item: PersonalAccessTokenResponse


class PersonalAccessTokenRevealResponse(BaseModel):
    token: str


class AdminPersonalAccessTokenResponse(PersonalAccessTokenResponse):
    """Token row enriched with owner identity — for the admin oversight view."""

    owner_id: uuid.UUID
    owner_email: str
    owner_name: str
