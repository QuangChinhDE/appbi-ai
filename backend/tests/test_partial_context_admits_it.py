"""Three ways a step was told less than it thought, none of which said so.

A model does not reach for a tool because a tool exists; it reaches for one when it
knows something is missing. Each of these hid that knowledge:

  * `report_read` returned `{"charts": [...]}` with no indication that it had read
    six of seventy. Granting the step `list_charts` changed nothing — measured, not
    assumed — because as far as it could tell it already held the whole report.
  * the prior-step gather head-truncates each result at 2,000 characters and said
    nothing, so a reading that stopped mid-array read as a complete one.
  * a refused tool call named the problem and no way out, so the model tried a
    neighbouring tool on the same wrong chart and answered from it.

Together they produced: "Danh mục sản phẩm có doanh thu cao nhất là 13,591,643.70"
— the report's grand total, no category named, `notices: []`.
"""
from __future__ import annotations

import json

from app.services.agent_flows.runtime.handlers import agent as A
from app.services.agent_flows.tools import result as R
from app.services.agent_flows.tools.packs import derived


# ── the reading says how much of the report it is ───────────────────────────


def _read(pinned: list[int], granted: list[int]) -> dict:
    """Run the real `report_read` handler with the warehouse stubbed out."""
    import asyncio
    import types

    from app.services.agent_flows.runtime.handlers import data as D

    node = types.SimpleNamespace(
        key="doc", name="Đọc báo cáo", chart_ids=pinned, include_filters=False,
        include_summary=False, include_data=True, detail="compact", max_rows=50,
        # `match_question` off and `max_charts` at the contract default: this test
        # is about what a PARTIAL reading admits, so the selection must stay the
        # one it was written against - every pinned chart, in the pinned order.
        match_question=False, max_charts=20, query="",
    )
    budget = types.SimpleNamespace(tools_left=lambda: 99, spend_tool=lambda: None)
    state = types.SimpleNamespace(
        outputs={}, notices=[], citations=[], tool_log=[], budget=budget,
    )
    rctx = types.SimpleNamespace(inp=types.SimpleNamespace(
        binding=types.SimpleNamespace(
            allowed_chart_ids=granted,
            capabilities=types.SimpleNamespace(read_rows=True, max_rows_per_call=50),
        ),
        report=types.SimpleNamespace(charts=[], chart=lambda _id: None),
    ))

    original = D._call
    D._call = lambda rc, st, tool, args: {"ok": True, "columns": ["a"], "rows": [{"a": 1}]}
    try:
        async def drain():
            async for _ in D.run_report_read(node, state, rctx):
                pass

        asyncio.new_event_loop().run_until_complete(drain())
    finally:
        D._call = original
    return state.outputs["doc"]


def test_scope_is_the_first_key_so_truncation_cannot_remove_it():
    """Ordering is the mechanism here, not tidiness.

    The caveat is written last and the consumer truncates from the front, so the
    one sentence that has to survive would be the one guaranteed to be cut.
    Anything that moves `scope` later re-breaks this silently.
    """
    out = _read(pinned=[1, 2], granted=list(range(1, 71)))

    assert list(out)[0] == "scope"


def test_a_partial_reading_names_the_way_to_the_rest():
    """N of M, and the next call to make. Both halves matter.

    "2/70" alone tells a model it is missing something without telling it what to
    do, and the observed behaviour in that case is to answer anyway.
    """
    scope = _read(pinned=[1, 2], granted=list(range(1, 71)))["scope"]

    assert scope == {
        "read": 2, "available": 70, "partial": True, "note": scope.get("note", ""),
    }
    assert "2/70" in scope["note"]
    assert "list_charts" in scope["note"]


def test_a_complete_reading_says_nothing():
    """No note when there is nothing to warn about.

    A caveat on a complete reading is noise, and noise is how a real caveat stops
    being read.
    """
    scope = _read(pinned=[1, 2], granted=[1, 2])["scope"]

    assert scope == {"read": 2, "available": 2}


# ── truncation admits it truncated ──────────────────────────────────────────


class _Step:
    def __init__(self, key, name, type_="agent"):
        self.key, self.name, self.type = key, name, type_


class _State:
    def __init__(self, outputs):
        self.outputs = outputs
        self.trace = [_Step(k, k) for k in outputs]


def test_a_cut_result_says_it_was_cut():
    """Two thousand characters that simply stop read as the whole of a step's work.

    The model is not being asked to distrust the content — only to know that the
    absence of something is not evidence that it does not exist.
    """
    big = json.dumps({"charts": [{"chart_id": i, "pad": "x" * 200} for i in range(40)]})
    assert len(big) > A._HANDOFF_CHARS

    gathered = A._all_step_results(_State({"doc": big}), None)

    # The invariant is unchanged; the MECHANISM is not. A JSON payload is now
    # reduced structurally rather than head-sliced, so the marker differs — but
    # the model must still be told that what is missing was removed, not absent.
    assert "lược" in gathered
    assert "KHÔNG phải là không có dữ liệu" in gathered


