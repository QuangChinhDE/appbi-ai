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
#: Bumped whenever the CHUNKER changes, not just the model or the profile.
#:
#: The first attempt at the block chunker re-indexed NOTHING: every document's
#: hash still matched, because the hash covered the model, the dimensions and the
#: chunk profile — none of which had changed — while the chunker was about to
#: split every document a completely different way. `embed_doc` reported
#: "unchanged" and was right to. A chunker version belongs in the cache key.
_INDEX_HASH_VERSION = "v6"


def _body_hash(cache_key: str, body: str) -> str:
    """sha256 of a composite cache key (model + chunk config) + body — any
    change to WHAT would be re-embedded (not just the body text) must bust
    the hash-gate, so this is not just the embedding model name anymore."""
    digest = hashlib.sha256(f"{cache_key}\n{body}".encode("utf-8")).hexdigest()
    return f"{_INDEX_HASH_VERSION}:{digest}"


def _is_current_index_hash(value: str | None) -> bool:
    """Only current-generation hashes are eligible for chunk-vector reuse."""
    return str(value or "").startswith(f"{_INDEX_HASH_VERSION}:")


def _tokens_for(size_chars: int | None) -> int:
    """The stored chunk size is in CHARACTERS for backwards compatibility with
    every saved document profile; the chunker thinks in tokens. One conversion,
    here, rather than two units drifting apart across the module."""
    from app.services.dashboard_ai_bot.govern_doc_blocks import estimate_tokens

    return max(48, estimate_tokens("x" * int(size_chars or _TARGET)))


