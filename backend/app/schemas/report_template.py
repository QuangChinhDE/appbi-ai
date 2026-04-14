"""
Pydantic schemas for report templates.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Block sub-schemas (used inside the blocks JSON array)
# ---------------------------------------------------------------------------

class TemplateBlockLayout(BaseModel):
    """Pixel-based position for a single block on the page canvas."""
    x: float = 48
    y: float = 48
    width: float = 698
    height: float = 100


class TemplateBlock(BaseModel):
    """A single block inside a template."""
    id: str = Field(..., description="Client-generated UUID")
    type: str = Field(..., description="title | table | signature | text | spacer | image")
    layout: TemplateBlockLayout
    config: Dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Template CRUD schemas
# ---------------------------------------------------------------------------

class ReportTemplateBase(BaseModel):
    """Shared fields for create / response."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    page_size: str = Field("A4", description="A4 | A3 | Letter")
    orientation: str = Field("portrait", description="portrait | landscape")


class ReportTemplateCreate(ReportTemplateBase):
    """Request body for creating a template."""
    blocks: List[TemplateBlock] = Field(default_factory=list)
    filters: List[Dict[str, Any]] = Field(default_factory=list)


class ReportTemplateUpdate(BaseModel):
    """Request body for updating a template (all fields optional)."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    page_size: Optional[str] = None
    orientation: Optional[str] = None
    blocks: Optional[List[TemplateBlock]] = None
    filters: Optional[List[Dict[str, Any]]] = None


class ReportTemplateResponse(ReportTemplateBase):
    """JSON sent back to the client."""
    id: int
    blocks: List[Dict[str, Any]] = Field(default_factory=list)
    filters: List[Dict[str, Any]] = Field(default_factory=list)
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
