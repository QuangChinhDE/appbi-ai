"""
AutoTaggingService — LLM-powered semantic metadata generation.

- tag_chart:      generates domain, intent, metrics, dimensions, tags,
                  auto_description, insight_keywords, common_questions
- describe_table: generates auto_description, column_descriptions, common_questions

Both run in FastAPI BackgroundTasks (sync LLMClient is safe there).
Silently no-ops if OPENROUTER_API_KEY is not set.

Guard rule: auto-describe does NOT overwrite description_source="user" or
"feedback" unless force=True. This respects human edits.
"""
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.services.llm_client import LLMClient

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _extract_col_names(columns_cache) -> list:
    """Handle both list [{name,type},...] and dict {columns:[...]} formats."""
    if not columns_cache:
        return []
    if isinstance(columns_cache, dict):
        columns_cache = columns_cache.get("columns", [])
    return [c.get("name", c) if isinstance(c, dict) else c for c in columns_cache]


def _format_column_stats(column_stats: dict, limit: int = 20) -> str:
    """Format column_stats into readable lines for LLM prompt."""
    if not column_stats:
        return "  (no column stats available)"
    lines = []
    for col, stats in list(column_stats.items())[:limit]:
        dtype = stats.get("dtype", "unknown")
        cardinality = stats.get("cardinality", "?")
        samples = stats.get("samples", [])[:3]
        null_pct = stats.get("null_pct", 0)
        line = f"  - {col} ({dtype}, {cardinality} distinct values"
        if null_pct > 0:
            line += f", {null_pct*100:.0f}% null"
        if samples:
            line += f", samples: {samples}"
        line += ")"
        lines.append(line)
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# System prompts
# ─────────────────────────────────────────────────────────────────────────────

_TABLE_DESCRIBE_SYSTEM = (
    "You are a BI data catalog assistant. Given table metadata, generate rich descriptions. "
    "Always respond ONLY with a valid JSON object — no markdown, no extra text. "
    "JSON keys: "
    "description (string: 2-3 sentence business description, mention data range if detectable), "
    "column_descriptions (object: map each column name to a 1-sentence plain-language description), "
    "common_questions (array of 3-5 short questions a business user might ask about this table)."
)

_CHART_TAG_SYSTEM = (
    "You are a BI metadata expert. Given chart information, extract semantic metadata. "
    "Always respond ONLY with a valid JSON object — no markdown, no extra text. "
    "JSON keys: "
    "domain (string: sales/marketing/finance/operations/hr/logistics/other), "
    "intent (string: trend/comparison/ranking/summary/distribution/other), "
    "metrics (array of strings: business metric names), "
    "dimensions (array of strings: grouping/slice dimension names), "
    "tags (array of strings: relevant search keywords, max 8), "
    "auto_description (string: 2-3 sentences describing what this chart shows and key insight), "
    "insight_keywords (array of 5-10 strings: phrases a user might search to find this chart, "
    "include synonyms and both English/Vietnamese terms if applicable), "
    "common_questions (array of 2-3 follow-up questions a user might ask after viewing this chart)."
)


# ─────────────────────────────────────────────────────────────────────────────
# Prompt builders
# ─────────────────────────────────────────────────────────────────────────────

def _build_table_prompt(table) -> str:
    parts = [f"Table name: {table.display_name}"]

    # Source type hint
    if table.source_kind == "sql_query" and table.source_query:
        parts.append(f"Source: SQL query\nSQL: {table.source_query[:300]}")
    else:
        parts.append("Source: physical table import")

    # Column stats (rich)
    if table.column_stats:
        parts.append(f"\nColumns ({len(table.column_stats)} total):")
        parts.append(_format_column_stats(table.column_stats))
    elif table.columns_cache:
        cols = _extract_col_names(table.columns_cache)
        if cols:
            parts.append(f"\nColumns: {', '.join(cols[:30])}")

    parts.append(
        "\nGenerate: description, column_descriptions (for every column listed), "
        "and common_questions. Respond ONLY in JSON."
    )
    return "\n".join(parts)


