"""
AutoTaggingService — LLM-powered semantic metadata generation.

- tag_chart: generates domain, intent, metrics, dimensions, tags for a chart
- describe_table: generates a natural-language description for a workspace table

Both are designed to run in FastAPI BackgroundTasks (non-blocking).
If OPENROUTER_API_KEY is not set, operations silently no-op.
"""
import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.services.llm_client import LLMClient

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Chart auto-tagging
# ---------------------------------------------------------------------------

_CHART_TAG_SYSTEM = (
    "You are a BI metadata expert. Given chart information, extract semantic metadata. "
    "Respond ONLY with a JSON object containing these keys: "
    "domain (string: sales/marketing/finance/operations/hr/logistics/other), "
    "intent (string: trend/comparison/ranking/summary/distribution/other), "
    "metrics (array of strings: business metric names), "
    "dimensions (array of strings: grouping/slice dimension names), "
    "tags (array of strings: relevant search keywords, max 8)."
)


def _build_chart_prompt(chart, table=None) -> str:
    parts = [
        f"Chart name: {chart.name}",
        f"Chart type: {chart.chart_type}",
    ]
    config = chart.config or {}
    if config.get("dimensions"):
        parts.append(f"X-axis / dimension column: {config['dimensions']}")
    if config.get("metrics"):
        parts.append(f"Y-axis / metric column: {config['metrics']}")
    if config.get("filters"):
        parts.append(f"Filters: {config['filters']}")
    if table:
        parts.append(f"Source table: {table.display_name}")
        if table.column_stats:
            cols = list(table.column_stats.keys())
            parts.append(f"Available columns: {', '.join(cols[:20])}")
        elif table.columns_cache:
            raw = table.columns_cache
            if isinstance(raw, dict):
                raw = raw.get("columns", [])
            cols = [c.get("name", c) if isinstance(c, dict) else c for c in raw[:20]]
            parts.append(f"Available columns: {', '.join(cols)}")
    return "\n".join(parts)


class AutoTaggingService:

    @staticmethod
    def tag_chart(db: Session, chart_id: int) -> bool:
        """
        Generate and upsert semantic metadata for a chart.
        Safe to call in background. Returns True on success.
        """
        try:
            from app.models.models import Chart, ChartMetadata
            from app.models.dataset_workspace import DatasetWorkspaceTable

            chart = db.query(Chart).filter(Chart.id == chart_id).first()
            if not chart:
                return False

            table = None
            if chart.workspace_table_id:
                table = db.query(DatasetWorkspaceTable).filter(
                    DatasetWorkspaceTable.id == chart.workspace_table_id
                ).first()

            prompt = _build_chart_prompt(chart, table)
            result = LLMClient.complete_json(prompt, system=_CHART_TAG_SYSTEM)
            if not result:
                return False

            # Upsert into chart_metadata
            existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
            if existing:
                existing.domain = result.get("domain") or existing.domain
                existing.intent = result.get("intent") or existing.intent
                existing.metrics = result.get("metrics") or existing.metrics
                existing.dimensions = result.get("dimensions") or existing.dimensions
                existing.tags = result.get("tags") or existing.tags
            else:
                new_meta = ChartMetadata(
                    chart_id=chart_id,
                    domain=result.get("domain"),
                    intent=result.get("intent"),
                    metrics=result.get("metrics") or [],
                    dimensions=result.get("dimensions") or [],
                    tags=result.get("tags") or [],
                )
                db.add(new_meta)

            db.commit()
            logger.info("AutoTaggingService: tagged chart %s → %s", chart_id, result)
            return True
        except Exception as exc:
            logger.warning("AutoTaggingService: tag_chart %s failed — %s", chart_id, exc)
            db.rollback()
            return False

    @staticmethod
    def describe_table(db: Session, table_id: int) -> bool:
        """
        Generate and store a natural-language description for a workspace table.
        Safe to call in background. Returns True on success.
        """
        try:
            from app.models.dataset_workspace import DatasetWorkspaceTable

            table = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == table_id
            ).first()
            if not table:
                return False

            # Build prompt
            col_info = []
            if table.column_stats:
                for col, stats in list(table.column_stats.items())[:20]:
                    dtype = stats.get("dtype", "unknown")
                    samples = stats.get("samples", [])
                    col_info.append(f"  - {col} ({dtype}): samples={samples[:3]}")
            elif table.columns_cache:
                raw = table.columns_cache
                if isinstance(raw, dict):
                    raw = raw.get("columns", [])
                for c in raw[:20]:
                    name = c.get("name", c) if isinstance(c, dict) else c
                    col_info.append(f"  - {name}")

            prompt = (
                f"Table name: {table.display_name}\n"
                f"Columns:\n" + "\n".join(col_info) + "\n\n"
                "Write a concise 1-2 sentence description of what this table likely contains "
                "and what business questions it can answer. "
                "Respond with JSON: {\"description\": \"...\"}."
            )

            result = LLMClient.complete_json(
                prompt,
                system="You are a BI data catalog assistant. Describe tables concisely.",
            )
            if not result or not result.get("description"):
                return False

            table.auto_description = result["description"]
            db.commit()
            logger.info("AutoTaggingService: described table %s", table_id)
            return True
        except Exception as exc:
            logger.warning("AutoTaggingService: describe_table %s failed — %s", table_id, exc)
            db.rollback()
            return False
