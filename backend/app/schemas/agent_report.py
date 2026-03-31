"""
Pydantic schemas for saved AI Agent report specs and runs.
"""
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


BuildMode = Literal["new_dashboard", "new_version", "replace_existing"]
ReportSpecStatus = Literal["draft", "ready", "running", "failed", "archived"]
WizardStep = Literal["select", "brief", "plan", "building"]
ReportRunStatus = Literal[
    "queued",
    "planning",
    "parsing_brief",
    "selecting_datasets",
    "profiling_data",
    "quality_gate",
    "planning_analysis",
    "planning_charts",
    "building",
    "building_dashboard",
    "generating_insights",
    "composing_report",
    "succeeded",
    "failed",
]


class AgentReportSpecBase(BaseModel):
    name: str = Field(..., min_length=3, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    selected_tables_snapshot: List[Dict[str, Any]] = Field(default_factory=list)
    domain_id: Optional[str] = Field(default=None, max_length=100)
    domain_version: Optional[str] = Field(default=None, max_length=50)
    brief_json: Dict[str, Any] = Field(default_factory=dict)
    approved_plan_json: Optional[Dict[str, Any]] = None


class AgentReportSpecCreate(AgentReportSpecBase):
    latest_dashboard_id: Optional[int] = None
    status: ReportSpecStatus = "draft"
    current_step: WizardStep = "select"


class AgentReportSpecUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=3, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2000)
    selected_tables_snapshot: Optional[List[Dict[str, Any]]] = None
    domain_id: Optional[str] = Field(default=None, max_length=100)
    domain_version: Optional[str] = Field(default=None, max_length=50)
    brief_json: Optional[Dict[str, Any]] = None
    approved_plan_json: Optional[Dict[str, Any]] = None
    latest_dashboard_id: Optional[int] = None
    status: Optional[ReportSpecStatus] = None
    current_step: Optional[WizardStep] = None


class AgentReportRunBase(BaseModel):
    build_mode: BuildMode = "new_dashboard"
    domain_id: Optional[str] = Field(default=None, max_length=100)
    domain_version: Optional[str] = Field(default=None, max_length=50)
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
    owner_email: Optional[str] = None
    latest_dashboard_id: Optional[int] = None
    status: ReportSpecStatus
    current_step: WizardStep = "select"
    last_run_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AgentReportSpecDetailResponse(AgentReportSpecResponse):
    runs: List[AgentReportRunResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)
