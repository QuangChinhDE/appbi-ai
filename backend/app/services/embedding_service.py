"""
EmbeddingService - generate vectors and store chart/table embeddings.

Uses the OpenAI embeddings endpoint. Embeddings are stored in
resource_embeddings (pgvector).
"""
import logging
import threading
from collections import OrderedDict
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings

logger = logging.getLogger(__name__)

OPENAI_BASE_URL = "https://api.openai.com/v1"

#: How long to wait for a QUERY embedding before giving up.
#:
#: Indexing keeps the generous `_TIMEOUT_S`: it runs in the background and a slow
#: response is better than a document that never gets embedded. A query is the
#: opposite - it sits inside an agent node with a 45-second budget for the WHOLE
#: run, so a call still waiting at 30 seconds has already lost the thing it was
#: trying to win. Returning None degrades to keyword ranking, which is what
#: happens anyway when no key is configured.
_QUERY_TIMEOUT_S = 12.0
_TIMEOUT_S = 30.0

#: A batch may not stall the passes it was meant to save.
#:
#: `prime_query_embeddings` buys vectors the retrieval passes are about to ask
#: for. If it fails they ask anyway, so a slow batch is not free the way a failed
#: cache lookup is - it is added on top. Measured once at 12s before this bound
#: existed, which made the saving cost more than the thing it replaced. Kept well
#: under the per-call ceiling so the fallback is still affordable.
_PRIME_TIMEOUT_S = 5.0

#: One HTTP client, kept open.
#:
#: MEASURED, five embedding calls to the same endpoint from this host:
#:
#:     a new connection each call   1177, 1467, 399, 390, 785 ms   (4218 total)
#:     one client, keep-alive        750,  260, 265, 261, 264 ms   (1800 total)
#:
#: `httpx.post` is a module-level helper that builds a client, sends one request
#: and closes it, so every embedding paid a fresh TLS handshake to
#: api.openai.com. That is the 750ms first call - and, worse, it is where the
#: variance lives: handshakes on a loaded host stretched to 1.5s and sometimes
#: failed outright with "_ssl.c:999: The handshake operation timed out". A
#: reused connection answers in 260ms, and answers in 260ms every time.
#:
#: This is the actual cause of the analysis node's timeout. The retrieval work
#: was never the expensive part; opening the same connection over and over was.
_client_lock = threading.Lock()
_client: Optional["httpx.Client"] = None


