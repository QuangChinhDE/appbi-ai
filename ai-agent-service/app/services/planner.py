from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Dict, Iterable, List, Optional

from fastapi import HTTPException

from app.clients.bi_client import bi_client
from app.schemas.agent import (
    AgentBriefRequest,
    AgentChartPlan,
    AgentPlanEvent,
    AgentPlanResponse,
    AgentSectionPlan,
)
from app.services.llm_client import generate_json


SUPPORTED_CHART_TYPES = {"KPI", "BAR", "LINE", "AREA", "PIE", "TABLE", "TIME_SERIES", "GROUPED_BAR", "STACKED_BAR"}


@dataclass
class TableContext:
    workspace_id: int
    workspace_name: str
    workspace_description: Optional[str]
    table_id: int
    table_name: str
    columns: List[Dict[str, Any]]
    sample_rows: List[Dict[str, Any]]
    table_description: Dict[str, Any]


@dataclass
class TableProfile:
    context: TableContext
    typed_columns: List[Dict[str, str]]
    numeric_columns: List[str]
    date_columns: List[str]
    categorical_columns: List[str]
    low_cardinality_columns: List[str]
    metric_candidates: List[str]
    dimension_candidates: List[str]
    table_kind: str
    primary_metric: Optional[str]
    primary_time: Optional[str]
    primary_dimension: Optional[str]
    question_matches: List[str]
    business_summary: str


def _slugify(value: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")


def _normalize_columns(columns: Iterable[Any]) -> List[Dict[str, Any]]:
    normalized = []
    for column in columns or []:
        if isinstance(column, dict):
            normalized.append(
                {
                    "name": column.get("name", ""),
                    "type": str(column.get("type", "string")).lower(),
                }
            )
        else:
            normalized.append({"name": str(column), "type": "string"})
    return [column for column in normalized if column["name"]]


def _infer_type(column: Dict[str, Any], sample_rows: List[Dict[str, Any]]) -> str:
    declared = (column.get("type") or "").lower()
    if any(token in declared for token in ("int", "float", "double", "number", "numeric", "decimal")):
        return "number"
    if any(token in declared for token in ("date", "time", "timestamp")):
        return "date"
    values = [row.get(column["name"]) for row in sample_rows if row.get(column["name"]) not in (None, "")]
    if not values:
        lowered_name = column["name"].lower()
        if any(token in lowered_name for token in ("date", "time", "month", "year", "week")):
            return "date"
        return "string"
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values):
        return "number"
    lowered_name = column["name"].lower()
    if any(token in lowered_name for token in ("date", "time", "month", "year", "week")):
        return "date"
    return "string"


def _unique_count(column_name: str, sample_rows: List[Dict[str, Any]]) -> int:
    values = {
        str(row.get(column_name)).strip()
        for row in sample_rows
        if row.get(column_name) not in (None, "")
    }
    return len(values)


def _score_name_against_terms(name: str, terms: List[str]) -> float:
    lowered = name.lower().replace("_", " ")
    score = 0.0
    for term in terms:
        cleaned = term.lower().strip()
        if not cleaned:
            continue
        if cleaned in lowered:
            score += 1.0
        else:
            overlap = set(cleaned.split()) & set(lowered.split())
            score += min(len(overlap) * 0.35, 0.7)
    return score


def _match_questions(text: str, questions: List[str]) -> List[str]:
    lowered = text.lower()
    matches = []
    for question in questions:
        tokens = [token for token in question.lower().replace("?", "").split() if len(token) > 3]
        if any(token in lowered for token in tokens):
            matches.append(question)
    return matches[:3]


def _truncate_text(value: Any, limit: int = 140) -> str:
    text = str(value).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def _representative_rows(sample_rows: List[Dict[str, Any]], max_rows: int = 6) -> List[Dict[str, Any]]:
    selected: List[Dict[str, Any]] = []
    seen_signatures: set[str] = set()
    for row in sample_rows:
        signature = json.dumps(row, sort_keys=True, default=str)
        if signature in seen_signatures:
            continue
        seen_signatures.add(signature)
        selected.append(row)
        if len(selected) >= max_rows:
            break
    return selected


