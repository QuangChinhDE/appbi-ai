"""Govern knowledge-doc RAG — embed long business docs as chunks (pgvector) and
retrieve the passages most RELEVANT to a question, instead of stuffing a
truncated summary into every prompt.

Design (prod-ready, reuses the existing OpenRouter 768-dim pipeline + pgvector
on the SAME Postgres — e.g. Cloud SQL for PostgreSQL, which supports pgvector):
  • embed_doc()  — HASH-GATED: re-saving an unchanged body → 0 embedding calls;
                   chunk-level dedup → editing one paragraph re-embeds only it.
  • retrieve_doc_chunks() — cosine top-k over this dashboard's Published docs.
Everything is best-effort: if no embedding key is configured (generate_* → None)
we keep old chunks and callers fall back to summary blurbs. Never raises.
"""
from __future__ import annotations

import hashlib
import logging
import re

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"\{\{[^}]+\}\}")   # {{metric:…}} / {{dashboard:…}} embed tokens
_TARGET = 850          # aim per chunk (chars)
_HARD = 1400           # hard-split blocks longer than this
_MAX_CHUNKS = 40


def _body_hash(model: str, body: str) -> str:
    return hashlib.sha256(f"{model}\n{body}".encode("utf-8")).hexdigest()


def chunk_doc(body: str | None) -> list[str]:
    """Split a markdown body into ~850-char chunks on paragraph boundaries, with
    embed tokens stripped (they're structural refs, not prose)."""
    cleaned = _TOKEN_RE.sub("", body or "").strip()
    if not cleaned:
        return []
    blocks = [b.strip() for b in re.split(r"\n\s*\n", cleaned) if b.strip()]
    chunks: list[str] = []
    cur = ""
    for b in blocks:
        if len(b) > _HARD:
            if cur:
                chunks.append(cur)
                cur = ""
            for i in range(0, len(b), _TARGET):
                chunks.append(b[i:i + _TARGET])
            continue
        if not cur:
            cur = b
        elif len(cur) + len(b) + 2 <= _TARGET:
            cur = f"{cur}\n\n{b}"
        else:
            chunks.append(cur)
            cur = b
    if cur:
        chunks.append(cur)
    return chunks[:_MAX_CHUNKS]


def delete_doc_chunks(db: Session, doc_id: int) -> None:
    try:
        db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc_id})
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


def embed_doc(db, doc) -> str:
    """(Re)embed a doc's chunks — hash-gated so unchanged bodies cost nothing.
    `doc` is a GovernKnowledgeDoc ORM instance. Returns a short status string."""
    from app.services.embedding_service import EmbeddingService
    try:
        # RAG serves the PUBLISHED (live) version's body — not the latest draft.
        # So editing a new draft does NOT re-index; only publishing does.
        from app.services.governance_service import GovernanceService
        live_body = GovernanceService.published_body(db, doc)
        body = (live_body or "").strip()
        model = settings.active_embedding_model

        # Archived or empty → drop chunks, clear hash (nothing to retrieve).
        if not body or (doc.status or "") == "Archived":
            db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id})
            doc.embedded_hash = None
            db.commit()
            return "cleared"

        h = _body_hash(model, body)
        if doc.embedded_hash == h:
            return "unchanged"  # HASH-GATE — no embedding calls at all

        chunks = chunk_doc(body)
        if not chunks:
            return "empty"

        # Reuse embeddings of paragraphs whose text is unchanged (chunk dedup).
        existing: dict[str, str] = {}
        for row in db.execute(
            text("SELECT content_hash, embedding::text FROM govern_doc_chunk WHERE doc_id = :d"),
            {"d": doc.id},
        ).fetchall():
            if row[1]:
                existing[row[0]] = row[1]

        prepared: list[tuple[int, str, str, str]] = []
        embedded_new = 0
        for idx, ch in enumerate(chunks):
            chash = hashlib.sha256(ch.encode("utf-8")).hexdigest()
            emb = existing.get(chash)
            if emb is None:
                vec = EmbeddingService.generate_embedding(ch)
                if vec is None:
                    # No key / provider error → keep old chunks, retry on next save.
                    logger.warning("govern_doc_embeddings: embedding unavailable (doc %s) — kept previous chunks", doc.id)
                    return "unavailable"
                emb = str(vec)
                embedded_new += 1
            prepared.append((idx, ch, chash, emb))

        # Atomic replace only after every chunk has an embedding.
        db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id})
        for idx, ch, chash, emb in prepared:
            db.execute(
                text(
                    """INSERT INTO govern_doc_chunk (doc_id, chunk_index, content, content_hash, embedding, model_version)
                       VALUES (:d, :i, :c, :h, :e, :m)"""
                ),
                {"d": doc.id, "i": idx, "c": ch, "h": chash, "e": emb, "m": model},
            )
        doc.embedded_hash = h
        db.commit()
        return f"embedded:{len(prepared)} (new {embedded_new})"
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_embeddings.embed_doc failed (doc %s)", getattr(doc, "id", None), exc_info=True)
        db.rollback()
        return "error"


