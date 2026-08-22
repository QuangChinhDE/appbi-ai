"""L2 re-ranking: the properties that must not silently change."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_doc_rerank.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.core.text_fold import fold_token_list, fold_tokens
from app.services.dashboard_ai_bot import doc_rerank


class _Db:
    """Corpus statistics stand-in. `fail` reproduces a database that cannot serve
    them, because ranking must degrade rather than take the search down with it."""

    def __init__(self, n=10, avg=100.0, df=None, fail=False):
        self.n, self.avg, self.df, self.fail = n, avg, df or {}, fail
        self._mode = None

    def execute(self, stmt, params=None):
        if self.fail:
            raise RuntimeError("statistics unavailable")
        self._mode = "df" if "unnest" in str(stmt) else "count"
        self._terms = (params or {}).get("terms") or []
        return self

    def first(self):
        return (self.n, self.avg)

    def fetchall(self):
        return [(t, self.df.get(t, 0)) for t in self._terms]


# ── the asymmetry that awarded zero to answers sitting in the passage ────────
def test_query_and_document_tokenise_identically():
    """A passage containing `delivered_customer_date`, "(BRL)" or "≥ 92%." must
    yield the tokens a person searches for. Splitting the document on whitespace
    produced "(brl)" and "92%.", which could never equal "brl" and "92" — and
    three questions whose answers were retrieved scored zero lexical evidence."""
    doc = fold_token_list("Đơn có ngày `delivered_customer_date`; **R$ (BRL)**; ≥ 92%.")
    for term in ("delivered", "customer", "date", "brl", "92"):
        assert term in doc, term
    assert fold_tokens("delivered_customer_date") <= set(doc)


def test_idf_is_never_negative_and_falls_with_frequency():
    """The `log(1 + ...)` form cannot go negative, which is the point of choosing
    it: the textbook `log((N-df+0.5)/(df+0.5))` turns negative once a term is in
    more than half the corpus, and a negative weight lets a passage score HIGHER
    by not containing a common word."""
    assert doc_rerank._idf(100, 100) == pytest.approx(0.005, abs=0.001)
    assert doc_rerank._idf(100, 1) > doc_rerank._idf(100, 50) > doc_rerank._idf(100, 100) > 0
    assert doc_rerank._idf(0, 0) == 0.0
    assert all(doc_rerank._idf(100, df) >= 0.0 for df in range(0, 101))


def test_absent_terms_score_no_coverage():
    stats = {"n_chunks": 10, "avg_len": 100.0, "df": {"kubernetes": 0, "ingress": 0}}
    bm25, coverage = doc_rerank.lexical_score(
        "Tỷ lệ giao đúng hẹn mục tiêu 92%.", ["kubernetes", "ingress"], stats)
    assert bm25 == 0.0 and coverage == 0.0


def test_present_terms_score_coverage_one():
    stats = {"n_chunks": 10, "avg_len": 40.0, "df": {"giao": 2, "hen": 1}}
    bm25, coverage = doc_rerank.lexical_score(
        "Tỷ lệ giao đúng hẹn mục tiêu 92%.", ["giao", "hen"], stats)
    assert bm25 > 0.0 and coverage == pytest.approx(1.0)


def test_diacritic_insensitive_match():
    """The reader types without diacritics; the document uses them."""
    stats = {"n_chunks": 10, "avg_len": 40.0, "df": {"dung": 1, "hen": 1}}
    _, coverage = doc_rerank.lexical_score("giao đúng hẹn", ["dung", "hen"], stats)
    assert coverage == pytest.approx(1.0)


# ── ordering ────────────────────────────────────────────────────────────────
def _rows():
    return [
        {"chunk_id": 1, "content": "Không liên quan gì cả.", "similarity": 0.9, "trust": "authored"},
        {"chunk_id": 2, "content": "Mục tiêu tỷ lệ giao đúng hẹn là 92%.", "similarity": 0.5, "trust": "authored"},
    ]


def test_lexical_evidence_can_outrank_higher_cosine():
    """The whole point of a second stage: the passage that actually contains the
    answer beats the one that merely sits nearby in vector space."""
    db = _Db(n=10, avg=40.0, df={"giao": 1, "hen": 1, "muc": 2, "tieu": 2})
    out = doc_rerank.score_candidates(
        db, "mục tiêu giao đúng hẹn", _rows(), sql_filter=" WHERE 1=1 ", params={})
    assert out[0]["chunk_id"] == 2


def test_external_content_loses_a_tie():
    """A crawled page and an authored document that match equally well are not
    equally trustworthy. Small on purpose — it breaks ties, it does not overrule
    evidence."""
    same = "Mục tiêu tỷ lệ giao đúng hẹn là 92%."
    rows = [
        {"chunk_id": 1, "content": same, "similarity": 0.5, "trust": "external"},
        {"chunk_id": 2, "content": same, "similarity": 0.5, "trust": "authored"},
    ]
    out = doc_rerank.score_candidates(
        _Db(df={"giao": 1}), "giao đúng hẹn", rows, sql_filter=" WHERE 1=1 ", params={})
    assert [r["chunk_id"] for r in out] == [2, 1]


def test_ties_break_deterministically():
    rows = [{"chunk_id": cid, "content": "x y z", "similarity": 0.5, "trust": "authored"}
            for cid in (9, 3, 7)]
    out = doc_rerank.score_candidates(
        _Db(), "khong khop gi", rows, sql_filter=" WHERE 1=1 ", params={})
    assert [r["chunk_id"] for r in out] == [3, 7, 9]


def test_statistics_failure_degrades_instead_of_raising():
    out = doc_rerank.score_candidates(
        _Db(fail=True), "mục tiêu", _rows(), sql_filter=" WHERE 1=1 ", params={})
    assert len(out) == 2
    assert all("rerank_score" in row for row in out)


def test_no_confidence_field_is_exposed():
    """Term coverage does NOT separate answerable from unanswerable questions
    (measured: best gap -0.612). Publishing it under a name like
    `answer_confidence` would hand callers a gate that does not work."""
    out = doc_rerank.score_candidates(
        _Db(df={"giao": 1}), "giao đúng hẹn", _rows(), sql_filter=" WHERE 1=1 ", params={})
    assert "answer_confidence" not in out[0]
    assert "term_coverage" in out[0]


def test_rerank_stage_is_unconditional():
    """One ranking behaviour. A flag here means every report of a bad result has
    to begin by establishing which path produced it."""
    import inspect

    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    src = inspect.getsource(gde._search_scoped_doc_chunks)
    assert "score_candidates(" in src
    assert src.index("candidate_ids") < src.index("score_candidates(")
