"""Asking again: when, in whose words, and what it costs."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_expansion.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.dashboard_ai_bot import govern_doc_expansion as exp


class _Vocab:
    """The two vocabularies, in the two shapes they are actually stored in:
    `govern_metrics.synonyms` is JSON, `glossary_terms.synonyms` is JSON text."""

    METRICS = [("gmv_tong_gia_tri_giao_dich", "GMV — Tổng giá trị giao dịch",
                ["GMV", "tổng giá trị giao dịch", "gross merchandise value"])]
    TERMS = [("don_giao_dung_hen", "Đơn giao đúng hẹn",
              '["giao đúng hẹn", "đúng hẹn", "on-time delivery", "OTD"]')]

    def execute(self, stmt, params=None):
        self._last = str(stmt)
        return self

    def fetchall(self):
        return self.METRICS if "govern_metrics" in self._last else self.TERMS


class _NoVocab:
    def execute(self, *a, **k):
        raise RuntimeError("no vocabulary tables here")


def rows(*texts):
    return [{"heading_path": "", "content": t, "section_content": ""} for t in texts]


# ── accent repair is decided per TERM, not per sentence ───────────────────────

def test_a_term_written_without_its_diacritics_gets_the_accented_form():
    """A marker heuristic was tried first — "does this sentence look like
    unaccented Vietnamese" from a list of function words — and it called
    "muc tieu don giao dung hen" accented, because a noun phrase carries none of
    them. Whether a term lost its diacritics is a property of the TERM."""
    out = exp.expand(_Vocab(), "muc tieu don giao dung hen", [])
    assert any(o["source"] == "accent" and "Đơn giao đúng hẹn" in o["query"]
               for o in out)


def test_a_different_word_is_not_labelled_an_accent_repair():
    """"OTD" → "Đơn giao đúng hẹn" is an abbreviation expanding, not diacritics
    being restored. The label decides what a trace tells a reader."""
    out = exp.expand(_Vocab(), "OTD la bao nhieu", [])
    assert all(o["source"] != "accent" for o in out)


def test_an_english_alias_expanding_to_vietnamese_is_not_an_accent_repair():
    out = exp.expand(_Vocab(), "gross merchandise value la gi", [])
    assert all(o["source"] != "accent" for o in out)


def test_an_accented_question_needs_no_accent_repair():
    out = exp.expand(_Vocab(), "Đơn giao đúng hẹn là gì?", [])
    assert all(o["source"] != "accent" for o in out)


# ── what it expands to ─────────────────────────────────────────────────────────

def test_an_abbreviation_expands_to_the_written_down_full_form():
    """"OTD" is recorded as "Đơn giao đúng hẹn". Nobody has to infer it."""
    out = exp.expand(_Vocab(), "OTD la bao nhieu", [])
    assert any("giao đúng hẹn" in o["query"] for o in out)


def test_an_english_alias_reaches_the_vietnamese_document():
    out = exp.expand(_Vocab(), "gross merchandise value la gi", [])
    assert any("giá trị giao dịch" in o["query"] for o in out)


def test_a_slug_is_expanded_as_words_not_as_a_slug():
    """`doanh_thu_thuan` embedded verbatim searches for the slug."""
    out = exp.expand(_Vocab(), "gmv tong gia tri giao dich", [])
    assert all("_" not in o["query"] for o in out)


def test_a_question_naming_no_known_term_expands_to_nothing():
    """"Chi phí thuê kho bãi" is a real business question this corpus cannot
    answer, and there is no vocabulary entry to rephrase it with. Inventing one
    would be guessing."""
    assert exp.expand(_Vocab(), "chi phi thue kho bai moi thang", []) == []


def test_the_wording_already_used_is_never_re_queried():
    """Re-embedding the phrase that just failed is a wasted pass."""
    out = exp.expand(_Vocab(), "on-time delivery la bao nhieu", [])
    assert all("on-time delivery" not in o["query"] for o in out)


def test_every_alternative_says_where_it_came_from():
    """A reader debugging a result cannot tell a direct hit from one reached
    through a KPI's alias unless the record says so."""
    for alternative in exp.expand(_Vocab(), "OTD la bao nhieu", []):
        assert alternative["source"] in ("metric", "glossary", "accent")
        assert alternative["why"]


# ── the guard that was backwards ───────────────────────────────────────────────

def test_strong_evidence_in_these_words_stops_the_expansion():
    out = exp.expand(_Vocab(), "OTD la bao nhieu",
                     rows("Đơn giao đúng hẹn đạt 92% trong tháng."),
                     evidence_is_weak=False)
    assert out == []


def test_weak_evidence_expands_even_when_the_phrase_appears():
    """THE bug this flag exists for. "OTD la bao nhieu" scored −5.20, far below the
    floor, and expansion was skipped because "giao đúng hẹn" appeared somewhere in
    those rejected results. A phrase surviving in evidence the reranker just threw
    out is not an answer."""
    out = exp.expand(_Vocab(), "OTD la bao nhieu",
                     rows("Đơn giao đúng hẹn đạt 92% trong tháng."),
                     evidence_is_weak=True)
    assert out, "phai mo rong khi bang chung yeu"


# ── bounds and failure ─────────────────────────────────────────────────────────

def test_the_number_of_extra_passes_is_bounded():
    """Each is a query embedding, a vector scan and a rerank."""
    out = exp.expand(_Vocab(), "OTD va GMV la gi", [])
    assert len(out) <= exp.MAX_EXPANSIONS


def test_a_missing_vocabulary_is_not_an_error():
    """A deployment with no glossary must still answer questions."""
    assert exp.expand(_NoVocab(), "OTD la bao nhieu", []) == []


def test_an_empty_question_expands_to_nothing():
    assert exp.expand(_Vocab(), "", []) == []


def test_a_two_letter_fragment_is_not_a_vocabulary_match():
    assert exp._MIN_TERM_CHARS >= 3


# ── the trigger, and what it replaced ──────────────────────────────────────────

def test_the_escalation_trigger_is_the_relevance_floor():
    """It escalated on `uncovered_clauses` — a rule that counts a clause covered
    when ANY of its terms appears ANYWHERE. Measured over all 56 eval cases it
    fired ZERO times: the feature existed and had never run."""
    import inspect

    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    source = inspect.getsource(gde.search_doc_chunks)
    assert "_EXPANSION_FLOOR" in source
    assert "ce_logit" in source


def test_the_trigger_floor_matches_the_answerability_floor():
    """Two constants for "retrieval found nothing about this" would drift, and then
    the system would expand on questions it was willing to answer."""
    from app.services.dashboard_ai_bot import govern_doc_answerability as ans
    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    assert gde._EXPANSION_FLOOR == ans.RELEVANCE_FLOOR


def test_a_multi_part_question_still_escalates_on_its_missing_half():
    """The floor cannot see that half a question went unanswered when the other
    half scored well, so clause coverage stays as a second, cheaper trigger."""
    import inspect

    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    assert "uncovered_clauses(question, rows)" in inspect.getsource(gde.search_doc_chunks)


# ── across phases ──────────────────────────────────────────────────────────────

def test_a_passage_records_the_alternative_that_reached_it():
    """Phase 1's contract carries provenance. An expansion hit that looks identical
    to a direct hit hides the mechanism that found it."""
    import inspect

    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    assert 'row["reached_via"] = alternative' in inspect.getsource(gde.search_doc_chunks)


def test_the_plan_reports_the_expansions_it_paid_for():
    import inspect

    from app.services.dashboard_ai_bot import govern_doc_embeddings as gde

    assert 'plan["expansions"]' in inspect.getsource(gde.search_doc_chunks)
