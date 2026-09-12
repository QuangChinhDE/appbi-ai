"""Asking again, in the words the documents actually use.

WHY THE OLD TRIGGER NEVER FIRED
-------------------------------
`search_doc_chunks` escalated when `uncovered_clauses` reported a part of the
question with no evidence. Measured over all 56 eval cases: it fired ZERO times.
The rule counts a clause as covered when ANY of its terms appears ANYWHERE in the
retrieved text, and in a corpus of business prose one common word always does. The
feature existed in code and had never once run.

Phase 2 produced the signal this should have used all along. The cross-encoder
separates "retrieval found something about this question" from "it did not" at
0.978 accuracy where term coverage reaches 0.844 — so expansion now escalates on
the same relevance floor the answerability verdict uses, and for the same reason.

WHAT IS TRIED, IN WHAT ORDER
----------------------------
Section 11's order, and its reasoning: internal vocabulary first, because the
company has written down what its own words mean and guessing is only needed after
that runs out.

    1. METRIC ALIASES     a governed KPI's declared synonyms. "GMV" is written down
                          as "tổng giá trị giao dịch"; nobody has to infer it.
    2. GLOSSARY SYNONYMS   the same, for vocabulary that is not a KPI.
    3. ACCENT RESTORATION  measured, not speculative: the cross-encoder is inert on
                          unaccented Vietnamese — every candidate scores negative,
                          the relevance gate adds nothing, and "muc tieu giao dung
                          hen" retrieves on the folding lexical path alone. When a
                          question is written without diacritics and the internal
                          vocabulary holds the accented form, that form is a better
                          query for the half of the pipeline that cannot fold.

NO LLM REWRITE HERE
-------------------
Section 11 permits one when deterministic expansion is not enough. It is not built
yet, deliberately: on this corpus deterministic expansion has not yet been shown to
be insufficient — it has never been shown to RUN. Adding a model call to a path
whose cheap half was dead would be measuring the model against nothing.

The seam is `expand()`: it returns queries and says where each came from, so an
LLM source can be added as a fourth entry that is consulted only after these three
return nothing.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: Never more than this many extra retrieval passes for one question. Each is a
#: query embedding, a vector scan and a rerank; a question that needs five
#: rephrasings is a question the corpus does not answer.
MAX_EXPANSIONS = 3

#: A vocabulary entry shorter than this matches too much. "AOV" is fine as an
#: explicit alias; a two-letter fragment found inside another word is not.
_MIN_TERM_CHARS = 3


def _vocabulary(db: Any) -> list[dict]:
    """Every name the business has written down for something, with its aliases.

    Metrics first: a governed KPI is a stronger statement than a glossary entry —
    somebody owns it and bound it to data — and when both define the same word the
    metric's phrasing is the one the documents were written against.
    """
    from sqlalchemy import text as _text

    out: list[dict] = []
    for sql, kind in (
        ("SELECT name, display_name, synonyms FROM govern_metrics", "metric"),
        ("SELECT name, display_name, synonyms FROM glossary_terms", "glossary"),
    ):
        try:
            rows = db.execute(_text(sql)).fetchall()
        except Exception:  # noqa: BLE001 — expansion is an enhancement
            logger.warning("expansion: %s vocabulary unavailable", kind, exc_info=True)
            continue
        for name, display, synonyms in rows:
            forms = [name, display, *(_as_list(synonyms))]
            out.append({
                "kind": kind,
                "forms": [f for f in ((str(x or "")).strip() for x in forms)
                          if len(f) >= _MIN_TERM_CHARS],
            })
    return out


def _as_list(value: Any) -> list:
    """`synonyms` is JSON in one table and a text array in the other."""
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        import json

        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except Exception:  # noqa: BLE001
            return []
    return []


def _readable(form: str) -> str:
    """A stored name into something worth embedding. `doanh_thu_thuan` is a slug —
    embedding it searches for the slug, not for the words."""
    return form.replace("_", " ").strip()


def expand(db: Any, question: str, rows: list[dict], *,
           evidence_is_weak: bool = True) -> list[dict]:
    """Alternative phrasings worth another retrieval pass.

    Returns `[{query, source, why}]` — the source named so a trace can show WHY a
    passage was reached, and so a reader debugging a result is not left guessing
    which of four mechanisms produced it.

    `evidence_is_weak` decides whether "this wording already appears in the
    results" is a reason NOT to expand. It was applied unconditionally at first,
    inherited from the old glossary trigger where the question was "is this term's
    wording missing". Under the new trigger the question is "did retrieval find
    anything about this at all", and there the guard is backwards: "OTD la bao
    nhieu" scored −5.20, well below the floor, and expansion was skipped because
    the phrase "giao đúng hẹn" appeared somewhere in those bad results. A phrase
    surviving in evidence the reranker just rejected is not an answer.
    """
    from app.core.text_fold import fold_text

    folded_question = fold_text(question)
    if not folded_question:
        return []
    haystack = fold_text(" ".join(
        " ".join([str(r.get("heading_path") or ""), str(r.get("content") or ""),
                  str(r.get("section_content") or "")])
        for r in rows
    ))

    out: list[dict] = []
    seen: set[str] = {folded_question}

    for entry in _vocabulary(db):
        forms = entry["forms"]
        folded = {fold_text(_readable(f)): _readable(f) for f in forms}
        folded = {k: v for k, v in folded.items() if k}
        # Which of this term's forms the question used, if any.
        named = [orig for key, orig in folded.items() if key in folded_question]
        if not named:
            continue
        # Already answered in these words — nothing to gain. Only when the
        # evidence was good enough to mean anything.
        if not evidence_is_weak and any(key in haystack for key in folded):
            continue

        # The forms the question actually used, folded. An alternative that folds
        # to one of these is the SAME WORD written with its diacritics; anything
        # else is a different word.
        used_folds = {fold_text(form) for form in named}

        for key, original in folded.items():
            # "Already used" is a question about the ORIGINAL text, not the folded
            # one. Skipping on the folded match discarded the accented form as
            # "already asked": "muc tieu don giao dung hen" folds to the same
            # string as "Đơn giao đúng hẹn", which is precisely why that form is
            # worth querying — the reader did NOT type it.
            if key in seen or original in question:
                continue
            seen.add(key)
            if key in used_folds and original not in question:
                # ACCENT REPAIR, decided exactly rather than guessed.
                #
                # A marker heuristic was tried first — "does this look like
                # Vietnamese typed without diacritics" from a list of function
                # words — and it called "muc tieu don giao dung hen" accented,
                # because a noun phrase carries none of them. Whether the question
                # dropped a term's diacritics is not a property of the sentence; it
                # is a property of the TERM, and comparing the two folded forms
                # answers it without a word list to maintain.
                source, why = "accent", (
                    "the accented form of a term the question wrote without "
                    "diacritics — the semantic reranker cannot fold"
                )
            else:
                source = entry["kind"]
                why = ("the %s's declared alias for a term the question named"
                       % ("KPI" if source == "metric" else "glossary entry"))
            out.append({"query": original, "source": source, "why": why})
            if len(out) >= MAX_EXPANSIONS:
                return out
    return out
