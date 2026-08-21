"""L2 re-ranking over hybrid candidates.

WHAT THIS IS FOR, MEASURED RATHER THAN ASSUMED
----------------------------------------------
On the 29-case baseline the first stage already reaches the right document every
time (recall@6 = 1.0) and the answer text is inside the retrieved passages every
time (phrase_hit = 1.0). Ranking headroom is small (hit@1 = 0.885). The one thing
that is actually broken is ABSTENTION: cosine similarity for answerable questions
ran as low as 0.183 while unanswerable ones reached 0.429, so the two populations
overlap and no cosine threshold can separate "we found it" from "it is not in the
knowledge base". Every unanswerable question therefore returns confident-looking
passages.

WHAT IT FIXED, AND WHAT IT TURNED OUT NOT TO FIX
------------------------------------------------
Ranking, measured on the 29-case set (agent scope, k=12):

    no reranker                          hit@1 0.885   MRR 0.931   recall@1 0.846
    this stage, 0.25 / 1.00 / 0.05       hit@1 0.962   MRR 0.981   recall@1 0.923

Abstention it did NOT fix, and the attempt is worth recording because the idea is
persuasive and wrong. The plan was to score each passage by the share of the
query's IDF weight it contains, on the theory that a question whose rare terms
appear nowhere must be unanswerable. Swept across weightings and both a
multiplicative and an additive combination, the answerable and unanswerable
populations never separated (best gap -0.612).

The reason is structural, not a tuning failure: term coverage measures how much of
the QUESTION appears in the passage, and question words are not answer words.
"AOV viết tắt của cái gì?" is answered perfectly by a passage containing none of
"viết", "tắt", "cái" — while "chính sách nghỉ phép" shares "ngày", "hàng", "năm",
"của" with half the corpus. Coverage therefore punishes verbose questions and
rewards unanswerable ones that happen to use common vocabulary.

Deciding whether a passage ANSWERS a question needs a model of that relation — a
cross-encoder, or the answering model itself reading the passages under an
instruction to abstain and cite. It is not obtainable from term statistics, so no
field here pretends to be a confidence gate. `term_coverage` is kept as a
diagnostic only.

NOT A NEURAL CROSS-ENCODER, AND THAT IS A DELIBERATE CHOICE
-----------------------------------------------------------
A cross-encoder (bge-reranker-v2-m3 and friends) would score relevance better.
It also means torch or onnxruntime in the image — hundreds of megabytes, a model
weight file to ship or download, and a first-use download is an egress path that
the per-document `external_processing` veto would then have to cover. The brief
was local and no new egress.

`score_candidates` is the seam: a cross-encoder drops in behind the same call and
the pipeline does not change. Until then this is lexical + governance evidence,
which is honest about what it is.
"""
from __future__ import annotations

import logging
import math

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.text_fold import fold_text, fold_token_list, fold_tokens

logger = logging.getLogger(__name__)

#: Okapi BM25 constants. 1.2 / 0.75 are the values the original TREC work settled
#: on and remain the default in Lucene; nothing here justifies inventing others.
_BM25_K1 = 1.2
_BM25_B = 0.75

#: How many query terms to price. A question with more distinct terms than this is
#: already unambiguous, and each extra term costs one indexed COUNT.
_MAX_QUERY_TERMS = 12

#: Above this many chunks in scope, corpus statistics are estimated instead of
#: counted. The count is one GIN lookup per term, which is cheap until it is not.
_IDF_EXACT_LIMIT = 200_000

#: Weights, swept against the eval set and re-swept after the scorer's input
#: changed from the body alone to heading path + body. Re-tuning was not optional:
#: the weights that were best on the old input scored hit@1 0.846 on the new one,
#: and 0.15 scores 0.885. A plain weighted sum of cosine and BM25 was measured too
#: and lost — see `score_candidates` for why the multiplication is not decoration.
#:
#: The sweep harness that produced these is gone: it monkeypatched a scorer
#: signature that has since grown, so it no longer ran, and a measurement script
#: that raises is worse than none. Re-derive with the same shape as
#: eval/experiment_cross_encoder.py if these ever need re-tuning.
_W_LEXICAL = 0.15
_W_SEMANTIC = 1.0
_W_GOVERNANCE = 0.05

