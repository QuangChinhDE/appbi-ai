"""The cross-encoder gate: what it decides, and what it must never decide."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_rerank_semantic.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.dashboard_ai_bot import doc_rerank, doc_rerank_semantic


def row(chunk_id, score, doc_id=1, **kw):
    base = {"chunk_id": chunk_id, "rerank_score": score, "doc_id": doc_id,
            "heading_path": "Mục", "content": "Nội dung", "similarity": 0.5}
    base.update(kw)
    return base


# ── the gate uses the SIGN and discards the magnitude ──────────────────────────

def test_a_relevant_candidate_is_lifted_above_an_irrelevant_one(monkeypatch):
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs",
                        lambda q, rows: [-6.0, 4.0])
    out = doc_rerank._apply_relevance_gate("câu hỏi", [row(1, 1.0), row(2, 0.2)])
    assert [r["chunk_id"] for r in out] == [2, 1]


def test_the_magnitude_never_reorders_within_the_relevant_band(monkeypatch):
    """The model emits roughly ±8, so its own ordering is nearly binary. Using it
    as a ranking collapsed recall@6 from 1.0 to 0.742 — it cannot choose between
    two relevant passages, and that choice decides whether the sentence holding
    the answer makes the window."""
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs",
                        lambda q, rows: [0.1, 9.0])
    out = doc_rerank._apply_relevance_gate("câu hỏi", [row(1, 1.0), row(2, 0.9)])
    # Both relevant → both lifted by the same constant → the original order holds,
    # even though the second scored ninety times higher.
    assert [r["chunk_id"] for r in out] == [1, 2]


def test_all_relevant_leaves_the_order_exactly_as_it_was(monkeypatch):
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs",
                        lambda q, rows: [3.0, 3.0, 3.0])
    rows = [row(1, 1.0), row(2, 0.8), row(3, 0.6)]
    out = doc_rerank._apply_relevance_gate("q", rows)
    assert [r["chunk_id"] for r in out] == [1, 2, 3]


def test_all_irrelevant_leaves_the_order_exactly_as_it_was(monkeypatch):
    """It only intervenes where it can discriminate. A question the model rejects
    entirely must fall back to the retriever's judgement, not to nothing."""
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs",
                        lambda q, rows: [-3.0, -5.0, -1.0])
    rows = [row(1, 1.0), row(2, 0.8), row(3, 0.6)]
    out = doc_rerank._apply_relevance_gate("q", rows)
    assert [r["chunk_id"] for r in out] == [1, 2, 3]


def test_the_verdict_is_recorded_on_the_row(monkeypatch):
    """A reranker whose decision cannot be inspected is one nobody can debug."""
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs",
                        lambda q, rows: [2.5, -2.5])
    out = doc_rerank._apply_relevance_gate("q", [row(1, 1.0), row(2, 0.9)])
    by_id = {r["chunk_id"]: r for r in out}
    assert by_id[1]["ce_relevant"] is True and by_id[1]["ce_logit"] == 2.5
    assert by_id[2]["ce_relevant"] is False


# ── absence is a supported state, not a failure ────────────────────────────────

def test_a_missing_model_changes_nothing(monkeypatch):
    """The lexical reranker is a complete implementation, not a fallback stub. An
    absent model must be a no-op, and a silently reordered result would be worse
    than an error."""
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs", lambda q, rows: None)
    rows = [row(1, 1.0), row(2, 2.0)]
    out = doc_rerank._apply_relevance_gate("q", rows)
    assert [r["chunk_id"] for r in out] == [1, 2]
    assert "ce_logit" not in out[0]


def test_a_single_candidate_is_not_worth_a_forward_pass(monkeypatch):
    called = []
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs",
                        lambda q, rows: called.append(1) or [1.0])
    doc_rerank._apply_relevance_gate("q", [row(1, 1.0)])
    assert called == []


def test_score_pairs_without_a_model_returns_none_not_zeros(monkeypatch):
    """None and all-zeros are different: the first is a deployment problem, the
    second is the model's answer, and a caller has to tell them apart."""
    monkeypatch.setattr(doc_rerank_semantic, "MODEL_DIR", "/nonexistent/path")
    monkeypatch.setattr(doc_rerank_semantic, "_session", None)
    assert doc_rerank_semantic.score_pairs("q", [row(1, 1.0)]) is None


def test_an_empty_question_scores_nothing():
    assert doc_rerank_semantic.score_pairs("", [row(1, 1.0)]) is None


def test_no_candidates_scores_nothing():
    assert doc_rerank_semantic.score_pairs("câu hỏi", []) is None


# ── what the model reads ───────────────────────────────────────────────────────

def test_the_passage_includes_the_heading_path():
    """It is part of what was EMBEDDED. Scoring a different string from the one
    retrieval matched was a real bug in the lexical version, where the chunk whose
    HEADING answered the question scored zero."""
    text = doc_rerank_semantic._passage(
        {"heading_path": "Vận hành > SLA", "content": "Mục tiêu ≥ 92%."}
    )
    assert "Vận hành > SLA" in text and "92%" in text