def retrieve_doc_chunks(db: Session, dashboard_id: int, question: str = "", k: int = 6) -> list[dict]:
    """Cosine top-k chunks over this dashboard's Published, linked docs. Empty if
    embeddings are unavailable (→ caller falls back to summary blurbs)."""
    from app.services.embedding_service import EmbeddingService
    try:
        # Cheap guard FIRST: if this dashboard has no embedded chunks yet, skip the
        # query-embedding API call entirely (0 wasted tokens until docs are embedded).
        has_chunks = db.execute(
            text(
                """
                SELECT 1 FROM govern_doc_chunk c
                JOIN govern_knowledge_docs d ON d.id = c.doc_id AND d.status = 'Published'
                JOIN govern_doc_asset_links l ON l.doc_id = d.id
                     AND l.asset_type = 'dashboard' AND l.asset_ref = :did
                WHERE c.embedding IS NOT NULL LIMIT 1
                """
            ),
            {"did": str(dashboard_id)},
        ).first()
        if not has_chunks:
            return []
        qvec = EmbeddingService.generate_query_embedding(question or "")
        if qvec is None:
            return []
        lit = str(qvec)  # floats only — safe to inline (mirrors EmbeddingService.search_similar)
        rows = db.execute(
            text(
                f"""
                SELECT c.doc_id, d.title, c.content,
                       1 - (c.embedding <=> '{lit}'::vector) AS sim
                FROM govern_doc_chunk c
                JOIN govern_knowledge_docs d
                     ON d.id = c.doc_id AND d.status = 'Published'
                JOIN govern_doc_asset_links l
                     ON l.doc_id = d.id AND l.asset_type = 'dashboard' AND l.asset_ref = :did
                WHERE c.embedding IS NOT NULL
                ORDER BY c.embedding <=> '{lit}'::vector
                LIMIT :k
                """
            ),
            {"did": str(dashboard_id), "k": k},
        ).fetchall()
        out = [{"doc_id": r[0], "title": r[1], "content": r[2], "similarity": float(r[3])} for r in rows]
        # Usage telemetry: these docs were just pulled into an AI answer.
        # Best-effort — analytics must never break retrieval.
        try:
            ids = sorted({r["doc_id"] for r in out})
            if ids:
                db.execute(
                    text("UPDATE govern_knowledge_docs SET retrieval_count = COALESCE(retrieval_count,0) + 1 WHERE id = ANY(:ids)"),
                    {"ids": ids},
                )
                db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        return out
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_embeddings.retrieve_doc_chunks failed", exc_info=True)
        return []


def backfill(db: Session) -> dict[int, str]:
    """Embed all Published docs missing/stale embeddings (idempotent, hash-gated)."""
    from app.models.governance import GovernKnowledgeDoc
    out: dict[int, str] = {}
    for d in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.status == "Published").all():
        out[d.id] = embed_doc(db, d)
    return out
