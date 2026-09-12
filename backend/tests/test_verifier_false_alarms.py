"""Two false alarms on CORRECT answers, and why they were worth fixing.

The figure check is the last thing standing between a model's arithmetic and a
reader who will act on it. Its whole value is that it means something — and a
warning that fires on right answers stops meaning anything, because people learn
to scroll past it, including the time it is catching a figure that really was
invented. So a false alarm is not the small half of this trade.

Both were found by reading a correct answer in the product:

    "Điểm đánh giá trung bình hiện là 4.086. Số liệu này được lấy từ biểu đồ
     "Olist · Điểm đánh giá TB · page-1" trong báo cáo phân tích."

Measured against evidence holding 4.0864, that answer produced claims of
[4086.0, 1.0] and flagged both. Neither is a claim the answer makes.
"""
from __future__ import annotations

import pytest

from app.services.dashboard_ai_bot.verifier import (
    extract_answer_numbers,
    verify_answer,
)


# ── the two false alarms ────────────────────────────────────────────────────


def test_a_rounded_figure_is_not_a_fabricated_one():
    """`4.086` reads as 4086 in Vietnamese and 4.086 in English.

    `parse_number` picks the Vietnamese reading on purpose — reading a
    thousands-grouped figure as a decimal understates it 1000×, which is the worse
    mistake when the job is to READ a number. Verification has the opposite
    asymmetry, so it accepts either reading and only flags a figure that matches
    under neither.
    """
    assert verify_answer("Điểm đánh giá trung bình là 4.086.", [4.0864]).unmatched == []


def test_a_digit_inside_a_quoted_report_name_is_not_a_claim():
    """Answers cite their source by name, and report names carry digits.

    "page-1" became a claim of 1, matched nothing, and labelled a correct answer
    unverified. The strip list already held this principle for `[chart:12]` and
    inline code — a citation carries ids and labels, never claims.
    """
    answer = 'Lấy từ biểu đồ "Olist · Điểm đánh giá TB · page-1".'

    assert extract_answer_numbers(answer) == []
    assert verify_answer(answer, [4.0864]).unmatched == []


# ── and the check still does its job ────────────────────────────────────────


def test_the_invented_total_is_still_caught():
    """The case recorded in the executor: a run reported 13.59M against data
    summing to 8.56M — every component right, the aggregate invented. Nothing
    above may make that pass."""
    out = verify_answer(
        "Tổng doanh thu là 13.591.643,70 trên các danh mục.",
        [1258681.34, 1205005.68, 8560000.0],
    )

    assert out.unmatched, "a fabricated total must still be reported"


def test_a_quoted_figure_is_still_checked():
    """The strip rule requires a LETTER inside the quotes, so quoting a number
    cannot be used to smuggle one past the check. Models quote names; they do not
    quote numbers, and a rule that trusted every quoted span would invite the one
    thing this verifier exists to catch."""
    out = verify_answer('Con số là "9999999".', [1258681.34])

    assert out.unmatched == [9999999.0]


def test_a_figure_matching_neither_reading_is_reported():
    """The alternate reading widens the check by exactly one ambiguity, not into a
    general tolerance. 5.500 is 5500 or 5.5; evidence holds neither."""
    out = verify_answer("Kết quả là 5.500.", [4.0864, 91.9])

    assert out.unmatched


@pytest.mark.parametrize("answer,evidence", [
    ("Doanh thu 1.258.681,34.", [1258681.34]),          # exact, vi-VN formatting
    ("Tỷ lệ 91,9%.", [91.9]),                            # percent
    ("GMV 15,8 triệu.", [15_800_000.0]),                 # scale word
])
def test_ordinary_correct_answers_stay_quiet(answer, evidence):
    """Regression net: the formats the product actually produces must not start
    warning because of the two changes above."""
    assert verify_answer(answer, evidence).unmatched == []
