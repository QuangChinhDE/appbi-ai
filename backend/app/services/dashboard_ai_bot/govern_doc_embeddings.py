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
import json
import logging
import re

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"\{\{[^}]+\}\}")   # {{metric:…}} / {{dashboard:…}} embed tokens
_HEADING_RE = re.compile(r"^#{1,6}\s+.*$", re.M)
_TARGET = 850          # default target per chunk (chars) — doc.chunk_size overrides
_HARD = 1400           # hard-split blocks longer than this, regardless of target
#: Runaway guard, not an editorial limit. It used to be 40, which silently
#: dropped ~1/3 of a 38k-character document: the doc looked complete on screen
#: while the AI only ever saw the first 40 chunks. Anything above this is
#: reported (see chunk_doc_detailed) instead of disappearing.
_MAX_CHUNKS = 500
_INDEX_HASH_VERSION = "v2"


def _body_hash(cache_key: str, body: str) -> str:
    """sha256 of a composite cache key (model + chunk config) + body — any
    change to WHAT would be re-embedded (not just the body text) must bust
    the hash-gate, so this is not just the embedding model name anymore."""
    digest = hashlib.sha256(f"{cache_key}\n{body}".encode("utf-8")).hexdigest()
    return f"{_INDEX_HASH_VERSION}:{digest}"


def _is_current_index_hash(value: str | None) -> bool:
    """Only current-generation hashes are eligible for chunk-vector reuse."""
    return str(value or "").startswith(f"{_INDEX_HASH_VERSION}:")


