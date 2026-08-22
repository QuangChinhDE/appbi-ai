"""Answerability and conflict: the two verdicts that decide whether to answer."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_answerability.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from datetime import date, datetime, timedelta, timezone

from app.services.dashboard_ai_bot import govern_doc_answerability as ans
from app.services.dashboard_ai_bot import govern_doc_conflict as conf
from app.services.dashboard_ai_bot import doc_rerank


def row(ce, *, doc_id=1, chunk_id=None, content="Mục tiêu ≥ 92%.", title="Vận hành",
        heading="Vận hành > SLA", **kw):
    base = {
        "doc_id": doc_id, "chunk_id": chunk_id if chunk_id is not None else doc_id * 100,
        "content": content, "title": title, "heading_path": heading,
        "similarity": 0.5, "trust": "authored", "source_version": 1,
    }
    if ce is not None:
        base["ce_logit"] = ce
        base["ce_relevant"] = ce > 0
    base.update(kw)
    return base


# ── the verdict ────────────────────────────────────────────────────────────────

def test_a_clearly_relevant_passage_is_answerable():
    out = ans.evaluate(None, "Mục tiêu giao đúng hẹn?", [row(7.4)], check_clauses=False)
    assert out["verdict"] == ans.ANSWERABLE


def test_nothing_relevant_is_not_enough_evidence():
    """Measured: on 48 cases the cross-encoder separates answerable from
    unanswerable at 0.978 accuracy where cosine reaches 0.822."""
    out = ans.evaluate(None, "Cấu hình Kubernetes?", [row(-6.4)], check_clauses=False)
    assert out["verdict"] == ans.NOT_ENOUGH_EVIDENCE
    assert out["basis"] == "relevance"


def test_an_empty_result_is_reported_differently_from_an_irrelevant_one():
    """"NOT_ENOUGH_EVIDENCE" from a relevance floor and the same verdict from an
    empty result set need different responses — a caller that cannot tell them
    apart will report a retrieval outage as a gap in the documentation."""
    assert ans.evaluate(None, "q", [])["basis"] == "empty"


def test_the_floor_is_not_the_optimum_and_says_so():
    """−3.99 scores best on the tuning set and sits exactly at the lowest
    answerable case. The shipped floor keeps a margin instead."""
    assert ans.RELEVANCE_FLOOR < -3.99


def test_a_passage_just_above_the_floor_still_answers():
    out = ans.evaluate(None, "q", [row(ans.RELEVANCE_FLOOR + 0.1)], check_clauses=False)
    assert out["verdict"] == ans.ANSWERABLE


# ── never judge a candidate the model did not look at ──────────────────────────

def test_unscored_candidates_do_not_count_as_evidence():
    """A row beyond the candidate cap carries no `ce_logit`. Reading its absence as
    a low score is how an unscored candidate becomes a refusal — and reading it as
    ZERO, which was the first design, made `max()` return the sentinel: an
    answerability measurement read 0.0 as "the best this question could do" for 40
    of 48 cases."""
    out = ans.evaluate(None, "q", [row(-6.0), row(None, doc_id=2)], check_clauses=False)
    assert out["judged_passages"] == 1
    assert out["best_relevance"] == -6.0
    assert out["verdict"] == ans.NOT_ENOUGH_EVIDENCE


def test_no_semantic_judgement_at_all_does_not_refuse():
    """With no model installed there is no relevance signal, and inventing one from
    its absence would abstain on everything."""
    out = ans.evaluate(None, "q", [row(None)], check_clauses=False)
    assert out["verdict"] == ans.ANSWERABLE
    assert out["basis"] == "no_semantic_judgement"


# ── abstention wording ─────────────────────────────────────────────────────────

def test_the_abstain_wording_travels_with_the_verdict():
    """One wording, so every consumer says the same thing."""
    out = ans.evaluate(None, "q", [row(-9.0)], check_clauses=False)
    assert out["abstain_text"] == ans.NO_EVIDENCE_TEXT
    assert "nguồn tri thức được phép truy cập" in out["abstain_text"]


def test_an_answerable_verdict_carries_no_abstain_text():
    assert ans.evaluate(None, "q", [row(5.0)], check_clauses=False)["abstain_text"] is None


# ── conflict comes before answerability ────────────────────────────────────────

def test_a_conflict_outranks_an_otherwise_answerable_verdict():
    """An evaluator that says ANSWERABLE while two sources disagree has picked a
    side without saying so."""
    out = ans.evaluate(None, "q", [row(7.0)], check_clauses=False,
                       conflict={"conflict": True, "summary": "95 vs 88"})
    assert out["verdict"] == ans.CONTRADICTORY
    assert out["reason"] == "95 vs 88"


def test_a_conflict_record_that_found_nothing_is_ignored():
    out = ans.evaluate(None, "q", [row(7.0)], check_clauses=False,
                       conflict={"conflict": False, "reason": "the figures agree"})
    assert out["verdict"] == ans.ANSWERABLE


# ── numeric claims ─────────────────────────────────────────────────────────────

def test_a_figure_in_markdown_bold_is_still_a_figure():
    """`\\b` after `%` asserts the NEXT character is a word character, so "**95%**"
    — how every figure in this corpus is written — matched nothing at all. The
    detector found zero claims in a corpus full of them."""
    assert conf.claims("Mục tiêu là **95%**, áp dụng từ Quý III.") == [(95.0, "percent")]


def test_a_figure_at_the_end_of_a_sentence_is_still_a_figure():
    assert conf.claims("Ngưỡng hiện tại là 88%") == [(88.0, "percent")]


def test_vietnamese_thousands_are_not_read_as_decimals():
    """Guessing wrong turns 1.234 into 1.234 and invents a conflict."""
    assert conf.claims("doanh thu 1.234 tỷ") == [(1234.0, "billion")]


def test_a_decimal_comma_is_a_decimal():
    assert conf.claims("tỷ lệ 92,5%") == [(92.5, "percent")]


def test_the_same_quantity_written_two_ways_is_one_unit():
    """Comparing "95%" with "95 phần trăm" as different units would hide a real
    conflict behind a spelling difference."""
    assert conf.claims("95 phần trăm")[0][1] == conf.claims("95%")[0][1]


def test_a_bare_number_with_no_unit_is_not_a_claim():
    assert conf.claims("phiên bản 2 của tài liệu") == []


# ── conflict detection ─────────────────────────────────────────────────────────

QUESTION = "Ngưỡng tỷ lệ giao đúng hẹn là bao nhiêu?"


def test_two_documents_stating_different_percentages_conflict():
    out = conf.detect(QUESTION, [
        row(5.0, doc_id=87, title="SLA hiện hành",
            content="Ngưỡng tỷ lệ giao đúng hẹn là **95%**."),
        row(3.0, doc_id=88, title="Sổ tay cũ",
            content="Ngưỡng tỷ lệ giao đúng hẹn dùng ở đây là **88%**."),
    ])
    assert out["conflict"] is True
    assert out["unit"] == "percent"
    assert {v for side in out["sides"] for v in side["values"]} == {95.0, 88.0}


def test_two_documents_agreeing_do_not_conflict():
    out = conf.detect(QUESTION, [
        row(5.0, doc_id=1, content="Ngưỡng tỷ lệ giao đúng hẹn là **92%**."),
        row(4.0, doc_id=2, content="Ngưỡng tỷ lệ giao đúng hẹn cũng là **92%**."),
    ])
    assert out["conflict"] is False


def test_different_units_are_not_a_contradiction():
    """"95%" and "95 đơn" are different quantities that happen to share a number."""
    out = conf.detect(QUESTION, [
        row(5.0, doc_id=1, content="Ngưỡng tỷ lệ giao đúng hẹn là **95%**."),
        row(4.0, doc_id=2, content="Ngưỡng tỷ lệ giao đúng hẹn đo trên 88 đơn."),
    ])
    assert out["conflict"] is False


def test_only_relevant_passages_are_compared():
    """A passage that is not about the question can hold any number without
    disagreeing with anything."""
    out = conf.detect(QUESTION, [
        row(5.0, doc_id=1, content="Ngưỡng tỷ lệ giao đúng hẹn là **95%**."),
        row(-6.0, doc_id=2, content="Biên lợi nhuận gộp đạt **88%** trong quý."),
    ])
    assert out["conflict"] is False


def test_one_document_alone_cannot_contradict_itself():
    out = conf.detect(QUESTION, [
        row(5.0, doc_id=1, content="Ngưỡng tỷ lệ giao đúng hẹn là **95%**."),
        row(4.0, doc_id=1, chunk_id=2, content="Ngưỡng tỷ lệ giao đúng hẹn cũ là **88%**."),
    ])
    assert out["conflict"] is False


def test_a_passage_that_shares_nothing_with_the_question_is_not_compared():
    out = conf.detect(QUESTION, [
        row(5.0, doc_id=1, content="Ngưỡng tỷ lệ giao đúng hẹn là **95%**."),
        row(2.0, doc_id=2, heading="Khác", content="Chỉ tiêu **88%** cho mảng nội dung."),
    ])
    assert out["conflict"] is False


# ── resolution ─────────────────────────────────────────────────────────────────

def side(doc_id, title, **kw):
    base = {"doc_id": doc_id, "title": title, "values": [95.0],
            "last_verified_at": None, "review_date": None, "importance": None,
            "updated_at": None, "trust": "authored"}
    base.update(kw)
    return base


def test_with_no_governance_data_the_conflict_stays_unresolved():
    """A resolver that always produces a winner is a resolver that guesses. On this
    repo's fixtures every governance column is empty."""
    out = conf.resolve([side(87, "SLA hiện hành"), side(88, "Sổ tay cũ", values=[88.0])])
    assert out["resolution"] == conf.UNRESOLVED
    assert out["current_doc_id"] is None
    assert "Không đủ dữ liệu quản trị" in out["summary"]


