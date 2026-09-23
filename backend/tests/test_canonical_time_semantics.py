# -*- coding: utf-8 -*-
"""One question, one answer: does this column NAME name a time axis?

WHY A CORPUS AND NOT A UNIT TEST PER HELPER.

Four implementations answered this, and each was individually "correct" against
its own author's examples. What they were not was the SAME, and nothing measured
them together:

    packs/_timefield.TIME_NAME_RX              segment-edge regex, 18 tokens
    coverage._DATE_NAME                        alias of the above
    project_ahead._DATE_NAME                   alias of the above
    advanced_tools._looks_like_datetime        substring `in`, 10 tokens
    insight_pack._looks_like_datetime_name     substring `in`, 8 tokens

Measured against one corpus they disagree in both directions:

    created_at     canonical=TIME   advanced_tools=-      (no `at` token)
    holiday_flag   canonical=-      advanced_tools=TIME   (`day` inside `holiday`)
    tuan / quy     canonical=-      advanced_tools=TIME   (tokens only it carried)
    ky_bao_cao     canonical=TIME   advanced_tools=-      (no `ky` token)

`compare_periods`, `analyze_trend`, forecast and seasonality all gate on
`advanced_tools`; `coverage` and `project_ahead` gate on the canonical one. Two
tools asked the same question about the same column and got opposite answers.

WHAT THIS FILE PINS. That every implementation returns the same verdict for every
name in the corpus, and that the verdicts themselves are the intended ones. The
agreement assertion is the one that matters over time: a fifth helper, or a token
added to one list and not the others, fails here rather than in a report.

WHAT IT DELIBERATELY DOES NOT PIN. Value-level validation. A name is a hint; the
tools that need certainty parse the VALUES and are strictly stronger. `coverage`
finds a date column named `key` that way, and nothing here should tempt anyone to
replace that with a name regex.
"""
from __future__ import annotations

import pytest

from app.services.time_semantics import looks_like_time_name

#: (name, is_time, why) — the `why` is for the failure message, which is read far
#: more often than this list.
CORPUS: tuple[tuple[str, bool, str], ...] = (
    # ── the substring traps ────────────────────────────────────────────────
    ("product_category_name_english", False, "`nam` lives inside `name`"),
    ("product_name_lenght", False, "`nam` inside `name`, misspelling and all"),
    ("name", False, "the bare word"),
    ("username", False, "`nam` inside `username`"),
    ("holiday_flag", False, "`day` inside `holiday`"),
    ("payday_amount", False, "`day` inside `payday`"),
    ("monday_sales", False, "`day` inside `monday` — a weekday label, not an axis"),
    ("quy_mo_doanh_nghiep", False, "AMBIGUOUS: `quy mo` is a size — values must decide"),
    # ── English time names ─────────────────────────────────────────────────
    ("created_at", True, "`at` — the one advanced_tools never learned"),
    ("updated_at", True, "same"),
    ("order_date", True, "plain"),
    ("event_timestamp", True, "plain"),
    ("year_month", True, "two tokens, either would do"),
    ("order_day", True, "`day` at a segment edge is a real axis"),
    ("fiscal_quarter", True, "plain"),
    ("iso_week", True, "plain"),
    ("dt", True, "warehouse shorthand"),
    ("reporting_period", True, "plain"),
    # ── Vietnamese, with and without diacritics ────────────────────────────
    ("ngay_tao", True, "loaders strip diacritics"),
    ("ngày_tạo", True, "authors do not"),
    ("thang_ban_hang", True, "month"),
    ("tháng", True, "month, with diacritics"),
    ("nam_tai_chinh", True, "year as a leading segment"),
    ("tuan", True, "week — a token only advanced_tools carried"),
    ("tuần", True, "week, with diacritics"),
    ("quy", False, "AMBIGUOUS without diacritics: `quý` quarter or `quy` rule"),
    ("quý", True, "STRONG: the diacritics settle it"),
    # ── AMBIGUOUS: the name suggests, the VALUES decide ────────────────────
    # Session 1 pinned these True on the strength of a segment token, which
    # let `analyze_trend` run time-series maths over ['engineering', 'sales'].
    # `looks_like_time_name` is now STRONG-only; these names are not rejected,
    # they are referred to their values. See
    # `test_time_axis_needs_more_than_a_name.py`, which locks that behaviour.
    ("ky_bao_cao", False, "AMBIGUOUS: a real axis, but only its VALUES can say so"),
    ("ky_thuat", False, "AMBIGUOUS: `kỹ thuật` is engineering — the bug this closed"),
    ("quy_dinh", False, "AMBIGUOUS: `quy định` is a regulation"),
    # ── non-time ───────────────────────────────────────────────────────────
    ("customer_state", False, "a dimension"),
    ("product_category", False, "a dimension"),
    ("revenue", False, "a measure"),
    ("kythuat", False, "no separator: the token is inside a word"),
)


