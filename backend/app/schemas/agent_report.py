"""
Pydantic schemas for saved AI Agent report specs and runs.
"""
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


BuildMode = Literal["new_dashboard", "new_version", "replace_existing"]
ReportSpecStatus = Literal["draft", "ready", "running", "failed", "archived"]
ReportRunStatus = Literal["queued", "planning", "building", "succeeded", "failed"]


class AgentReportSpecBase(BaseModel):
    name: str = Field(..., min_length=3, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    selected_tables_snapshot: List[Dict[str, Any]] = Field(default_factory=list)
    brief_json: Dict[str, Any] = Field(default_factory=dict)
    approved_plan_json: Optional[Dict[str, Any]] = None


class AgentReportSpecCreate(AgentReportSpecBase):
    latest_dashboard_id: Optional[int] = None
    status: ReportSpecStatus = "draft"


class AgentReportSpecUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=3, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    selected_tables_snapshot: Optional[List[Dict[str, Any]]] = None
    brief_json: Optional[Dict[str, Any]] = None
    approved_plan_json: Optional[Dict[str, Any]] = None
    latest_dashboard_id: Optional[int] = None
    status: Optional[ReportSpecStatus] = None


class AgentReportRunBase(BaseModel):
    build_mode: BuildMode = "new_dashboard"
    input_brief_json: Dict[str, Any] = Field(default_factory=dict)
    plan_json: Dict[str, Any] = Field(default_factory=dict)
    target_dashboard_id: Optional[int] = None


class AgentReportRunCreate(AgentReportRunBase):
    status: ReportRunStatus = "queued"


class AgentReportRunUpdate(BaseModel):
    status: Optional[ReportRunStatus] = None
    error: Optional[str] = None
    dashboard_id: Optional[int] = None
    target_dashboard_id: Optional[int] = None
    result_summary_json: Optional[Dict[str, Any]] = None
    plan_json: Optional[Dict[str, Any]] = None
    input_brief_json: Optional[Dict[str, Any]] = None
    finished_at: Optional[datetime] = None


class AgentReportRunResponse(AgentReportRunBase):
    id: int
    report_spec_id: int
    triggered_by: Optional[UUID] = None
    dashboard_id: Optional[int] = None
    status: ReportRunStatus
    error: Optional[str] = None
    result_summary_json: Optional[Dict[str, Any]] = None
    created_at: datetime
    finished_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class AgentReportSpecResponse(AgentReportSpecBase):
    id: int
    owner_id: Optional[UUID] = None
    latest_dashboard_id: Optional[int] = None
    status: ReportSpecStatus
    last_run_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AgentReportSpecDetailResponse(AgentReportSpecResponse):
    runs: List[AgentReportRunResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)
