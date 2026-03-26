from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class SelectedTableRef(BaseModel):
    workspace_id: int
    table_id: int


class AgentBriefRequest(BaseModel):
    output_language: Optional[str] = Field(default="auto", pattern="^(auto|vi|en)$")
    report_name: Optional[str] = Field(default=None, max_length=255)
    report_type: Optional[str] = Field(default="executive_tracking", max_length=100)
    goal: str = Field(..., min_length=3, max_length=500)
    audience: Optional[str] = Field(default=None, max_length=255)
    timeframe: Optional[str] = Field(default=None, max_length=255)
    why_now: Optional[str] = Field(default=None, max_length=500)
    business_background: Optional[str] = Field(default=None, max_length=2000)
    kpis: List[str] = Field(default_factory=list)
    questions: List[str] = Field(default_factory=list)
    comparison_period: Optional[str] = Field(default=None, max_length=120)
    refresh_frequency: Optional[str] = Field(default=None, max_length=120)
    must_include_sections: List[str] = Field(default_factory=list)
    alert_focus: List[str] = Field(default_factory=list)
    preferred_granularity: Optional[str] = Field(default=None, max_length=100)
    decision_context: Optional[str] = Field(default=None, max_length=500)
    report_style: Optional[str] = Field(default="executive", max_length=120)
    insight_depth: Optional[str] = Field(default="balanced", max_length=120)
    recommendation_style: Optional[str] = Field(default="suggested_actions", max_length=120)
    confidence_preference: Optional[str] = Field(default="include_tentative_with_caveats", max_length=120)
    preferred_dashboard_structure: Optional[str] = Field(default=None, max_length=255)
    include_text_narrative: bool = True
    include_action_items: bool = True
    include_data_quality_notes: bool = True
    table_roles_hint: List[str] = Field(default_factory=list)
    business_glossary: List[str] = Field(default_factory=list)
    known_data_issues: List[str] = Field(default_factory=list)
    important_dimensions: List[str] = Field(default_factory=list)
    columns_to_avoid: List[str] = Field(default_factory=list)
    notes: Optional[str] = Field(default=None, max_length=2000)
    planning_mode: str = Field(default="deep", pattern="^(quick|deep)$")
    selected_tables: List[SelectedTableRef] = Field(default_factory=list)

    @field_validator(
        "kpis",
        "questions",
        "must_include_sections",
        "alert_focus",
        "table_roles_hint",
        "business_glossary",
        "known_data_issues",
        "important_dimensions",
        "columns_to_avoid",
        mode="before",
    )
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


class ParsedBriefArtifact(BaseModel):
    output_language: Optional[str] = None
    business_goal: str
    target_audience: Optional[str] = None
    decision_context: Optional[str] = None
    report_style: Optional[str] = None
    insight_depth: Optional[str] = None
    recommendation_style: Optional[str] = None
    primary_kpis: List[str] = Field(default_factory=list)
    secondary_kpis: List[str] = Field(default_factory=list)
    must_answer_questions: List[str] = Field(default_factory=list)
    required_sections: List[str] = Field(default_factory=list)
    risk_focus: List[str] = Field(default_factory=list)
    important_dimensions: List[str] = Field(default_factory=list)
    columns_to_avoid: List[str] = Field(default_factory=list)
    glossary_terms: List[str] = Field(default_factory=list)
    known_data_issues: List[str] = Field(default_factory=list)
    table_role_hints: List[str] = Field(default_factory=list)
    narrative_preferences: Dict[str, Any] = Field(default_factory=dict)
    explicit_assumptions: List[str] = Field(default_factory=list)
    clarification_gaps: List[str] = Field(default_factory=list)
    success_criteria: List[str] = Field(default_factory=list)


class DatasetFitArtifactItem(BaseModel):
    workspace_id: int
    workspace_name: str
    table_id: int
    table_name: str
    fit_score: float
    suggested_role: str
    good_for: List[str] = Field(default_factory=list)
    weak_for: List[str] = Field(default_factory=list)
    metadata_risk: str = "low"
    coverage_notes: List[str] = Field(default_factory=list)
    notes: str = ""