@pytest.mark.parametrize("name,expected,why", CORPUS)
def test_the_canonical_answer_is_the_intended_one(name, expected, why):
    got = looks_like_time_name(name)
    assert got is expected, f"{name!r}: expected time={expected} ({why}), got {got}"


def _all_implementations():
    """Every function in the repository that answers the NAME question.

    Imported lazily and by name so that adding a fifth one is a deliberate edit
    here rather than something this file silently fails to cover.
    """
    from app.services.dashboard_ai_bot.insight_pack import _looks_like_datetime_name
    from app.services.dashboard_ai_bot.thinking.advanced_tools import _looks_like_datetime
    from app.services.time_semantics import looks_like_time_name

    return {
        "time_semantics.looks_like_time_name": looks_like_time_name,
        "advanced_tools._looks_like_datetime": _looks_like_datetime,
        "insight_pack._looks_like_datetime_name": _looks_like_datetime_name,
    }


@pytest.mark.parametrize("name,expected,why", CORPUS)
def test_every_implementation_agrees_on_every_name(name, expected, why):
    """The anti-drift assertion.

    `compare_periods` must not accept a column that `coverage` calls categorical,
    and `detect_seasonality` must not refuse one that `project_ahead` reads as an
    axis. They ask the same question; they must give the same answer.
    """
    verdicts = {label: bool(fn(name)) for label, fn in _all_implementations().items()}
    disagreeing = {k: v for k, v in verdicts.items() if v is not expected}
    assert not disagreeing, (
        f"{name!r} ({why}) — expected {expected}, but "
        + ", ".join(f"{k}={v}" for k, v in sorted(disagreeing.items()))
    )


def test_the_packs_use_the_canonical_objects_and_the_right_tier():
    """Neither pack may re-implement the rule, and each must pick its own tier.

    `coverage` scores candidates and then PARSES their values, so it may consider
    an ambiguous name. `project_ahead` projects, so its name hint is strong-only
    and an ambiguous axis has to be proven from the labels.
    """
    from app.services.agent_flows.tools.packs.coverage import _DATE_NAME as cov
    from app.services.agent_flows.tools.packs.project_ahead import _DATE_NAME as proj
    from app.services.time_semantics import TIME_NAME_CANDIDATE_RX, TIME_NAME_RX

    assert cov is TIME_NAME_CANDIDATE_RX
    assert proj is TIME_NAME_RX


def test_the_canonical_module_is_neutral_ground():
    """A dashboard tool must not have to import Agent Flow product code to ask
    a generic semantic question.

    `dashboard_ai_bot` already reaches into `agent_flows` in a few places; that is
    existing debt, and this is not the place to add to it.
    """
    import app.services.time_semantics as mod

    assert mod.__name__ == "app.services.time_semantics"
    src = mod.__file__ or ""
    assert "agent_flows" not in src.replace("\\", "/")
    assert "dashboard_ai_bot" not in src.replace("\\", "/")


def test_a_name_is_only_a_hint_and_the_value_check_stays_stronger():
    """`coverage` accepts a column named `key` when its VALUES are dates.

    Pinned so the convergence does not tempt anyone to route value validation
    through the name regex.
    """
    from app.services.agent_flows.tools.packs import coverage

    assert looks_like_time_name("key") is False
    # The value-level parser is a separate, stronger gate and still exists.
    assert hasattr(coverage, "_DATE_NAME")
    assert coverage.__doc__ is not None
