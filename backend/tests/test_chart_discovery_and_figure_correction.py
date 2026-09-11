"""The two holes at either end of a turn: finding a chart, and shipping a number.

Both were found by measuring the live deployment rather than by reading code, and
both were invisible from inside the module that caused them:

  * `list_charts` declared itself cheap and "returns no row data", and by default
    ran one live warehouse query per chart to report a row count `compact` mode
    then mostly discarded. Measured on a 70-chart report with a fresh context per
    call — the way a real turn pays it — that was 37,720 ms against 1 ms, for
    ~307 tokens. 20 of the 34 tools require a `chart_id`, and this is the only
    tool that issues one.

  * 32 of 269 real runs shipped an answer containing a figure absent from the
    evidence. The system detected every one and forwarded every one, because the
    check ran after the answer was finished.
"""
from __future__ import annotations

import asyncio
import types

import pytest

from app.services.dashboard_ai_bot.thinking import tools as T


class _FakeDashboard:
    name = "Olist"
    description = ""


class _FakeCtx:
    """Only the surface `tool_list_charts` touches."""

    def __init__(self, meta: dict):
        self.dashboard = _FakeDashboard()
        self.chart_meta = meta
        self.allowed_chart_ids = set(meta)
        self.public_filters = []
        self.pages = []


def _meta():
    return {
        1: {"name": "Olist · Tỷ lệ giao đúng hẹn theo tháng", "chart_type": "line"},
        2: {"name": "Olist · Doanh thu theo danh mục", "chart_type": "bar"},
        3: {"name": "Olist · Giao đúng hẹn (%)", "chart_type": "kpi"},
        4: {"name": "Olist · Số đơn hàng", "chart_type": "kpi"},
    }


def _charts(res):
    return ((res.get("data") or res).get("charts")) or []


def _coverage(res):
    return ((res.get("data") or res).get("coverage")) or {}


# ── discovery ───────────────────────────────────────────────────────────────


def test_listing_charts_does_not_query_the_warehouse():
    """The default listing answers "which charts exist" without reading any.

    This is the whole defect in one assertion. The tool fetched every chart's data
    to report `total_rows`, which is the only field of that scan `compact` keeps —
    thirty-odd seconds, on the one tool every measuring question has to pass
    through to obtain a `chart_id`, out of a 45-second run budget.
    """
    fetched: list[int] = []

    def _boom(ctx, chart_id):
        fetched.append(chart_id)
        raise AssertionError("listing charts must not run a query per chart")

    original = T._fetch_chart_data
    T._fetch_chart_data = _boom
    try:
        res = T.tool_list_charts(_FakeCtx(_meta()), {})
    finally:
        T._fetch_chart_data = original

    assert fetched == []
    assert len(_charts(res)) == 4
    # And it says the counts were not read, rather than implying they are zero:
    # reporting 0 is what made an earlier version look like an empty dashboard.
    assert "row_counts" in _coverage(res)


def test_row_counts_are_available_to_a_caller_that_asks():
    """Opt-in, not removed. A narrowed list is a reasonable thing to count."""
    seen: list[int] = []

    def _fake(ctx, chart_id):
        seen.append(chart_id)
        return {"columns": ["a"], "rows": [{"a": 1}, {"a": 2}]}

    original = T._fetch_chart_data
    T._fetch_chart_data = _fake
    try:
        res = T.tool_list_charts(_FakeCtx(_meta()), {"with_row_counts": True})
    finally:
        T._fetch_chart_data = original

    assert sorted(seen) == [1, 2, 3, 4]
    assert all(c.get("total_rows") == 2 for c in _charts(res))


def test_the_catalogue_can_be_searched_the_way_a_question_is_phrased():
    """Accent-insensitive, ranked, and the best match leads.

    A viewer asks about "tỷ lệ giao đúng hẹn"; the agent's only route to a
    `chart_id` used to be reading all 70 charts. Ranking matters as much as
    filtering: chart 1 carries the whole phrase, chart 3 only part of it.
    """
    res = T.tool_list_charts(_FakeCtx(_meta()), {"query": "tỷ lệ giao đúng hẹn"})
    ids = [c["chart_id"] for c in _charts(res)]

    assert ids[0] == 1
    assert 2 not in ids          # "Doanh thu" shares none of these words
    assert _coverage(res).get("query") == "tỷ lệ giao đúng hẹn"


def test_search_works_without_diacritics():
    """`đúng hẹn` has to be reachable from `dung hen`, or the search is decorative.

    The canonical fold, not a local NFKD copy — that one left Vietnamese `đ`
    intact, so "dung hen" missed "đúng hẹn" and the whole feature was a no-op for
    anyone typing without accents.
    """
    ids = [c["chart_id"] for c in _charts(
        T.tool_list_charts(_FakeCtx(_meta()), {"query": "giao dung hen"}))]

    assert set(ids) == {1, 3}


def test_a_query_that_matches_nothing_falls_back_to_the_whole_list():
    """A bad guess costs a listing, not the answer.

    Returning zero charts would read to the agent as "this report has no charts",
    and the recovery from that is to stop — the failure mode the search was added
    to remove.
    """
    res = T.tool_list_charts(_FakeCtx(_meta()), {"query": "con vit mau tim"})

    assert len(_charts(res)) == 4
    assert _coverage(res).get("query_matched_nothing") == "con vit mau tim"
    assert "No chart matches" in _coverage(res).get("note", "")


