"""Schemas for HTML dashboard import preview/build responses."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.schemas import DashboardResponse


class DashboardHtmlImportCalculatedField(BaseModel):
    """A calculated field suggested by AI during HTML import analysis."""

    name: str
    expression: str
    label: Optional[str] = None
    source_key: Optional[str] = None


class DashboardHtmlImportAnalyzeResponse(BaseModel):
    """Preview payload returned after analyzing imported HTML."""

    suggested_dashboard_name: str
    document_title: Optional[str] = None
    source_profile: Dict[str, Any] = Field(default_factory=dict)
    chart_plans: List[Dict[str, Any]] = Field(default_factory=list)
    calculated_fields: List[DashboardHtmlImportCalculatedField] = Field(default_factory=list)
    ignored_blocks: List[Dict[str, Any]] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    ai_meta: Dict[str, Any] = Field(default_factory=dict)


class DashboardHtmlImportTypeChange(BaseModel):
    """Tracks when HTML visuals are converted to a supported native chart type."""

    block_id: Optional[str] = None
    title: Optional[str] = None
    from_chart_type: Optional[str] = Field(default=None, alias="from")
    to_chart_type: Optional[str] = Field(default=None, alias="to")
    note: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)


class DashboardHtmlImportBuildResponse(BaseModel):
    """Result payload after materializing the imported dashboard."""

    dashboard: DashboardResponse
    dashboard_id: int
    created_chart_count: int
    type_changes: List[DashboardHtmlImportTypeChange] = Field(default_factory=list)
    page_id: str
    page_name: str
    dataset_id: Optional[int] = None
    dataset_table_id: Optional[int] = None
    dataset_table_ids: Optional[Dict[str, int]] = Field(
        default=None,
        description="Mapping of source_key to dataset_table_id for multi-file imports.",
    )
