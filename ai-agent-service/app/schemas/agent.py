from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class SelectedTableRef(BaseModel):
    workspace_id: int
    table_id: int


class AgentBriefRequest(BaseModel):
    report_name: Optional[str] = Field(default=None, max_length=255)
    report_type: Optional[str] = Field(default="executive_tracking", max_length=100)
    goal: str = Field(..., min_length=3, max_length=500)
    audience: Optional[str] = Field(default=None, max_length=255)
    timeframe: Optional[str] = Field(default=None, max_length=255)
    kpis: List[str] = Field(default_factory=list)
    questions: List[str] = Field(default_factory=list)
    comparison_period: Optional[str] = Field(default=None, max_length=120)
    refresh_frequency: Optional[str] = Field(default=None, max_length=120)
    must_include_sections: List[str] = Field(default_factory=list)
    alert_focus: List[str] = Field(default_factory=list)
    preferred_granularity: Optional[str] = Field(default=None, max_length=100)
    decision_context: Optional[str] = Field(default=None, max_length=500)
    notes: Optional[str] = Field(default=None, max_length=2000)
    planning_mode: str = Field(default="deep", pattern="^(quick|deep)$")
    selected_tables: List[SelectedTableRef] = Field(default_factory=list)

    @field_validator("kpis", "questions", "must_include_sections", "alert_focus", mode="before")
    @classmethod
    def _normalize_string_lists(cls, value: Any) -> List[str]:
        if value is None:
            return []
        if isinstance(value, str):
            value = [value]
        cleaned: List[str] = []
        for item in value:
            text = str(item).strip()
            if text:
                cleaned.append(text)
        return cleaned

    @model_validator(mode="after")
    def _validate_selected_tables(self) -> "AgentBriefRequest":
        if not self.selected_tables:
            raise ValueError("selected_tables must contain at least one table")
        return self


class AgentChartPlan(BaseModel):
    key: str
    title: str
    chart_type: str
    workspace_id: int
    workspace_table_id: int
    workspace_name: str
    table_name: str
    rationale: str
    insight_goal: Optional[str] = None
    why_this_chart: Optional[str] = None
    confidence: float = 0.6
    alternative_considered: Optional[str] = None
    expected_signal: Optional[str] = None
    config: Dict[str, Any]


class AgentSectionPlan(BaseModel):
    title: str
    workspace_id: int
    workspace_table_id: int
    workspace_name: str
    table_name: str
    intent: str
    why_this_section: Optional[str] = None
    questions_covered: List[str] = Field(default_factory=list)
    priority: int = 1
    chart_keys: List[str]


class AgentPlanResponse(BaseModel):
    dashboard_title: str
    dashboard_summary: str
    strategy_summary: Optional[str] = None
    planning_mode: str = "deep"
    quality_score: float = 0.0
    quality_breakdown: Dict[str, float] = Field(default_factory=dict)
    sections: List[AgentSectionPlan]
    charts: List[AgentChartPlan]
    warnings: List[str] = Field(default_factory=list)


class AgentBuildRequest(BaseModel):
    brief: AgentBriefRequest
    plan: AgentPlanResponse
    build_mode: str = Field(default="new_dashboard", pattern="^(new_dashboard|new_version|replace_existing)$")
    report_spec_id: Optional[int] = None
    report_run_id: Optional[int] = None
    target_dashboard_id: Optional[int] = None


class AgentBuildEvent(BaseModel):
    type: str
    phase: str
    message: str
    chart_id: Optional[int] = None
    dashboard_id: Optional[int] = None
    dashboard_url: Optional[str] = None
    error: Optional[str] = None


class AgentPlanEvent(BaseModel):
    type: str
    phase: str
    message: str
    plan: Optional[AgentPlanResponse] = None
    error: Optional[str] = None