def _build_chart_prompt(chart, table=None) -> str:
    parts = [
        f"Chart name: {chart.name}",
        f"Chart type: {chart.chart_type}",
    ]
    config = chart.config or {}
    if config.get("dimensions"):
        parts.append(f"X-axis / dimension columns: {config['dimensions']}")
    if config.get("metrics"):
        parts.append(f"Y-axis / metric columns: {config['metrics']}")
    if config.get("filters"):
        parts.append(f"Filters: {config['filters']}")

    if table:
        parts.append(f"\nSource table: {table.display_name}")
        if table.auto_description:
            parts.append(f"Table description: {table.auto_description}")
        if table.column_stats:
            cols = list(table.column_stats.keys())[:20]
            parts.append(f"Available columns: {', '.join(cols)}")
        elif table.columns_cache:
            cols = _extract_col_names(table.columns_cache)[:20]
            if cols:
                parts.append(f"Available columns: {', '.join(cols)}")

    parts.append(
        "\nGenerate all required JSON keys including auto_description, "
        "insight_keywords, and common_questions."
    )
    return "\n".join(parts)


# ─────────────────────────────────────────────────────────────────────────────
# Service
# ─────────────────────────────────────────────────────────────────────────────

class AutoTaggingService:

    @staticmethod
    def describe_table(db: Session, table_id: int, force: bool = False) -> bool:
        """
        Generate and store description, column_descriptions, and common_questions
        for a workspace table.

        Safe to call in BackgroundTasks. Returns True on success.

        Guard: skips if description_source in ("user", "feedback") unless force=True.
        """
        try:
            from app.models.dataset_workspace import DatasetWorkspaceTable

            table = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == table_id
            ).first()
            if not table:
                return False

            # Guard: respect user/feedback edits
            if not force and table.description_source in ("user", "feedback"):
                logger.debug(
                    "AutoTaggingService: skipping table %s — description_source=%s",
                    table_id, table.description_source
                )
                return True  # Not an error — intentionally skipped

            prompt = _build_table_prompt(table)
            result = LLMClient.complete_json(prompt, system=_TABLE_DESCRIBE_SYSTEM, max_tokens=800)
            if not result:
                return False

            # Write all three fields
            if result.get("description"):
                table.auto_description = result["description"]
            if result.get("column_descriptions"):
                table.column_descriptions = result["column_descriptions"]
            if result.get("common_questions"):
                table.common_questions = result["common_questions"]

            table.description_source = "auto"
            table.description_updated_at = datetime.utcnow()

            db.commit()
            logger.info(
                "AutoTaggingService: described table %s (cols=%d, questions=%d)",
                table_id,
                len(result.get("column_descriptions") or {}),
                len(result.get("common_questions") or []),
            )
            return True

        except Exception as exc:
            logger.warning("AutoTaggingService: describe_table %s failed — %s", table_id, exc)
            db.rollback()
            return False

    @staticmethod
    def tag_chart(db: Session, chart_id: int, force: bool = False) -> bool:
        """
        Generate and upsert full semantic metadata for a chart:
        domain, intent, metrics, dimensions, tags (existing),
        auto_description, insight_keywords, common_questions (new).

        Safe to call in BackgroundTasks. Returns True on success.

        Guard: skips new knowledge fields if description_source in ("user", "feedback")
               unless force=True. Core tagging fields (domain/intent/metrics) always update.
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
            result = LLMClient.complete_json(prompt, system=_CHART_TAG_SYSTEM, max_tokens=800)
            if not result:
                return False

            # Upsert into chart_metadata
            existing = db.query(ChartMetadata).filter(
                ChartMetadata.chart_id == chart_id
            ).first()

            if existing:
                meta = existing
                # Core tagging fields — always update
                meta.domain = result.get("domain") or meta.domain
                meta.intent = result.get("intent") or meta.intent
                meta.metrics = result.get("metrics") or meta.metrics
                meta.dimensions = result.get("dimensions") or meta.dimensions
                meta.tags = result.get("tags") or meta.tags
            else:
                meta = ChartMetadata(
                    chart_id=chart_id,
                    domain=result.get("domain"),
                    intent=result.get("intent"),
                    metrics=result.get("metrics") or [],
                    dimensions=result.get("dimensions") or [],
                    tags=result.get("tags") or [],
                )
                db.add(meta)

            # Knowledge fields — guard unless force
            if force or meta.description_source not in ("user", "feedback"):
                if result.get("auto_description"):
                    meta.auto_description = result["auto_description"]
                if result.get("insight_keywords"):
                    meta.insight_keywords = result["insight_keywords"]
                if result.get("common_questions"):
                    meta.common_questions = result["common_questions"]
                meta.description_source = "auto"
                meta.description_updated_at = datetime.utcnow()

            db.commit()
            logger.info(
                "AutoTaggingService: tagged chart %s → domain=%s intent=%s",
                chart_id, result.get("domain"), result.get("intent")
            )
            return True

        except Exception as exc:
            logger.warning("AutoTaggingService: tag_chart %s failed — %s", chart_id, exc)
            db.rollback()
            return False