class ProfilingArtifactItem(BaseModel):
    workspace_id: int
    workspace_name: str
    table_id: int
    table_name: str
    row_sample_count: int
    column_count: int
    table_grain: str
    candidate_metrics: List[str] = Field(default_factory=list)
    candidate_dimensions: List[str] = Field(default_factory=list)
    candidate_time_fields: List[str] = Field(default_factory=list)
    top_dimensions: Dict[str, List[str]] = Field(default_factory=dict)
    null_risk_columns: List[str] = Field(default_factory=list)
    freshness_summary: Optional[str] = None
    semantic_summary: Optional[str] = None
    risk_flags: List[str] = Field(default_factory=list)


class QualityGateArtifact(BaseModel):
    overall_status: str = "pass"
    blockers: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    acceptable_risks: List[str] = Field(default_factory=list)
    confidence_penalties: Dict[str, float] = Field(default_factory=dict)
    recommended_adjustments: List[str] = Field(default_factory=list)
    fields_with_issues: List[str] = Field(default_factory=list)
    quality_summary: Optional[str] = None


class AnalysisQuestionMap(BaseModel):
    question: str
    target_table_id: Optional[int] = None
    target_table_name: Optional[str] = None
    suggested_method: str
    target_metric: Optional[str] = None
    target_dimension: Optional[str] = None
    target_time_field: Optional[str] = None
    expected_signal: Optional[str] = None


class AnalysisPlanArtifact(BaseModel):
    business_thesis: str
    analysis_objectives: List[str] = Field(default_factory=list)
    question_map: List[AnalysisQuestionMap] = Field(default_factory=list)
    hypotheses: List[str] = Field(default_factory=list)
    priority_checks: List[str] = Field(default_factory=list)
    fallback_checks: List[str] = Field(default_factory=list)
    section_logic: Dict[str, str] = Field(default_factory=dict)
    narrative_flow: List[str] = Field(default_factory=list)


class ChartInsightArtifact(BaseModel):
    chart_key: str
    chart_id: Optional[int] = None
    title: str
    chart_type: str
    caption: str
    finding: str
    evidence_summary: str
    confidence: float = 0.6
    warning_if_any: Optional[str] = None


class SectionInsightArtifact(BaseModel):
    section_title: str
    table_name: str
    summary: str
    key_findings: List[str] = Field(default_factory=list)
    caveats: List[str] = Field(default_factory=list)
    recommended_actions: List[str] = Field(default_factory=list)
    confidence: float = 0.6
    chart_keys: List[str] = Field(default_factory=list)
    chart_ids: List[int] = Field(default_factory=list)


class InsightReportArtifact(BaseModel):
    executive_summary: str
    top_findings: List[str] = Field(default_factory=list)
    headline_risks: List[str] = Field(default_factory=list)
    priority_actions: List[str] = Field(default_factory=list)
    section_insights: List[SectionInsightArtifact] = Field(default_factory=list)
    chart_insights: List[ChartInsightArtifact] = Field(default_factory=list)


class DashboardBlueprintArtifact(BaseModel):
    dashboard_title: str
    executive_summary: str
    reading_order: List[str] = Field(default_factory=list)
    section_intro_text: Dict[str, str] = Field(default_factory=dict)
    chart_caption_map: Dict[str, str] = Field(default_factory=dict)
    narrative_flow: List[str] = Field(default_factory=list)
    layout_strategy: str = ""
    callout_priority: List[str] = Field(default_factory=list)


class AgentRuntimeMetadata(BaseModel):
    provider: str
    model: str
    fallback_chain: List[Dict[str, str]] = Field(default_factory=list)
    timeout_seconds: int


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
    parsed_brief: Optional[ParsedBriefArtifact] = None
    dataset_fit_report: List[DatasetFitArtifactItem] = Field(default_factory=list)
    profiling_report: List[ProfilingArtifactItem] = Field(default_factory=list)
    quality_gate_report: Optional[QualityGateArtifact] = None
    analysis_plan: Optional[AnalysisPlanArtifact] = None
    runtime: Optional[AgentRuntimeMetadata] = None
    phase_runtimes: Dict[str, AgentRuntimeMetadata] = Field(default_factory=dict)


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
    report_url: Optional[str] = None
    error: Optional[str] = None


class AgentPlanEvent(BaseModel):
    type: str
    phase: str
    message: str
    plan: Optional[AgentPlanResponse] = None
    error: Optional[str] = None
