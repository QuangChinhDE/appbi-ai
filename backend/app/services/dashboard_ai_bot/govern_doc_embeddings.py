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

from app.core.config import settings

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


def _body_hash(cache_key: str, body: str) -> str:
    """sha256 of a composite cache key (model + chunk config) + body — any
    change to WHAT would be re-embedded (not just the body text) must bust
    the hash-gate, so this is not just the embedding model name anymore."""
    return hashlib.sha256(f"{cache_key}\n{body}".encode("utf-8")).hexdigest()


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
        model = (getattr(doc, "embedding_model", None) or "").strip() or settings.active_embedding_model
        size, overlap = _clamp_chunk_params(getattr(doc, "chunk_size", None), getattr(doc, "chunk_overlap", None))
        strategy = getattr(doc, "chunk_strategy", None) or "paragraph"
        return doc.embedded_hash != _body_hash(f"{model}:{strategy}:{size}:{overlap}", body)
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


def _vector_ranked_ids(db: Session, sql_filter: str, params: dict, lit: str, limit: int) -> list:
    """Chunk ids ordered by true cosine distance, nearest first.

    Sorts on the distance the query already returns instead of trusting the
    index's emission order, which is what makes `relaxed_order` safe to use for
    its higher recall: the index may hand rows back slightly out of order, but
    what leaves this function is exact.
    """
    _tune_vector_scan(db)
    rows = db.execute(
        text(
            f"""
            SELECT c.id, (c.embedding <=> '{lit}'::vector) AS dist
            FROM govern_doc_chunk c
            {sql_filter}
            ORDER BY c.embedding <=> '{lit}'::vector
            LIMIT :lim
            """
        ),
        {**params, "lim": limit},
    ).fetchall()
    return [r[0] for r in sorted(rows, key=lambda r: r[1])]


def active_embedding_model() -> str:
    """The model the read path will trust. Chunks embedded with anything else
    are excluded rather than compared: cosine distance between two different
    models' vectors is a meaningless number that still sorts, so mixing them
    degrades ranking without ever raising an error."""
    return (settings.active_embedding_model or "").strip()


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


def embed_doc(db, doc) -> dict:
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

        cache_key = f"{model}:{strategy}:{size}:{overlap}"
        h = _body_hash(cache_key, body)
        if doc.embedded_hash == h:
            existing_count = db.execute(
                text("SELECT COUNT(*) FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id}
            ).scalar() or 0
            return {"status": "unchanged", "chunks": int(existing_count), "new_chunks": 0}  # HASH-GATE — no embedding calls at all

        chunks, chunk_info = chunk_doc_detailed(body, strategy=strategy, size=size, overlap=overlap)
        if not chunks:
            return {"status": "empty", "chunks": 0, "new_chunks": 0}
        if chunk_info["truncated"]:
            logger.warning(
                "govern_doc_embeddings: doc %s exceeds the %s-chunk cap — %s chunks (%s chars) not indexed",
                doc.id, chunk_info["max_chunks"], chunk_info["dropped_chunks"], chunk_info["dropped_chars"],
            )

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


def retrieve_doc_chunks(db: Session, dashboard_id: int, question: str = "", k: int = 6) -> list[dict]:
    """Cosine top-k chunks over this dashboard's Published, linked docs. Empty if
    embeddings are unavailable (→ caller falls back to summary blurbs)."""
    from app.services.embedding_service import EmbeddingService
    try:
        # Lock this transaction down to published chunks before touching the
        # store, rather than trusting that nothing earlier in the request opened
        # an authoring window.
        restricted_scope(db)
        # Cheap guard FIRST: if this dashboard has no embedded chunks yet, skip the
        # query-embedding API call entirely (0 wasted tokens until docs are embedded).
        has_chunks = db.execute(
            text(
                """
                SELECT 1 FROM govern_doc_chunk c
                JOIN govern_knowledge_docs d ON d.id = c.doc_id AND d.status = 'Published'
                JOIN govern_doc_asset_links l ON l.doc_id = d.id
                     AND l.asset_type = 'dashboard' AND l.asset_ref = :did
                WHERE c.embedding IS NOT NULL AND c.model_version = :emb_model LIMIT 1
                """
            ),
            {"did": str(dashboard_id), "emb_model": active_embedding_model()},
        ).first()
        if not has_chunks:
            return []
        qvec = EmbeddingService.generate_query_embedding(question or "")
        if qvec is None:
            return []
        lit = str(qvec)  # floats only — safe to inline (mirrors EmbeddingService.search_similar)

        # HYBRID recall: semantic (vector) OR literal (full-text), fused.
        # Vector alone misses exact identifiers — a search for a quarter code or
        # a date returns "related-sounding" prose instead of the line that
        # literally contains it.
        scope = """
                JOIN govern_knowledge_docs d
                     ON d.id = c.doc_id AND d.status = 'Published'
                JOIN govern_doc_asset_links l
                     ON l.doc_id = d.id AND l.asset_type = 'dashboard' AND l.asset_ref = :did
                WHERE c.embedding IS NOT NULL
                  AND c.model_version = :emb_model
        """
        scope_params = {"did": str(dashboard_id), "emb_model": active_embedding_model()}
        pool = max(k * 4, 20)
        vec_ids = _vector_ranked_ids(db, scope, scope_params, lit, pool)
        kw_ids = _keyword_ranked_ids(db, scope, scope_params, question or "", pool)

        fused = _fuse_rrf(vec_ids, kw_ids)
        if not fused:
            return []
        top_ids = sorted(fused, key=lambda i: -fused[i])[:k]
        rows = db.execute(
            text(f"""
                SELECT c.id, c.doc_id, d.title, c.content,
                       1 - (c.embedding <=> '{lit}'::vector) AS sim, c.trust
                FROM govern_doc_chunk c
                JOIN govern_knowledge_docs d ON d.id = c.doc_id
                WHERE c.id = ANY(:ids)
            """),
            {"ids": top_ids},
        ).fetchall()
        by_id = {r[0]: r for r in rows}
        out = [
            {"doc_id": by_id[i][1], "title": by_id[i][2], "content": by_id[i][3],
             "similarity": float(by_id[i][4]),
             # Travels WITH the passage on purpose: a consumer that never sees
             # where the text came from cannot treat it any differently.
             "trust": by_id[i][5],
             "matched_by":
                 ("both" if i in vec_ids and i in kw_ids else "keyword" if i in kw_ids else "vector")}
            for i in top_ids if i in by_id
        ]
        log_retrieval(db, consumer="dashboard_bot", consumer_ref=str(dashboard_id),
                      question=question or "", rows=out, chunk_ids=top_ids)

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