def _table_kind(column_names: List[str], sample_rows: List[Dict[str, Any]]) -> str:
    lowered = " ".join(column_names).lower()
    if any(token in lowered for token in ("date", "event", "created", "occurred", "timestamp")):
        return "event"
    if any(token in lowered for token in ("snapshot", "balance", "inventory", "status")):
        return "snapshot"
    if len(sample_rows) <= 10:
        return "lookup"
    return "fact"


def _count_field(columns: List[Dict[str, Any]]) -> str:
    for preferred in ("id", "record_id", "uuid"):
        for column in columns:
            if column["name"].lower() == preferred:
                return column["name"]
    return columns[0]["name"] if columns else "id"


async def load_table_contexts(brief: AgentBriefRequest, token: str) -> List[TableContext]:
    contexts: List[TableContext] = []
    for ref in brief.selected_tables:
        workspace = await bi_client.get_workspace(ref.workspace_id, token)
        table = next((item for item in workspace.get("tables", []) if item.get("id") == ref.table_id), None)
        if table is None:
            raise HTTPException(
                status_code=404,
                detail=f"Table {ref.table_id} not found in workspace {ref.workspace_id}",
            )
        preview = await bi_client.preview_workspace_table(ref.workspace_id, ref.table_id, limit=40, token=token)
        description = await bi_client.get_table_description(ref.workspace_id, ref.table_id, token)
        columns = _normalize_columns(table.get("columns_cache", {}).get("columns") or preview.get("columns", []))
        contexts.append(
            TableContext(
                workspace_id=ref.workspace_id,
                workspace_name=workspace.get("name", f"Workspace {ref.workspace_id}"),
                workspace_description=workspace.get("description"),
                table_id=ref.table_id,
                table_name=table.get("display_name") or table.get("source_table_name") or f"Table {ref.table_id}",
                columns=columns,
                sample_rows=preview.get("rows", []),
                table_description=description,
            )
        )
    return contexts


def profile_table(brief: AgentBriefRequest, context: TableContext) -> TableProfile:
    typed_columns = [{"name": column["name"], "type": _infer_type(column, context.sample_rows)} for column in context.columns]
    numeric_columns = [column["name"] for column in typed_columns if column["type"] == "number"]
    date_columns = [column["name"] for column in typed_columns if column["type"] == "date"]
    categorical_columns = [column["name"] for column in typed_columns if column["type"] == "string"]
    low_cardinality_columns = [
        column_name
        for column_name in categorical_columns
        if 1 < _unique_count(column_name, context.sample_rows) <= 10
    ]

    scoring_terms = brief.kpis + brief.questions + [brief.goal, brief.audience or "", brief.report_type or ""]
    metric_candidates = sorted(
        numeric_columns,
        key=lambda name: (_score_name_against_terms(name, scoring_terms), -len(name)),
        reverse=True,
    )
    dimension_candidates = sorted(
        categorical_columns,
        key=lambda name: (_score_name_against_terms(name, brief.questions + [brief.goal]), -len(name)),
        reverse=True,
    )

    description_text = context.table_description.get("auto_description") or ""
    table_kind = _table_kind([column["name"] for column in typed_columns], context.sample_rows)
    primary_metric = metric_candidates[0] if metric_candidates else None
    primary_time = date_columns[0] if date_columns else None
    primary_dimension = (low_cardinality_columns or dimension_candidates or categorical_columns or [None])[0]

    business_summary = description_text or (
        f"{context.table_name} looks like a {table_kind} table with "
        f"{len(typed_columns)} columns and {len(context.sample_rows)} sampled rows."
    )
    question_matches = _match_questions(
        " ".join([context.table_name, business_summary, " ".join(column["name"] for column in typed_columns)]),
        brief.questions,
    )

    return TableProfile(
        context=context,
        typed_columns=typed_columns,
        numeric_columns=numeric_columns,
        date_columns=date_columns,
        categorical_columns=categorical_columns,
        low_cardinality_columns=low_cardinality_columns,
        metric_candidates=metric_candidates,
        dimension_candidates=dimension_candidates,
        table_kind=table_kind,
        primary_metric=primary_metric,
        primary_time=primary_time,
        primary_dimension=primary_dimension,
        question_matches=question_matches,
        business_summary=business_summary,
    )


