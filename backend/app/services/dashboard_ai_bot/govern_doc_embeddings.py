"""Govern knowledge-doc RAG — embed long business docs as chunks (pgvector) and
retrieve the passages most RELEVANT to a question, instead of stuffing a
truncated summary into every prompt.

Design (prod-ready, reuses the existing OpenRouter 768-dim pipeline + pgvector
on the SAME Postgres — e.g. Cloud SQL for PostgreSQL, which supports pgvector):
  • embed_doc()  — HASH-GATED: re-saving an unchanged body (and unchanged
                   chunking/model config) → 0 embedding calls; chunk-level
                   dedup → editing one paragraph re-embeds only it.
  • retrieve_doc_chunks() — cosine top-k over this dashboard's Published docs.
Everything is best-effort: if no embedding key is configured (generate_* → None)
we keep old chunks and callers fall back to summary blurbs. Never raises.

Chunking is configurable per-doc (doc.chunk_strategy/chunk_size/chunk_overlap/
embedding_model — the Govern "Embedding" tab) instead of hardcoded, via
chunk_doc()'s strategy/size/overlap kwargs; every kwarg defaults to the
original hardcoded behavior so no existing caller changes without opting in.
preview_chunks() is the SAME code path with no DB/embedding cost, so a preview
always matches what embed_doc() will actually produce.
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
_HEADING_RE = re.compile(r"^#{1,6}\s+.*$", re.M)
_TARGET = 850          # default target per chunk (chars) — doc.chunk_size overrides
_HARD = 1400           # hard-split blocks longer than this, regardless of target
_MAX_CHUNKS = 40


def _body_hash(cache_key: str, body: str) -> str:
    """sha256 of a composite cache key (model + chunk config) + body — any
    change to WHAT would be re-embedded (not just the body text) must bust
    the hash-gate, so this is not just the embedding model name anymore."""
    return hashlib.sha256(f"{cache_key}\n{body}".encode("utf-8")).hexdigest()


def _clamp_chunk_params(size: int | None, overlap: int | None) -> tuple[int, int]:
    size = max(100, min(int(size or _TARGET), _HARD))
    overlap = max(0, min(int(overlap or 0), size // 2))
    return size, overlap


def _merge_blocks(blocks: list[str], size: int, hard: int, max_chunks: int) -> list[str]:
    """Greedily merge paragraph-like blocks up to ~`size` chars, hard-splitting
    any single block longer than `hard`. Shared by the paragraph and heading
    strategies (heading pre-splits into sections, then reuses this to merge
    within each section)."""
    chunks: list[str] = []
    cur = ""
    for b in blocks:
        if len(b) > hard:
            if cur:
                chunks.append(cur)
                cur = ""
            for i in range(0, len(b), size):
                chunks.append(b[i:i + size])
            continue
        if not cur:
            cur = b
        elif len(cur) + len(b) + 2 <= size:
            cur = f"{cur}\n\n{b}"
        else:
            chunks.append(cur)
            cur = b
    if cur:
        chunks.append(cur)
    return chunks[:max_chunks]


def _split_paragraph(cleaned: str, size: int, hard: int, max_chunks: int) -> list[str]:
    blocks = [b.strip() for b in re.split(r"\n\s*\n", cleaned) if b.strip()]
    return _merge_blocks(blocks, size, hard, max_chunks)


def _split_heading(cleaned: str, size: int, hard: int, max_chunks: int) -> list[str]:
    """Split on markdown heading boundaries FIRST (so a chunk never straddles
    a section break), then apply the same target/hard-split merge WITHIN each
    section — a section longer than `size` still gets broken into multiple
    chunks, it just never bleeds into the next section's chunk."""
    positions = [m.start() for m in _HEADING_RE.finditer(cleaned)]
    if not positions or positions[0] != 0:
        positions = [0] + positions
    sections = []
    for i, start in enumerate(positions):
        end = positions[i + 1] if i + 1 < len(positions) else len(cleaned)
        section = cleaned[start:end].strip()
        if section:
            sections.append(section)
    chunks: list[str] = []
    for section in sections:
        blocks = [b.strip() for b in re.split(r"\n\s*\n", section) if b.strip()]
        chunks.extend(_merge_blocks(blocks, size, hard, max_chunks))
    return chunks[:max_chunks]


def _split_fixed(cleaned: str, size: int, max_chunks: int) -> list[str]:
    return [cleaned[i:i + size] for i in range(0, len(cleaned), size)][:max_chunks]


def _apply_overlap(chunks: list[str], overlap: int) -> list[str]:
    """Prepend the trailing `overlap` chars of the PREVIOUS (non-overlapped)
    chunk to each chunk after the first — one shared implementation applied
    after any strategy produces its blocks, rather than three separate
    per-strategy overlap implementations."""
    if overlap <= 0 or len(chunks) < 2:
        return chunks
    out = [chunks[0]]
    for i in range(1, len(chunks)):
        out.append(f"{chunks[i - 1][-overlap:]}{chunks[i]}")
    return out