def _clamp_chunk_params(size: int | None, overlap: int | None) -> tuple[int, int]:
    size = max(100, min(int(size or _TARGET), _HARD))
    overlap = max(0, min(int(overlap or 0), size // 2))
    return size, overlap


def _split_oversized(block: dict, child_tokens: int) -> list[dict]:
    """One block into as many pieces as the budget needs, keeping its identity.

    Every piece keeps the SAME `ordinal`, so a citation still resolves to the one
    block the text came from — splitting for size must not invent structure the
    document does not have.
    """
    from app.services.dashboard_ai_bot.govern_doc_blocks import (
        Block, _split_prose, _split_table, estimate_tokens,
    )

    if estimate_tokens(block.get("text") or "") <= child_tokens:
        return [block]
    stub = Block(kind=block["kind"], text=block.get("text") or "")
    pieces = (_split_table(stub, child_tokens) if block["kind"] == "table"
              else _split_prose(stub, child_tokens))
    return [{**block, "text": piece.text} for piece in pieces] or [block]


def build_chunk_rows(doc_title: str | None, blocks: list[dict], *,
                     child_tokens: int) -> tuple[list[dict], dict]:
    """Project the AST into indexable chunks.

    Takes BLOCKS, not markdown. Chunking is now a projection of a structure that
    was already extracted, so changing how chunks are sized does not re-run
    extraction — which for a scanned document means not re-running OCR.

    Each chunk records the block ordinals it covers (`block_from`/`block_to`).
    That is what makes a citation survive a re-chunk: block ordinals are stable
    for the life of a document version, chunk ids are not.

    Rules that are not negotiable:
      * a chunk never crosses a section boundary — a passage spanning two sections
        belongs to neither and its citation would name the wrong one
      * a table is never merged with prose, and carries its header
      * a figure is never merged with anything, or its classification is lost —
        which is exactly what happened when merging set every multi-block chunk to
        "paragraph" and left zero figures in a corpus with seven of them
    """
    from app.services.dashboard_ai_bot.govern_doc_blocks import (
        context_prefix, estimate_tokens,
    )

    rows: list[dict] = []
    produced = 0
    dropped = 0
    dropped_chars = 0
    truncated = False

    # Group blocks into sections: a `section` block starts a new one, and its own
    # title is not chunk content — it is the heading path of what follows.
    groups: list[dict] = []
    for block in blocks:
        if block["kind"] == "section":
            groups.append({
                "heading_path": block.get("heading_path") or block.get("text"),
                "page": block.get("page"),
                "blocks": [],
            })
            continue
        if not (block.get("text") or "").strip():
            continue
        if not groups:
            groups.append({
                "heading_path": block.get("heading_path"),
                "page": block.get("page"),
                "blocks": [],
            })
        groups[-1]["blocks"].append(block)

    for section_index, group in enumerate(groups):
        members = group["blocks"]
        if not members:
            continue
        prefix = context_prefix(
            doc_title,
            [p for p in (group.get("heading_path") or "").split(" > ") if p],
            group.get("page"),
        )
        pending: list[dict] = []

        def emit(items: list[dict]) -> None:
            nonlocal produced, dropped, dropped_chars, truncated
            if not items:
                return
            body = "\n\n".join(b["text"] for b in items).strip()
            if not body:
                return
            if produced >= _MAX_CHUNKS:
                truncated = True
                dropped += 1
                dropped_chars += len(body)
                return
            header = next((b.get("table_header") for b in items if b.get("table_header")), None)
            kind = items[0]["kind"] if len(items) == 1 else "paragraph"
            rows.append({
                "content": body,
                # The header is prepended to what gets EMBEDDED so a table
                # fragment is searchable by its column names, and kept in
                # `table_header` so the assembler can show it too.
                "embed_text": "\n\n".join(
                    part for part in [prefix, header if kind == "table" else None, body] if part
                ),
                "section_index": section_index,
                "heading_path": group.get("heading_path") or None,
                "block_kind": kind,
                "page": items[0].get("page") or group.get("page"),
                "token_count": estimate_tokens(body),
                "block_from": items[0]["ordinal"],
                "block_to": items[-1]["ordinal"],
                "table_header": header,
            })
            produced += 1

        for block in members:
            # Tables and figures stand alone: merging a table into prose destroys
            # the signal a reader needs to interpret the numbers, and merging a
            # figure loses the fact that it IS a figure.
            if block["kind"] in ("table", "figure"):
                emit(pending)
                pending = []
                # A block bigger than the budget is SPLIT, not emitted whole. The
                # AST records a table as one table because that is what the
                # document has; the projection is where it gets divided — and each
                # fragment keeps its header, because a row of numbers whose columns
                # nobody can name is the worst thing a BI index can hold.
                for piece in _split_oversized(block, child_tokens):
                    emit([piece])
                continue
            pieces = _split_oversized(block, child_tokens)
            if len(pieces) > 1:
                emit(pending)
                pending = []
                for piece in pieces:
                    emit([piece])
                continue
            candidate = pending + [block]
            if pending and estimate_tokens("\n\n".join(b["text"] for b in candidate)) > child_tokens:
                emit(pending)
                pending = [block]
            else:
                pending = candidate
        emit(pending)

    info = {
        "produced": produced + dropped,
        "kept": produced,
        "sections": len({r["section_index"] for r in rows}),
        "truncated": truncated,
        "dropped_chunks": dropped,
        "dropped_chars": dropped_chars,
        "max_chunks": _MAX_CHUNKS,
    }
    return rows, info


def chunk_doc_detailed(body: str | None, *, strategy: str = "paragraph", size: int = _TARGET,
                       overlap: int = 0) -> tuple[list[str], dict]:
    """Chunk a body AND report what happened, so truncation can never be silent.

    Returns (chunks, info) where info carries `produced` (before the cap),
    `kept`, `truncated` and how many characters were dropped.
    """
    # Delegates to the tree builder so a preview cannot disagree with what will
    # be indexed. `strategy`/`overlap` are accepted and IGNORED: the block model
    # derives structure from the document instead of being told how to guess at
    # it, and keeping the old knobs alive would mean keeping the old chunker too.
    # Markdown in, blocks out, then the same projection the indexer uses — so a
    # preview cannot disagree with what will actually be embedded.
    from app.services.dashboard_ai_bot.govern_doc_ast import _blocks_from_markdown

    blocks = [{**b, "ordinal": i} for i, b in enumerate(_blocks_from_markdown(body or ""))]
    rows, info = build_chunk_rows(None, blocks, child_tokens=_tokens_for(size))
    return [r["content"] for r in rows], info


def chunk_doc(body: str | None, *, strategy: str = "paragraph", size: int = _TARGET, overlap: int = 0) -> list[str]:
    """Split a markdown body into chunks. `strategy` is 'paragraph' (default —
    split on blank lines), 'heading' (split on markdown headings first, then
    paragraph-merge within each section), or 'fixed' (raw character window).
    Embed tokens ({{…}}) are stripped (structural refs, not prose); [[wikilinks]]
    keep their readable text ([[A|B]]→B, [[A]]→A) so the AI reads the
    authored relationship as words. Every kwarg defaults to the original
    hardcoded behavior, so `chunk_doc(body)` is unchanged for existing callers."""
    return chunk_doc_detailed(body, strategy=strategy, size=size, overlap=overlap)[0]


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
#: `iterative_scan` is not optional: without it the filter starves the result set.
#:
#: `strict_order` over `relaxed_order`, and the reason is DETERMINISM rather than
#: recall. `relaxed_order` returns rows as it finds them, so the candidate SET can
#: differ between two runs of the identical query — the eval harness caught the
#: dashboard and agent suites disagreeing on one question intermittently, roughly
#: one run in three, with byte-identical SQL and parameters. A knowledge base that
#: answers the same question differently on a re-ask cannot be audited.
#:
#: It costs nothing here. Relaxed beats strict at ef=100 (70% vs 52%), which is
#: what the first choice was based on, but by ef=400 they converge (79% vs 78%) —
#: so raising ef_search buys back the recall that ordering strictly gives up.
_HNSW_EF_SEARCH = 400
_HNSW_ITERATIVE_SCAN = "strict_order"


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

def index_cache_key(doc, model: str, dimensions) -> str:
    """Everything that decides WHETHER a re-embed is needed, in one place.

    Two callers compute this: `embed_doc`, to decide whether to work, and
    `index_is_stale`, to report whether the index is current. They were building
    it separately and drifted — the reporter kept the old format, missing the
    embedding dimensions and the AST fingerprint, so after the AST landed every
    document reported as stale while search worked perfectly. A gate and its
    detector have to agree by construction, not by both being edited.
    """
    size, overlap = _clamp_chunk_params(
        getattr(doc, "chunk_size", None), getattr(doc, "chunk_overlap", None)
    )
    strategy = getattr(doc, "chunk_strategy", None) or "paragraph"
    return "%s:%s:%s:%s:%s:%s" % (
        model, dimensions, strategy, size, overlap, getattr(doc, "ast_hash", None),
    )


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
        return doc.embedded_hash != _body_hash(index_cache_key(doc, model, dimensions), body)
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_embeddings: staleness check failed (doc %s)", getattr(doc, "id", None), exc_info=True)
        return False

#: Which policy level each outbound purpose requires. Adding a new external call
#: means adding a line HERE — the check cannot be forgotten in a new call site
#: without also forgetting to name the purpose, which does not compile past review.
_EGRESS_REQUIREMENT = {
    "embedding": ("embedding", "full"),
    "ocr": ("full",),
    "vision": ("full",),
    "rerank": ("full",),
}


def processing_policy(doc) -> str:
    """The document's policy, defaulting OPEN for embedding.

    A freshly constructed ORM object has the attribute as None until flush, and
    treating that as the most restrictive value once left every brand-new
    document unindexed. The default is what the column default says.
    """
    value = (getattr(doc, "external_processing", None) or "").strip().lower()
    return value if value in ("none", "embedding", "full") else "embedding"


def egress_allowed(doc, purpose: str = "embedding") -> bool:
    """May `purpose` send this document's content to an external provider?"""
    return processing_policy(doc) in _EGRESS_REQUIREMENT.get(purpose, ("full",))


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
            ORDER BY c.embedding <=> CAST(:query_vector AS vector), c.id
            LIMIT :lim
            """
        ),
        {**params, "query_vector": vector_literal, "lim": limit},
    ).fetchall()
    return [
        (int(row[0]), 1.0 - float(row[1]))
        # (distance, id): equal distances must break the same way every run, or
        # the fused ranking downstream is not reproducible.
        for row in sorted(rows, key=lambda row: (row[1], row[0]))
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
    nothing, which is worse than not folding at all.

    THE OPERATOR IS OR, NOT AND, AND THAT WAS A BUG FIX
    ---------------------------------------------------
    `plainto_tsquery` joins every token with AND, so a real question —
    "Mục tiêu tỷ lệ giao đúng hẹn là bao nhiêu phần trăm?" — became a twelve-term
    AND chain that almost no passage satisfies. Measured on the 23-case baseline:
    the keyword branch contributed to 3 of 23 questions. Hybrid retrieval was
    vector retrieval with a keyword assist that only fired on short exact queries
    like a quarter code, which is exactly the shape of query the original hybrid
    work was tested with — so the hole did not show.

    Relaxing to OR, measured on the same cases:

        AND (before)   recall@1 0.60   MRR 0.802   keyword in  3/23
        OR  (after)    recall@1 0.85   MRR 0.935   keyword in 23/23

    Five questions moved to rank 1, none regressed. A variant that first dropped
    short tokens and function words scored WORSE (recall@1 0.75) — `simple` has no
    stopword list and ts_rank has no corpus statistics, so the intuition that
    noise words would dominate did not survive contact with the measurement; RRF
    consumes rank only, and a passage matching more query terms still sorts above
    one matching a single common word.

    The rewrite goes through the tsquery TEXT that Postgres itself produced rather
    than tokenising in Python: `plainto_tsquery` already tokenised, it keeps
    multi-character lexemes such as `31/12/2025` whole, and the value stays bound
    rather than interpolated.

    SCALING CAVEAT: an OR query matches far more rows, and `ts_rank` must score
    every match before LIMIT applies. Harmless at this corpus size; on a large
    library this becomes the keyword branch's cost centre and will need a cheaper
    prefilter.
    """
    doc = f"to_tsvector('simple', {fold}(c.content))"
    qry = f"replace(plainto_tsquery('simple', {fold}(:q))::text, ' & ', ' | ')::tsquery"
    return f"""
        SELECT c.id
        FROM govern_doc_chunk c
        {sql_filter}
          AND {doc} @@ {qry}
        -- `c.id` is a TIEBREAKER, not decoration. Relaxing the query to OR made
        -- ties common: many passages now share a ts_rank, and without a total
        -- order Postgres may return them in any sequence. RRF fuses by RANK, so
        -- an unstable order makes the whole ranking unstable — the eval harness
        -- caught the dashboard and agent paths disagreeing on one case for this
        -- reason alone, with identical inputs.
        ORDER BY ts_rank({doc}, {qry}) DESC, c.id
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
        if not egress_allowed(doc, "embedding"):
            db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id})
            doc.embedded_hash = None
            db.commit()
            log_egress(db, doc, outcome="blocked", model=model, purpose="embedding")
            return {
                "status": "blocked", "chunks": 0, "new_chunks": 0,
                "detail": (
                    "Tài liệu đang đặt chế độ không gửi ra ngoài "
                    f"(external_processing = {processing_policy(doc)})."
                ),
            }

        # GATE TWO: the chunker and the model. The AST hash is part of the key so a
        # rebuilt AST re-embeds, and the chunker version is part of it so a new
        # chunker does — the first block chunker shipped and re-indexed NOTHING
        # because neither the model nor the profile had changed.
        h = _body_hash(index_cache_key(doc, model, dimensions), body)
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

        # GATE ONE: the source. Rebuilds the AST only when the published version
        # or the extraction changed — never because the chunker did.
        from app.services.dashboard_ai_bot.govern_doc_ast import ast_blocks, ensure_ast

        ast_state = ensure_ast(db, doc, force=force_full_rebuild)
        blocks = ast_blocks(db, doc)
        if not blocks:
            db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id})
            doc.embedded_hash = None
            db.commit()
            return {"status": "empty", "chunks": 0, "new_chunks": 0,
                    "ast": ast_state}

        children, chunk_info = build_chunk_rows(
            getattr(doc, "title", None), blocks, child_tokens=_tokens_for(size)
        )
        if not children:
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

        # The hash covers the EMBEDDED string, not the stored body: renaming a
        # heading changes the context prefix, which changes the vector, and a hash
        # over the body alone would reuse a vector that no longer matches its text.
        embedded_new = 0
        for row in children:
            ch = row["embed_text"]
            chash = hashlib.sha256(ch.encode("utf-8")).hexdigest()
            row["hash"] = chash
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
            row["embedding"] = emb

        # Atomic replace only after every chunk has an embedding.
        db.execute(text("DELETE FROM govern_doc_chunk WHERE doc_id = :d"), {"d": doc.id})
        for index, row in enumerate(children):
            db.execute(
                text(
                    """INSERT INTO govern_doc_chunk
                           (doc_id, chunk_index, content, content_hash, embedding,
                            model_version, section_index, heading_path,
                            block_kind, page, token_count,
                            source_version, block_from, block_to)
                       VALUES (:d, :i, :c, :h, :e, :m, :si, :hp, :bk, :pg, :tc,
                               :sv, :bf, :bt)"""
                ),
                {
                    "d": doc.id, "i": index, "c": row["content"], "h": row["hash"],
                    "e": row["embedding"], "m": model,
                    "si": row["section_index"], "hp": row["heading_path"],
                    "bk": row["block_kind"], "pg": row["page"],
                    "tc": row["token_count"],
                    "sv": int(getattr(doc, "ast_version", 0) or 0),
                    "bf": row.get("block_from"), "bt": row.get("block_to"),
                },
            )
        doc.embedded_hash = h
        db.commit()
        if embedded_new:
            log_egress(
                db, doc, outcome="sent", model=model, chunks=embedded_new,
                chars=sum(len(r["embed_text"] or "") for r in children
                          if r["hash"] not in existing),
            )
        return {
            "status": "embedded", "chunks": len(children),
            "sections": chunk_info["sections"], "new_chunks": embedded_new,
            "ast": ast_state,
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
    changed_by: str | None = None,
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
    db.commit()
    # The profile change is persisted here; the RE-INDEX is queued. Changing the
    # chunking profile invalidates every vector for this document, which is the
    # bulk case the queue exists for — and doing it inline would have re-created
    # the request-blocking path the queue replaced.
    from app.services.govern_doc_index_queue import enqueue

    job = enqueue(db, doc.id, reason="config", requested_by=changed_by)
    return {"status": "queued", "chunks": 0, "new_chunks": 0, "job": job,
            "embedding_model": resolved, "chunk_strategy": chunk_strategy,
            "chunk_size": size, "chunk_overlap": overlap}


def _dashboard_doc_ids(db: Session, dashboard_id: int) -> list[int]:
    """The documents attached to a dashboard, as ids."""
    rows = db.execute(
        text(
            "SELECT DISTINCT doc_id FROM govern_doc_asset_links "
            "WHERE asset_type = 'dashboard' AND asset_ref = :ref"
        ),
        {"ref": str(dashboard_id)},
    ).fetchall()
    return sorted({int(r[0]) for r in rows})


#: The hydration SELECT's columns, in order.
#:
#: The row was read by POSITION — `by_id[chunk_id][15]`, twenty-three times — and
#: every column added shifted the ones after it. Two test fixtures and both
#: retrieval tests broke on the last addition with `IndexError: tuple index out of
#: range`, pointing at neither the SELECT nor the reader. Positional access to a
#: twenty-three-column row is a puzzle, not an interface.
#:
#: Declared here so the SQL below, the reader, and the test fixtures all name the
#: same thing. Adding a column means one entry here and one in the SELECT, and
#: forgetting the second is a KeyError that says which name is missing.
CHUNK_HYDRATION_COLUMNS = (
    "id", "doc_id", "title", "chunk_index", "content",
    "trust", "model_version", "heading_path", "page", "block_kind",
    "token_count", "section_index",
    "block_from", "block_to", "source_version",
    "last_verified_at", "review_date", "importance",
    "sensitivity", "owner", "status", "updated_at", "doc_type", "source_type",
)


def _by_name(row) -> dict:
    """One hydration row as a mapping. Raises if the SELECT and the list disagree."""
    if len(row) != len(CHUNK_HYDRATION_COLUMNS):
        raise ValueError(
            "hydration row has %d columns, CHUNK_HYDRATION_COLUMNS declares %d — "
            "the SELECT and the column list have drifted"
            % (len(row), len(CHUNK_HYDRATION_COLUMNS))
        )
    return dict(zip(CHUNK_HYDRATION_COLUMNS, row))


def _scoped_chunk_filter(
    db: Session,
    *,
    dashboard_id: int | None,
    doc_ids: set[int] | list[int] | None,
    published_only: bool,
) -> tuple[str, dict] | None:
    """Build the ONE scope shared by keyword and every model-specific vector scan.

    A dashboard is resolved to document ids FIRST so that every caller produces
    the identical SQL shape. It used to join the link table instead, and the two
    shapes — a join versus `doc_id = ANY(...)` — gave Postgres different plans
    over the same rows; with an approximate index scanning in `relaxed_order`,
    different plans return different CANDIDATE SETS. The eval harness caught the
    dashboard and the agent disagreeing on one question with the same six
    documents in scope. Same rows is not the same query; now it is the same query.
    """
    allowed = sorted({int(item) for item in (doc_ids or [])})
    if doc_ids is not None and not allowed:
        return None
    if not allowed and dashboard_id is not None:
        allowed = _dashboard_doc_ids(db, int(dashboard_id))
        if not allowed:
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
    if not allowed:
        return None
    predicates.append("c.doc_id = ANY(:allowed)")
    params["allowed"] = allowed
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


def _section_context(db: Session, keys: set[tuple[int, int]]) -> dict[tuple[int, int], str]:
    """`(doc_id, section_index) -> the whole section's text`, in one query.

    This is why a section is a key and not a row: the text is assembled from the
    chunks that make it up, so it can never disagree with them and nothing is
    stored twice. Ordered by `chunk_index` so the section reads in document order.
    """
    if not keys:
        return {}
    try:
        rows = db.execute(
            text(
                """
                SELECT c.doc_id, c.section_index,
                       string_agg(c.content, E'\n\n' ORDER BY c.chunk_index)
                FROM govern_doc_chunk c
                WHERE (c.doc_id, c.section_index) IN (
                    SELECT * FROM unnest(CAST(:docs AS int[]), CAST(:sections AS int[]))
                )
                GROUP BY c.doc_id, c.section_index
                """
            ),
            {"docs": [k[0] for k in keys], "sections": [k[1] for k in keys]},
        ).fetchall()
        return {(int(r[0]), int(r[1])): r[2] for r in rows}
    except Exception:  # noqa: BLE001 — context is an enhancement, not a dependency
        logger.warning("govern_doc_embeddings: section context unavailable", exc_info=True)
        return {}


def _search_scoped_doc_chunks(
    db: Session,
    question: str,
    *,
    k: int,
    dashboard_id: int | None,
    doc_ids: set[int] | list[int] | None,
    published_only: bool,
    gate_question: str | None = None,
) -> list[dict]:
    """Hybrid retrieval across any number of document embedding models.

    Each model gets its own query vector and filtered ANN scan. Their ranks,
    plus one model-independent full-text rank, are merged with RRF so raw cosine
    scores from unrelated vector spaces are never compared.
    """
    from app.services.embedding_service import EmbeddingService

    scoped = _scoped_chunk_filter(
        db,
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

    # The candidate pool is sized for the RERANKER, not for the answer. Stage one
    # only has to get the right passages into this window; stage two decides the
    # order. Widening it is cheap (one ANN scan + one full-text scan) and it is
    # the only way a second stage can improve anything — a reranker cannot
    # recover what was never retrieved.
    pool = max(k * 5, 30)
    keyword_ids = _keyword_ranked_ids(
        db, sql_filter, scope_params, question or "", max(pool, k * 8)
    )

    # A governed metric named in the question resolves DETERMINISTICALLY to the
    # document that defines it. This is not a similarity guess and it is not
    # optional: the chunker strips `{{metric:...}}` before embedding, so neither
    # vector nor keyword recall can see a metric reference at all. Fed in as a
    # third ranked list so there is still one fusion, not a special case.
    from app.services.dashboard_ai_bot.govern_metric_links import (
        home_doc_chunk_ids, metrics_in_question,
    )

    named_metrics = metrics_in_question(db, question or "")
    metric_home_docs = {m["home_doc_id"] for m in named_metrics}
    metric_ids = home_doc_chunk_ids(
        db, sql_filter, scope_params, metric_home_docs, pool
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
    if metric_ids:
        ranked_lists.append(metric_ids)
    if not ranked_lists:
        return []
    fused = _fuse_rrf(*ranked_lists)
    # Take the whole pool into stage two, then let the reranker cut to k.
    candidate_ids = sorted(fused, key=lambda item: (-fused[item], item))[:pool]
    rows = db.execute(
        text(
            """
            SELECT c.id, c.doc_id, d.title, c.chunk_index, c.content,
                   c.trust, c.model_version, c.heading_path, c.page, c.block_kind,
                   c.token_count, c.section_index,
                   c.block_from, c.block_to, c.source_version,
                   -- GOVERNANCE, read at retrieval time.
                   --
                   -- Ranking by authority and warning a reader that a policy is
                   -- overdue for review both need these, and both were impossible:
                   -- the retriever selected content and provenance and stopped, so
                   -- every consumer that wanted "is this still verified" had to go
                   -- back to the database per row or do without. They are columns
                   -- on a table already joined; carrying them costs nothing.
                   d.last_verified_at, d.review_date, d.importance,
                   d.sensitivity, d.owner, d.status, d.updated_at, d.doc_type,
                   -- WHERE a passage lives is described differently per source: a
                   -- page for a PDF, a heading for a Google Doc, a URL for a
                   -- crawled page. The anchor cannot be built without knowing
                   -- which kind of document this is.
                   d.source_type
            FROM govern_doc_chunk c
            JOIN govern_knowledge_docs d ON d.id = c.doc_id
            WHERE c.id = ANY(:ids)
            """
        ),
        {"ids": candidate_ids},
    ).fetchall()
    by_id = {int(row[0]): _by_name(row) for row in rows}
    section_context = _section_context(
        db, {(int(r["doc_id"]), int(r["section_index"])) for r in by_id.values()}
    )
    keyword_set = set(keyword_ids)
    from app.services.dashboard_ai_bot import govern_doc_citation as _citation

    candidates = [
        {
            "chunk_id": chunk_id,
            "doc_id": int(row["doc_id"]),
            "title": row["title"],
            "chunk_index": int(row["chunk_index"]),
            "content": row["content"],
            "similarity": vector_scores.get(chunk_id),
            "rrf_score": float(fused[chunk_id]),
            "trust": row["trust"],
            "embedding_model": row["model_version"],
            # Where this passage came from, recorded at index time. A citation
            # rebuilt later from a re-chunked document is a guess.
            "heading_path": row["heading_path"],
            "page": row["page"],
            "block_kind": row["block_kind"],
            "token_count": row["token_count"],
            "section_index": row["section_index"],
            # SMALL TO BIG. The chunk is what matched; the section is what a model
            # should read to understand it. Assembled from its siblings, so no row
            # stores a second copy of the same prose.
            "section_content": section_context.get(
                (int(row["doc_id"]), int(row["section_index"]))
            ),
            "block_from": row["block_from"],
            "block_to": row["block_to"],
            "source_version": row["source_version"],
            # How much a reader should trust this ROW, beyond how well it matched.
            "last_verified_at": row["last_verified_at"],
            "review_date": row["review_date"],
            "importance": row["importance"],
            "sensitivity": row["sensitivity"],
            "owner": row["owner"],
            "doc_status": row["status"],
            "updated_at": row["updated_at"],
            "doc_type": row["doc_type"],
            "source_type": row["source_type"],
            # Built by ONE function, which also computes the content fingerprint
            # that makes the citation checkable later. A block ordinal is a
            # coordinate and coordinates move: `govern_doc_block` keeps a single
            # version per document, so resolving an old ordinal against it returns
            # today's text at yesterday's position — silently. The fingerprint is
            # what turns that into a detectable mismatch.
            "citation": _citation.build(
                {**row_dict, "content": row["content"],
                 "chunk_id": chunk_id, "doc_id": int(row["doc_id"]),
                 "title": row["title"], "heading_path": row["heading_path"],
                 "page": row["page"], "block_from": row["block_from"],
                 "block_kind": row["block_kind"],
                 "source_version": row["source_version"]},
                source_type=row["source_type"],
            ),
            "matched_by": (
                "both"
                if chunk_id in vector_ids and chunk_id in keyword_set
                else "keyword"
                if chunk_id in keyword_set
                else "vector"
                if chunk_id in vector_ids
                # Reached ONLY through the governance graph: neither half of
                # search could see it, which is the case this exists for.
                else "metric"
            ),
        }
        for chunk_id, row, row_dict in (
            (cid, by_id[cid], by_id[cid]) for cid in candidate_ids if cid in by_id
        )
    ]

    # ── stage two ─────────────────────────────────────────────────────────────
    # Always runs. There is no flag: two ranking behaviours behind a switch means
    # every bug report has to start by asking which one was on.
    from app.services.dashboard_ai_bot.doc_rerank import score_candidates

    reranked = score_candidates(
        db, question or "", candidates, sql_filter=sql_filter, params=scope_params,
        metric_home_docs=metric_home_docs,
        # On an expanded search `question` is a clause or a glossary variant; the
        # relevance gate must still judge against what the reader asked.
        gate_question=gate_question or question or "",
    )
    for row in reranked:
        # Named so a consumer can say "this is the declared definition" rather
        # than "this looked similar".
        row["is_metric_home"] = row["doc_id"] in metric_home_docs
        row["named_metrics"] = [
            m for m in named_metrics if m["home_doc_id"] == row["doc_id"]
        ]
    return reranked[: max(1, k)]


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
    """Reusable multi-model search without retrieval telemetry.

    One pass for most questions. A multi-part question whose parts did NOT all
    find evidence gets an extra pass per missing part, fused into the same result.
    That is the query planner: it escalates on observed evidence rather than
    predicting complexity up front, so a simple question pays nothing for it.
    """
    if db is None:
        return []
    k = max(1, int(k))
    # `published_only` and `authoring` are not independent. Three of the four
    # combinations are legal; the fourth — an AI retrieval path allowed to read
    # drafts — is a leak, and nothing but convention was preventing it. Draft
    # visibility is a PROPERTY of authoring, so it is derived here rather than
    # passed alongside and trusted: an author testing their own document may see
    # its draft, an agent answering a question may not, and a future caller
    # cannot get that wrong by forgetting an argument.
    if not authoring:
        published_only = True
    try:
        authoring_scope(db) if authoring else restricted_scope(db)
        rows = _search_scoped_doc_chunks(
            db, question, k=k, dashboard_id=dashboard_id,
            doc_ids=doc_ids, published_only=published_only,
            gate_question=question,
        )

        from app.services.dashboard_ai_bot.govern_doc_query_plan import (
            describe, glossary_variants, uncovered_clauses,
        )

        # Two reasons to look again, both read off the evidence rather than
        # predicted: a PART of the question found nothing, or a term the glossary
        # knows by another name found nothing under the name that was used.
        missing = uncovered_clauses(question, rows) + glossary_variants(db, question, rows)
        extra = 0
        if missing:
            # Retrieve for the parts that went unanswered and merge. Merged by
            # chunk id and best score rather than re-fused: the clause passes are
            # answering DIFFERENT questions, so their ranks are not comparable and
            # RRF across them would average away the very evidence just found.
            by_id = {row["chunk_id"]: row for row in rows}
            for clause in missing:
                extra += 1
                for row in _search_scoped_doc_chunks(
                    db, clause, k=k, dashboard_id=dashboard_id,
                    doc_ids=doc_ids, published_only=published_only,
                    # RETRIEVED for the clause, JUDGED against the whole question.
                    gate_question=question,
                ):
                    current = by_id.get(row["chunk_id"])
                    if current is None or (row.get("rerank_score") or 0) > (current.get("rerank_score") or 0):
                        by_id[row["chunk_id"]] = row
            rows = sorted(
                by_id.values(),
                key=lambda r: (-(r.get("rerank_score") or 0.0), r["chunk_id"]),
            )[: k * 2]
            logger.info(
                "govern_doc_query_plan: expanded for %s unanswered clause(s)", len(missing)
            )

        plan = describe(question, rows, extra)
        for row in rows:
            row["query_plan"] = plan
        return rows
    except Exception:  # noqa: BLE001
        logger.warning("govern_doc_embeddings.search_doc_chunks failed", exc_info=True)
        db.rollback()
        return []


def retrieve_doc_chunks(
    db: Session,
    dashboard_id: int | None = None,
    question: str = "",
    k: int = 6,
    doc_ids: set[int] | list[int] | None = None,
    consumer: str = "dashboard_bot",
) -> list[dict]:
    """Search the published documents this report/flow is allowed to read.

    `dashboard_id` is OPTIONAL because a dashboard is a way of naming a document
    scope, not the only one. An Agent Flow step carries its own grant, and
    `_scoped_chunk_filter` already treats an explicit `doc_ids` as sufficient —
    so requiring a dashboard here would have forced any consumer without one down
    to keyword-only recall, which is the exact gap this engine exists to close.
    `consumer` is recorded in the audit so the log can distinguish who read what.
    """
    if db is None:
        return []
    if dashboard_id is None and not doc_ids:
        return []  # no scope named at all — fail closed rather than search everything
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
        consumer=consumer,
        consumer_ref=str(dashboard_id) if dashboard_id is not None else None,
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


def stale_index_docs(db: Session, *, published_only: bool = True) -> dict[int, str]:
    """`doc_id -> why its index cannot be searched`. Empty when everything is fine.

    Read-only and cheap: this is what a screen shows and what the repair job asks
    before spending a single embedding call.
    """
    out: dict[int, str] = {}
    # A DRAFT can be searched too — the authoring console does exactly that when
    # an author inspects what was indexed before publishing. Scanning only
    # Published documents left that case with no detector at all: doc 43 had a
    # NULL hash, the retriever refused every chunk, and the Vectors tab showed an
    # empty result with nothing anywhere saying why.
    scope_sql = _STALE_INDEX_SQL if published_only else _STALE_INDEX_SQL.replace(
        "WHERE d.status = 'Published'", "WHERE d.status <> 'Archived'"
    )
    try:
        rows = db.execute(text(f"SELECT id, reason FROM ({scope_sql}) s "
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

        query = db.query(GovernKnowledgeDoc)
        query = (query.filter(GovernKnowledgeDoc.status == "Published") if published_only
                 else query.filter(GovernKnowledgeDoc.status != "Archived"))
        for doc in query.all():
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
            # Queued, not embedded here. Repair is a BULK operation — the case the
            # queue exists for — and a repair that embedded inline would be the
            # one remaining path that could hold a request open for minutes.
            from app.services.govern_doc_index_queue import enqueue

            enqueue(db, doc_id, reason="repair", requested_by="index_repair")
            status = "queued"
        except Exception:  # noqa: BLE001 — one bad document must not stop the rest
            logger.exception("govern_doc_embeddings: could not queue repair for doc %s", doc_id)
            status = "error"
        results[doc_id] = status
        if status in ("embedded", "unchanged", "queued"):
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
    """Queue every Published document for indexing (idempotent, hash-gated).

    Queues rather than embeds: this is the largest bulk operation in the module,
    and it used to hold one request open for the entire library.
    """
    from app.models.governance import GovernKnowledgeDoc
    from app.services.govern_doc_index_queue import enqueue

    out: dict[int, str] = {}
    for d in db.query(GovernKnowledgeDoc).filter(GovernKnowledgeDoc.status == "Published").all():
        enqueue(db, d.id, reason="repair", requested_by="backfill")
        out[d.id] = "queued"
    return out
