"""One shape for a retrieved thing, whatever kind of thing it is.

WHY THIS EXISTS
---------------
The retriever produces a row with fifteen useful fields. The agent's search tool
then rebuilt that row by hand into a different dict, renaming as it went:

    retriever            tool
    ─────────────────    ──────────────
    content          →   snippet
    doc_id           →   id
    source_version   →   version
    rerank_score     →   rank_score
    matched_by       →   retrieved_by
    section_content  →   section
    chunk_id         →   (dropped)

Nothing about that was deliberate. It is what happens when the producer and the
consumer are written at different times, and the cost is real: every new consumer
re-derives the mapping, a field that gets forgotten is silently absent rather than
an error, and `chunk_id` — the only way to point at one passage and check it
later — had already been forgotten.

So the shape is declared once, here, and everything that returns evidence projects
through it. Adding a field means adding it in one place; forgetting one is visible
because the name does not exist.

WHAT A HIT IS NOT
-----------------
It is NOT the assembled context. The assembler (govern_doc_context) decides what
the model reads, under a token budget, with neighbours and section text. A hit is
the structured record of ONE piece of evidence and where it came from — for the
tool's JSON reply, for a citation, and for a person debugging why a passage
appeared at all.

CONTENT IS NOT TRUNCATED BY CHARACTER COUNT
-------------------------------------------
`content[:320]` cut 27% of this corpus's passages mid-sentence, and 320 was a
number nobody chose for a reason. A passage is carried whole up to a TOKEN
ceiling, and when that ceiling bites it is REPORTED — a consumer that thinks it
received the whole passage will summarise a fragment as though it were the point.
"""
from __future__ import annotations

from typing import Any

#: Every field a hit may carry, in the order a reader would want them. Declared as
#: data so a test can assert the contract rather than trusting a comment.
FIELDS = (
    "source_type",        # document | metric | term | dataset
    "doc_id",
    "document_version",   # which published version this text belongs to
    "title",
    "chunk_id",           # the addressable id of the passage
    "content",
    "content_truncated",
    "heading_path",
    "page",
    "block_kind",
    "table_header",
    "section_content",
    "retrieval_method",   # vector | keyword | both | metric_home | glossary
    "reason_retrieved",   # the same, said in words a person can read
    "vector_similarity",
    "hybrid_score",       # RRF, stage one
    "rerank_score",       # stage two — the score that decided the order
    "lexical_bm25",
    "term_coverage",
    "trust",              # authored | uploaded | linked | external
    "authority",          # is this the declared definition of the metric asked about
    "owner",
    "last_verified_at",
    "review_date",
    "review_overdue",
    "importance",
    "sensitivity",
    "citation",
    "embedding_model",
    # WHEN, as distinct from whether an owner verified it. The old tool attached
    # this for a documented reason — a 2019 policy quoted as current — and the
    # contract keeps it rather than dropping a field a consumer already relied on.
    "updated_at",
    "doc_type",
)

#: Ceiling for a hit's `content`, in tokens. Roughly 900 characters of the mixed
#: Vietnamese/English prose this corpus holds — comfortably above the largest
#: chunk the chunker produces, so in practice it never fires. It exists so a
#: pathological document cannot put fifty thousand characters into a tool reply.
MAX_CONTENT_TOKENS = 220

#: How the retrieval channel is described to a model. `matched_by` is a code; a
#: model reading "both" has to guess what the two were.
_METHOD_WORDS = {
    "both": "matched by meaning AND by keyword",
    "vector": "matched by meaning (embedding similarity)",
    "keyword": "matched by keyword only — no semantic match",
    "metric_home": "this document is the DECLARED definition of a metric in the question",
    "glossary": "matched through a glossary synonym",
}


def _review_overdue(review_date: Any) -> bool | None:
    """Is this document past the review its owner scheduled?

    None when no review was ever scheduled — which is different from "not
    overdue", and a consumer that cannot tell them apart will report an
    unreviewed document as current.
    """
    if not review_date:
        return None
    try:
        from datetime import date, datetime

        if isinstance(review_date, datetime):
            review_date = review_date.date()
        return bool(review_date < date.today())
    except Exception:  # noqa: BLE001
        return None


def _clip(content: str) -> tuple[str, bool]:
    """`(text, was_truncated)` under the token ceiling, cut at a word boundary."""
    from app.services.dashboard_ai_bot.govern_doc_blocks import estimate_tokens

    text = str(content or "")
    if estimate_tokens(text) <= MAX_CONTENT_TOKENS:
        return text, False
    # estimate_tokens is characters/ratio, so invert it for the cut point.
    keep = max(1, int(len(text) * MAX_CONTENT_TOKENS / max(1, estimate_tokens(text))))
    cut = text[:keep]
    space = cut.rfind(" ")
    if space > keep * 0.6:
        cut = cut[:space]
    return cut.rstrip() + "…", True


