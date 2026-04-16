"""Pydantic schemas for report templates."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


def _default_template_definition() -> Dict[str, Any]:
    return {
        "version": 3,
        "layout": "table",
        "columns": [],
        "header": {"title": ""},
    }


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
    blocks: Any = Field(default_factory=_default_template_definition, description="TemplateDefinition v3")
    filters: List[Dict[str, Any]] = Field(default_factory=list)


class ReportTemplateUpdate(BaseModel):
    """Request body for updating a template (all fields optional)."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    page_size: Optional[str] = None
    orientation: Optional[str] = None
    blocks: Optional[Any] = Field(None, description="TemplateDefinition v3")
    filters: Optional[List[Dict[str, Any]]] = None


class ReportTemplateResponse(ReportTemplateBase):
    """JSON sent back to the client."""
    id: int
    blocks: Any = Field(default_factory=_default_template_definition, description="TemplateDefinition v3")
    filters: List[Dict[str, Any]] = Field(default_factory=list)
    owner_id: Optional[UUID] = None
    owner_email: Optional[str] = None
    user_permission: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
