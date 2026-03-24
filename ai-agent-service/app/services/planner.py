from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Tuple

from fastapi import HTTPException

from app.clients.bi_client import bi_client
from app.schemas.agent import (
    AgentBriefRequest,
    AgentChartPlan,
    AgentPlanResponse,
    AgentSectionPlan,
)


@dataclass
class TableContext:
    workspace_id: int
    workspace_name: str
    table_id: int
    table_name: str
    columns: List[Dict[str, Any]]
    sample_rows: List[Dict[str, Any]]


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
    if declared in {"integer", "float", "number", "numeric", "decimal"}:
        return "number"
    if declared in {"date", "datetime", "timestamp"}:
        return "date"

    values = [row.get(column["name"]) for row in sample_rows if row.get(column["name"]) not in (None, "")]
    if not values:
        return "string"
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values):
        return "number"
    lowered_name = column["name"].lower()
    if any(token in lowered_name for token in ("date", "time", "month", "year", "week")):
        return "date"
    return "string"


def _count_field(columns: List[Dict[str, Any]]) -> str:
    for preferred in ("id", "record_id", "uuid"):
        for column in columns:
            if column["name"].lower() == preferred:
                return column["name"]
    return columns[0]["name"] if columns else "id"


def _unique_count(column_name: str, sample_rows: List[Dict[str, Any]]) -> int:
    values = {
        str(row.get(column_name)).strip()
        for row in sample_rows
        if row.get(column_name) not in (None, "")
    }
    return len(values)


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
        preview = await bi_client.preview_workspace_table(ref.workspace_id, ref.table_id, limit=20, token=token)
        columns = _normalize_columns(table.get("columns_cache", {}).get("columns") or preview.get("columns", []))
        contexts.append(
            TableContext(
                workspace_id=ref.workspace_id,
                workspace_name=workspace.get("name", f"Workspace {ref.workspace_id}"),
                table_id=ref.table_id,
                table_name=table.get("display_name") or table.get("source_table_name") or f"Table {ref.table_id}",
                columns=columns,
                sample_rows=preview.get("rows", []),
            )
        )
    return contexts


