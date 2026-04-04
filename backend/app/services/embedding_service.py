"""
EmbeddingService - generate and store vector embeddings for charts/tables.

Uses the OpenRouter embeddings endpoint so all AI traffic goes through the same
provider. Embeddings are stored in resource_embeddings (pgvector).
"""
import logging
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings

logger = logging.getLogger(__name__)

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def _openrouter_embed(content: str) -> Optional[List[float]]:
    if not settings.OPENROUTER_API_KEY:
        return None

    payload: Dict[str, Any] = {
        "model": settings.OPENROUTER_EMBEDDING_MODEL,
        "input": content,
        "encoding_format": "float",
    }
    if settings.OPENROUTER_EMBEDDING_DIMENSIONS > 0:
        payload["dimensions"] = settings.OPENROUTER_EMBEDDING_DIMENSIONS

    try:
        response = httpx.post(
            f"{OPENROUTER_BASE_URL}/embeddings",
            headers={
                "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": settings.OPENROUTER_SITE_URL,
                "X-Title": settings.OPENROUTER_APP_NAME,
            },
            json=payload,
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json().get("data") or []
        if not data:
            return None
        embedding = data[0].get("embedding")
        if not isinstance(embedding, list):
            return None
        return [float(value) for value in embedding]
    except Exception as exc:
        logger.warning("EmbeddingService: OpenRouter embedding failed - %s", exc)
        return None


def _extract_col_names(columns_cache) -> List[str]:
    """Handle both array [{name, type}, ...] and object {"columns": [...]} formats."""
    if not columns_cache:
        return []
    if isinstance(columns_cache, dict):
        columns_cache = columns_cache.get("columns", [])
    return [c.get("name", c) if isinstance(c, dict) else c for c in columns_cache]


class EmbeddingService:
    @staticmethod
    def generate_embedding(content: str) -> Optional[List[float]]:
        """Generate a document embedding via OpenRouter."""
        if not settings.OPENROUTER_API_KEY:
            logger.debug("EmbeddingService: OPENROUTER_API_KEY not set, skipping")
            return None
        result = _openrouter_embed(content[:8000])
        if result is None:
            logger.warning("EmbeddingService: generate failed - returned None")
        return result

    @staticmethod
    def generate_query_embedding(query: str) -> Optional[List[float]]:
        """Generate a query embedding via OpenRouter."""
        if not settings.OPENROUTER_API_KEY:
            return None
        result = _openrouter_embed(query[:2000])
        if result is None:
            logger.warning("EmbeddingService: query embed failed - returned None")
        return result

    @staticmethod
    def build_chart_text(chart, table=None) -> str:
        """
        Build rich searchable text from chart + optional table info.
        Incorporates knowledge system fields: auto_description, insight_keywords,
        query_aliases, common_questions from ChartMetadata.
        """
        parts = [
            f"Chart: {chart.name}",
            f"Type: {chart.chart_type}",
        ]

        m = getattr(chart, "chart_meta", None)
        if m:
            if m.domain:
                parts.append(f"Domain: {m.domain}")
            if m.intent:
                parts.append(f"Intent: {m.intent}")
            if m.metrics:
                parts.append(f"Metrics: {', '.join(m.metrics)}")
            if m.dimensions:
                parts.append(f"Dimensions: {', '.join(m.dimensions)}")
            if m.tags:
                parts.append(f"Tags: {', '.join(m.tags)}")
            if m.auto_description:
                parts.append(f"Description: {m.auto_description}")
            if m.insight_keywords:
                parts.append(f"Keywords: {', '.join(m.insight_keywords)}")
            if m.query_aliases:
                parts.append(f"Also searched as: {', '.join(m.query_aliases)}")
            if m.common_questions:
                parts.append(f"Common questions: {'; '.join(m.common_questions)}")

        config = chart.config or {}
        if config.get("dimensions"):
            parts.append(f"X-axis: {config['dimensions']}")
        if config.get("metrics"):
            parts.append(f"Y-axis: {config['metrics']}")

        if table:
            parts.append(f"Table: {table.display_name}")
            if table.auto_description:
                parts.append(f"Table description: {table.auto_description[:200]}")
            if table.column_stats:
                parts.append(f"Columns: {', '.join(table.column_stats.keys())}")
            elif table.columns_cache:
                cols = _extract_col_names(table.columns_cache)
                if cols:
                    parts.append(f"Columns: {', '.join(cols)}")

        return "\n".join(parts)

    @staticmethod
    def build_table_text(table) -> str:
        """
        Build rich searchable text for a dataset table.
        Incorporates knowledge system fields: column_descriptions, query_aliases,
        common_questions for significantly better embedding search quality.
        """
        parts = [f"Table: {table.display_name}"]

        if table.auto_description:
            parts.append(f"Description: {table.auto_description}")

        if table.column_descriptions:
            for col, desc in list(table.column_descriptions.items())[:20]:
                parts.append(f"Column {col}: {desc}")

        if table.column_stats:
            col_summary = ", ".join(
                [
                    f"{col} ({stats.get('dtype', 'unknown')})"
                    for col, stats in list(table.column_stats.items())[:25]
                ]
            )
            parts.append(f"Columns: {col_summary}")
        elif table.columns_cache:
            cols = _extract_col_names(table.columns_cache)
            if cols:
                parts.append(f"Columns: {', '.join(cols[:25])}")

        if table.query_aliases:
            parts.append(
                "Also known as / commonly searched with: "
                f"{', '.join(table.query_aliases)}"
            )

        if table.common_questions:
            parts.append(f"Common questions: {'; '.join(table.common_questions)}")

        return "\n".join(parts)

    @staticmethod
    def upsert_embedding(
        db: Session,
        resource_type: str,
        resource_id: int,
        source_text: str,
    ) -> bool:
        """Generate embedding and upsert into resource_embeddings. Returns True on success."""
        vector = EmbeddingService.generate_embedding(source_text)
        if vector is None:
            return False

        try:
            db.execute(
                text(
                    """
                INSERT INTO resource_embeddings
                    (resource_type, resource_id, embedding, source_text, updated_at)
                VALUES
                    (:rtype, :rid, :emb, :src, NOW())
                ON CONFLICT (resource_type, resource_id)
                DO UPDATE SET
                    embedding   = EXCLUDED.embedding,
                    source_text = EXCLUDED.source_text,
                    updated_at  = NOW()
            """
                ),
                {
                    "rtype": resource_type,
                    "rid": resource_id,
                    "emb": str(vector),
                    "src": source_text,
                },
            )
            db.commit()
            logger.info("EmbeddingService: upserted %s/%s", resource_type, resource_id)
            return True
        except Exception as exc:
            logger.warning("EmbeddingService: upsert failed - %s", exc)
            db.rollback()
            return False

    @staticmethod
    def embed_chart(db: Session, chart_id: int) -> bool:
        """Embed a chart (with its dataset table). Safe to call in background."""
        try:
            from app.models.dataset import DatasetTable
            from app.models.models import Chart

            chart = db.query(Chart).filter(Chart.id == chart_id).first()
            if not chart:
                return False
            table = None
            if chart.dataset_table_id:
                table = db.query(DatasetTable).filter(
                    DatasetTable.id == chart.dataset_table_id
                ).first()
            source_text = EmbeddingService.build_chart_text(chart, table)
            return EmbeddingService.upsert_embedding(db, "chart", chart_id, source_text)
        except Exception as exc:
            logger.warning("EmbeddingService: embed_chart %s failed - %s", chart_id, exc)
            return False

    @staticmethod
    def embed_table(db: Session, table_id: int) -> bool:
        """Embed a dataset table. Safe to call in background."""
        try:
            from app.models.dataset import DatasetTable

            table = db.query(DatasetTable).filter(
                DatasetTable.id == table_id
            ).first()
            if not table:
                return False
            source_text = EmbeddingService.build_table_text(table)
            return EmbeddingService.upsert_embedding(db, "dataset_table", table_id, source_text)
        except Exception as exc:
            logger.warning("EmbeddingService: embed_table %s failed - %s", table_id, exc)
            return False

    @staticmethod
    def delete_embedding(db: Session, resource_type: str, resource_id: int) -> None:
        """Remove embedding when resource is deleted."""
        try:
            db.execute(
                text(
                    "DELETE FROM resource_embeddings WHERE resource_type=:rt AND resource_id=:rid"
                ),
                {"rt": resource_type, "rid": resource_id},
            )
            db.commit()
        except Exception as exc:
            logger.warning("EmbeddingService: delete failed - %s", exc)
            db.rollback()

    @staticmethod
    def search_similar(
        db: Session,
        query: str,
        resource_type: str = "chart",
        limit: int = 5,
        user_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Vector similarity search with optional permission filtering.
        Returns list of {resource_id, source_text, similarity}.
        Falls back to empty list if embeddings are not available.
        """
        query_vector = EmbeddingService.generate_query_embedding(query)
        if query_vector is None:
            return []

        try:
            qemb_lit = str(query_vector)
            if resource_type == "chart" and user_id is not None:
                rows = db.execute(
                    text(
                        f"""
                    SELECT
                        re.resource_id,
                        re.source_text,
                        1 - (re.embedding <=> '{qemb_lit}'::vector) AS similarity
                    FROM resource_embeddings re
                    JOIN charts c ON c.id = re.resource_id
                    LEFT JOIN resource_shares rs
                        ON rs.resource_type = 'chart'
                        AND rs.resource_id = CAST(c.id AS varchar)
                        AND rs.user_id = CAST(:uid AS uuid)
                    WHERE re.resource_type = :rtype
                      AND (c.owner_id = CAST(:uid AS uuid) OR rs.id IS NOT NULL)
                    ORDER BY re.embedding <=> '{qemb_lit}'::vector
                    LIMIT :lim
                """
                    ),
                    {
                        "rtype": resource_type,
                        "uid": str(user_id),
                        "lim": limit,
                    },
                ).fetchall()
            else:
                rows = db.execute(
                    text(
                        f"""
                    SELECT resource_id, source_text,
                           1 - (embedding <=> '{qemb_lit}'::vector) AS similarity
                    FROM resource_embeddings
                    WHERE resource_type = :rtype
                    ORDER BY embedding <=> '{qemb_lit}'::vector
                    LIMIT :lim
                """
                    ),
                    {
                        "rtype": resource_type,
                        "lim": limit,
                    },
                ).fetchall()

            return [
                {
                    "resource_id": row[0],
                    "source_text": row[1],
                    "similarity": float(row[2]),
                }
                for row in rows
            ]
        except Exception as exc:
            logger.warning("EmbeddingService: search failed - %s", exc)
            return []