def from_chunk(row: dict) -> dict:
    """A retriever row → a hit. The one place that mapping is written."""
    content, truncated = _clip(row.get("content"))
    method = str(row.get("matched_by") or "") or None
    citation = row.get("citation") or {
        "doc_id": row.get("doc_id"),
        "title": row.get("title"),
        "heading_path": row.get("heading_path"),
        "page": row.get("page"),
        "block": row.get("block_from"),
        "source_version": row.get("source_version"),
    }
    return {
        "source_type": "document",
        "doc_id": row.get("doc_id"),
        "document_version": row.get("source_version"),
        "title": row.get("title"),
        "chunk_id": row.get("chunk_id"),
        "content": content,
        "content_truncated": truncated,
        "heading_path": row.get("heading_path"),
        "page": row.get("page"),
        "block_kind": row.get("block_kind"),
        "table_header": row.get("table_header"),
        "section_content": row.get("section_content"),
        "retrieval_method": method,
        "reason_retrieved": _METHOD_WORDS.get(method or "", method),
        "vector_similarity": row.get("similarity"),
        "hybrid_score": row.get("rrf_score"),
        "rerank_score": row.get("rerank_score"),
        "lexical_bm25": row.get("bm25"),
        "term_coverage": row.get("term_coverage"),
        "trust": row.get("trust"),
        "authority": bool(row.get("is_metric_home")),
        "owner": row.get("owner"),
        "last_verified_at": _iso(row.get("last_verified_at")),
        "review_date": _iso(row.get("review_date")),
        "review_overdue": _review_overdue(row.get("review_date")),
        "importance": row.get("importance"),
        "sensitivity": row.get("sensitivity"),
        "citation": citation,
        "embedding_model": row.get("embedding_model"),
        "updated_at": _iso(row.get("updated_at")),
        "doc_type": row.get("doc_type"),
    }


def from_metric(metric: Any, *, home_doc_id: int | None = None) -> dict:
    """A governed KPI as evidence.

    Same shape as a passage on purpose: a consumer ranking or citing evidence
    should not need to know which table it came out of. `authority` is True
    because a governed metric IS the declared definition — that is what governing
    it means.
    """
    return _blank({
        "source_type": "metric",
        "doc_id": home_doc_id,
        "title": getattr(metric, "display_name", None) or getattr(metric, "name", None),
        "content": getattr(metric, "definition", None),
        "authority": True,
        "owner": getattr(metric, "owner", None),
        "trust": "authored",
        "retrieval_method": "metric_home",
        "reason_retrieved": _METHOD_WORDS["metric_home"],
        "citation": {"metric": getattr(metric, "name", None), "doc_id": home_doc_id},
    })


def from_term(term: Any) -> dict:
    """A glossary term. Vocabulary, not a governed number — so `authority` stays
    False: knowing what a word means is not the same as owning its definition."""
    return _blank({
        "source_type": "term",
        "title": getattr(term, "display_name", None) or getattr(term, "name", None),
        "content": getattr(term, "description", None),
        "trust": "authored",
        "retrieval_method": "glossary",
        "reason_retrieved": _METHOD_WORDS["glossary"],
        "citation": {"term": getattr(term, "name", None)},
    })


def from_document(doc: Any, *, content: str, method: str = "keyword") -> dict:
    """A whole document matched by title/summary rather than by passage."""
    clipped, truncated = _clip(content)
    return _blank({
        "source_type": "document",
        "doc_id": getattr(doc, "id", None),
        "document_version": getattr(doc, "published_version", None),
        "title": getattr(doc, "title", None),
        "content": clipped,
        "content_truncated": truncated,
        "trust": "authored",
        "owner": getattr(doc, "owner", None),
        "last_verified_at": _iso(getattr(doc, "last_verified_at", None)),
        "review_date": _iso(getattr(doc, "review_date", None)),
        "review_overdue": _review_overdue(getattr(doc, "review_date", None)),
        "importance": getattr(doc, "importance", None),
        "sensitivity": getattr(doc, "sensitivity", None),
        "updated_at": _iso(getattr(doc, "updated_at", None)),
        "doc_type": getattr(doc, "doc_type", None),
        "retrieval_method": method,
        "reason_retrieved": _METHOD_WORDS.get(method, method),
        "citation": {"doc_id": getattr(doc, "id", None),
                     "title": getattr(doc, "title", None),
                     "source_version": getattr(doc, "published_version", None)},
    })


def _blank(values: dict) -> dict:
    """Every declared field present, absent ones explicitly null.

    A missing key and a null value read the same to a model and completely
    differently to code: `"page" in hit` was how one consumer decided whether to
    show a page number, and it was True for every hit because the key was always
    written. Writing all of them makes the shape checkable.
    """
    hit = {name: None for name in FIELDS}
    hit["content_truncated"] = False
    hit["authority"] = False
    hit.update({k: v for k, v in values.items() if k in hit})
    return hit


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)
