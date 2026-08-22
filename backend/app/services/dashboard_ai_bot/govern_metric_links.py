"""Metric mentions resolved through the governance graph, not through search.

WHY THIS IS NOT A SEARCH PROBLEM
-------------------------------
The chunker strips `{{metric:...}}` tokens before embedding, because they are
structural references rather than prose. That has a consequence worth stating
plainly: metric references are INVISIBLE to both halves of retrieval. A question
about a governed metric cannot be answered by hoping its name happens to appear
in the right passage.

It does not need to be. `GovernMetric.home_doc_id` already records which document
DEFINES each metric — the single source of truth an author declared — and that is
a deterministic lookup, not a similarity guess. The demo corpus shows exactly why
it matters: the phrase "Gross Merchandise Value" appears in the GLOSSARY document,
while the document that defines GMV is a different one. Text search sends the
reader to the glossary; the graph sends them to the definition.

So this is used to (a) make sure the defining document's passages are in the
candidate pool at all, and (b) tell the reranker that one of the candidates is the
declared source of truth for something the question actually asked about.

A DEPRECATED metric is skipped. A DRAFT one is not: it is still the best pointer
anyone has recorded, and "being written" is not the same as "wrong".
"""
from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.text_fold import fold_text, fold_tokens

logger = logging.getLogger(__name__)

#: Aliases shorter than this are ignored as mentions. "GMV" is three characters
#: and must match; two-character aliases match half the language.
_MIN_ALIAS = 3


def _aliases(row) -> list[str]:
    """Every way a question might name this metric, folded, longest first.

    Longest first so "gross merchandise value" is tested before "gmv" and the
    match that is reported is the most specific one present.
    """
    display, machine, synonyms = row[1], row[2], row[3] or []
    raw = [display, machine.replace("_", " ") if machine else None, *synonyms]
    folded = {fold_text(a) for a in raw if a and len(fold_text(a)) >= _MIN_ALIAS}
    return sorted(folded, key=lambda a: (-len(a), a))


def metrics_in_question(db: Session, question: str) -> list[dict]:
    """Governed metrics the question names, each with the document that defines it.

    Matching is on the FOLDED question, so "gia tri giao dich" finds a metric
    called "Giá trị giao dịch". Multi-word aliases are matched as substrings; a
    single-word alias must match a whole token, or "gmv" would fire inside an
    unrelated word.
    """
    folded_question = fold_text(question)
    if not folded_question:
        return []
    question_tokens = fold_tokens(question)
    try:
        rows = db.execute(
            text(
                """
                SELECT m.id, m.display_name, m.name, m.synonyms, m.home_doc_id,
                       m.status, d.title
                FROM govern_metrics m
                JOIN govern_knowledge_docs d ON d.id = m.home_doc_id
                WHERE m.home_doc_id IS NOT NULL
                  AND COALESCE(m.status, '') <> 'Deprecated'
                """
            )
        ).fetchall()
    except Exception:  # noqa: BLE001 — a retrieval enhancement, never a dependency
        logger.warning("govern_metric_links: metric lookup failed", exc_info=True)
        return []

    found: list[dict] = []
    for row in rows:
        for alias in _aliases(row):
            hit = (alias in question_tokens) if " " not in alias else (alias in folded_question)
            if hit:
                found.append({
                    "metric_id": int(row[0]),
                    "metric": row[2],
                    "display_name": row[1],
                    "home_doc_id": int(row[4]),
                    "home_doc_title": row[6],
                    "matched_alias": alias,
                    "status": row[5],
                })
                break
    return found


def home_doc_chunk_ids(db: Session, sql_filter: str, params: dict,
                       home_doc_ids: set[int], limit: int) -> list[int]:
    """The defining documents' chunks, in document order, within the search scope.

    Scope-constrained on purpose: naming a metric does not grant access to the
    document that defines it. `sql_filter` is the same one the rest of the search
    ran under, so this can only surface what the caller could already reach.
    """
    if not home_doc_ids:
        return []
    try:
        rows = db.execute(
            text(
                f"""
                SELECT c.id
                FROM govern_doc_chunk c
                {sql_filter}
                  AND c.doc_id = ANY(:home_docs)
                ORDER BY c.doc_id, c.chunk_index
                LIMIT :lim
                """
            ),
            {**params, "home_docs": sorted(home_doc_ids), "lim": limit},
        ).fetchall()
        return [int(r[0]) for r in rows]
    except Exception:  # noqa: BLE001
        logger.warning("govern_metric_links: home-doc chunk lookup failed", exc_info=True)
        return []