#: Weight for "this document was DECLARED the definition of a metric the question
#: named". Its own term rather than a governance tie-breaker, because it is not a
#: heuristic about quality — it is a recorded fact about authority, and it has to
#: be able to outrank a passage that merely repeats the words. Folded into
#: `_W_GOVERNANCE` at 0.05 it contributed 0.3 and the glossary still won.
_W_METRIC_SSOT = 2.0


def corpus_stats(db: Session, sql_filter: str, params: dict, terms: list[str]) -> dict:
    """`{n_chunks, avg_len, df: {term: count}}` for the documents in scope.

    Document frequency is computed against the SAME scope the search ran in, not
    the whole table: a term that is rare overall can be ubiquitous inside one
    space, and it is the scope the reader is asking about.
    """
    stats = {"n_chunks": 0, "avg_len": 1.0, "df": {}}
    try:
        row = db.execute(
            text(
                f"""
                SELECT count(*), COALESCE(avg(length(c.content)), 1)
                FROM govern_doc_chunk c
                {sql_filter}
                """
            ),
            params,
        ).first()
        stats["n_chunks"] = int(row[0] or 0)
        stats["avg_len"] = max(1.0, float(row[1] or 1.0))
        if not terms or not stats["n_chunks"] or stats["n_chunks"] > _IDF_EXACT_LIMIT:
            return stats

        # One round trip, one indexed COUNT per term. The correlated subquery is
        # what lets the GIN index on to_tsvector(appbi_unaccent(content)) serve it.
        rows = db.execute(
            text(
                f"""
                SELECT t.term,
                       (SELECT count(*)
                          FROM govern_doc_chunk c
                          {sql_filter}
                            AND to_tsvector('simple', appbi_unaccent(c.content))
                                @@ plainto_tsquery('simple', appbi_unaccent(t.term)))
                FROM unnest(CAST(:terms AS text[])) AS t(term)
                """
            ),
            {**params, "terms": terms},
        ).fetchall()
        stats["df"] = {str(r[0]): int(r[1] or 0) for r in rows}
    except Exception:  # noqa: BLE001 — ranking must degrade, never fail the search
        logger.warning("doc_rerank: corpus statistics unavailable", exc_info=True)
    return stats


def query_terms(question: str) -> list[str]:
    """Distinct matchable terms, longest first so the cap keeps the specific ones.

    Length is a crude proxy for specificity, but it is the right crude proxy here:
    Vietnamese function words ("la", "gi", "cua") are short, and `simple` has no
    stopword dictionary to ask instead.
    """
    return sorted(fold_tokens(question), key=lambda t: (-len(t), t))[:_MAX_QUERY_TERMS]


def _idf(n_chunks: int, df: int) -> float:
    """BM25's probabilistic IDF in its non-negative form.

    The textbook `log((N - df + 0.5) / (df + 0.5))` turns NEGATIVE once a term
    appears in more than half the corpus, which would let a passage score higher
    by not containing a common word. The `log(1 + ...)` variant Lucene uses cannot,
    so the `max(0, ...)` below is belt-and-braces rather than the mechanism.
    """
    if n_chunks <= 0:
        return 0.0
    return max(0.0, math.log(1.0 + (n_chunks - df + 0.5) / (df + 0.5)))


def lexical_score(content: str, terms: list[str], stats: dict) -> tuple[float, float]:
    """`(bm25, covered_idf_fraction)` for one passage.

    The second value is the share of the query's total term WEIGHT this passage
    contains, bounded 0..1. A DIAGNOSTIC, not a gate — see the module docstring
    for why it cannot decide whether a question is answerable.
    """
    if not terms:
        return 0.0, 0.0
    # SAME tokeniser as the query. See fold_token_list: splitting the document on
    # whitespace instead produced tokens like "(brl)" and "92%." that could never
    # equal the query's "brl" and "92", and the substring fallback that used to
    # paper over it also matched "nghi" inside "nghia" — inflating confidence for
    # questions the corpus cannot answer.
    tokens = fold_token_list(content)
    doc_len = max(1, len(tokens))
    counts: dict[str, int] = {}
    for token in tokens:
        counts[token] = counts.get(token, 0) + 1

    n_chunks = int(stats.get("n_chunks") or 0)
    df_map = stats.get("df") or {}
    total_weight = 0.0
    covered_weight = 0.0
    bm25 = 0.0
    for term in terms:
        weight = _idf(n_chunks, int(df_map.get(term, 0)))
        total_weight += weight
        tf = counts.get(term, 0)
        if not tf:
            continue
        covered_weight += weight
        denominator = tf + _BM25_K1 * (
            1 - _BM25_B + _BM25_B * doc_len / max(1.0, float(stats.get("avg_len") or 1.0))
        )
        bm25 += weight * (tf * (_BM25_K1 + 1)) / max(1e-9, denominator)
    coverage = (covered_weight / total_weight) if total_weight > 0 else 0.0
    return bm25, coverage