def _profile_prompt_payload(profile: TableProfile) -> Dict[str, Any]:
    return {
        "workspace_id": profile.context.workspace_id,
        "workspace_name": profile.context.workspace_name,
        "table_id": profile.context.table_id,
        "table_name": profile.context.table_name,
        "table_kind": profile.table_kind,
        "business_summary": _truncate_text(profile.business_summary, 260),
        "numeric_columns": profile.numeric_columns[:8],
        "date_columns": profile.date_columns[:6],
        "dimension_candidates": profile.dimension_candidates[:8],
        "primary_metric": profile.primary_metric,
        "primary_time": profile.primary_time,
        "primary_dimension": profile.primary_dimension,
        "common_questions": (profile.context.table_description.get("common_questions") or [])[:4],
        "sample_rows": _representative_rows(profile.context.sample_rows, max_rows=4),
        "columns": [{"name": column["name"], "type": column["type"]} for column in profile.typed_columns],
    }


async def _generate_strategy_with_llm(brief: AgentBriefRequest, profiles: List[TableProfile]) -> Optional[Dict[str, Any]]:
    system_prompt = (
        "You are a senior BI analyst designing a dashboard plan. "
        "Use the brief and table profiles to create a business-first report strategy. "
        "Do not invent columns or tables. Return strict JSON only."
    )
    user_prompt = json.dumps(
        {
            "brief": brief.model_dump(),
            "tables": [_profile_prompt_payload(profile) for profile in profiles],
            "output_contract": {
                "dashboard_title": "string",
                "dashboard_summary": "string",
                "strategy_summary": "string",
                "warnings": ["string"],
                "sections": [
                    {
                        "table_id": "number",
                        "title": "string",
                        "intent": "string",
                        "why_this_section": "string",
                        "questions_covered": ["string"],
                        "priority": "number",
                        "charts": [
                            {
                                "title": "string",
                                "chart_type": "KPI|BAR|LINE|AREA|PIE|TABLE|TIME_SERIES|GROUPED_BAR|STACKED_BAR",
                                "insight_goal": "string",
                                "why_this_chart": "string",
                                "metric_hint": "string|null",
                                "dimension_hint": "string|null",
                                "time_hint": "string|null",
                                "expected_signal": "string|null",
                                "alternative_considered": "string|null",
                                "confidence": "0.0-1.0"
                            }
                        ]
                    }
                ]
            },
        },
        ensure_ascii=False,
        default=str,
    )
    return await generate_json(system_prompt=system_prompt, user_prompt=user_prompt)


