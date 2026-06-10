"""Pydantic schemas for the workspace public-facing API.

A "workspace" is the bundle of workboards a non-AppBI end-user sees behind
a single ``/w/{token}`` URL. Authentication uses Workboard app-user rows
stored by AppBI; screen RLS maps that identity onto dataset rows.

These schemas are kept separate from ``schemas.py`` so editing the workboard
runtime/layout layer does not accidentally break the public auth surface.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# Access modes the public link supports.
#   - "internal": only AppBI staff can open the workspace.
#     Preview/runtime use the AppBI session.
#   - "public_app_users": workers/foremen log in with PIN against a
#     Workboard app-user row stored by AppBI.
WorkspaceAccessMode = Literal["internal", "public_app_users"]


class AppUserPayload(BaseModel):
    """Shape of an app-user row inside an export bundle.

    The bundle stores users next to the workboard so re-importing is
    self-contained — no separate dataset wiring needed. ``pin_hash`` is
    optional: bundles exported with credentials excluded omit it, and
    admins set fresh PINs after import.
    """

    username: str = Field(..., min_length=1, max_length=255)
    pin_hash: Optional[str] = Field(
        default=None,
        max_length=255,
        description=(
            "Bcrypt-hashed PIN. Omitted in bundles exported with "
            "include_credentials=false; admin must set a PIN after import."
        ),
    )
    full_name: Optional[str] = Field(default=None, max_length=255)
    role: Optional[str] = Field(default=None, max_length=64)
    active: bool = Field(default=True)
    context: Dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="ignore")


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
    # Screen ids hidden ON THIS PUBLIC LINK ONLY — the builder/layout is
    # untouched (still shows every screen), but the public runtime drops these
    # from the nav and blocks their content endpoints. Lets an owner expose
    # only some workspaces/screens of an app through a given Cổng.
    hidden_screen_ids: List[str] = Field(default_factory=list)

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
    access_mode: WorkspaceAccessMode = "internal"
    # Mirrors access_mode == "public_app_users". Kept as an explicit field
    # so older FE clients that only check ``requires_login`` keep working.
    # Default tracks access_mode="internal" → no PIN login.
    requires_login: bool = False


class WorkspaceMenuResponse(BaseModel):
    workspace: WorkspaceMetaPublic
    app_user: WorkspaceAppUserPublic
    menu: List[WorkspaceMenuItemPublic]


class WorkspaceMetaResponse(BaseModel):
    """Returned for unauthenticated GET /public/workspaces/{token} so the FE
    can render the login screen with proper branding before user logs in."""

    workspace: WorkspaceMetaPublic
