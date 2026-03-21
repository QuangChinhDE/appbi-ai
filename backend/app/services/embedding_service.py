"""
EmbeddingService — generate and store vector embeddings for charts/tables.

Uses Gemini gemini-embedding-001 (768 dims via outputDimensionality) via direct httpx call.
NOTE: text-embedding-004 is not available on this project's API key.
      gemini-embedding-001 is available on v1beta and supports outputDimensionality=768
      so the DB vector(768) schema stays unchanged.
Stores embeddings in resource_embeddings table (pgvector).
"""
import logging
from typing import List, Optional, Dict, Any

import httpx
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.core.config import settings

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = "models/gemini-embedding-001"
EMBEDDING_DIMS = 768
_GEMINI_EMBED_URL = (
    "https://generativelanguage.googleapis.com/v1beta/"
    "models/gemini-embedding-001:embedContent"
)


def _gemini_embed(content: str, task_type: str) -> Optional[List[float]]:
    """
    Direct httpx POST to Gemini v1beta embedding endpoint.
    Uses outputDimensionality=768 to match the existing vector(768) DB column.
    """
    if not settings.GEMINI_API_KEY:
        return None
    try:
        resp = httpx.post(
            _GEMINI_EMBED_URL,
            params={"key": settings.GEMINI_API_KEY},
            json={
                "model": EMBEDDING_MODEL,
                "content": {"parts": [{"text": content}]},
                "taskType": task_type,
                "outputDimensionality": EMBEDDING_DIMS,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()["embedding"]["values"]
    except Exception as exc:
        logger.warning("EmbeddingService: _gemini_embed failed — %s", exc)
        return None


def _extract_col_names(columns_cache) -> List[str]:
    """Handle both array [{name, type}, ...] and object {"columns": [...]} formats."""
    if not columns_cache:
        return []
    if isinstance(columns_cache, dict):
        columns_cache = columns_cache.get("columns", [])
    return [c.get("name", c) if isinstance(c, dict) else c for c in columns_cache]


class EmbeddingService:

    # ── Embedding generation ────────────────────────────────────────────────

    @staticmethod
    def generate_embedding(content: str) -> Optional[List[float]]:
        """Call Gemini embedding API. Returns 768-dim vector or None on failure."""
        if not settings.GEMINI_API_KEY:
            logger.debug("EmbeddingService: GEMINI_API_KEY not set, skipping")
            return None
        result = _gemini_embed(content[:8000], "RETRIEVAL_DOCUMENT")
        if result is None:
            logger.warning("EmbeddingService: generate failed — returned None")
        return result

    @staticmethod
    def generate_query_embedding(query: str) -> Optional[List[float]]:
        """Embedding for a search query (different task_type for better retrieval)."""
        if not settings.GEMINI_API_KEY:
            return None
        result = _gemini_embed(query[:2000], "RETRIEVAL_QUERY")
        if result is None:
            logger.warning("EmbeddingService: query embed failed — returned None")
        return result

    # ── Text builders ───────────────────────────────────────────────────────

    @staticmethod
    def build_chart_text(chart, table=None) -> str:
        """Build searchable text from chart + optional table info."""
        parts = [
            f"Chart: {chart.name}",
            f"Type: {chart.chart_type}",
        ]

        # Chart metadata (domain, intent, metrics, tags) — relationship is chart_meta
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

        # Chart config axes
        config = chart.config or {}
        if config.get("dimensions"):
            parts.append(f"X-axis: {config['dimensions']}")
        if config.get("metrics"):
            parts.append(f"Y-axis: {config['metrics']}")

        # Table info
        if table:
            parts.append(f"Table: {table.display_name}")
            if table.column_stats:
                parts.append(f"Columns: {', '.join(table.column_stats.keys())}")
            elif table.columns_cache:
                cols = _extract_col_names(table.columns_cache)
                if cols:
                    parts.append(f"Columns: {', '.join(cols)}")

        return "\n".join(parts)

    @staticmethod
    def build_table_text(table) -> str:
        """Build searchable text for a workspace table."""
        parts = [f"Table: {table.display_name}"]
        if table.auto_description:
            parts.append(f"Description: {table.auto_description}")
        if table.column_stats:
            parts.append(f"Columns: {', '.join(table.column_stats.keys())}")
        elif table.columns_cache:
            cols = _extract_col_names(table.columns_cache)
            if cols:
                parts.append(f"Columns: {', '.join(cols)}")
        return "\n".join(parts)

    # ── Upsert helpers ──────────────────────────────────────────────────────

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
            db.execute(text("""
                INSERT INTO resource_embeddings
                    (resource_type, resource_id, embedding, source_text, updated_at)
                VALUES
                    (:rtype, :rid, :emb, :src, NOW())
                ON CONFLICT (resource_type, resource_id)
                DO UPDATE SET
                    embedding   = EXCLUDED.embedding,
                    source_text = EXCLUDED.source_text,
                    updated_at  = NOW()
            """), {
                "rtype": resource_type,
                "rid": resource_id,
                "emb": str(vector),
                "src": source_text,
            })
            db.commit()
            logger.info("EmbeddingService: upserted %s/%s", resource_type, resource_id)
            return True
        except Exception as exc:
            logger.warning("EmbeddingService: upsert failed — %s", exc)
            db.rollback()
            return False

    @staticmethod
    def embed_chart(db: Session, chart_id: int) -> bool:
        """Embed a chart (with its workspace table). Safe to call in background."""
        try:
            from app.models.models import Chart
            from app.models.dataset_workspace import DatasetWorkspaceTable
            chart = db.query(Chart).filter(Chart.id == chart_id).first()
            if not chart:
                return False
            table = None
            if chart.workspace_table_id:
                table = db.query(DatasetWorkspaceTable).filter(
                    DatasetWorkspaceTable.id == chart.workspace_table_id
                ).first()
            source_text = EmbeddingService.build_chart_text(chart, table)
            return EmbeddingService.upsert_embedding(db, "chart", chart_id, source_text)
        except Exception as exc:
            logger.warning("EmbeddingService: embed_chart %s failed — %s", chart_id, exc)
            return False

    @staticmethod
    def embed_table(db: Session, table_id: int) -> bool:
        """Embed a workspace table. Safe to call in background."""
        try:
            from app.models.dataset_workspace import DatasetWorkspaceTable
            table = db.query(DatasetWorkspaceTable).filter(
                DatasetWorkspaceTable.id == table_id
            ).first()
            if not table:
                return False
            source_text = EmbeddingService.build_table_text(table)
            return EmbeddingService.upsert_embedding(db, "workspace_table", table_id, source_text)
        except Exception as exc:
            logger.warning("EmbeddingService: embed_table %s failed — %s", table_id, exc)
            return False

    @staticmethod
    def delete_embedding(db: Session, resource_type: str, resource_id: int) -> None:
        """Remove embedding when resource is deleted."""
        try:
            db.execute(text(
                "DELETE FROM resource_embeddings WHERE resource_type=:rt AND resource_id=:rid"
            ), {"rt": resource_type, "rid": resource_id})
            db.commit()
        except Exception as exc:
            logger.warning("EmbeddingService: delete failed — %s", exc)
            db.rollback()

    # ── Search ──────────────────────────────────────────────────────────────

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
        Falls back to empty list if embeddings not available.
        """
        query_vector = EmbeddingService.generate_query_embedding(query)
        if query_vector is None:
            return []

        try:
            # Embed the vector literal directly — avoids SQLAlchemy `:param::type` tokenizer conflict
            qemb_lit = str(query_vector)
            if resource_type == "chart" and user_id is not None:
                # Permission-aware: only charts owned by or shared with user
                rows = db.execute(text(f"""
                    SELECT
                        re.resource_id,
                        re.source_text,
                        1 - (re.embedding <=> '{qemb_lit}'::vector) AS similarity
                    FROM resource_embeddings re
                    JOIN charts c ON c.id = re.resource_id
                    LEFT JOIN resource_shares rs
                        ON rs.resource_type = 'chart'
                        AND rs.resource_id = c.id
                        AND rs.user_id = CAST(:uid AS uuid)
                    WHERE re.resource_type = :rtype
                      AND (c.owner_id = CAST(:uid AS uuid) OR rs.id IS NOT NULL)
                    ORDER BY re.embedding <=> '{qemb_lit}'::vector
                    LIMIT :lim
                """), {
                    "rtype": resource_type,
                    "uid": str(user_id),
                    "lim": limit,
                }).fetchall()
            else:
                rows = db.execute(text(f"""
                    SELECT resource_id, source_text,
                           1 - (embedding <=> '{qemb_lit}'::vector) AS similarity
                    FROM resource_embeddings
                    WHERE resource_type = :rtype
                    ORDER BY embedding <=> '{qemb_lit}'::vector
                    LIMIT :lim
                """), {
                    "rtype": resource_type,
                    "lim": limit,
                }).fetchall()

            return [
                {
                    "resource_id": row[0],
                    "source_text": row[1],
                    "similarity": float(row[2]),
                }
                for row in rows
            ]
        except Exception as exc:
            logger.warning("EmbeddingService: search failed — %s", exc)
            return []