def _build_heuristic_strategy(brief: AgentBriefRequest, profiles: List[TableProfile]) -> Dict[str, Any]:
    warnings: List[str] = []
    sections: List[Dict[str, Any]] = []

    executive_profile = max(
        profiles,
        key=lambda profile: (
            1 if profile.primary_metric else 0,
            1 if profile.primary_time else 0,
            len(profile.metric_candidates),
            len(profile.typed_columns),
        ),
    )

    def _base_chart_requests(profile: TableProfile) -> List[Dict[str, Any]]:
        requests: List[Dict[str, Any]] = []
        count_field = _count_field(profile.typed_columns)
        requests.append(
            {
                "title": f"{profile.context.table_name} - Total volume",
                "chart_type": "KPI",
                "insight_goal": "Establish the baseline size of the dataset or activity",
                "why_this_chart": "A dashboard should begin with a simple baseline KPI.",
                "metric_hint": count_field,
                "dimension_hint": None,
                "time_hint": None,
                "expected_signal": "Overall scale and volume",
                "alternative_considered": "A detail table would be less useful as the opening visual.",
                "confidence": 0.72,
            }
        )
        if profile.primary_metric:
            requests.append(
                {
                    "title": f"{profile.context.table_name} - {profile.primary_metric.replace('_', ' ').title()}",
                    "chart_type": "KPI",
                    "insight_goal": f"Track the main performance metric around {profile.primary_metric}.",
                    "why_this_chart": "A headline KPI makes it easier to scan the main business outcome quickly.",
                    "metric_hint": profile.primary_metric,
                    "dimension_hint": None,
                    "time_hint": None,
                    "expected_signal": "Headline KPI movement",
                    "alternative_considered": "A bar chart would hide the top-line number.",
                    "confidence": 0.84,
                }
            )
        if profile.primary_metric and profile.primary_time:
            requests.append(
                {
                    "title": f"{profile.context.table_name} - Trend over time",
                    "chart_type": "TIME_SERIES",
                    "insight_goal": f"Show how {profile.primary_metric} changes over {profile.primary_time}.",
                    "why_this_chart": "A trend view is essential for monitoring and executive reporting.",
                    "metric_hint": profile.primary_metric,
                    "dimension_hint": None,
                    "time_hint": profile.primary_time,
                    "expected_signal": "Trend, growth, or decline over time",
                    "alternative_considered": "A KPI alone would hide direction and seasonality.",
                    "confidence": 0.88,
                }
            )
        if profile.primary_dimension:
            requests.append(
                {
                    "title": f"{profile.context.table_name} - Breakdown by {profile.primary_dimension.replace('_', ' ').title()}",
                    "chart_type": "BAR",
                    "insight_goal": f"Compare performance across {profile.primary_dimension}.",
                    "why_this_chart": "Breakdowns help explain which segment drives the overall result.",
                    "metric_hint": profile.primary_metric or count_field,
                    "dimension_hint": profile.primary_dimension,
                    "time_hint": None,
                    "expected_signal": "Top and bottom performing segments",
                    "alternative_considered": "A pie chart may hide rank order.",
                    "confidence": 0.81,
                }
            )
        if profile.low_cardinality_columns:
            requests.append(
                {
                    "title": f"{profile.context.table_name} - Share mix",
                    "chart_type": "PIE",
                    "insight_goal": "Show share of total across the simplest low-cardinality segment.",
                    "why_this_chart": "A compact composition chart complements the comparison chart.",
                    "metric_hint": profile.primary_metric or count_field,
                    "dimension_hint": profile.low_cardinality_columns[0],
                    "time_hint": None,
                    "expected_signal": "Composition and share-of-total",
                    "alternative_considered": "A second bar chart would feel repetitive.",
                    "confidence": 0.68,
                }
            )
        requests.append(
            {
                "title": f"{profile.context.table_name} - Detail view",
                "chart_type": "TABLE",
                "insight_goal": "Keep a drill-down style view for record-level inspection.",
                "why_this_chart": "A table gives the report a practical fallback for follow-up inspection.",
                "metric_hint": None,
                "dimension_hint": None,
                "time_hint": None,
                "expected_signal": "Detailed rows for operational follow-up",
                "alternative_considered": "A second summary chart would not support investigation.",
                "confidence": 0.64,
            }
        )
        return requests

    executive_questions = brief.questions[:3] or executive_profile.question_matches
    sections.append(
        {
            "table_id": executive_profile.context.table_id,
            "title": "Executive summary",
            "intent": f"Answer the top-level goal: {brief.goal}",
            "why_this_section": "This section leads with the most decision-relevant KPIs and trend so the audience can orient quickly.",
            "questions_covered": executive_questions,
            "priority": 1,
            "charts": _base_chart_requests(executive_profile)[:4],
        }
    )

    for index, profile in enumerate(profiles, start=1):
        charts = _base_chart_requests(profile)
        if profile.context.table_id == executive_profile.context.table_id:
            charts = charts[2:5] + charts[-1:]
        if not profile.primary_time and any(section.lower() == "trend" for section in brief.must_include_sections):
            warnings.append(f"{profile.context.table_name} has no clear time field for a stronger trend section.")
        sections.append(
            {
                "table_id": profile.context.table_id,
                "title": f"{profile.context.workspace_name} / {profile.context.table_name}",
                "intent": f"Explain performance and drivers in {profile.context.table_name}.",
                "why_this_section": profile.business_summary,
                "questions_covered": profile.question_matches or brief.questions[:2],
                "priority": index + 1,
                "charts": charts[:4],
            }
        )

    dashboard_title = brief.report_name or brief.goal.strip().rstrip(".")
    dashboard_summary_parts = [
        f"This dashboard is designed for {brief.audience or 'the target audience'} to monitor {brief.goal.strip().lower()}.",
    ]
    if brief.timeframe:
        dashboard_summary_parts.append(f"Primary timeframe: {brief.timeframe}.")
    if brief.comparison_period:
        dashboard_summary_parts.append(f"Compare against: {brief.comparison_period}.")
    if brief.alert_focus:
        dashboard_summary_parts.append(f"Alert focus: {', '.join(brief.alert_focus[:3])}.")

    return {
        "dashboard_title": dashboard_title,
        "dashboard_summary": " ".join(dashboard_summary_parts),
        "strategy_summary": (
            "Lead with an executive overview, then move into per-table breakdowns that explain the main drivers "
            "and preserve at least one detail view for operational follow-up."
        ),
        "warnings": warnings,
        "sections": sections,
    }