def test_a_recent_verification_decides():
    out = conf.resolve([
        side(87, "SLA hiện hành", last_verified_at="2026-08-01"),
        side(88, "Sổ tay cũ", values=[88.0], last_verified_at="2024-01-01"),
    ])
    assert out["resolution"] == conf.RESOLVED
    assert out["current_doc_id"] == 87
    assert out["resolved_by"] == "last_verified_at"


def test_updated_at_is_never_allowed_to_decide():
    """It was, and the first real run resolved in favour of the document titled
    "Sổ tay vận hành kho (BẢN CŨ)" because its row happened to be written last.
    `updated_at` records that a row changed, not that a person stands behind it."""
    out = conf.resolve([
        side(87, "SLA hiện hành", updated_at="2020-01-01"),
        side(88, "Sổ tay cũ", values=[88.0], updated_at="2026-08-21"),
    ])
    assert out["resolution"] == conf.UNRESOLVED


def test_both_figures_are_reported_even_when_one_wins():
    """"The current figure is 95%" without "an older handbook says 88%" leaves the
    reader unable to recognise the other number when they meet it."""
    out = conf.resolve([
        side(87, "SLA hiện hành", last_verified_at="2026-08-01"),
        side(88, "Sổ tay cũ", values=[88.0], last_verified_at="2024-01-01"),
    ])
    assert "95" in out["summary"] and "88" in out["summary"]