def test_candidates_are_bounded():
    """Gating deeper into the pool measured WORSE than gating the shortlist:
    a +2.0 constant on a passage ranked twentieth overtakes a correct first."""
    assert doc_rerank_semantic.MAX_CANDIDATES == 12


# ── which question the gate judges ─────────────────────────────────────────────

def test_the_gate_judges_the_users_question_not_the_expanded_clause(monkeypatch):
    """An expanded search retrieves for a clause or a glossary variant, and the
    merge keeps the higher score across passes — so without this a passage the gate
    approved for the variant "doanh thu ròng" outranked one approved for what was
    actually asked."""
    seen = []
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs",
                        lambda q, rows: seen.append(q) or [1.0] * len(rows))
    monkeypatch.setattr(doc_rerank, "corpus_stats", lambda *a, **k: {})
    monkeypatch.setattr(doc_rerank, "lexical_score", lambda *a, **k: (0.0, 0.0))
    doc_rerank.score_candidates(
        None, "doanh thu ròng", [row(1, 1.0), row(2, 0.5)],
        sql_filter="", params={}, gate_question="net revenue tính thế nào",
    )
    assert seen == ["net revenue tính thế nào"]


def test_without_an_expansion_the_gate_judges_the_question_itself(monkeypatch):
    seen = []
    monkeypatch.setattr(doc_rerank_semantic, "score_pairs",
                        lambda q, rows: seen.append(q) or [1.0] * len(rows))
    monkeypatch.setattr(doc_rerank, "corpus_stats", lambda *a, **k: {})
    monkeypatch.setattr(doc_rerank, "lexical_score", lambda *a, **k: (0.0, 0.0))
    doc_rerank.score_candidates(
        None, "câu hỏi gốc", [row(1, 1.0), row(2, 0.5)], sql_filter="", params={},
    )
    assert seen == ["câu hỏi gốc"]


def test_the_gate_sees_the_whole_pool_not_the_trimmed_window():
    """Its value is lifting a passage the base score ranked tenth. Applied after
    the pool was cut to k it lost hit@1 0.806 -> 0.774, because by then there is
    nothing left to lift — so it must stay inside the reranker."""
    import inspect

    source = inspect.getsource(doc_rerank.score_candidates)
    assert "_apply_relevance_gate(gate_question or question, scored)" in source
    assert source.index("_apply_relevance_gate") < source.index("_diversify(scored)")


# ── the real model, when it is installed ───────────────────────────────────────

MODEL_PRESENT = doc_rerank_semantic.available()


@pytest.mark.skipif(not MODEL_PRESENT, reason="reranker model not fetched")
def test_the_real_model_prefers_the_passage_that_answers_the_question():
    scores = doc_rerank_semantic.score_pairs(
        "tỷ lệ giao đúng hẹn mục tiêu bao nhiêu",
        [{"heading_path": "Vận hành > Cam kết giao đúng hẹn",
          "content": "Mục tiêu tỷ lệ đơn giao đúng hẹn là từ 92% trở lên."},
         {"heading_path": "Marketing > Kênh",
          "content": "Chi phí thu hút khách hàng được phân bổ theo kênh."}],
    )
    assert scores[0] > 0 > scores[1]


@pytest.mark.skipif(not MODEL_PRESENT, reason="reranker model not fetched")
def test_the_real_model_crosses_languages():
    """An English question against a Vietnamese corpus is the case a lexical
    reranker cannot help with at all."""
    scores = doc_rerank_semantic.score_pairs(
        "on-time delivery target",
        [{"heading_path": "Vận hành > Cam kết giao đúng hẹn",
          "content": "Mục tiêu tỷ lệ đơn giao đúng hẹn là từ 92% trở lên."},
         {"heading_path": "Doanh thu > Doanh thu thuần",
          "content": "Doanh thu thuần là tổng giá trị hàng hoá trừ hoàn tiền."}],
    )
    assert scores[0] > scores[1]


@pytest.mark.skipif(not MODEL_PRESENT, reason="reranker model not fetched")
def test_scores_line_up_with_their_rows_after_length_batching():
    """Batches are grouped by passage length to cut padding cost. A reranker that
    returned scores against the wrong rows would be worse than no reranker."""
    rows = [
        {"heading_path": "A", "content": "x"},
        {"heading_path": "Vận hành > Cam kết giao đúng hẹn",
         "content": "Mục tiêu tỷ lệ đơn giao đúng hẹn là từ 92% trở lên, đo theo tháng "
                    "và báo cáo trong cuộc họp vận hành đầu tháng sau."},
        {"heading_path": "B", "content": "y"},
    ]
    scores = doc_rerank_semantic.score_pairs("mục tiêu giao đúng hẹn", rows)
    assert scores[1] == max(scores), "the answering passage did not get its score"
