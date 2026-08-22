"""Does the evidence actually support an answer — and to which part of the question?

WHY THIS IS NOT A SIMILARITY THRESHOLD
--------------------------------------
It was tried. Cosine and term coverage were both swept over every weighting and
both score formulas, and neither separates answerable from unanswerable questions
on this corpus: the best gap between the two distributions was NEGATIVE. A field
called `answer_confidence` was built on them and then deleted rather than shipped,
because a confidence number that is wrong in the confident direction is worse than
no number.

What changed is the cross-encoder. Cosine compares two vectors built independently,
and the passage's vector was made before anyone asked the question. The
cross-encoder reads the pair and was trained on exactly this judgement. Measured
over 48 cases (36 answerable, 3 partial, 9 no-answer):

    signal                       accuracy   always-answer
    cross-encoder (max logit)      0.978        0.800
    term coverage                  0.844        0.800
    cosine                         0.822        0.800

WHERE THE FLOOR COMES FROM
--------------------------
Not from the best accuracy. The best threshold on this set is −3.99, which is
EXACTLY the lowest-scoring answerable case — one more question half a point below
it and the evaluator starts refusing to answer things the corpus answers. Tuned to
the last decimal on 48 questions is a hypothesis, not a constant.

    floor    no-answer caught    answerable wrongly refused    partial mislabelled
    −3.99         8/9                     0                          1
    −4.05         8/9                     0                          1
    −4.50         7/9                     0                          0
    −5.00         6/9                     0                          0
    −5.50         3/9                     0                          0

−4.5 sits roughly in the middle of the gap: 0.51 below the lowest answerable case,
0.42 below the highest no-answer case. It gives up one detection for a margin that
survives questions it was not tuned on. The asymmetry is deliberate — a false
abstention is a system that looks broken to someone holding the document that
answers them, and the answer layer already carries an instruction to say when the
passages do not contain the answer, so a miss here is caught downstream.

THE ONE IT CANNOT CATCH
-----------------------
"Mức phạt khi vi phạm cam kết giao đúng hẹn là bao nhiêu?" — the corpus has an SLA
commitment and says nothing about penalties. The cross-encoder scores the SLA
passage +0.82, because that passage IS about the question. It answers "is this
relevant", not "does this contain the answer", and on a right-topic/no-answer
question those differ. No retrieval statistic closes that gap; a model reading the
passage does, which is why the abstain instruction ships with the context and not
only here.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

ANSWERABLE = "ANSWERABLE"
PARTIALLY_ANSWERABLE = "PARTIALLY_ANSWERABLE"
NOT_ENOUGH_EVIDENCE = "NOT_ENOUGH_EVIDENCE"
CONTRADICTORY = "CONTRADICTORY"

#: Below this, the best passage retrieval could find is not about the question.
#: See the docstring for the sweep this came from and why it is not the optimum.
RELEVANCE_FLOOR = -4.5

#: The same question, asked of ONE CLAUSE. A clause is a fragment — "GMV được tính
#: thế nào" rather than a whole question — and the cross-encoder scores fragments
#: lower even when the evidence is sitting there, so the question-level floor does
#: not transfer. Measured over 26 clauses drawn from the multi-part cases:
#:
#:     floor    part correctly called missing    part wrongly called missing
#:     −2.0              8/8                              2
#:     −3.0              7/8                              1
#:     −3.5              6/8                              0
#:     −4.5              3/8                              0
#:
#: −3.5, on the same principle as the question floor: never tell a reader a part of
#: their question went unanswered when the corpus answers it. The two distributions
#: overlap by 0.44 — one covered clause at −3.21 ("Liệt kê các mục tiêu vận hành",
#: a list-me question the model scores poorly) sits above one missing clause at
#: −2.77 — so no threshold is clean, and this one errs in the survivable direction.
CLAUSE_FLOOR = -3.5

#: Never split a question into more parts than this for coverage. Each part costs a
#: retrieval and a scoring pass, and a question with five askable parts is rare
#: enough that stopping at four loses little and bounds the cost.
MAX_CLAUSES_CHECKED = 4

#: What a viewer is told when there is nothing to answer from. Said in the
#: document's own terms — "the knowledge sources I am allowed to read" — because
#: "I don't know" invites the reader to assume the system is broken, and "there is
#: no policy" is a claim about the company that retrieval cannot make.
NO_EVIDENCE_TEXT = (
    "Chưa tìm thấy đủ thông tin trong nguồn tri thức được phép truy cập."
)


def evaluate(db: Any, question: str, rows: list[dict], *,
             conflict: dict | None = None, doc_ids: Any = None,
             check_clauses: bool = True) -> dict:
    """What the evidence supports. Returns a verdict and the reasons behind it.

    `rows` are retrieval rows AFTER reranking — they carry `ce_logit` where the
    cross-encoder judged them and no such key where it did not, which is the
    distinction the whole verdict rests on.

    The order of the checks is the order of the failures they prevent:

      1. nothing retrieved       — no evidence at all
      2. a CONTRADICTION         — before answerability, because an evaluator that
                                   says ANSWERABLE while two sources disagree has
                                   picked a side without saying so
      3. a STRONGLY covered clause beside a missing one — partial, and it
                                   overrides the floor below, because a composite
                                   question drags its own aggregate score down and
                                   one clause with real evidence proves part of it
                                   can be answered
      4. nothing relevant enough — the floor above
      5. an ordinary covered clause beside a missing one — partial
    """
    evidence_ids = [r.get("chunk_id") for r in rows if r.get("chunk_id") is not None]

    if not rows:
        return _verdict(NOT_ENOUGH_EVIDENCE, "no passage was retrieved at all",
                        basis="empty", evidence_ids=[])

    if conflict and conflict.get("conflict"):
        return _verdict(
            CONTRADICTORY,
            conflict.get("summary") or "sources disagree",
            basis="conflict", evidence_ids=evidence_ids, conflict=conflict,
        )

    # Only rows the model actually judged. A row with no `ce_logit` was never
    # looked at, and reading its absence as a low score is how an unscored
    # candidate becomes a refusal.
    judged = [float(r["ce_logit"]) for r in rows if r.get("ce_logit") is not None]
    best = max(judged) if judged else None

    covered, missing, strong = ([], [], [])
    if check_clauses:
        covered, missing, strong = _clause_coverage(db, question, rows, doc_ids)

    # PARTIAL IS CHECKED BEFORE THE FLOOR, not after.
    #
    # A composite question drags its own score down: "CAC được tính thế nào và văn
    # phòng công ty ở đâu?" scored −4.55 as a whole and was refused outright, while
    # its first half is answered by a document sitting in the corpus. One covered
    # clause is direct evidence that part of the question CAN be answered, and it
    # outranks an aggregate that half of the question dragged below a floor.
    # TWO DECISIONS, TWO BARS.
    #
    # "Is this partial?" and "may partial override the question floor?" are not the
    # same question, and using one threshold for both broke whichever it was tuned
    # against. A clause merely above the clause floor is enough to say a part went
    # unanswered; it is not enough to overrule an aggregate score that says the
    # corpus knows nothing about any of it. Only a STRONGLY covered clause — one
    # whose own retrieval found a passage the model judged relevant outright — is
    # proof that part of the question is answerable.
    #
    # Both directions were measured. Overriding on `covered` turned "Chính sách
    # nghỉ phép và ngày phép hàng năm" — a question with no answer at all — into a
    # partial one. Requiring `strong` for the ordinary partial verdict lost two
    # genuine partials whose answerable half scored −1.31 and −0.21: real evidence,
    # just not emphatic.
    if missing and strong:
        return _verdict(
            PARTIALLY_ANSWERABLE,
            "evidence covers %s but nothing was found for %s"
            % (_quote(strong), _quote(missing)),
            basis="clause_coverage_strong", evidence_ids=evidence_ids,
            best_relevance=best, judged=len(judged),
            covered=covered, missing=missing,
        )

    if best is not None and best < RELEVANCE_FLOOR:
        return _verdict(
            NOT_ENOUGH_EVIDENCE,
            "the closest passage scored %.2f, below the floor %.1f — retrieval "
            "found nothing about this question" % (best, RELEVANCE_FLOOR),
            basis="relevance", evidence_ids=evidence_ids,
            best_relevance=best, judged=len(judged),
            covered=covered, missing=missing,
        )

    # Above the floor, so the question is answerable — but a part of it still went
    # unanswered, and an answer that covers half a question while reading as
    # complete is the failure this verdict exists to name.
    if missing and covered:
        return _verdict(
            PARTIALLY_ANSWERABLE,
            "evidence covers %s but nothing was found for %s"
            % (_quote(covered), _quote(missing)),
            basis="clause_coverage", evidence_ids=evidence_ids,
            best_relevance=best, judged=len(judged),
            covered=covered, missing=missing,
        )

    return _verdict(
        ANSWERABLE,
        ("the retrieved passages are about the question"
         if best is None else
         "the closest passage scored %.2f" % best),
        basis="relevance" if best is not None else "no_semantic_judgement",
        evidence_ids=evidence_ids, best_relevance=best, judged=len(judged),
        covered=covered, missing=missing,
    )


def _clause_coverage(db: Any, question: str, rows: list[dict],
                     doc_ids: Any) -> tuple[list[str], list[str], list[str]]:
    """Which askable parts of the question the evidence speaks to.

    The splitter is the query planner's — it already decides what counts as a
    clause, and two definitions of "part of a question" would disagree on exactly
    the multi-part questions this is for.

    The JUDGEMENT is not the planner's. `uncovered_clauses` calls a clause covered
    when ANY of its terms appears anywhere in the retrieved text, which is the
    right trigger for "should I search again" and far too lenient for "was this
    part answered": "chính sách nghỉ phép ra sao" counted as covered because the
    word "chính sách" appears in an unrelated passage. Measured, it caught 0 of 3
    partial questions.

    Each clause is retrieved for SEPARATELY and judged on its own evidence. Scoring
    a clause against passages fetched for the composite question measures how the
    retrieval budget got split, not whether the corpus answers that part — an
    answerable "GMV được tính thế nào" scored −0.97 that way because the other half
    of the question had taken the window.
    """
    try:
        from app.services.dashboard_ai_bot.govern_doc_query_plan import clauses

        parts = clauses(question)[:MAX_CLAUSES_CHECKED]
        if len(parts) < 2:
            return [], [], []

        from app.services.dashboard_ai_bot.govern_doc_embeddings import (
            search_doc_chunks,
        )

        covered: list[str] = []
        missing: list[str] = []
        strong: list[str] = []
        for clause in parts:
            own = search_doc_chunks(db, clause, k=8, doc_ids=doc_ids) or []
            judged = [float(r["ce_logit"]) for r in own if r.get("ce_logit") is not None]
            if not judged:
                # Nothing was judged — the model is absent or the clause retrieved
                # nothing scoreable. Silence is not evidence of absence.
                covered.append(clause)
                continue
            best_clause = max(judged)
            if best_clause < CLAUSE_FLOOR:
                missing.append(clause)
            else:
                covered.append(clause)
                # STRONGLY covered: this clause's own retrieval found a passage the
                # model judged relevant, not merely one that cleared the floor. The
                # distinction decides whether a partial verdict may override the
                # question-level floor — see `evaluate`.
                if best_clause > 0:
                    strong.append(clause)
        return covered, missing, strong
    except Exception:  # noqa: BLE001 — a verdict without clause detail beats none
        logger.warning("answerability: clause coverage failed", exc_info=True)
        return [], [], []


def _quote(parts: list[str]) -> str:
    return ", ".join('"%s"' % p for p in parts[:3]) or "(nothing)"


def _verdict(verdict: str, reason: str, *, basis: str, evidence_ids: list,
             best_relevance: float | None = None, judged: int = 0,
             covered: list[str] | None = None, missing: list[str] | None = None,
             conflict: dict | None = None) -> dict:
    """The verdict plus everything needed to argue with it.

    `basis` names WHICH signal decided, because "NOT_ENOUGH_EVIDENCE" from a
    relevance floor and the same verdict from an empty result set need different
    responses, and a caller that cannot tell them apart will report a retrieval
    outage as a gap in the documentation.
    """
    return {
        "verdict": verdict,
        "reason": reason,
        "basis": basis,
        "evidence_ids": evidence_ids,
        "best_relevance": round(best_relevance, 3) if best_relevance is not None else None,
        "judged_passages": judged,
        "covered_clauses": covered or [],
        "missing_clauses": missing or [],
        "conflict": conflict,
        # What a viewer should be told when there is nothing to say. Carried with
        # the verdict so every consumer says the same thing.
        "abstain_text": NO_EVIDENCE_TEXT if verdict == NOT_ENOUGH_EVIDENCE else None,
    }