def _http() -> "httpx.Client":
    """The shared client, built on first use.

    Lazy because importing this module must not open sockets - it is imported by
    tests, by alembic and by workers that never embed anything.
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = httpx.Client(
                    timeout=_TIMEOUT_S,
                    limits=httpx.Limits(
                        max_keepalive_connections=8, max_connections=16,
                        keepalive_expiry=90.0,
                    ),
                )
    return _client

#: Query vectors, kept in process.
#:
#: MEASURED, on one two-clause question against ten published documents:
#:
#:     tong 3394ms | embedding 2142ms qua 4 lan (63%)
#:          514ms  "Ty le giao dung hen duoc tinh nhu the nao..."
#:          736ms  "Don giao dung hen"
#:          440ms  "giao dung hen"
#:          452ms  "dung hen"
#:
#: One question, four round trips to OpenAI, because query expansion runs an extra
#: retrieval pass per alternative and each pass embedded its own query. A single
#: call was measured between 1.7s and 7.4s from this host, so the cost is not only
#: large but unpredictable - which is what a timeout on an analysis node looks like
#: from the outside.
#:
#: The same short alternatives recur constantly (an expansion term is derived from
#: a KPI's recorded alias, not from the user's wording), so the cache earns its
#: keep across questions as well as within one. An embedding is a pure function of
#: (text, model), so a hit is never stale; the only bound needed is memory.
_QUERY_CACHE_MAX = 512
_query_cache: "OrderedDict[tuple, List[float]]" = OrderedDict()
_query_cache_lock = threading.Lock()


def _cache_get(key):
    with _query_cache_lock:
        vector = _query_cache.get(key)
        if vector is not None:
            _query_cache.move_to_end(key)
        return vector


def _cache_put(key, vector) -> None:
    if not vector:
        return
    with _query_cache_lock:
        _query_cache[key] = vector
        _query_cache.move_to_end(key)
        while len(_query_cache) > _QUERY_CACHE_MAX:
            _query_cache.popitem(last=False)


@dataclass(frozen=True)
class EmbeddingProfile:
    model: str
    provider: str = "openai"
    dimensions: int = 768
    distance_metric: str = "cosine"


def _configured_profiles() -> Dict[str, EmbeddingProfile]:
    dimensions = settings.openai_embedding_dimensions
    return {
        model: EmbeddingProfile(model=model, dimensions=dimensions)
        for model in settings.embedding_models
        if model.startswith("text-embedding-3-")
    }


def _resolve_profile(model: Optional[str] = None) -> EmbeddingProfile:
    requested = (model or "").strip() or settings.active_embedding_model
    profile = _configured_profiles().get(requested)
    if profile is None:
        allowed = ", ".join(_configured_profiles()) or "(none configured)"
        raise ValueError(
            f"Unsupported embedding model '{requested}'. Allowed models: {allowed}."
        )
    return profile


def _openai_embed(content: str, model: Optional[str] = None,
                  timeout: float = _TIMEOUT_S) -> Optional[List[float]]:
    api_key = settings.OPENAI_API_KEY.strip()
    if not api_key:
        return None

    try:
        profile = _resolve_profile(model)
    except ValueError as exc:
        logger.warning("EmbeddingService: %s", exc)
        return None

    payload: Dict[str, Any] = {
        "model": profile.model,
        "input": content,
        "encoding_format": "float",
        "dimensions": profile.dimensions,
    }

    try:
        response = _http().post(
            f"{OPENAI_BASE_URL}/embeddings",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json().get("data") or []
        if not data:
            return None
        embedding = data[0].get("embedding")
        if not isinstance(embedding, list):
            return None
        vector = [float(value) for value in embedding]
        if len(vector) != profile.dimensions:
            logger.warning(
                "EmbeddingService: model %s returned %s dimensions; expected %s",
                profile.model,
                len(vector),
                profile.dimensions,
            )
            return None
        return vector
    except Exception as exc:
        logger.warning("EmbeddingService: OpenAI embedding failed - %s", exc)
        return None


def _openai_embed_many(contents: List[str], model: Optional[str] = None,
                       timeout: float = _TIMEOUT_S) -> Optional[List[List[float]]]:
    """Embed a batch in one request. Returns vectors in the order asked, or None.

    Every failure mode collapses to None on purpose: this is a saving, and a
    caller that cannot take the saving must still be able to take the slow path.
    """
    api_key = settings.OPENAI_API_KEY.strip()
    if not api_key or not contents:
        return None
    try:
        profile = _resolve_profile(model)
    except ValueError as exc:
        logger.warning("EmbeddingService: %s", exc)
        return None

    try:
        response = _http().post(
            f"{OPENAI_BASE_URL}/embeddings",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": profile.model,
                "input": contents,
                "encoding_format": "float",
                "dimensions": profile.dimensions,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json().get("data") or []
        if len(data) != len(contents):
            logger.warning(
                "EmbeddingService: batch returned %s vectors for %s inputs",
                len(data), len(contents),
            )
            return None
        # `index` is authoritative; the endpoint does not promise input order.
        out: List[Optional[List[float]]] = [None] * len(contents)
        for item in data:
            position = item.get("index")
            vector = item.get("embedding")
            if not isinstance(position, int) or not isinstance(vector, list):
                return None
            if not 0 <= position < len(contents):
                return None
            if len(vector) != profile.dimensions:
                return None
            out[position] = [float(value) for value in vector]
        return None if any(v is None for v in out) else out
    except Exception as exc:  # noqa: BLE001
        logger.warning("EmbeddingService: OpenAI batch embedding failed - %s", exc)
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
    def embedding_profiles() -> List[Dict[str, Any]]:
        return [asdict(profile) for profile in _configured_profiles().values()]

    @staticmethod
    def resolve_model(model: Optional[str] = None) -> str:
        """Return a configured model id or raise before any data is changed."""
        return _resolve_profile(model).model

    @staticmethod
    def dimensions_for(model: Optional[str] = None) -> int:
        return _resolve_profile(model).dimensions

    @staticmethod
    def generate_embedding(content: str, model: Optional[str] = None) -> Optional[List[float]]:
        """Generate a vector using a configured fixed-dimension profile."""
        if not settings.OPENAI_API_KEY.strip():
            logger.debug("EmbeddingService: OPENAI_API_KEY not set, skipping")
            return None
        result = _openai_embed(content[:8000], model=model)
        if result is None:
            logger.warning("EmbeddingService: generate failed - returned None")
        return result

    @staticmethod
    def generate_query_embedding(query: str, model: Optional[str] = None) -> Optional[List[float]]:
        """Generate a query embedding via OpenAI, or read one already paid for."""
        if not settings.OPENAI_API_KEY.strip():
            return None
        text_in = (query or "")[:2000]
        key = ((model or "").strip() or settings.active_embedding_model, text_in)
        cached = _cache_get(key)
        if cached is not None:
            return cached
        result = _openai_embed(text_in, model=model, timeout=_QUERY_TIMEOUT_S)
        if result is None:
            logger.warning("EmbeddingService: query embed failed - returned None")
            return None
        _cache_put(key, result)
        return result

    @staticmethod
    def prime_query_embeddings(queries: List[str], model: Optional[str] = None) -> int:
        """Embed several queries in ONE request, into the cache the search reads.

        The OpenAI embeddings endpoint takes a list. Query expansion does not: it
        runs one retrieval pass per alternative, and each pass embedded its own
        query on its own round trip. Four sequential trips at 0.4-7.4 seconds each
        is the difference between an answer and a timeout, and three of them were
        buying vectors for three short phrases that could have travelled together.

        Nothing about the callers changes. This fills the cache, and the passes that
        follow ask for their vectors the way they always did and find them already
        there - so a failure here costs a batch, never a search.
        """
        if not settings.OPENAI_API_KEY.strip():
            return 0
        resolved = (model or "").strip() or settings.active_embedding_model
        wanted, seen = [], set()
        for query in queries or []:
            text_in = (query or "").strip()[:2000]
            if not text_in or text_in in seen:
                continue
            seen.add(text_in)
            if _cache_get((resolved, text_in)) is None:
                wanted.append(text_in)
        if not wanted:
            return 0
        vectors = _openai_embed_many(wanted, model=model, timeout=_PRIME_TIMEOUT_S)
        if not vectors:
            return 0
        primed = 0
        for text_in, vector in zip(wanted, vectors):
            if vector:
                _cache_put((resolved, text_in), vector)
                primed += 1
        return primed

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
        *,
        commit: bool = True,
    ) -> bool:
        """Generate and upsert a resource vector without poisoning caller work.

        The SQL runs in a savepoint because this helper is also called while a
        knowledge fact and its review/audit rows are still pending. A vector
        failure is best-effort and must not roll back those business records.
        Standalone chart/table jobs keep the historical commit-on-success
        behaviour; transactional callers pass ``commit=False``.
        """
        vector = EmbeddingService.generate_embedding(source_text)
        if vector is None:
            return False

        try:
            with db.begin_nested():
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
            if commit:
                db.commit()
            logger.info("EmbeddingService: upserted %s/%s", resource_type, resource_id)
            return True
        except Exception as exc:
            logger.warning("EmbeddingService: upsert failed - %s", exc)
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
                    WHERE re.resource_type = :rtype
                                            AND (
                                                c.owner_id = CAST(:uid AS uuid)
                                                OR EXISTS (
                                                    SELECT 1
                                                    FROM resource_shares rs
                                                    WHERE rs.resource_type = 'chart'
                                                        AND rs.resource_id = CAST(c.id AS varchar)
                                                        AND (
                                                            rs.user_id = CAST(:uid AS uuid)
                                                            OR rs.team_id IN (
                                                                SELECT tm.team_id
                                                                FROM team_memberships tm
                                                                WHERE tm.user_id = CAST(:uid AS uuid)
                                                            )
                                                        )
                                                )
                                            )
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
