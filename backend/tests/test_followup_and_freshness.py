"""A question that leans on the one before it, and a document past its review date.

TURN TWO WAS RETRIEVED AS IF IT WERE TURN ONE
----------------------------------------------
Measured on the live corpus. Turn one — "Tỷ lệ giao đúng hẹn được tính như thế
nào?" — answered from the SLA policy. Then, asked the way people actually ask:

    "Còn trường hợp loại trừ thì sao?"  ANSWERABLE   ← Intelligence user guide
                                                       and the report overview
    "Thế còn cái đó thì sao?"           NOT_ENOUGH_EVIDENCE
    "Vậy ai chịu trách nhiệm?"          NOT_ENOUGH_EVIDENCE

The first is the worst: two documents with nothing to do with delivery cleared the
relevance floor, and the verdict said the evidence supported an answer.

Joining the previous question to EVERY turn was measured too, and it is the wrong
fix — "Doanh thu tháng này bao nhiêu?" gets dragged onto the delivery documents
and comes back ANSWERABLE. So the rule fires only on an opener that points at the
previous turn, and these tests pin both halves: that it fires, and that it does
not.

AND A POLICY PAST ITS REVIEW DATE SOUNDED EXACTLY LIKE A FRESH ONE
------------------------------------------------------------------
`review_date` is read at retrieval time and carried on the hit contract, and never
reached the evidence block the answering model reads.
"""
from __future__ import annotations

import datetime as dt
import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_followup.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.dashboard_ai_bot.govern_doc_context import _review_overdue, render
from app.services.dashboard_ai_bot.govern_doc_followup import (
    looks_relative,
    prior_user_question,
    resolve,
)

PRIOR = "Tỷ lệ giao đúng hẹn được tính như thế nào?"


# ── it fires on a question that cannot stand alone ────────────────────────────

def test_an_opener_that_points_backwards_is_a_follow_up():
    for q in ("Còn trường hợp loại trừ thì sao?",
              "Thế còn cái đó thì sao?",
              "Vậy ai chịu trách nhiệm?",
              "Ngoài ra còn gì nữa?"):
        assert looks_relative(q), q


def test_it_reads_the_question_without_diacritics_too():
    """A viewer typing "the con cai do thi sao" is asking the same thing, and the
    rest of this module folds for exactly that reason."""
    assert looks_relative("the con cai do thi sao")
    assert looks_relative("con truong hop loai tru thi sao")


def test_a_deictic_makes_a_question_relative_even_without_an_opener():
    assert looks_relative("Cái đó áp dụng từ bao giờ?")


def test_the_previous_question_is_placed_in_front_and_the_viewer_s_words_kept():
    """Kept, not replaced by a synthesised standalone sentence: the retriever
    fuses a vector rank with a keyword rank, and the viewer's own terms are what
    the keyword half matches on."""
    out, rewritten = resolve("Còn trường hợp loại trừ thì sao?", PRIOR)
    assert rewritten
    assert out.startswith(PRIOR)
    assert "trường hợp loại trừ" in out


# ── and does NOT fire on anything that stands alone ───────────────────────────

def test_a_new_subject_is_not_rewritten():
    """Measured: joined to the previous question, "Doanh thu tháng này bao nhiêu?"
    was dragged onto the delivery documents and still came back ANSWERABLE — a
    confident answer from the wrong corner of the corpus."""
    for q in ("Doanh thu tháng này bao nhiêu?",
              "GMV có gồm phí ship không?",
              "Tỷ lệ hoàn hàng là bao nhiêu?"):
        assert not looks_relative(q), q
        assert resolve(q, PRIOR) == (q, False)


def test_a_sentence_final_particle_is_not_an_opener():
    """"Vậy ai chịu trách nhiệm?" leans on the previous turn. "Ai chịu trách nhiệm
    về chất lượng dữ liệu vậy?" is a complete question with a particle at the end,
    and rewriting it would be rewriting something that already works."""
    q = "Ai chịu trách nhiệm về chất lượng dữ liệu vậy?"
    assert not looks_relative(q)


def test_a_long_question_carries_its_own_subject():
    long_q = "Còn " + " ".join(["chi tiết"] * 20) + " thì sao?"
    assert not looks_relative(long_q)


def test_the_same_question_twice_is_not_a_follow_up():
    """Doubling it would double every term's weight in the keyword rank."""
    assert resolve(PRIOR, PRIOR) == (PRIOR, False)


def test_turn_one_has_nothing_to_lean_on():
    assert resolve("Còn cái đó thì sao?", "") == ("Còn cái đó thì sao?", False)
    assert resolve("Còn cái đó thì sao?", None) == ("Còn cái đó thì sao?", False)


# ── whose question was it ─────────────────────────────────────────────────────

def test_the_previous_VIEWER_question_is_taken_not_the_assistant_s_reply():
    history = [
        {"role": "user", "content": PRIOR},
        {"role": "assistant", "content": "Tỷ lệ giao đúng hẹn là 91,2%."},
    ]
    assert prior_user_question(history) == PRIOR


def test_it_reads_envelope_turns_as_well_as_dicts():
    from app.services.agent_flows.envelope import Turn

    history = [Turn(role="user", content=PRIOR),
               Turn(role="assistant", content="…")]
    assert prior_user_question(history) == PRIOR


def test_an_empty_history_yields_nothing_rather_than_raising():
    assert prior_user_question([]) == ""
    assert prior_user_question(None) == ""


# ── a promise made and broken reaches the answer ──────────────────────────────

def test_a_scheduled_review_that_has_passed_is_overdue():
    assert _review_overdue(dt.date.today() - dt.timedelta(days=1)) is True
    assert _review_overdue("2020-01-01") is True


def test_a_review_still_ahead_is_not():
    assert _review_overdue(dt.date.today() + dt.timedelta(days=1)) is False


def test_no_review_date_is_no_broken_promise():
    """False rather than True: nobody said they would check this, so nothing was
    missed. Nine of ten published documents here have never been verified, and a
    warning on almost every answer is a warning nobody reads."""
    assert _review_overdue(None) is False
    assert _review_overdue("") is False
    assert _review_overdue("khong-phai-ngay") is False


def test_the_evidence_block_names_which_passage_is_stale():
    """On the source line, not as a footnote: a model composing one sentence from
    three passages has to know WHICH of them is the stale one."""
    block = render([
        {"n": 1, "title": "Chính sách SLA", "heading_path": "SLA",
         "text": "nội dung", "content": "nội dung",
         "review_overdue": True, "review_date": "2025-01-01"},
        {"n": 2, "title": "Vận hành", "heading_path": "Giao vận",
         "text": "nội dung 2", "content": "nội dung 2"},
    ])
    lines = [ln for ln in block.splitlines() if ln.startswith("[")]
    assert "QUÁ HẠN RÀ SOÁT" in lines[0]
    assert "2025-01-01" in lines[0]
    assert "QUÁ HẠN" not in lines[1]