def _clamp_chunk_params(size: int | None, overlap: int | None) -> tuple[int, int]:
    size = max(100, min(int(size or _TARGET), _HARD))
    overlap = max(0, min(int(overlap or 0), size // 2))
    return size, overlap


def _merge_blocks(blocks: list[str], size: int, hard: int) -> list[str]:
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
    return chunks


def _split_paragraph(cleaned: str, size: int, hard: int) -> list[str]:
    blocks = [b.strip() for b in re.split(r"\n\s*\n", cleaned) if b.strip()]
    return _merge_blocks(blocks, size, hard)


def _split_heading(cleaned: str, size: int, hard: int) -> list[str]:
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
        chunks.extend(_merge_blocks(blocks, size, hard))
    return chunks


def _split_fixed(cleaned: str, size: int) -> list[str]:
    return [cleaned[i:i + size] for i in range(0, len(cleaned), size)]


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


def chunk_doc_detailed(body: str | None, *, strategy: str = "paragraph", size: int = _TARGET,
                       overlap: int = 0) -> tuple[list[str], dict]:
    """Chunk a body AND report what happened, so truncation can never be silent.

    Returns (chunks, info) where info carries `produced` (before the cap),
    `kept`, `truncated` and how many characters were dropped.
    """
    chunks = _chunk_all(body, strategy=strategy, size=size, overlap=overlap)
    produced = len(chunks)
    kept = chunks[:_MAX_CHUNKS]
    dropped_chars = sum(len(c) for c in chunks[_MAX_CHUNKS:])
    return kept, {
        "produced": produced,
        "kept": len(kept),
        "truncated": produced > _MAX_CHUNKS,
        "dropped_chunks": max(0, produced - len(kept)),
        "dropped_chars": dropped_chars,
        "max_chunks": _MAX_CHUNKS,
    }


def chunk_doc(body: str | None, *, strategy: str = "paragraph", size: int = _TARGET, overlap: int = 0) -> list[str]:
    """Split a markdown body into chunks. `strategy` is 'paragraph' (default —
    split on blank lines), 'heading' (split on markdown headings first, then
    paragraph-merge within each section), or 'fixed' (raw character window).
    Embed tokens ({{…}}) are stripped (structural refs, not prose); [[wikilinks]]
    keep their readable text ([[A|B]]→B, [[A]]→A) so the AI reads the
    authored relationship as words. Every kwarg defaults to the original
    hardcoded behavior, so `chunk_doc(body)` is unchanged for existing callers."""
    return chunk_doc_detailed(body, strategy=strategy, size=size, overlap=overlap)[0]


def _chunk_all(body: str | None, *, strategy: str, size: int, overlap: int) -> list[str]:
    """Split with NO cap applied — the cap is a separate, reported decision."""
    body_text = re.sub(r"\[\[([^\]|\n]+?)\|([^\]\n]+?)\]\]", r"\2", body or "")
    body_text = re.sub(r"\[\[([^\]\n]+?)\]\]", r"\1", body_text)
    cleaned = _TOKEN_RE.sub("", body_text).strip()
    if not cleaned:
        return []

    size, overlap = _clamp_chunk_params(size, overlap)
    strategy = (strategy or "paragraph").strip().lower()
    if strategy == "heading":
        chunks = _split_heading(cleaned, size, _HARD)
    elif strategy == "fixed":
        chunks = _split_fixed(cleaned, size)
    else:
        chunks = _split_paragraph(cleaned, size, _HARD)
    return _apply_overlap(chunks, overlap)


def preview_chunks(body: str | None, *, strategy: str = "paragraph", size: int = _TARGET, overlap: int = 0) -> list[str]:
    """Pure text-splitting — no DB writes, no embedding-API calls. Calls the
    IDENTICAL code path as embed_doc(), so a preview always matches exactly
    what will actually be embedded."""
    return chunk_doc(body, strategy=strategy, size=size, overlap=overlap)


#: HNSW recall knobs, applied per transaction before any vector scan.
#:
#: Every vector query in this module is FILTERED (published docs, linked to one
#: dashboard, one embedding model). An approximate index picks its candidates
#: FIRST and the filter runs after, so a plain scan can hand back fewer rows
#: than asked for — indistinguishable, to the caller, from "the knowledge base
#: has no answer".
#:
#: Measured on 20k vectors with a 2.5%-selective filter, top-6, against an exact
#: scan (uniform-random vectors, i.e. the WORST case for any ANN index — real
#: embeddings cluster and score far higher):
#:
#:     ivfflat lists=10, probes=1 (the old index)  ->  13% recall
#:     HNSW, iterative_scan off                    ->  38%, and only 75/180 rows
#:     HNSW ef=100 strict_order                    ->  52%
#:     HNSW ef=400 relaxed_order                   ->  79%   ~8 ms/query
#:     HNSW ef=800 relaxed_order                   ->  90%  ~13 ms/query
#:
#: `iterative_scan` is not optional: without it the filter starves the result
#: set. `relaxed_order` beats `strict_order` at equal cost, and its one downside
#: — results not in exact distance order — is neutralised by re-sorting on the
#: distance we select anyway (see _vector_ranked_ids). RRF fuses by RANK, so an
#: out-of-order list would otherwise corrupt the fusion silently.
_HNSW_EF_SEARCH = 400
_HNSW_ITERATIVE_SCAN = "relaxed_order"


def _tune_vector_scan(db: Session) -> None:
    """Raise recall for this transaction's vector scans. Best-effort: a server
    without HNSW still answers, just with default recall, so this must never be
    the reason a question goes unanswered."""
    try:
        db.execute(text(f"SET LOCAL hnsw.ef_search = {int(_HNSW_EF_SEARCH)}"))
        db.execute(text(f"SET LOCAL hnsw.iterative_scan = {_HNSW_ITERATIVE_SCAN}"))
    except Exception:  # noqa: BLE001
        db.rollback()  # a failed SET poisons the transaction
        logger.info("govern_doc_embeddings: HNSW scan tuning unavailable — using server defaults")


#: The one place document text leaves this system. Named so the egress log can
#: say WHERE it went, not just that it went.
_EMBEDDING_PROVIDER = "openai"


def log_retrieval(db: Session, *, consumer: str, consumer_ref: str | None, question: str,
                  rows: list[dict], chunk_ids: list) -> None:
    """Record one read out of the vector store.

    The question is hashed, never stored: the audit needs to prove two answers
    came from the same question, not to keep a second copy of everything anyone
    asked. Written in its own transaction and never raised — an audit failure
    must not become an outage.
    """
    try:
        q = question or ""
        db.execute(
            text(
                """
                INSERT INTO govern_doc_retrieval_log
                    (consumer, consumer_ref, question_hash, question_chars,
                     doc_ids, chunk_ids, top_similarity)
                VALUES (:c, :r, :qh, :qc, CAST(:d AS json), CAST(:ch AS json), :sim)
                """
            ),
            {
                "c": consumer, "r": str(consumer_ref) if consumer_ref is not None else None,
                "qh": hashlib.sha256(q.encode("utf-8")).hexdigest() if q else None,
                "qc": len(q),
                "d": json.dumps(sorted({r["doc_id"] for r in rows})),
                "ch": json.dumps(list(chunk_ids)),
                "sim": max((r.get("similarity") or 0.0) for r in rows) if rows else None,
            },
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("govern_doc_embeddings: retrieval audit write failed", exc_info=True)

def index_is_stale(db: Session, doc) -> bool:
    """Has the published content moved on since the last successful embed?

    `embedded_hash` already covers the body AND the chunking/model config, so
    recomputing it is the whole check. It matters because the two ways indexing
    fails are both silent: an embed run that returned 'unavailable' keeps the old
    chunks, and a re-publish that never re-embedded leaves the AI quoting a
    previous edition. Neither shows up in a chunk COUNT, which is all the
    readiness score ever looked at.
    """
    try:
        from app.services.governance_service import GovernanceService

        body = (GovernanceService.published_body(db, doc) or "").strip()
        if not body:
            return False
        from app.services.embedding_service import EmbeddingService

        model = EmbeddingService.resolve_model(getattr(doc, "embedding_model", None))
        dimensions = EmbeddingService.dimensions_for(model)
        size, overlap = _clamp_chunk_params(getattr(doc, "chunk_size", None), getattr(doc, "chunk_overlap", None))
        strategy = getattr(doc, "chunk_strategy", None) or "paragraph"
        return doc.embedded_hash != _body_hash(
            f"{model}:{dimensions}:{strategy}:{size}:{overlap}", body
        )
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_embeddings: staleness check failed (doc %s)", getattr(doc, "id", None), exc_info=True)
        return False

def egress_allowed(doc) -> bool:
    """Only an EXPLICIT False blocks.

    A freshly constructed ORM object has the attribute set to None until the
    column default is applied at flush, and `bool(None)` is False — which read
    as "block this document" and left every brand-new document unindexed. The
    default here is open; blocking is a decision someone has to have made.
    """
    return getattr(doc, "allow_external_embedding", None) is not False


def log_egress(db: Session, doc, *, outcome: str, model: str, chunks: int = 0,
               chars: int = 0, purpose: str = "embedding", triggered_by: str | None = None) -> None:
    """Record a transfer of document text to the external embedding provider.

    Best-effort by design: failing to write the audit row must never be the
    reason indexing fails. It is written in its OWN transaction so a later
    rollback of the embedding cannot erase the fact that text was already sent —
    the network call has happened by then and cannot be un-sent.
    """
    try:
        db.execute(
            text(
                """
                INSERT INTO govern_doc_egress_log
                    (doc_id, doc_title, sensitivity, purpose, provider, model,
                     chunks_sent, chars_sent, outcome, triggered_by)
                VALUES (:d, :t, :s, :p, :prov, :m, :c, :ch, :o, :by)
                """
            ),
            {
                "d": doc.id, "t": (getattr(doc, "title", "") or "")[:300],
                "s": getattr(doc, "sensitivity", None), "p": purpose,
                "prov": _EMBEDDING_PROVIDER, "m": model, "c": chunks, "ch": chars,
                "o": outcome, "by": triggered_by,
            },
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("govern_doc_embeddings: egress log write failed (doc %s)", getattr(doc, "id", None), exc_info=True)

def authoring_scope(db: Session) -> None:
    """Let THIS transaction read chunks of documents that are not published.

    Row-level security defaults `govern_doc_chunk` to published rows only, so a
    retrieval path that forgets its filter returns nothing rather than drafts.
    The Knowledge Hub console legitimately needs the drafts — an author has to be
    able to inspect what was indexed before publishing — so it says so, once, per
    transaction. `SET LOCAL` is deliberate: a session-level SET would ride the
    pooled connection into the next request and quietly widen it.
    """
    _set_chunk_scope(db, "authoring")


def restricted_scope(db: Session) -> None:
    """Close the authoring window for the rest of this transaction.

    `SET LOCAL` lives until the transaction ends, so an authoring read earlier in
    the same request would otherwise leave drafts visible to everything after it.
    Retrieval therefore does not merely *assume* a closed scope, it closes one —
    which is also the call any future consumer of this store should make first.
    """
    _set_chunk_scope(db, "")


def _set_chunk_scope(db: Session, value: str) -> None:
    try:
        db.execute(text("SET LOCAL appbi.chunk_scope = :v"), {"v": value})
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("govern_doc_embeddings: could not set chunk scope %r", value, exc_info=True)


def _vector_ranked_hits(
    db: Session, sql_filter: str, params: dict, vector_literal: str, limit: int
) -> list[tuple[int, float]]:
    """Chunk ids and cosine similarities, ordered nearest first.

    Sorts on the distance the query already returns instead of trusting the
    index's emission order, which is what makes `relaxed_order` safe to use for
    its higher recall: the index may hand rows back slightly out of order, but
    what leaves this function is exact.
    """
    _tune_vector_scan(db)
    rows = db.execute(
        text(
            f"""
            SELECT c.id, (c.embedding <=> CAST(:query_vector AS vector)) AS dist
            FROM govern_doc_chunk c
            {sql_filter}
            ORDER BY c.embedding <=> CAST(:query_vector AS vector)
            LIMIT :lim
            """
        ),
        {**params, "query_vector": vector_literal, "lim": limit},
    ).fetchall()
    return [
        (int(row[0]), 1.0 - float(row[1]))
        for row in sorted(rows, key=lambda row: row[1])
    ]


def _vector_ranked_ids(
    db: Session, sql_filter: str, params: dict, lit: str, limit: int
) -> list[int]:
    """Backward-compatible id-only view used by the vector console/tests."""
    return [
        chunk_id
        for chunk_id, _similarity in _vector_ranked_hits(
            db, sql_filter, params, lit, limit
        )
    ]


#: Reciprocal-rank-fusion constant. 60 is the value from the original RRF paper
#: and is what most hybrid-search implementations use; it damps the influence of
#: any single ranker's top hit without needing score normalisation (cosine and
#: ts_rank are on totally different scales, so summing them directly would be
#: meaningless).
_RRF_K = 60


def _fuse_rrf(*ranked_lists: list) -> dict:
    """Reciprocal Rank Fusion over several ranked id-lists.

    Chosen over a weighted score sum because cosine similarity and ts_rank are
    not comparable quantities; RRF only needs the ORDER each ranker produced.
    """
    scores: dict = {}
    for ranked in ranked_lists:
        for rank, key in enumerate(ranked):
            scores[key] = scores.get(key, 0.0) + 1.0 / (_RRF_K + rank + 1)
    return scores


def _keyword_sql(sql_filter: str, fold: str) -> str:
    """Full-text ranking SQL. `fold` wraps both sides of the match so the doc and
    the query are normalised identically — mismatched folding silently matches
    nothing, which is worse than not folding at all."""
    doc = f"to_tsvector('simple', {fold}(c.content))"
    qry = f"plainto_tsquery('simple', {fold}(:q))"
    return f"""
        SELECT c.id
        FROM govern_doc_chunk c
        {sql_filter}
          AND {doc} @@ {qry}
        ORDER BY ts_rank({doc}, {qry}) DESC
        LIMIT :lim
    """


def _keyword_ranked_ids(db: Session, sql_filter: str, params: dict, query: str, limit: int) -> list:
    """Chunk ids ordered by Postgres full-text relevance. Returns [] when the
    query has no usable tokens (e.g. only punctuation) — never raises, because
    keyword search is an ENHANCEMENT to vector search, not a dependency.

    Accent-folded first (a Vietnamese reader types "Quy II/2026" for a document
    that says "Quý II/2026"), with a plain retry so a database that never ran
    migration 0046 degrades to accent-sensitive matching instead of no matching.
    """
    args = {**params, "q": query, "lim": limit}
    for fold in ("appbi_unaccent", ""):
        try:
            rows = db.execute(text(_keyword_sql(sql_filter, fold)), args).fetchall()
            return [r[0] for r in rows]
        except Exception:  # noqa: BLE001
            db.rollback()  # the failed statement poisons the transaction
            if fold:
                logger.info("govern_doc_embeddings: appbi_unaccent unavailable; retrying accent-sensitive")
                continue
            logger.warning(
                "govern_doc_embeddings: keyword ranking failed; falling back to vector only", exc_info=True
            )
    return []


def delete_doc_chunks(db: Session, doc_id: int) -> None:
    try:
        authoring_scope(db)
        db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc_id})
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


def embed_doc(db, doc, *, force_full_rebuild: bool = False) -> dict:
    """(Re)embed a doc's chunks — hash-gated so an unchanged body AND unchanged
    chunking/model config cost nothing. `doc` is a GovernKnowledgeDoc ORM
    instance. Returns {status, chunks, new_chunks, detail?} where status is
    one of 'embedded'|'unchanged'|'cleared'|'empty'|'unavailable'|'error' —
    callers persist this via GovernanceService.log_doc_run() instead of
    discarding it as a bare string like before."""
    from app.services.embedding_service import EmbeddingService
    try:
        # Re-indexing legitimately touches drafts, so this transaction needs to
        # see its own unpublished chunks (the dedup read below).
        authoring_scope(db)
        # Serialize every writer for this document. Without this lock, a reset to
        # model B and a scheduled sync still running on model A can finish out of
        # order and leave the document row and its chunks in different spaces.
        db.execute(
            text(
                "SELECT id FROM govern_knowledge_docs "
                "WHERE id = :d FOR UPDATE"
            ),
            {"d": doc.id},
        )
        # This instance may have been loaded before it waited for the lock.
        # Refresh after acquiring it so model/config cannot be stale.
        db.refresh(doc)
        # RAG serves the PUBLISHED (live) version's body — not the latest draft.
        # So editing a new draft does NOT re-index; only publishing does.
        from app.services.governance_service import GovernanceService
        live_body = GovernanceService.published_body(db, doc)
        body = (live_body or "").strip()
        try:
            model = EmbeddingService.resolve_model(
                getattr(doc, "embedding_model", None)
            )
            dimensions = EmbeddingService.dimensions_for(model)
        except ValueError as exc:
            db.rollback()
            return {
                "status": "error",
                "chunks": 0,
                "new_chunks": 0,
                "detail": str(exc),
            }
        strategy = getattr(doc, "chunk_strategy", None) or "paragraph"
        size, overlap = _clamp_chunk_params(getattr(doc, "chunk_size", None), getattr(doc, "chunk_overlap", None))

        # Archived or empty → drop chunks, clear hash (nothing to retrieve).
        if not body or (doc.status or "") == "Archived":
            db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id})
            doc.embedded_hash = None
            db.commit()
            return {"status": "cleared", "chunks": 0, "new_chunks": 0}

        # The veto is checked BEFORE chunking, let alone before any network call:
        # a blocked document must not have its text prepared for transfer at all.
        if not egress_allowed(doc):
            db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id})
            doc.embedded_hash = None
            db.commit()
            log_egress(db, doc, outcome="blocked", model=model)
            return {
                "status": "blocked", "chunks": 0, "new_chunks": 0,
                "detail": "Tài liệu bị chặn gửi ra nhà cung cấp embedding bên ngoài.",
            }

        cache_key = f"{model}:{dimensions}:{strategy}:{size}:{overlap}"
        h = _body_hash(cache_key, body)
        if doc.embedded_hash == h and not force_full_rebuild:
            existing = db.execute(
                text(
                    "SELECT COUNT(*), COUNT(*) FILTER (WHERE model_version = :m) "
                    "FROM govern_doc_chunk WHERE doc_id = :d"
                ),
                {"d": doc.id, "m": model},
            ).first()
            existing_count = int(existing[0] or 0) if existing else 0
            matching_count = int(existing[1] or 0) if existing else 0
            if existing_count and existing_count == matching_count:
                db.commit()
                return {
                    "status": "unchanged",
                    "chunks": existing_count,
                    "new_chunks": 0,
                }

        chunks, chunk_info = chunk_doc_detailed(body, strategy=strategy, size=size, overlap=overlap)
        if not chunks:
            db.commit()
            return {"status": "empty", "chunks": 0, "new_chunks": 0}
        if chunk_info["truncated"]:
            logger.warning(
                "govern_doc_embeddings: doc %s exceeds the %s-chunk cap — %s chunks (%s chars) not indexed",
                doc.id, chunk_info["max_chunks"], chunk_info["dropped_chunks"], chunk_info["dropped_chars"],
            )

        # Reuse only vectors produced by this exact model. Content hashes are not
        # portable across embedding spaces: equal text embedded by another model
        # is still a different vector and must be regenerated.
        existing: dict[str, str] = {}
        if not force_full_rebuild and _is_current_index_hash(doc.embedded_hash):
            for row in db.execute(
                text(
                    "SELECT content_hash, embedding::text FROM govern_doc_chunk "
                    "WHERE doc_id = :d AND model_version = :m"
                ),
                {"d": doc.id, "m": model},
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
                    detail = (
                        "Embedding provider unavailable after reset; the old "
                        "vector index was removed and this document is not "
                        "searchable until a successful rebuild."
                        if force_full_rebuild
                        else "Embedding provider unavailable; the previous vector index was kept."
                    )
                    logger.warning(
                        "govern_doc_embeddings: embedding unavailable (doc %s) — %s",
                        doc.id,
                        detail,
                    )
                    # For a normal refresh this preserves the old vectors. For
                    # an explicit reset, the caller's pending delete is committed
                    # so stale vectors are never relabeled as the new model.
                    db.commit()
                    return {
                        "status": "unavailable",
                        "chunks": 0,
                        "new_chunks": embedded_new,
                        "detail": detail,
                    }
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
        if embedded_new:
            log_egress(
                db, doc, outcome="sent", model=model, chunks=embedded_new,
                chars=sum(len(c) for _, c, ch, _ in prepared if ch not in existing),
            )
        return {
            "status": "embedded", "chunks": len(prepared), "new_chunks": embedded_new,
            # Surfaced so the UI can say "N chunks were not indexed" instead of
            # the document quietly being 2/3 present.
            "truncated": chunk_info["truncated"],
            "dropped_chunks": chunk_info["dropped_chunks"],
            "dropped_chars": chunk_info["dropped_chars"],
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("govern_doc_embeddings.embed_doc failed (doc %s)", getattr(doc, "id", None), exc_info=True)
        db.rollback()
        return {"status": "error", "chunks": 0, "new_chunks": 0, "detail": str(exc)[:300]}


def reset_doc_embedding(
    db,
    doc,
    *,
    model: str,
    chunk_strategy: str,
    chunk_size: int,
    chunk_overlap: int,
) -> dict:
    """Reset a document's vector space and rebuild it from zero.

    This is the only operation allowed to change a locked document model. Old
    vectors and the old hash are committed away before the new model is called,
    so a failed provider request cannot leave mislabeled or mixed-model chunks.
    """
    from app.services.embedding_service import EmbeddingService

    resolved = EmbeddingService.resolve_model(model)
    if chunk_strategy not in ("paragraph", "heading", "fixed"):
        raise ValueError("chunk_strategy must be paragraph, heading, or fixed.")
    size, overlap = _clamp_chunk_params(chunk_size, chunk_overlap)

    authoring_scope(db)
    db.execute(
        text(
            "SELECT id FROM govern_knowledge_docs WHERE id = :d FOR UPDATE"
        ),
        {"d": doc.id},
    )
    db.refresh(doc)
    db.execute(
        text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id}
    )
    doc.embedded_hash = None
    doc.embedding_model = resolved
    doc.chunk_strategy = chunk_strategy
    doc.chunk_size = size
    doc.chunk_overlap = overlap
    # embed_doc refreshes after taking the same row lock. Flush these settings so
    # that refresh observes the requested profile in this transaction.
    db.flush()
    result = embed_doc(db, doc, force_full_rebuild=True)
    db.commit()
    return result


def _scoped_chunk_filter(
    *,
    dashboard_id: int | None,
    doc_ids: set[int] | list[int] | None,
    published_only: bool,
) -> tuple[str, dict] | None:
    """Build one scope shared by keyword and every model-specific vector scan."""
    allowed = sorted({int(item) for item in (doc_ids or [])})
    if doc_ids is not None and not allowed:
        return None

    joins = ["JOIN govern_knowledge_docs d ON d.id = c.doc_id"]
    params: dict = {}
    predicates = [
        "c.embedding IS NOT NULL",
        # Legacy hashes predate model-safe dedup, so their vectors cannot be
        # trusted even when the model label happens to match. Migration 0049
        # invalidates those hashes; backfill replaces the rows and writes v2.
        f"d.embedded_hash LIKE '{_INDEX_HASH_VERSION}:%'",
        # A document owns one vector space. Mismatched legacy rows are invalid
        # index data and must never be searched, even by the keyword branch.
        #
        # `IS NOT DISTINCT FROM`, NOT `=`. `embedding_model` is nullable and the
        # column is documented as "null = the deployment's active model", so a
        # plain `=` evaluates to NULL for those rows — which SQL treats as false,
        # excluding every chunk of that document from BOTH branches with nothing
        # said anywhere. The invariant meant "same space", and two NULLs are the
        # same space; `=` cannot express that.
        "c.model_version IS NOT DISTINCT FROM d.embedding_model",
    ]
    if published_only:
        predicates.append("d.status = 'Published'")
    if allowed:
        predicates.append("c.doc_id = ANY(:allowed)")
        params["allowed"] = allowed
    else:
        if dashboard_id is None:
            return None
        joins.append(
            "JOIN govern_doc_asset_links l ON l.doc_id = d.id "
            "AND l.asset_type = 'dashboard' AND l.asset_ref = :did"
        )
        params["did"] = str(dashboard_id)
    return f"{' '.join(joins)} WHERE {' AND '.join(predicates)}", params


def _model_doc_groups(db: Session, sql_filter: str, params: dict) -> dict[str, list[int]]:
    rows = db.execute(
        text(
            f"""
            SELECT DISTINCT c.model_version, c.doc_id
            FROM govern_doc_chunk c
            {sql_filter}
            ORDER BY c.model_version, c.doc_id
            """
        ),
        params,
    ).fetchall()
    groups: dict[str, list[int]] = {}
    for model, doc_id in rows:
        if model:
            groups.setdefault(str(model), []).append(int(doc_id))
    return groups


def _search_scoped_doc_chunks(
    db: Session,
    question: str,
    *,
    k: int,
    dashboard_id: int | None,
    doc_ids: set[int] | list[int] | None,
    published_only: bool,
) -> list[dict]:
    """Hybrid retrieval across any number of document embedding models.

    Each model gets its own query vector and filtered ANN scan. Their ranks,
    plus one model-independent full-text rank, are merged with RRF so raw cosine
    scores from unrelated vector spaces are never compared.
    """
    from app.services.embedding_service import EmbeddingService

    scoped = _scoped_chunk_filter(
        dashboard_id=dashboard_id,
        doc_ids=doc_ids,
        published_only=published_only,
    )
    if scoped is None:
        return []
    sql_filter, scope_params = scoped
    groups = _model_doc_groups(db, sql_filter, scope_params)
    if not groups:
        return []

    pool = max(k * 4, 20)
    keyword_ids = _keyword_ranked_ids(
        db, sql_filter, scope_params, question or "", max(pool, k * 8)
    )
    vector_lists: list[list[int]] = []
    vector_scores: dict[int, float] = {}
    vector_ids: set[int] = set()

    for model, model_doc_ids in groups.items():
        query_vector = EmbeddingService.generate_query_embedding(
            question or "", model=model
        )
        if query_vector is None:
            # Keyword results for this model remain usable. One provider/model
            # failure must not take the whole multi-model search down.
            continue
        model_filter = (
            f"{sql_filter} AND c.model_version = :embedding_model "
            "AND c.doc_id = ANY(:model_doc_ids)"
        )
        hits = _vector_ranked_hits(
            db,
            model_filter,
            {
                **scope_params,
                "embedding_model": model,
                "model_doc_ids": model_doc_ids,
            },
            str(query_vector),
            pool,
        )
        ranked = [chunk_id for chunk_id, _similarity in hits]
        if ranked:
            vector_lists.append(ranked)
            vector_ids.update(ranked)
            vector_scores.update(dict(hits))

    ranked_lists = [*vector_lists]
    if keyword_ids:
        ranked_lists.append(keyword_ids)
    if not ranked_lists:
        return []
    fused = _fuse_rrf(*ranked_lists)
    top_ids = sorted(fused, key=lambda item: -fused[item])[: max(1, k)]
    rows = db.execute(
        text(
            """
            SELECT c.id, c.doc_id, d.title, c.chunk_index, c.content,
                   c.trust, c.model_version
            FROM govern_doc_chunk c
            JOIN govern_knowledge_docs d ON d.id = c.doc_id
            WHERE c.id = ANY(:ids)
            """
        ),
        {"ids": top_ids},
    ).fetchall()
    by_id = {int(row[0]): row for row in rows}
    keyword_set = set(keyword_ids)
    return [
        {
            "chunk_id": chunk_id,
            "doc_id": int(by_id[chunk_id][1]),
            "title": by_id[chunk_id][2],
            "chunk_index": int(by_id[chunk_id][3]),
            "content": by_id[chunk_id][4],
            "similarity": vector_scores.get(chunk_id),
            "rrf_score": float(fused[chunk_id]),
            "trust": by_id[chunk_id][5],
            "embedding_model": by_id[chunk_id][6],
            "matched_by": (
                "both"
                if chunk_id in vector_ids and chunk_id in keyword_set
                else "keyword"
                if chunk_id in keyword_set
                else "vector"
            ),
        }
        for chunk_id in top_ids
        if chunk_id in by_id
    ]


def search_doc_chunks(
    db: Session,
    question: str,
    *,
    k: int = 6,
    dashboard_id: int | None = None,
    doc_ids: set[int] | list[int] | None = None,
    published_only: bool = True,
    authoring: bool = False,
) -> list[dict]:
    """Reusable multi-model search without retrieval telemetry."""
    if db is None:
        return []
    try:
        authoring_scope(db) if authoring else restricted_scope(db)
        return _search_scoped_doc_chunks(
            db,
            question,
            k=max(1, int(k)),
            dashboard_id=dashboard_id,
            doc_ids=doc_ids,
            published_only=published_only,
        )
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_embeddings.search_doc_chunks failed", exc_info=True)
        db.rollback()
        return []


def retrieve_doc_chunks(
    db: Session,
    dashboard_id: int,
    question: str = "",
    k: int = 6,
    doc_ids: set[int] | list[int] | None = None,
) -> list[dict]:
    """Search the published documents this report/flow is allowed to read."""
    if db is None:
        return []
    out = search_doc_chunks(
        db,
        question,
        k=k,
        dashboard_id=dashboard_id,
        doc_ids=doc_ids,
        published_only=True,
        authoring=False,
    )
    chunk_ids = [row["chunk_id"] for row in out]
    log_retrieval(
        db,
        consumer="dashboard_bot",
        consumer_ref=str(dashboard_id),
        question=question or "",
        rows=out,
        chunk_ids=chunk_ids,
    )

    try:
        ids = sorted({row["doc_id"] for row in out})
        if ids:
            db.execute(
                text(
                    "UPDATE govern_knowledge_docs "
                    "SET retrieval_count = COALESCE(retrieval_count, 0) + 1 "
                    "WHERE id = ANY(:ids)"
                ),
                {"ids": ids},
            )
            db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return out



#: A document whose vector index cannot be trusted, and why.
#:
#: THE THREE WAYS AN INDEX GOES BAD, AND WHY THEY ARE ONE PROBLEM
#: -------------------------------------------------------------
#: `_scoped_chunk_filter` will not search a document unless its hash is the
#: current version AND every chunk carries the same model the document is pinned
#: to. Anything else is index data the retriever refuses to trust — correctly,
#: because trusting it silently returns passages from the wrong vector space.
#:
#: The catch is that refusing is invisible. A document in this state still exists,
#: still shows in the library, still looks attached to its dashboard — and the
#: assistant simply stops finding it. Measured on this deployment after migration
#: 0049 invalidated legacy hashes: five of six documents on the main dashboard
#: became unsearchable, and "GMV là gì" returned nothing at all while a document
#: literally titled "Từ vựng & Quy ước" sat one query away.
#:
#: So the states are enumerated here rather than left implicit in a WHERE clause,
#: and something has to act on them.
_STALE_INDEX_SQL = f"""
    SELECT d.id,
           CASE
             WHEN d.embedded_hash IS NULL THEN 'never_indexed'
             WHEN d.embedded_hash NOT LIKE '{_INDEX_HASH_VERSION}:%' THEN 'old_index_format'
             WHEN EXISTS (
                    SELECT 1 FROM govern_doc_chunk c
                     WHERE c.doc_id = d.id
                       AND c.model_version IS DISTINCT FROM d.embedding_model
                  ) THEN 'model_changed'
             WHEN NOT EXISTS (
                    SELECT 1 FROM govern_doc_chunk c
                     WHERE c.doc_id = d.id AND c.embedding IS NOT NULL
                  ) THEN 'no_vectors'
             ELSE NULL
           END AS reason
      FROM govern_knowledge_docs d
     WHERE d.status = 'Published'
"""


def stale_index_docs(db: Session) -> dict[int, str]:
    """`doc_id -> why its index cannot be searched`. Empty when everything is fine.

    Read-only and cheap: this is what a screen shows and what the repair job asks
    before spending a single embedding call.
    """
    out: dict[int, str] = {}
    try:
        rows = db.execute(text(f"SELECT id, reason FROM ({_STALE_INDEX_SQL}) s "
                               "WHERE reason IS NOT NULL")).fetchall()
        out = {int(r[0]): str(r[1]) for r in rows}
    except Exception:  # noqa: BLE001 — a health read must never break a request
        logger.warning("govern_doc_embeddings: stale-index scan failed", exc_info=True)
        return {}

    # AND the content check, which the SQL above cannot do.
    #
    # The query knows the SHAPE of an index — its format, its model, whether any
    # vectors exist. It cannot know whether the text they were made from is still
    # the published text, because that means recomputing the hash from the live
    # body. `index_is_stale` does exactly that, so a document re-published without
    # a re-embed — the AI quoting a previous edition, silently — is caught here
    # rather than by a second detector on another screen answering a different
    # half of the same question.
    try:
        from app.models.governance import GovernKnowledgeDoc

        for doc in (
            db.query(GovernKnowledgeDoc)
            .filter(GovernKnowledgeDoc.status == "Published").all()
        ):
            if doc.id not in out and index_is_stale(db, doc):
                out[doc.id] = "content_changed"
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_embeddings: content-staleness scan failed",
                       exc_info=True)
    return out


