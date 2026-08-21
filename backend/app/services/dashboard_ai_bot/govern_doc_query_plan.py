"""Multi-part questions, answered by parts — but only when one pass was not enough.

WHY IT ESCALATES INSTEAD OF CLASSIFYING
---------------------------------------
The usual design asks a model "is this question complex?" and plans accordingly.
That costs a round trip before any retrieval has happened, on every question, to
decide something retrieval could simply demonstrate. So this does the opposite:
retrieve once, then check whether every part of the question actually found
evidence. A question that was answered needs no plan; one that half-answered gets
a second pass aimed at the half that is missing.

The check is free — it reads the passages already in hand — so simple questions
pay nothing, which is the property the roadmap asked for.

WHY THERE IS NO MODEL IN HERE
-----------------------------
Rewriting or decomposing with an LLM means a provider call, which means latency,
cost, and a new egress path that the per-document `external_processing` policy
would have to cover. Vietnamese multi-part questions are overwhelmingly joined by
a small set of words — "và", "hoặc", "so sánh … với …", a comma list — and
splitting on those is deterministic, instant, and inspectable. When it is not
enough, the model reading the assembled passages is a better place to reason than
a rewriting step that has already thrown the original wording away.

WHAT "NOT ENOUGH" MEANS
-----------------------
Not a similarity threshold. Cosine is not comparable across questions (see
doc_rerank), so a floor would fire on well-answered specific questions and stay
silent on badly-answered vague ones. Instead: every clause contributes its
distinctive terms, and a clause whose terms appear NOWHERE in the retrieved text
is a part of the question that went unanswered. That is directly observable.
"""
from __future__ import annotations

import logging
import re

from app.core.text_fold import fold_text, fold_tokens

logger = logging.getLogger(__name__)

#: Conjunctions and separators that join two askable clauses. Deliberately short:
#: every word here can split a question that was never two questions.
_SPLIT_RE = re.compile(
    r"\s+(?:và cả|và|cùng với|so với|hoặc|hay là|hay|;)\s+|[;]|(?<=\S),\s+(?=\S)",
    re.IGNORECASE,
)

#: A clause shorter than this is a fragment, not a question ("và cả" leftovers,
#: trailing particles). Splitting on it would search for noise.
_MIN_CLAUSE_TOKENS = 2

#: Interrogatives and scaffolding that carry no retrieval signal. A clause made
#: only of these is not asking about anything.
_SCAFFOLD = {
    "la", "gi", "bao", "nhieu", "the", "nao", "sao", "vi", "cua", "cho", "khi",
    "co", "khong", "duoc", "voi", "trong", "mot", "cac", "nhung", "de", "tu",
    "den", "theo", "tren", "duoi", "thi", "ma", "nay", "do", "ai", "phai", "se",
    "da", "dang", "ra", "vao", "ve", "hay", "va", "liet", "ke", "cho", "biet",
    "what", "is", "the", "of", "and", "for", "how", "why", "does", "do", "list",
}

#: Never fan out further than this. Each extra clause is another query embedding.
_MAX_CLAUSES = 4


def clauses(question: str) -> list[str]:
    """Askable parts of a question, or a single-element list when it has one part.

    Returns the ORIGINAL wording of each clause, not a folded form: the clause is
    about to be embedded, and embeddings are made from words, not from tokens.
    """
    raw = [c.strip(" ,;?.") for c in _SPLIT_RE.split(question or "") if c and c.strip()]
    kept: list[str] = []
    for clause in raw:
        content = fold_tokens(clause) - _SCAFFOLD
        if len(content) >= _MIN_CLAUSE_TOKENS:
            kept.append(clause)
    if len(kept) < 2:
        return [question] if (question or "").strip() else []
    return kept[:_MAX_CLAUSES]


def uncovered_clauses(question: str, rows: list[dict]) -> list[str]:
    """Clauses whose distinctive terms appear NOWHERE in what was retrieved.

    Reads the assembled text — heading path, passage, and the section around it —
    because that is what the answer will be grounded in. A clause covered only by
    the section still counts as covered: the model will see it.
    """
    parts = clauses(question)
    if len(parts) < 2:
        return []
    haystack = fold_text(" ".join(
        " ".join([
            str(row.get("heading_path") or ""),
            str(row.get("content") or ""),
            str(row.get("section_content") or ""),
        ])
        for row in rows
    ))
    missing: list[str] = []
    for clause in parts:
        terms = fold_tokens(clause) - _SCAFFOLD
        if terms and not any(term in haystack for term in terms):
            missing.append(clause)
    return missing


def describe(question: str, rows: list[dict], extra_passes: int) -> dict:
    """What the planner decided, for the audit and for a reader debugging a result.

    A plan that cannot be inspected is a plan nobody can trust; `extra_passes` of
    zero is the normal, reportable case rather than an absence of information.
    """
    parts = clauses(question)
    return {
        "clauses": parts if len(parts) > 1 else [],
        "expanded": extra_passes > 0,
        "extra_passes": extra_passes,
        "uncovered": uncovered_clauses(question, rows),
    }