def governance_score(row: dict) -> float:
    """Small preference for the passage a reader should trust.

    Two documents can both answer a question and disagree; two can both match and
    one be a crawled web page. Ranking is where that gets decided, because the
    reranker will otherwise pick on wording alone. Kept deliberately small — this
    breaks ties, it does not overrule evidence.
    """
    score = 0.0
    if (row.get("trust") or "authored") in ("authored", "uploaded"):
        score += 0.5
    if row.get("trust") == "external":
        score -= 0.5
    return score


def score_candidates(db: Session, question: str, rows: list[dict], *,
                     sql_filter: str, params: dict,
                     metric_home_docs: set[int] | None = None,
                     gate_question: str | None = None) -> list[dict]:
    """Attach `rerank_score` to each candidate and return them best first.

    The score is cosine similarity AMPLIFIED BY lexical evidence, plus a small
    lexical term of its own. The multiplication is not decoration: of the
    combinations swept, it was the only one that beat the no-reranker baseline,
    and it has a reading — a passage whose rare terms match the question deserves
    to have its semantic similarity taken more seriously than one that merely sits
    nearby in vector space. A plain weighted sum of the two scored strictly worse
    (hit@1 0.846 at best) because it lets a high cosine outvote the absence of
    every query term.
    """
    if not rows:
        return []
    terms = query_terms(question)
    stats = corpus_stats(db, sql_filter, params, terms)

    scored: list[dict] = []
    for row in rows:
        # Score the text that was EMBEDDED, which includes the heading path.
        # Scoring the body alone gave zero lexical evidence to the passage whose
        # HEADING answered the question: "Điểm đánh giá trung bình" is the heading,
        # and the body under it reads "— thang 1–5, mục tiêu ≥ 4.2" with none of
        # the question's words in it. The chunk holding the answer ranked below its
        # own siblings and fell out of the window.
        scoring_text = "\n".join(
            part for part in [row.get("heading_path"), row.get("content")] if part
        )
        bm25, coverage = lexical_score(scoring_text, terms, stats)
        semantic = float(row.get("similarity") or 0.0)
        out = dict(row)
        out["bm25"] = round(bm25, 4)
        out["term_coverage"] = round(coverage, 4)
        # Semantic similarity still contributes: a paraphrase with no shared
        # wording is exactly what embeddings are for, and dropping it would
        # trade one blind spot for another.
        out["rerank_score"] = round(
            _W_LEXICAL * bm25
            + _W_SEMANTIC * semantic * max(1.0, bm25)
            + _W_GOVERNANCE * governance_score(row)
            + (_W_METRIC_SSOT if (metric_home_docs and row.get("doc_id") in metric_home_docs) else 0.0),
            4,
        )
        scored.append(out)

    scored.sort(key=lambda r: (-r["rerank_score"], r["chunk_id"]))
    # The gate runs HERE, on the full candidate pool, because that is where it
    # earns its cost: it can lift a passage the base score ranked tenth. Measured
    # both ways — moving it after the pool was cut to k lost hit@1 0.806 → 0.774,
    # since by then there is nothing left to lift.
    #
    # But it judges `gate_question`, the question the USER asked, not `question`,
    # which on an expanded search is a clause or a glossary variant. The merge
    # keeps the higher `rerank_score` across passes, so without this a passage the
    # gate approved for the variant "doanh thu ròng" outranked one approved for
    # what was actually asked.
    scored = _apply_relevance_gate(gate_question or question, scored)
    return _diversify(scored)