def repair_stale_index(db: Session, *, limit: int = 100) -> dict:
    """Rebuild every document whose index the retriever refuses to trust.

    WIPE AND REBUILD, NOT MIGRATE. Translating an old index into the new format
    would mean trusting vectors produced by a chunking or model configuration
    nobody can reconstruct — and the whole reason the retriever rejects them is
    that they cannot be trusted. Re-embedding is a few seconds and a few cents per
    document, and it produces an index whose provenance is known.

    Idempotent by construction: `embed_doc` is hash-gated, so a document already
    in good order costs nothing and reports `unchanged`. Bounded by `limit` so a
    large library repairs over several passes instead of holding a worker for
    minutes at boot.
    """
    from app.models.governance import GovernKnowledgeDoc

    stale = stale_index_docs(db)
    if not stale:
        return {"scanned": 0, "repaired": 0, "failed": 0, "remaining": 0, "results": {}}

    todo = sorted(stale)[:limit]
    results: dict[int, str] = {}
    repaired = failed = 0
    for doc_id in todo:
        doc = db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.id == doc_id).first()
        if doc is None:
            continue
        try:
            # `force_full_rebuild` because the stored hash is exactly what we have
            # decided not to believe; letting the hash gate decide would skip the
            # documents that most need rebuilding.
            status = embed_doc(db, doc, force_full_rebuild=True).get("status", "error")
        except Exception:  # noqa: BLE001 — one bad document must not stop the rest
            logger.exception("govern_doc_embeddings: repair failed for doc %s", doc_id)
            status = "error"
        results[doc_id] = status
        if status in ("embedded", "unchanged"):
            repaired += 1
        else:
            failed += 1

    remaining = max(0, len(stale) - len(todo))
    logger.info(
        "govern_doc_embeddings: index repair — %s scanned, %s repaired, %s failed, %s left",
        len(stale), repaired, failed, remaining,
    )
    return {
        "scanned": len(stale), "repaired": repaired, "failed": failed,
        "remaining": remaining, "results": results,
    }

def backfill(db: Session) -> dict[int, str]:
    """Embed all Published docs missing/stale embeddings (idempotent, hash-gated)."""
    from app.models.governance import GovernKnowledgeDoc
    out: dict[int, str] = {}
    for d in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.status == "Published").all():
        out[d.id] = embed_doc(db, d).get("status", "error")
    return out
