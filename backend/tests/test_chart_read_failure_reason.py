# -*- coding: utf-8 -*-
"""Why a chart could not be read, told to the person who can fix it.

THE BUG THIS FILE EXISTS FOR
----------------------------
Reported from the field: eight charts failed `get_chart_summary` in one run. What
the product said was a count —

    Không đọc được dữ liệu của 8 biểu đồ (987, 990, 1000, 1001). Câu trả lời có
    thể thiếu.

— and, when nothing came back at all, "Không đọc được dữ liệu của bất kỳ biểu đồ
nào trong phạm vi được cấp." The cause existed only in the server log, behind a
comment that said "the full text is in the server log for whoever is debugging".
A flow author cannot read the server log, so the cause was unreachable by the one
person who could act on it.

Their workaround was to switch on `Chart data` so the read step had a second path.
It works, and it makes things worse in two ways: raw rows now go into every
downstream prompt where a digest used to go, and — this is the sharp part — the
rescued charts stop counting as unreadable, so the notice disappears too. The
workaround silences the symptom and the cause together.

Three things are pinned here:
  1. a chart that yields nothing reports its reason,
  2. a chart rescued by the fallback ALSO reports its reason,
  3. reasons are deduplicated, because eight charts on one broken table are one
     fact, not eight.
"""
from __future__ import annotations

from app.services.agent_flows.runtime.handlers.data import (
    _degraded_by_reason, _entry_has_data, _failure_reasons, _why,
)

# The real shape, from `tool_get_chart_summary` after this change: `error` is the
# short English fragment the model reads, `detail` the message a person needs.
BROKEN = {
    "ok": False,
    "error": "failed to load chart 987: DataError",
    "detail": "DataError: Invalid NUMERIC value: 8.436574074074073 Field: delivery_days",
}
ROWS = {"ok": True, "columns": ["a"], "rows": [[1]]}


def _chart(cid: int, **payloads) -> dict:
    return {"chart_id": cid, **payloads}


# ── 1. the reason survives to somewhere a person can read it ────────────────


def test_a_reason_is_the_detail_not_the_model_facing_fragment():
    """`error` names the exception CLASS. `detail` names the column that broke —
    which is the half you can act on without shell access to the box."""
    assert "delivery_days" in _why(BROKEN)


def test_a_tool_that_worked_has_no_reason():
    assert _why(ROWS) == ""
    assert _why(None) == ""
    assert _why("not a dict") == ""


def test_a_short_error_still_speaks_when_there_is_no_detail():
    """Older call sites pass no `detail`; they must not go silent."""
    assert _why({"ok": False, "error": "chart_out_of_scope"}) == "chart_out_of_scope"


# ── 2. charts that yielded nothing ──────────────────────────────────────────


def test_a_chart_that_returned_nothing_reports_why():
    reasons = _failure_reasons([_chart(987, summary=BROKEN)])

    assert len(reasons) == 1
    assert "delivery_days" in reasons[0]


def test_eight_charts_on_one_broken_table_are_one_sentence():
    """THE SHAPE OF THE ACTUAL REPORT. Repeating an identical reason eight times
    tells an author nothing the first told them, and buries it."""
    entries = [_chart(c, summary=BROKEN) for c in (987, 990, 1000, 1001, 1002, 1003, 1004, 1005)]

    assert _failure_reasons(entries) == [_why(BROKEN)]


def test_a_healthy_chart_contributes_no_reason():
    assert _failure_reasons([_chart(1, summary=ROWS)]) == []


# ── 3. the case the count could never see ───────────────────────────────────


def test_a_chart_rescued_by_the_fallback_still_reports_why():
    """THE REGRESSION THE WORKAROUND CREATED.

    `Chart data` on, `get_chart_summary` broken: the chart HAS data, so it is not
    unreadable, so the old code said nothing at all — while the run silently
    started paying raw rows into every downstream prompt.
    """
    entry = _chart(987, summary=BROKEN, data=ROWS)

    assert _entry_has_data(entry), "the fallback did its job — this chart is readable"
    assert _failure_reasons([entry]) == [], "so it is not in the unreadable list"

    degraded = _degraded_by_reason([entry])
    assert list(degraded) == [_why(BROKEN)]
    assert degraded[_why(BROKEN)] == [987]


def test_degraded_charts_group_by_reason_not_by_chart():
    entries = [_chart(c, summary=BROKEN, data=ROWS) for c in (987, 990, 1000)]

    degraded = _degraded_by_reason(entries)

    assert len(degraded) == 1
    assert degraded[_why(BROKEN)] == [987, 990, 1000]


def test_a_run_where_everything_worked_says_nothing():
    """A maintenance note on a healthy run is noise, and noise is how the real
    ones stop being read."""
    entries = [_chart(c, summary=ROWS, data=ROWS) for c in (1, 2, 3)]

    assert _failure_reasons(entries) == []
    assert _degraded_by_reason(entries) == {}


def test_an_index_entry_is_complete_without_either_payload():
    """`detail="index"` reads no chart on purpose. It must not be reported as a
    degraded read — that guard was already wrong once."""
    assert _degraded_by_reason([{"chart_id": 5, "indexed": True}]) == {}


def test_the_two_collectors_never_claim_the_same_chart():
    """One chart is either unreadable or degraded, never both — otherwise an
    author reads two notices about one problem and looks for two."""
    entries = [
        _chart(987, summary=BROKEN),             # nothing came back
        _chart(990, summary=BROKEN, data=ROWS),  # rescued
    ]

    assert _failure_reasons(entries) == [_why(BROKEN)]
    assert _degraded_by_reason(entries) == {_why(BROKEN): [990]}
