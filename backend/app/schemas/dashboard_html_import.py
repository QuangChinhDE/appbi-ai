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
    derived_tables: List[Dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "Derived-table operations declared by the AppBI Import Plan v1 "
            "(``dataset_ops[op='derived_table']``). Materialized at build time "
            "as per-chart customSql bindings; not directly persisted."
        ),
    )
    ignored_blocks: List[Dict[str, Any]] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    ai_meta: Dict[str, Any] = Field(default_factory=dict)

    # ── Dashboard-level contract ────────────────────────────────────────────
    # These are the fields that make an import produce a REPORT rather than a
    # pile of charts. `build_dashboard_from_import` has always read them off the
    # analysis dict, but they were never declared here — and because the client
    # round-trips this response back to /build, Pydantic dropped every one on
    # serialisation. The theme branch in build was therefore unreachable from
    # any UI flow, which is why an imported dashboard always landed on the
    # default look no matter what the source HTML declared.
    theme_config: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Report theme in AppBI's own token vocabulary — templateId / "
            "colorwayId plus any explicit tokens. Never raw CSS."
        ),
    )
    layout_mode: Optional[str] = Field(
        default=None, description="'grid' | 'canvas'."
    )
    canvas_config: Optional[Dict[str, Any]] = Field(
        default=None, description="Free-canvas size/snap, when layout_mode='canvas'."
    )
    slicer_cluster_layout: Optional[Dict[str, Any]] = Field(
        default=None,
        description=(
            "Where the filters live: position (top/bottom/left/right/drawer/"
            "hidden) + direction. Derived from the source's own filter bar or "
            "rail so an imported report keeps its filter UX."
        ),
    )
    slicers: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Filter controls recognised in the source, as slicer entries.",
    )
    pages_config: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Page list, when one document expands into several pages.",
    )
    widgets: List[Dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "Non-chart blocks — section headers, callouts, text, images. These "
            "carry the source's visual hierarchy; dropping them was what turned "
            "an imported report into a bag of loose charts."
        ),
    )
    template_family: Optional[str] = Field(
        default=None,
        description=(
            "console | brief | ops | editorial | presentation — the layout "
            "family the source most resembles, chosen by AI when the HTML "
            "carries no AppBI metadata of its own."
        ),
    )


class DashboardHtmlImportBatchAnalyzeDocumentResponse(BaseModel):
    """Analyze result for one HTML document in a batch import."""

    document_id: str
    filename: Optional[str] = None
    page_name: str
    analysis: DashboardHtmlImportAnalyzeResponse


class DashboardHtmlImportBatchAnalyzeResponse(BaseModel):
    """Preview payload returned after analyzing multiple imported HTML documents."""

    suggested_dashboard_name: str
    document_count: int
    documents: List[DashboardHtmlImportBatchAnalyzeDocumentResponse] = Field(default_factory=list)


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


class DashboardHtmlImportBatchBuildPageResponse(BaseModel):
    """Build result for one HTML document/page in a batch import."""

    document_id: str
    filename: Optional[str] = None
    page_id: str
    page_name: str
    created_chart_count: int
    type_changes: List[DashboardHtmlImportTypeChange] = Field(default_factory=list)


class DashboardHtmlImportBatchBuildResponse(BaseModel):
    """Result payload after materializing multiple imported HTML documents."""

    dashboard: DashboardResponse
    dashboard_id: int
    created_chart_count: int
    pages: List[DashboardHtmlImportBatchBuildPageResponse] = Field(default_factory=list)
    dataset_id: Optional[int] = None
    dataset_table_id: Optional[int] = None
    dataset_table_ids: Optional[Dict[str, int]] = Field(
        default=None,
        description="Mapping of source_key to dataset_table_id for multi-file imports.",
    )
