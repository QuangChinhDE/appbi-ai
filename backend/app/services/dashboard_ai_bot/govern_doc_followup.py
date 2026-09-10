"""A question that only makes sense after the one before it.

WHAT WAS MEASURED
-----------------
Turn one: "Tỷ lệ giao đúng hẹn được tính như thế nào?" — answered from the SLA
policy and the operations handbook, correctly. Then the viewer asks the way
people actually ask, without repeating the subject:

    "Còn trường hợp loại trừ thì sao?"  ANSWERABLE   ← from the Intelligence
                                                       user guide and the Olist
                                                       report overview
    "Thế còn cái đó thì sao?"           NOT_ENOUGH_EVIDENCE
    "Vậy ai chịu trách nhiệm?"          NOT_ENOUGH_EVIDENCE

The first is the worst of the three: retrieval landed on two documents that have
nothing to do with delivery, the relevance floor was satisfied, and the verdict
said the evidence supports an answer. A wrong document answered confidently.

Carrying the previous question forward fixes all three — same corpus, same
retriever:

    "Tỷ lệ giao đúng hẹn được tính như thế nào? Còn trường hợp loại trừ thì sao?"
        → ANSWERABLE, from the SLA policy and Vận hành & Giao vận

WHY A RULE AND NOT A MODEL CALL
-------------------------------
The obvious design is to hand the last few turns to a model and ask for a
standalone question. That is a round trip before any retrieval, on every follow-up
turn, to produce something the sentence already determines — and this module was
written in the same week the analysis node's timeout turned out to be network
latency. `govern_doc_expansion` made the same choice for the same reason.

The rule is narrow on purpose. Joining the previous question to EVERY turn was
measured too, and it is actively harmful:

    "Doanh thu tháng này bao nhiêu?"   alone → its own topic
                                       joined → dragged onto the delivery
                                                documents, and still ANSWERABLE

So a topic change must not be rewritten, and the only reliable signal that a
question is NOT a topic change is that it opens by pointing at the previous one:
"còn…", "thế còn…", "vậy…". Those words are the viewer saying "relative to what
we were just discussing", and they are what this looks for.
"""
from __future__ import annotations

from app.core.text_fold import fold_text

#: Openers that make a question RELATIVE to the one before it.
#:
#: Matched at the START only. "Vậy ai chịu trách nhiệm?" is a follow-up; "Ai chịu
#: trách nhiệm vậy?" is a complete question with a sentence-final particle, and
#: rewriting it would be rewriting a question that already stands alone.
#:
#: Folded, so they match with or without diacritics — a viewer typing "the con
#: cai do thi sao" is asking the same thing.
_MARKERS: tuple[str, ...] = (
    "con ",          # "Còn trường hợp loại trừ thì sao?"
    "the con ",
    "vay con ",
    "the thi ",
    "vay thi ",
    "vay ",          # "Vậy ai chịu trách nhiệm?"
    "the ",          # "Thế còn cái đó thì sao?"
    "ngoai ra ",
    "the nao voi ",
    "what about ",
    "and what about ",
)

#: A question can also be relative without an opener, by pointing at something
#: with no name: "cái đó", "chỗ này", "nó". Checked anywhere in the sentence.
_DEICTICS: tuple[str, ...] = (
    "cai do", "cai nay", "cai ay", "cho do", "cho nay",
    "dieu do", "viec do", "truong hop do", "no thi", "chung thi",
)

#: Past this, a question is long enough to carry its own subject and a rewrite
#: would be adding noise to something that already works. Measured questions that
#: needed the rewrite were 4-7 words.
_MAX_FOLLOWUP_WORDS = 14

#: How much of the previous question to carry. Whole, not a extracted "subject":
#: pulling the subject out means deciding what the subject IS, which is the
#: parsing problem this module exists to avoid, and the measurement above used
#: the whole sentence.
_MAX_PRIOR_CHARS = 160


def looks_relative(question: str) -> bool:
    """Does this question only make sense against the one before it?"""
    folded = fold_text(question or "").strip()
    if not folded:
        return False
    if len(folded.split()) > _MAX_FOLLOWUP_WORDS:
        return False
    if any(folded.startswith(marker) for marker in _MARKERS):
        return True
    return any(d in folded for d in _DEICTICS)


def resolve(question: str, prior_question: str | None) -> tuple[str, bool]:
    """`(query_to_retrieve_with, was_rewritten)`.

    The viewer's words are KEPT and the previous question is placed in front of
    them, rather than replaced by a synthesised standalone sentence. Two reasons:
    the retriever is fusing a vector rank with a keyword rank and the viewer's own
    terms are what the keyword half matches on, and an author reading the trace
    can see exactly what was asked and what was added.
    """
    asked = (question or "").strip()
    prior = (prior_question or "").strip()
    if not asked or not prior or not looks_relative(asked):
        return asked, False
    if fold_text(prior) == fold_text(asked):
        # The same question twice is not a follow-up, and doubling it would
        # double every term's weight in the keyword rank.
        return asked, False
    return f"{prior[:_MAX_PRIOR_CHARS]} {asked}", True


def prior_user_question(history: list) -> str:
    """The most recent thing the VIEWER asked, from a conversation history.

    Accepts the envelope's `Turn` objects or plain dicts, because the two callers
    hold different shapes and neither should have to convert for this.
    """
    for turn in reversed(list(history or [])):
        role = getattr(turn, "role", None) or (
            turn.get("role") if isinstance(turn, dict) else None)
        if role != "user":
            continue
        content = getattr(turn, "content", None) or (
            turn.get("content") if isinstance(turn, dict) else "")
        text = str(content or "").strip()
        if text:
            return text
    return ""