def test_the_model_is_offered_the_search_argument():
    """A capability the schema hides does not exist.

    `light` had skipped the warehouse scan since Phase 15.74 — for the ONE internal
    caller that knew to pass it. It was never in the schema, so every model-issued
    call took the 37-second path. The lesson generalises: the tool's contract is
    what the model is shown, not what the function accepts.
    """
    spec = [t for t in T.TOOL_DEFINITIONS if t["name"] == "list_charts"][0]
    props = spec["input_schema"]["properties"]

    assert "query" in props
    assert "with_row_counts" in props
    assert "query" in spec["description"]


# ── figure correction ───────────────────────────────────────────────────────


class _FakeBudget:
    def __init__(self):
        self.llm_calls = 0

    def spend_llm(self):
        self.llm_calls += 1


class _FakeState:
    def __init__(self, evidence):
        self.evidence = evidence
        self.budget = _FakeBudget()
        self.prompt_tokens = 0
        self.completion_tokens = 0


def test_a_figure_absent_from_the_evidence_is_named_not_hedged():
    """The correction prompt must say WHICH number, and offer an honest way out.

    Its predecessor was a Notice reading "một số con số có thể chưa khớp", attached
    to the answer and shipped. A warning that vague only ever produces a hedge, and
    the hedge was already the problem.
    """
    from app.services.agent_flows.runtime.handlers import agent as A

    state = _FakeState([100.0, 200.0])
    unsupported = A._unsupported_figures("Tổng là 13590000 trên 100 và 200.", state)

    assert 13590000 in unsupported

    captured = {}

    async def _fake_stream(**kw):
        captured["messages"] = kw["messages"]

        async def gen():
            yield types.SimpleNamespace(type="text", text="Tổng là 300.")

        return gen()

    original = A._stream
    A._stream = lambda **kw: _run_fake(_fake_stream, kw)
    try:
        out = asyncio.new_event_loop().run_until_complete(
            A._retry_figures(
                None, state, "SYS", [{"role": "user", "content": "hỏi"}],
                "Tổng là 13590000 trên 100 và 200.", unsupported,
                provider="openai", api_key="k", model="gpt-4o-mini",
            )
        )
    finally:
        A._stream = original

    assert out == "Tổng là 300."
    asked = str(captured["messages"][-1]["content"])
    assert "13590000" in asked                      # named, not "some numbers"
    assert "chưa có dữ liệu" in asked               # removal is an allowed answer
    assert state.budget.llm_calls == 1


def _run_fake(factory, kw):
    """`_stream` is called, not awaited — unwrap the coroutine into the generator."""

    class _Wrapper:
        def __aiter__(self):
            self._gen = None
            return self

        async def __anext__(self):
            if self._gen is None:
                self._gen = await factory(**kw)
            return await self._gen.__anext__()

    return _Wrapper()


def test_a_correction_is_kept_only_when_it_is_actually_better():
    """A derived figure computed correctly also fails the check.

    So the rewrite has to earn its place: fewer unsupported figures, or the first
    answer stands. A rewrite that trades a wrong total for a wrong breakdown is
    not a correction, and losing the original's right figures to it would be a
    second defect wearing the first one's clothes.
    """
    from app.services.agent_flows.runtime.handlers import agent as A

    state = _FakeState([100.0, 200.0])

    before = A._unsupported_figures("Tổng 13590000.", state)
    worse = A._unsupported_figures("Tổng 13590000 và 999999.", state)
    dropped = A._unsupported_figures("Chưa có dữ liệu cho tổng; đọc được 100 và 200.",
                                     state)

    assert len(dropped) < len(before)      # the honest answer is accepted
    assert len(worse) > len(before)        # a second invention is rejected

    # AND THE CASE THE GATE EXISTS FOR. 300 is the correct sum of 100 and 200, and
    # it is still "unsupported" — no tool returned it. Showing the arithmetic is a
    # legitimate reply to the correction prompt, and it does not reduce the count.
    # That is why the rule is "strictly fewer", not "none": demanding zero would
    # force the model to delete figures it had derived correctly, and the original
    # answer is kept instead.
    derived = A._unsupported_figures("Tổng 300 = 100 + 200.", state)
    assert derived == [300.0]
    assert len(derived) == len(before)     # not better — so the first answer stands


def test_no_evidence_means_no_correction_round():
    """A run that called no tools has nothing to check against.

    Treating "no evidence" as "everything is fabricated" would fire the correction
    on every definition answer — which are sourced from documents, not figures —
    and spend a model call teaching it to delete correct numbers.
    """
    from app.services.agent_flows.runtime.handlers import agent as A

    assert A._unsupported_figures("Tổng là 13590000.", _FakeState([])) == []
    assert A._unsupported_figures("", _FakeState([100.0])) == []


@pytest.mark.parametrize("value,shown", [(300.0, "300"), (8.4, "8.4")])
def test_figures_are_shown_as_the_answer_would_have_written_them(value, shown):
    """`300.0` is not a number anyone wrote; the model has to recognise its own."""
    from app.services.agent_flows.runtime.handlers import agent as A

    assert A._fmt_figure(value) == shown