#: What a positive cross-encoder verdict is worth. Large enough that a relevant
#: passage always outranks an irrelevant one, and applied UNIFORMLY so ordering
#: inside each band is still decided by the score above.
_W_CE_GATE = 2.0


def _apply_relevance_gate(question: str, scored: list[dict]) -> list[dict]:
    """Let the cross-encoder say WHETHER each candidate is relevant, nothing more.

    Called ONCE per question, on the final candidate set, by `search_doc_chunks`.
    It used to run inside `score_candidates`, which is per RETRIEVAL PASS — and a
    multi-part or glossary-expanded question runs several. That was wrong twice
    over. It tripled the cost (three forward passes over the same pool, measured
    at 2.2s for one question), and the merge keeps the HIGHER `rerank_score` across
    passes, so a passage the gate approved while answering a glossary VARIANT
    outranked one approved for the question the user actually asked. A relevance
    verdict is a property of the question and the final candidates, not of
    whichever pass happened to surface a row.

    Its magnitude is deliberately discarded. Measured over 34 questions, using the
    raw logit as the ranking collapsed recall@6 from 1.0 to 0.742: the model emits
    roughly ±8, so its own ordering is nearly binary and cannot choose between two
    relevant passages — which is the judgement that decides whether the sentence
    holding the answer makes the window. Using only the SIGN raised hit@1 from
    0.742 to 0.839 and MRR from 0.860 to 0.906 with phrase_hit unchanged. See
    eval/experiment_cross_encoder.py for all five arms.

    Silent no-op when the model is absent, and — by construction — when it cannot
    discriminate: if every candidate scores the same side of zero, every candidate
    gets the same constant and the order is untouched.
    """
    if len(scored) < 2:
        return scored
    from app.services.dashboard_ai_bot import doc_rerank_semantic

    verdicts = doc_rerank_semantic.score_pairs(question, scored)
    if verdicts is None:
        return scored
    for row, logit in zip(scored, verdicts):
        row["ce_logit"] = round(float(logit), 3)
        row["ce_relevant"] = bool(logit > 0)
        if logit > 0:
            row["rerank_score"] = round(row["rerank_score"] + _W_CE_GATE, 4)
    scored.sort(key=lambda r: (-r["rerank_score"], r["chunk_id"]))
    return scored


# NO VERDICT CACHE, DELIBERATELY.
#
# An expanded search gates an overlapping pool two or three times against the same
# question, so memoising the verdict looks free: measured, it took a three-pass
# question from 3.8s to 2.3s while a one-pass question stayed at ~1.2s. It was
# tried and removed.
#
# The cache has to be keyed on the model's real input — (question, passage) — or a
# hit can return a verdict about different text; chunk id is not that key, because
# a re-index reuses ids. Keyed correctly it then collapses two candidates with
# identical text into one entry, which is right, and it makes the ranking depend on
# what the process scored earlier, which is how two of its three revisions were
# wrong. A stateful cache that keeps producing subtle bugs is not worth 1.5s on a
# minority query shape; the extra passes only run when the first genuinely missed
# something, and that is a real second search, not an avoidable one.


#: At most this many chunks from one document in the returned window.
#:
#: Chunks got smaller when the chunker became structure-aware, and a document with
#: many small sections started taking most of the window: a question spanning two
#: documents ("list the operations and experience targets") stopped seeing the
#: second one. Measured on the 29-case set — see eval/experiment_diversity.py.
_MAX_PER_DOC = 2


def _diversify(scored: list[dict]) -> list[dict]:
    """Reorder so no single document monopolises the window.

    Not a filter — nothing is dropped. Chunks beyond a document's quota are moved
    BEHIND the first pass, so a caller taking the top k sees more documents while
    a caller taking everything still gets everything, in a sensible order.
    """
    if len(scored) <= _MAX_PER_DOC:
        return scored
    kept: list[dict] = []
    overflow: list[dict] = []
    seen: dict[int, int] = {}
    for row in scored:
        doc_id = row.get("doc_id")
        count = seen.get(doc_id, 0)
        if count < _MAX_PER_DOC:
            seen[doc_id] = count + 1
            kept.append(row)
        else:
            overflow.append(row)
    return kept + overflow