def _build_charts_for_table(
    brief: AgentBriefRequest,
    context: TableContext,
) -> Tuple[List[AgentChartPlan], List[str]]:
    warnings: List[str] = []
    charts: List[AgentChartPlan] = []

    typed_columns = [
        {"name": column["name"], "type": _infer_type(column, context.sample_rows)}
        for column in context.columns
    ]
    numeric_columns = [column["name"] for column in typed_columns if column["type"] == "number"]
    date_columns = [column["name"] for column in typed_columns if column["type"] == "date"]
    categorical_columns = [column["name"] for column in typed_columns if column["type"] == "string"]
    low_card_columns = [
        column_name
        for column_name in categorical_columns
        if _unique_count(column_name, context.sample_rows) and _unique_count(column_name, context.sample_rows) <= 8
    ]

    count_field = _count_field(typed_columns)
    title_prefix = context.table_name

    def add_chart(chart_type: str, title: str, rationale: str, config: Dict[str, Any]) -> None:
        key = f"{_slugify(context.workspace_name)}-{_slugify(context.table_name)}-{len(charts) + 1}"
        charts.append(
            AgentChartPlan(
                key=key,
                title=title,
                chart_type=chart_type,
                workspace_id=context.workspace_id,
                workspace_table_id=context.table_id,
                workspace_name=context.workspace_name,
                table_name=context.table_name,
                rationale=rationale,
                config=config,
            )
        )

    add_chart(
        "KPI",
        f"{title_prefix} - Total Records",
        f"Baseline volume KPI for {context.table_name}.",
        {
            "workspace_id": context.workspace_id,
            "chartType": "KPI",
            "roleConfig": {
                "metrics": [{"field": count_field, "agg": "count", "label": "Total Records"}],
            },
            "filters": [],
        },
    )

    if numeric_columns:
        metric_field = numeric_columns[0]
        metric_label = brief.kpis[0] if brief.kpis else metric_field.replace("_", " ").title()
        add_chart(
            "KPI",
            f"{title_prefix} - {metric_label}",
            f"Headline KPI mapped from {metric_field}.",
            {
                "workspace_id": context.workspace_id,
                "chartType": "KPI",
                "roleConfig": {
                    "metrics": [{"field": metric_field, "agg": "sum", "label": metric_label}],
                },
                "filters": [],
            },
        )

    if date_columns and numeric_columns:
        add_chart(
            "TIME_SERIES",
            f"{title_prefix} - Trend Over Time",
            f"Trend chart to monitor how {numeric_columns[0]} changes over {date_columns[0]}.",
            {
                "workspace_id": context.workspace_id,
                "chartType": "TIME_SERIES",
                "roleConfig": {
                    "timeField": date_columns[0],
                    "metrics": [{"field": numeric_columns[0], "agg": "sum", "label": numeric_columns[0].replace("_", " ").title()}],
                },
                "filters": [],
            },
        )

    if categorical_columns:
        dimension = categorical_columns[0]
        if numeric_columns:
            metrics = [{"field": numeric_columns[0], "agg": "sum", "label": numeric_columns[0].replace("_", " ").title()}]
            rationale = f"Comparison chart for {numeric_columns[0]} by {dimension}."
        else:
            metrics = [{"field": count_field, "agg": "count", "label": "Count"}]
            rationale = f"Category distribution chart for {dimension}."
        add_chart(
            "BAR",
            f"{title_prefix} - Breakdown by {dimension.replace('_', ' ').title()}",
            rationale,
            {
                "workspace_id": context.workspace_id,
                "chartType": "BAR",
                "roleConfig": {
                    "dimension": dimension,
                    "metrics": metrics,
                },
                "filters": [],
            },
        )

    if low_card_columns:
        dimension = low_card_columns[0]
        metric_field = numeric_columns[0] if numeric_columns else count_field
        metric_agg = "sum" if numeric_columns else "count"
        add_chart(
            "PIE",
            f"{title_prefix} - Share by {dimension.replace('_', ' ').title()}",
            f"Share-of-total chart for low-cardinality field {dimension}.",
            {
                "workspace_id": context.workspace_id,
                "chartType": "PIE",
                "roleConfig": {
                    "dimension": dimension,
                    "metrics": [{"field": metric_field, "agg": metric_agg, "label": "Share"}],
                },
                "filters": [],
            },
        )

    selected_columns = [column["name"] for column in typed_columns[: min(len(typed_columns), 6)]]
    if selected_columns:
        add_chart(
            "TABLE",
            f"{title_prefix} - Detail Table",
            "Tabular view for record-level inspection.",
            {
                "workspace_id": context.workspace_id,
                "chartType": "TABLE",
                "roleConfig": {"selectedColumns": selected_columns},
                "filters": [],
            },
        )
    else:
        warnings.append(f"{context.table_name} has no columns available for detailed table output.")

    max_per_table = 4 if len(brief.selected_tables) == 1 else 3
    return charts[:max_per_table], warnings


def build_agent_plan(brief: AgentBriefRequest, contexts: List[TableContext]) -> AgentPlanResponse:
    sections: List[AgentSectionPlan] = []
    charts: List[AgentChartPlan] = []
    warnings: List[str] = []

    for context in contexts:
        table_charts, table_warnings = _build_charts_for_table(brief, context)
        warnings.extend(table_warnings)
        charts.extend(table_charts)
        sections.append(
            AgentSectionPlan(
                title=f"{context.workspace_name} / {context.table_name}",
                workspace_id=context.workspace_id,
                workspace_table_id=context.table_id,
                workspace_name=context.workspace_name,
                table_name=context.table_name,
                intent=f"Section answering {brief.goal}",
                chart_keys=[chart.key for chart in table_charts],
            )
        )

    charts = charts[:8]
    allowed_chart_keys = {chart.key for chart in charts}
    sections = [
        section.model_copy(update={"chart_keys": [key for key in section.chart_keys if key in allowed_chart_keys]})
        for section in sections
    ]

    dashboard_title = brief.goal.strip().rstrip(".")
    if len(dashboard_title) > 80:
        dashboard_title = dashboard_title[:77].rstrip() + "..."

    summary_parts = [f"Dashboard generated for goal: {brief.goal.strip()}"]
    if brief.audience:
        summary_parts.append(f"Audience: {brief.audience.strip()}")
    if brief.timeframe:
        summary_parts.append(f"Timeframe: {brief.timeframe.strip()}")
    if brief.questions:
        summary_parts.append(f"Focus questions: {', '.join(brief.questions[:3])}")

    if not charts:
        warnings.append("Planner could not infer any valid charts from the selected tables.")

    return AgentPlanResponse(
        dashboard_title=dashboard_title,
        dashboard_summary=" ".join(summary_parts),
        sections=sections,
        charts=charts,
        warnings=warnings,
    )