def test_a_cut_PROSE_result_also_says_it_was_cut():
    """The other reduction path. JSON shrinks structurally; prose is cut on a line
    boundary and carries its own marker — both must announce themselves."""
    big = "\n".join("dòng %d với nội dung dài vừa phải để vượt ngân sách" % i
                     for i in range(600))
    assert len(big) > A._HANDOFF_CHARS

    gathered = A._all_step_results(_State({"doc": big}), None)

    assert "lược bớt" in gathered
    assert "KHÔNG phải là không có dữ liệu" in gathered


def test_a_result_that_fits_is_left_alone():
    """No marker on an untruncated result — it would be a lie about the payload."""
    gathered = A._all_step_results(_State({"doc": "ngắn gọn"}), None)

    assert "bị cắt bớt" not in gathered
    assert "ngắn gọn" in gathered


# ── a refusal names the recovery ────────────────────────────────────────────


def test_an_out_of_scope_chart_says_how_to_find_a_valid_one():
    """One correct recovery for this code, so it lives in the contract, not a caller."""
    out = R.err("chart 999999 is not part of this dashboard", code="chart_out_of_scope")

    assert out["ok"] is False
    # A route is named. WHICH route is asserted by the routing tests at the
    # bottom of this file — that pair moves when a better tool ships, and this
    # one only cares that the refusal is not a dead end.
    assert out["recovery"]


def test_a_kpi_tile_refused_for_ranking_says_what_to_rank_instead():
    """Situational, so it is passed explicitly — and it forbids the wrong fallback.

    Told only "no grouping column to rank by", the model called `total_measure` on
    the same tile and reported its total as the top category. The recovery has to
    rule that out, not merely suggest an alternative.
    """
    columns = ["doanh_thu"]
    out = R.err(
        "chart 679 has no grouping column to rank by",
        code="not_applicable",
        recovery=(
            "This chart is a single-value tile. To rank, find a chart that breaks "
            "this measure down: call list_charts with a `query` of the question's "
            "keywords, pick one whose dimensions include the grouping you need, "
            "and retry with that chart_id. Do NOT answer a ranking question from "
            "this tile's total."
        ),
        detail={"columns": columns},
    )

    assert "list_charts" in out["recovery"]
    assert "Do NOT answer a ranking question from this tile" in out["recovery"]


def test_a_missing_chart_id_is_recoverable_rather_than_just_wrong():
    """The real one, through the real code path."""
    out = derived._load(None, {})

    assert out["error_code"] == "bad_argument"
    assert out["recovery"]


def test_codes_with_no_single_right_answer_get_no_invented_one():
    """`not_applicable` covers several unrelated situations.

    A default hint here would confidently send the model somewhere useless — an
    additivity refusal is not fixed by listing charts. Silence beats a wrong map
    entry, so the map holds only codes with ONE recovery.
    """
    out = R.err("cannot correlate two charts with no shared dimension",
                code="not_applicable")

    assert "recovery" not in out


# ── recovery hints are routing, and routing goes stale ──────────────────────


def test_a_recovery_hint_points_at_the_strongest_route_available():
    """The hint is routing, so adding a better route means updating the hints.

    Caught live, and only by running the product: after `resolve_chart_candidates`
    shipped, `rank_values` still refused a KPI tile with "call list_charts" —
    written months earlier, when a name search was the only way to find a chart.
    A weak model followed it exactly, listed charts by name, picked another KPI
    tile and reported its total as the top product category. The tool existed, was
    granted, and was never reached, because nothing pointed at it.
    """
    out = derived._load(None, {})

    assert "search_business_assets" in out["recovery"]
    assert "list_charts" not in out["recovery"]


def test_the_out_of_scope_hint_routes_to_the_asset_search_too():
    """Same rule, the other code — and this one is shared by every chart tool."""
    hint = R.err("chart 999999 is not part of this dashboard",
                 code="chart_out_of_scope")["recovery"]

    assert "search_business_assets" in hint
    assert "resolve_chart_candidates" in hint


# ── an answer a person can actually read ────────────────────────────────────


def test_latex_a_chat_bubble_cannot_render_is_turned_into_plain_text():
    """Asked how a KPI is calculated, a model answered in display math.

    The chat renders markdown, not TeX, so the backslashes and braces reached the
    viewer verbatim — seen in the product, on a correct answer. The whole suite
    checks the FIGURES in an answer; nothing had checked whether it was legible.
    """
    b = chr(92)
    raw = (
        "Công thức:\n\n"
        + b + "[\n" + b + "text{avg_review_score} = " + b + "text{AVG}("
        + b + "text{review" + b + "_score})\n" + b + "]\n\n"
        "Hiện là 4.09."
    )
    out = A._plain_formulas(raw)

    assert "avg_review_score = AVG(review_score)" in out
    assert b not in out
    assert "4.09" in out                       # the figure survives untouched


def test_ordinary_prose_is_left_exactly_alone():
    """The transform is narrow, and a false positive rewrites a correct answer."""
    plain = "Doanh thu 1.000 đ, tỷ lệ 92% — không có công thức nào ở đây."

    assert A._plain_formulas(plain) == plain
    assert A._plain_formulas("") == ""


def test_inline_math_and_escaped_characters_both_go():
    b = chr(92)
    out = A._plain_formulas(b + "(x" + b + "_1" + b + ") tăng 5" + b + "%")

    assert out == "x_1 tăng 5%"
