from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class SelectedTableRef(BaseModel):
    workspace_id: int
    table_id: int


class AgentBriefRequest(BaseModel):
    goal: str = Field(..., min_length=3, max_length=500)
    audience: Optional[str] = Field(default=None, max_length=255)
    timeframe: Optional[str] = Field(default=None, max_length=255)
    kpis: List[str] = Field(default_factory=list)
    questions: List[str] = Field(default_factory=list)
    selected_tables: List[SelectedTableRef] = Field(default_factory=list)

    @field_validator("kpis", "questions", mode="before")
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
    config: Dict[str, Any]


class AgentSectionPlan(BaseModel):
    title: str
    workspace_id: int
    workspace_table_id: int
    workspace_name: str
    table_name: str
    intent: str
    chart_keys: List[str]


class AgentPlanResponse(BaseModel):
    dashboard_title: str
    dashboard_summary: str
    sections: List[AgentSectionPlan]
    charts: List[AgentChartPlan]
    warnings: List[str] = Field(default_factory=list)


class AgentBuildRequest(BaseModel):
    brief: AgentBriefRequest
    plan: AgentPlanResponse


class AgentBuildEvent(BaseModel):
    type: str
    phase: str
    message: str
    chart_id: Optional[int] = None
    dashboard_id: Optional[int] = None
    dashboard_url: Optional[str] = None
    error: Optional[str] = None