def _pick_best_name(candidates: List[str], hint: Optional[str], fallback: Optional[str]) -> Optional[str]:
    if not candidates:
        return fallback
    if hint:
        ranked = sorted(candidates, key=lambda name: _score_name_against_terms(name, [hint]), reverse=True)
        if ranked and _score_name_against_terms(ranked[0], [hint]) > 0:
            return ranked[0]
    return fallback or candidates[0]


def _metric_payload(profile: TableProfile, metric_hint: Optional[str], label: Optional[str] = None) -> Dict[str, str]:
    numeric_candidates = profile.metric_candidates or profile.numeric_columns
    numeric_metric = _pick_best_name(numeric_candidates, metric_hint, profile.primary_metric)
    if numeric_metric and numeric_metric in numeric_candidates:
        return {
            "field": numeric_metric,
            "agg": "sum",
            "label": label or numeric_metric.replace("_", " ").title(),
        }

    count_field = _count_field(profile.typed_columns)
    return {
        "field": count_field,
        "agg": "count",
        "label": label or "Record Count",
    }


def _build_chart_config(profile: TableProfile, chart_request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    chart_type = str(chart_request.get("chart_type", "TABLE")).upper()
    if chart_type not in SUPPORTED_CHART_TYPES:
        chart_type = "TABLE"

    metric_hint = chart_request.get("metric_hint")
    dimension_hint = chart_request.get("dimension_hint")
    time_hint = chart_request.get("time_hint")
    metric_payload = _metric_payload(profile, metric_hint, chart_request.get("title"))
    dimension = _pick_best_name(profile.low_cardinality_columns + profile.dimension_candidates, dimension_hint, profile.primary_dimension)
    time_field = _pick_best_name(profile.date_columns, time_hint, profile.primary_time)

    if chart_type == "KPI":
        return {
            "workspace_id": profile.context.workspace_id,
            "chartType": "KPI",
            "roleConfig": {"metrics": [metric_payload]},
            "filters": [],
        }

    if chart_type == "TIME_SERIES":
        if not time_field:
            return None
        return {
            "workspace_id": profile.context.workspace_id,
            "chartType": "TIME_SERIES",
            "roleConfig": {
                "timeField": time_field,
                "metrics": [metric_payload],
            },
            "filters": [],
        }

    if chart_type in {"BAR", "LINE", "AREA", "GROUPED_BAR", "STACKED_BAR"}:
        if not dimension:
            return None
        role_config: Dict[str, Any] = {"dimension": dimension, "metrics": [metric_payload]}
        if chart_type in {"GROUPED_BAR", "STACKED_BAR"} and len(profile.dimension_candidates) > 1:
            breakdown = next((item for item in profile.dimension_candidates if item != dimension), None)
            if breakdown:
                role_config["breakdown"] = breakdown
        return {
            "workspace_id": profile.context.workspace_id,
            "chartType": chart_type,
            "roleConfig": role_config,
            "filters": [],
        }

    if chart_type == "PIE":
        if not dimension:
            return None
        return {
            "workspace_id": profile.context.workspace_id,
            "chartType": "PIE",
            "roleConfig": {
                "dimension": dimension,
                "metrics": [_metric_payload(profile, metric_hint, "Share")],
            },
            "filters": [],
        }

    selected_columns = [column["name"] for column in profile.typed_columns[: min(8, len(profile.typed_columns))]]
    return {
        "workspace_id": profile.context.workspace_id,
        "chartType": "TABLE",
        "roleConfig": {"selectedColumns": selected_columns},
        "filters": [],
    }


def _materialize_strategy(brief: AgentBriefRequest, strategy: Dict[str, Any], profiles: List[TableProfile]) -> AgentPlanResponse:
    profile_map = {profile.context.table_id: profile for profile in profiles}
    charts: List[AgentChartPlan] = []
    sections: List[AgentSectionPlan] = []
    warnings = list(strategy.get("warnings") or [])

    for section_index, raw_section in enumerate(strategy.get("sections") or [], start=1):
        table_id = raw_section.get("table_id")
        profile = profile_map.get(table_id)
        if not profile:
            warnings.append(f"Planner referenced unknown table {table_id}; skipped section.")
            continue

        section_chart_keys: List[str] = []
        for chart_index, raw_chart in enumerate(raw_section.get("charts") or [], start=1):
            chart_type = str(raw_chart.get("chart_type", "TABLE")).upper()
            config = _build_chart_config(profile, raw_chart)
            if not config:
                warnings.append(
                    f"Skipped chart '{raw_chart.get('title', chart_type)}' for {profile.context.table_name} because required fields were missing."
                )
                continue
            key = f"{_slugify(profile.context.workspace_name)}-{_slugify(profile.context.table_name)}-{section_index}-{chart_index}"
            section_chart_keys.append(key)
            charts.append(
                AgentChartPlan(
                    key=key,
                    title=raw_chart.get("title") or f"{profile.context.table_name} {chart_type.title()}",
                    chart_type=chart_type,
                    workspace_id=profile.context.workspace_id,
                    workspace_table_id=profile.context.table_id,
                    workspace_name=profile.context.workspace_name,
                    table_name=profile.context.table_name,
                    rationale=raw_chart.get("insight_goal") or raw_chart.get("why_this_chart") or "Supports the report objective.",
                    insight_goal=raw_chart.get("insight_goal"),
                    why_this_chart=raw_chart.get("why_this_chart"),
                    confidence=float(raw_chart.get("confidence") or 0.6),
                    alternative_considered=raw_chart.get("alternative_considered"),
                    expected_signal=raw_chart.get("expected_signal"),
                    config=config,
                )
            )

        if section_chart_keys:
            sections.append(
                AgentSectionPlan(
                    title=raw_section.get("title") or f"{profile.context.workspace_name} / {profile.context.table_name}",
                    workspace_id=profile.context.workspace_id,
                    workspace_table_id=profile.context.table_id,
                    workspace_name=profile.context.workspace_name,
                    table_name=profile.context.table_name,
                    intent=raw_section.get("intent") or f"Analyze {profile.context.table_name}",
                    why_this_section=raw_section.get("why_this_section"),
                    questions_covered=list(raw_section.get("questions_covered") or []),
                    priority=int(raw_section.get("priority") or section_index),
                    chart_keys=section_chart_keys,
                )
            )

    if not charts:
        warnings.append("Planner could not produce any valid charts from the selected tables.")

    charts = charts[:12]
    allowed_keys = {chart.key for chart in charts}
    sections = [
        section.model_copy(update={"chart_keys": [key for key in section.chart_keys if key in allowed_keys]})
        for section in sections
        if any(key in allowed_keys for key in section.chart_keys)
    ]
    sections = sorted(sections, key=lambda section: section.priority)

    return AgentPlanResponse(
        dashboard_title=(strategy.get("dashboard_title") or brief.report_name or brief.goal).strip()[:120],
        dashboard_summary=(strategy.get("dashboard_summary") or brief.goal).strip(),
        strategy_summary=strategy.get("strategy_summary"),
        planning_mode=brief.planning_mode,
        sections=sections,
        charts=charts,
        warnings=warnings,
    )


def _review_plan_quality(plan: AgentPlanResponse, brief: AgentBriefRequest) -> AgentPlanResponse:
    active_question_hits = sum(
        1
        for question in brief.questions
        if any(question in section.questions_covered for section in plan.sections)
    )
    question_coverage = active_question_hits / max(len(brief.questions), 1) if brief.questions else 1.0

    metric_text = " ".join(
        " ".join(
            [
                chart.title,
                chart.rationale or "",
                chart.insight_goal or "",
                json.dumps(chart.config, ensure_ascii=False),
            ]
        )
        for chart in plan.charts
    ).lower()
    kpi_hits = sum(1 for kpi in brief.kpis if kpi.lower() in metric_text)
    kpi_coverage = kpi_hits / max(len(brief.kpis), 1) if brief.kpis else 1.0

    unique_chart_types = len({chart.chart_type for chart in plan.charts})
    chart_diversity = min(unique_chart_types / 4.0, 1.0)
    section_balance = min(len(plan.sections) / max(len(brief.selected_tables), 1), 1.0)
    dataset_fit = 1.0 if plan.charts and plan.sections else 0.0

    quality_breakdown = {
        "question_coverage": round(question_coverage, 3),
        "kpi_coverage": round(kpi_coverage, 3),
        "chart_diversity": round(chart_diversity, 3),
        "section_balance": round(section_balance, 3),
        "dataset_fit": round(dataset_fit, 3),
    }
    quality_score = (
        question_coverage * 0.26
        + kpi_coverage * 0.22
        + chart_diversity * 0.16
        + section_balance * 0.16
        + dataset_fit * 0.20
    )

    warnings = list(plan.warnings)
    if quality_breakdown["question_coverage"] < 0.6 and brief.questions:
        warnings.append("Draft only partially maps to the explicit business questions; consider refining the brief.")
    if quality_breakdown["chart_diversity"] < 0.5:
        warnings.append("Draft has limited chart variety. Consider replacing one chart during review.")

    return plan.model_copy(
        update={
            "quality_score": round(quality_score, 3),
            "quality_breakdown": quality_breakdown,
            "warnings": warnings,
        }
    )


async def generate_agent_plan(brief: AgentBriefRequest, token: str) -> AgentPlanResponse:
    contexts = await load_table_contexts(brief, token)
    profiles = [profile_table(brief, context) for context in contexts]
    strategy = await _generate_strategy_with_llm(brief, profiles) if brief.planning_mode == "deep" else None
    if strategy is None:
        strategy = _build_heuristic_strategy(brief, profiles)
    plan = _materialize_strategy(brief, strategy, profiles)
    return _review_plan_quality(plan, brief)


def _plan_event(event_type: str, phase: str, message: str, plan: Optional[AgentPlanResponse] = None, error: Optional[str] = None) -> str:
    event = AgentPlanEvent(type=event_type, phase=phase, message=message, plan=plan, error=error)
    return json.dumps(event.model_dump(), ensure_ascii=False) + "\n"


async def generate_agent_plan_stream(brief: AgentBriefRequest, token: str) -> AsyncGenerator[str, None]:
    yield _plan_event("phase", "collect_context", "Inspecting the selected workspace tables and sample data.")
    contexts = await load_table_contexts(brief, token)

    yield _plan_event("phase", "profile_tables", "Profiling metrics, time fields, segments, and likely business meaning.")
    profiles = [profile_table(brief, context) for context in contexts]

    yield _plan_event("phase", "report_strategy", "Building a dashboard strategy from the business brief.")
    strategy = await _generate_strategy_with_llm(brief, profiles) if brief.planning_mode == "deep" else None
    if strategy is None:
        yield _plan_event("phase", "report_strategy", "No LLM strategy was available, so the Agent is using the guided fallback planner.")
        strategy = _build_heuristic_strategy(brief, profiles)

    yield _plan_event("phase", "chart_candidates", "Translating the strategy into concrete chart candidates.")
    plan = _materialize_strategy(brief, strategy, profiles)

    yield _plan_event("phase", "plan_review", "Reviewing the draft for question coverage, chart diversity, and report balance.")
    plan = _review_plan_quality(plan, brief)

    yield _plan_event("done", "done", "Draft ready for review.", plan=plan)
