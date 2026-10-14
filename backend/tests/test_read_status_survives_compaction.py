# -*- coding: utf-8 -*-
"""Read STATUS and downstream PAYLOAD are two concepts; compaction may only touch one.

REPRODUCED DEFECT (P0). `include_summary=true`, `include_data=false`,
`detail=compact`: `get_chart_summary` succeeds and returns `{"ok": true, "data": …}`.
`_compact()` then replaces `entry["summary"]` with a presentation object that
carries chart_name/chart_type/total_rows/columns and, deliberately, no `ok`.
`_entry_has_data()` decides success by reading `payload["ok"]`. With Chart data
off there is no second payload to rescue the verdict, so a read that WORKED was
reported "Không đọc được dữ liệu của bất kỳ biểu đồ nào".

INVARIANT: a presentation/compaction step can never change whether a tool
succeeded. Status is recorded once, at execution, and read from there afterwards.

The last test is the one that matters: it asserts the property for EVERY shaping
mode rather than for the reported input, so a third mode added later cannot
reintroduce the class.
"""
import pytest

from app.services.agent_flows.runtime.handlers.data import _compact, _entry_has_data


def ok_summary():
    return {"ok": True, "data": {
        "chart_name": "MRR Active by time", "chart_type": "line", "total_rows": 24,
        "columns": [{"name": "mrr_active", "kind": "number", "total": 1000,
                     "top_values": [["a", 3], ["b", 2]]}]}}


def ok_data():
    return {"ok": True, "data": {"rows": [{"mrr_active": 100}]}}


def failed(msg="DataError"):
    return {"ok": False, "error": msg, "detail": msg}


# ── the reported case ────────────────────────────────────────────────────────

def test_summary_only_compact_is_still_a_successful_read():
    entry = {"chart_id": 1, "summary": ok_summary()}
    _compact(entry)
    assert _entry_has_data(entry), (
        "compaction turned a successful summary-only read into an unreadable chart "
        "— the exact P0 defect"
    )


# ── the rest of the matrix ───────────────────────────────────────────────────

def test_summary_only_full():
    assert _entry_has_data({"chart_id": 1, "summary": ok_summary()})


def test_data_only():
    assert _entry_has_data({"chart_id": 1, "data": ok_data()})


def test_summary_and_data():
    assert _entry_has_data({"chart_id": 1, "summary": ok_summary(), "data": ok_data()})


def test_summary_fails_data_succeeds_is_degraded_not_unreadable():
    entry = {"chart_id": 1, "summary": failed(), "data": ok_data()}
    assert _entry_has_data(entry)


def test_summary_succeeds_data_fails_is_degraded_not_unreadable():
    entry = {"chart_id": 1, "summary": ok_summary(), "data": failed()}
    assert _entry_has_data(entry)


def test_both_fail_is_unreadable():
    assert not _entry_has_data({"chart_id": 1, "summary": failed(), "data": failed()})


def test_nothing_requested_is_unreadable():
    assert not _entry_has_data({"chart_id": 1})


def test_index_mode_is_complete_by_design():
    assert _entry_has_data({"chart_id": 1, "indexed": True})


def test_degraded_pair_survives_compaction_too():
    """summary ok + data failed, then compacted. Still a read, still degraded."""
    entry = {"chart_id": 1, "summary": ok_summary(), "data": failed()}
    _compact(entry)
    assert _entry_has_data(entry)


def test_compaction_never_rescues_a_failure():
    """The invariant runs both ways: shaping must not INVENT success either."""
    entry = {"chart_id": 1, "summary": failed()}
    _compact(entry)
    assert not _entry_has_data(entry)


# ── the class, not the instance ──────────────────────────────────────────────

SHAPERS = {"compact": _compact, "none": lambda e: None}


@pytest.mark.parametrize("shaper", sorted(SHAPERS))
@pytest.mark.parametrize("entry_name", ["summary_only", "data_only", "both", "degraded"])
def test_no_shaping_mode_may_change_the_verdict(shaper, entry_name):
    entries = {
        "summary_only": {"chart_id": 1, "summary": ok_summary()},
        "data_only": {"chart_id": 1, "data": ok_data()},
        "both": {"chart_id": 1, "summary": ok_summary(), "data": ok_data()},
        "degraded": {"chart_id": 1, "summary": ok_summary(), "data": failed()},
    }
    entry = entries[entry_name]
    before = _entry_has_data(entry)
    SHAPERS[shaper](entry)
    assert _entry_has_data(entry) == before, (
        f"shaping mode {shaper!r} changed the read verdict for {entry_name}"
    )