def chunk_doc(body: str | None, *, strategy: str = "paragraph", size: int = _TARGET, overlap: int = 0) -> list[str]:
    """Split a markdown body into chunks. `strategy` is 'paragraph' (default —
    split on blank lines), 'heading' (split on markdown headings first, then
    paragraph-merge within each section), or 'fixed' (raw character window).
    Embed tokens ({{…}}) are stripped (structural refs, not prose); [[wikilinks]]
    keep their readable text ([[A|B]]→B, [[A]]→A) so the AI reads the
    authored relationship as words. Every kwarg defaults to the original
    hardcoded behavior, so `chunk_doc(body)` is unchanged for existing callers."""
    body_text = re.sub(r"\[\[([^\]|\n]+?)\|([^\]\n]+?)\]\]", r"\2", body or "")
    body_text = re.sub(r"\[\[([^\]\n]+?)\]\]", r"\1", body_text)
    cleaned = _TOKEN_RE.sub("", body_text).strip()
    if not cleaned:
        return []

    size, overlap = _clamp_chunk_params(size, overlap)
    strategy = (strategy or "paragraph").strip().lower()
    if strategy == "heading":
        chunks = _split_heading(cleaned, size, _HARD, _MAX_CHUNKS)
    elif strategy == "fixed":
        chunks = _split_fixed(cleaned, size, _MAX_CHUNKS)
    else:
        chunks = _split_paragraph(cleaned, size, _HARD, _MAX_CHUNKS)
    return _apply_overlap(chunks, overlap)[:_MAX_CHUNKS]


def preview_chunks(body: str | None, *, strategy: str = "paragraph", size: int = _TARGET, overlap: int = 0) -> list[str]:
    """Pure text-splitting — no DB writes, no embedding-API calls. Calls the
    IDENTICAL code path as embed_doc(), so a preview always matches exactly
    what will actually be embedded."""
    return chunk_doc(body, strategy=strategy, size=size, overlap=overlap)


def delete_doc_chunks(db: Session, doc_id: int) -> None:
    try:
        db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc_id})
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


def embed_doc(db, doc) -> dict:
    """(Re)embed a doc's chunks — hash-gated so an unchanged body AND unchanged
    chunking/model config cost nothing. `doc` is a GovernKnowledgeDoc ORM
    instance. Returns {status, chunks, new_chunks, detail?} where status is
    one of 'embedded'|'unchanged'|'cleared'|'empty'|'unavailable'|'error' —
    callers persist this via GovernanceService.log_doc_run() instead of
    discarding it as a bare string like before."""
    from app.services.embedding_service import EmbeddingService
    try:
        # RAG serves the PUBLISHED (live) version's body — not the latest draft.
        # So editing a new draft does NOT re-index; only publishing does.
        from app.services.governance_service import GovernanceService
        live_body = GovernanceService.published_body(db, doc)
        body = (live_body or "").strip()
        model = (getattr(doc, "embedding_model", None) or "").strip() or settings.active_embedding_model
        strategy = getattr(doc, "chunk_strategy", None) or "paragraph"
        size, overlap = _clamp_chunk_params(getattr(doc, "chunk_size", None), getattr(doc, "chunk_overlap", None))

        # Archived or empty → drop chunks, clear hash (nothing to retrieve).
        if not body or (doc.status or "") == "Archived":
            db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id})
            doc.embedded_hash = None
            db.commit()
            return {"status": "cleared", "chunks": 0, "new_chunks": 0}

        cache_key = f"{model}:{strategy}:{size}:{overlap}"
        h = _body_hash(cache_key, body)
        if doc.embedded_hash == h:
            existing_count = db.execute(
                text("SELECT COUNT(*) FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id}
            ).scalar() or 0
            return {"status": "unchanged", "chunks": int(existing_count), "new_chunks": 0}  # HASH-GATE — no embedding calls at all

        chunks = chunk_doc(body, strategy=strategy, size=size, overlap=overlap)
        if not chunks:
            return {"status": "empty", "chunks": 0, "new_chunks": 0}

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
                vec = EmbeddingService.generate_embedding(ch, model=model)
                if vec is None:
                    # No key / provider error / incompatible model id → keep old
                    # chunks untouched, retry on next save.
                    logger.warning("govern_doc_embeddings: embedding unavailable (doc %s) — kept previous chunks", doc.id)
                    return {"status": "unavailable", "chunks": 0, "new_chunks": embedded_new}
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
        return {"status": "embedded", "chunks": len(prepared), "new_chunks": embedded_new}
    except Exception as exc:  # noqa: BLE001
        logger.warning("govern_doc_embeddings.embed_doc failed (doc %s)", getattr(doc, "id", None), exc_info=True)
        db.rollback()
        return {"status": "error", "chunks": 0, "new_chunks": 0, "detail": str(exc)[:300]}


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
        out[d.id] = embed_doc(db, d).get("status", "error")
    return out