def test_a_tie_on_every_signal_is_unresolved():
    out = conf.resolve([
        side(87, "A", last_verified_at="2026-08-01"),
        side(88, "B", values=[88.0], last_verified_at="2026-08-01"),
    ])
    assert out["resolution"] == conf.UNRESOLVED


def test_a_signal_only_one_side_has_cannot_decide():
    """Comparing a document that recorded a review date against one that did not
    would rank "somebody filled in a field" above "somebody did not"."""
    out = conf.resolve([
        side(87, "A", review_date="2027-01-01"),
        side(88, "B", values=[88.0]),
    ])
    assert out["resolution"] == conf.UNRESOLVED


# ── governance in ranking: measured, and deliberately limited ──────────────────

def test_ranking_uses_trust_and_nothing_else():
    """Verification recency was added here and MEASURED WORSE: exactly one document
    in the corpus has a verification date — the overview, which mentions every
    topic shallowly — and its +0.025 was enough to lift an overview passage above
    the specific document that answered. hit@1 0.806 → 0.774 over the same 34
    cases. Section 7 forbids precisely that, so the signal moved to conflict
    resolution and to the hit, where it decides something without reordering."""
    recent = datetime.now(timezone.utc) - timedelta(days=1)
    assert (doc_rerank.governance_score({"trust": "authored", "last_verified_at": recent})
            == doc_rerank.governance_score({"trust": "authored"}))
    assert (doc_rerank.governance_score({"trust": "authored", "importance": "high"})
            == doc_rerank.governance_score({"trust": "authored"}))


def test_a_crawled_page_ranks_below_an_authored_document():
    """The one governance signal that survived the measurement: a passage from a
    public web page is written by whoever controls that page."""
    assert (doc_rerank.governance_score({"trust": "external"})
            < doc_rerank.governance_score({"trust": "authored"}))


def test_governance_cannot_outrank_relevance():
    """THE constraint. The whole governance term spans 1.0 raw, ±0.05 after the
    weight — against a relevance term spanning several points and a metric-SSOT
    term worth 2.0."""
    best = doc_rerank.governance_score({"trust": "authored"})
    worst = doc_rerank.governance_score({"trust": "external"})
    span = (best - worst) * doc_rerank._W_GOVERNANCE
    assert span < 0.1, "governance span %.3f is large enough to reorder evidence" % span


def test_verification_still_decides_a_conflict():
    """Where the signal genuinely belongs: not "rank this higher" but "of these two
    documents that disagree, this is the one somebody stands behind"."""
    out = conf.resolve([
        side(87, "hien hanh", last_verified_at="2026-08-01"),
        side(88, "ban cu", values=[88.0], last_verified_at="2024-01-01"),
    ])
    assert out["current_doc_id"] == 87


def test_an_overdue_review_reaches_the_reader_without_reordering():
    """`review_overdue` travels on the hit so an answer can say the policy it just
    quoted is overdue — a fact for the reader, not a demotion."""
    from app.services.dashboard_ai_bot import knowledge_hit

    hit = knowledge_hit.from_chunk(
        {"content": "x", "review_date": date.today() - timedelta(days=1)})
    assert hit["review_overdue"] is True
