"""Pydantic schemas for the workspace public-facing API.

A "workspace" is the bundle of workboards a non-AppBI end-user sees behind
a single ``/w/{token}`` URL. Authentication is delegated to a project-owned
table inside the workspace's dataset; AppBI never owns the user list.

These schemas are kept separate from ``schemas.py`` so editing the workboard
runtime/layout layer does not accidentally break the public auth surface.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class AppUsersConfig(BaseModel):
    """Tells the runtime which dataset table holds the workspace users.

    Each project chooses its own schema — AppBI just needs the column names
    so it can fetch credentials, evaluate role-based menus, and feed RLS
    expressions with ``{{app_user.*}}`` placeholders.
    """

    table_id: int = Field(..., description="dataset_tables.id holding the user list")
    username_column: str = Field(..., min_length=1, max_length=120)
    credential_column: str = Field(..., min_length=1, max_length=120)
    credential_kind: str = Field(
        default="bcrypt",
        description="How the credential column is hashed (bcrypt is the only supported value today)",
    )
    role_column: Optional[str] = Field(default=None, max_length=120)
    active_column: Optional[str] = Field(default=None, max_length=120)
    active_value: Any = Field(
        default=None,
        description="Value of active_column meaning 'enabled'. Defaults to truthy / 'ACTIVE' / true / 1.",
    )
    context_columns: List[str] = Field(
        default_factory=list,
        description="Extra columns to expose as {{app_user.<col>}} for RLS / lookup filters",
    )

    model_config = ConfigDict(extra="forbid")


class WorkspaceMenuItem(BaseModel):
    """One card in the post-login menu."""

    workboard_slug: str = Field(..., min_length=1, max_length=120)
    label: str = Field(..., min_length=1, max_length=120)
    description: Optional[str] = None
    icon: Optional[str] = None
    # Empty list means "visible to every logged-in app user".
    roles: List[str] = Field(default_factory=list)
    # Optional: route directly to a particular view inside the workboard
    # instead of the workboard default.
    view_id: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


class WorkspaceBranding(BaseModel):
    app_name: Optional[str] = None
    logo_url: Optional[str] = None
    primary_color: Optional[str] = None
    welcome_text: Optional[str] = None

    model_config = ConfigDict(extra="forbid")


# ── API request/response schemas ──────────────────────────────────────────

class WorkspaceLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=255)
    pin: str = Field(..., min_length=1, max_length=128)

    model_config = ConfigDict(extra="forbid")


class WorkspaceAppUserPublic(BaseModel):
    """Identity shape returned to the public client after login."""

    username: str
    role: Optional[str] = None
    full_name: Optional[str] = None
    context: Dict[str, Any] = Field(default_factory=dict)


class WorkspaceLoginResponse(BaseModel):
    session_token: str
    expires_in: int
    app_user: WorkspaceAppUserPublic


class WorkspaceMenuItemPublic(BaseModel):
    workboard_id: int
    workboard_slug: str
    label: str
    description: Optional[str] = None
    icon: Optional[str] = None
    view_id: Optional[str] = None


class WorkspaceMetaPublic(BaseModel):
    name: str
    description: Optional[str] = None
    branding: Optional[WorkspaceBranding] = None
    requires_login: bool = True


class WorkspaceMenuResponse(BaseModel):
    workspace: WorkspaceMetaPublic
    app_user: WorkspaceAppUserPublic
    menu: List[WorkspaceMenuItemPublic]


class WorkspaceMetaResponse(BaseModel):
    """Returned for unauthenticated GET /public/workspaces/{token} so the FE
    can render the login screen with proper branding before user logs in."""

    workspace: WorkspaceMetaPublic
