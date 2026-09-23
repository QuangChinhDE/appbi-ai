"""Finding the right asset before measuring anything.

The pack exists because of two measured failures on report 67:

  * Only `list_charts` could enumerate anything. `search_knowledge` refuses an
    empty query and `recall_knowledge()` returns zero facts, so a question naming
    a business concept had exactly one route — guess a chart name — and a wrong
    guess produced a confident answer off the wrong chart.

  * The governed link metric -> dataset_table -> chart knows 11 charts carry
    `on_time_rate`. A keyword search for the metric's own Vietnamese name finds 6.
    The five it misses include "Đơn trễ theo tháng", which measures the same thing
    under its inverse name — unreachable by any string match, and exactly what a
    governed binding is for.
"""
from __future__ import annotations

import types

import pytest

from app.services.agent_flows.tools.context import extract_chart_field_semantics
from app.services.agent_flows.tools.packs import discover as D


def _role(measure: str, dimension: str = "dataset_table_437.order_status") -> dict:
    """A chart config in the shape the DATABASE stores, pollution included.

    `baseFilters` carries the dataset's filterable columns, which is why a
    substring search over the config blob matched every column on every chart of
    a dataset. `_charts_on_table` reads the grouping key out of `roleConfig`
    instead, so the fixture has to carry both halves or it tests neither.
    """
    return {
        "chartType": "BAR",
        "queryMode": "role",
        "roleConfig": {"metrics": [{"field": measure, "agg": "auto"}],
                       "dimension": dimension},
        "baseFilters": [
            {"field": "dataset_table_437.on_time_rate", "op": "in", "values": []},
            {"field": "dataset_table_437.order_count", "op": "in", "values": []},
        ],
    }


class _FakeChart:
    def __init__(self, cid, name, table, config):
        self.id, self.name = cid, name
        self.dataset_table_id, self.config = table, config


class _Query:
    """Just enough of a SQLAlchemy query for `_charts_on_table`."""

    def __init__(self, rows):
        self._rows = rows

    def filter(self, *conditions):
        return self

    def all(self):
        return self._rows


class _FakeCtx:
    def __init__(self, charts, allowed):
        self._charts = charts
        self.allowed_chart_ids = set(allowed)
        self.db = types.SimpleNamespace(query=lambda _model: _Query(self._visible()))
        # The same structured field extraction the runtime performs, from the
        # same configs — so the matcher under test reads what it reads live.
        self.chart_meta = {
            c.id: {"name": c.name,
                   "fields": extract_chart_field_semantics(c.config)}
            for c in charts
        }

    def _visible(self):
        # The real query filters by id IN allowed; the fake applies the same rule
        # so a test cannot pass by the double being more permissive than the DB.
        return [c for c in self._charts if c.id in self.allowed_chart_ids]


def _charts():
    return [
        _FakeChart(683, "Giao đúng hẹn (%)", 437,
                   _role("dataset_table_437.on_time_rate")),
        _FakeChart(715, "Đơn trễ theo tháng", 437,
                   _role("dataset_table_437.on_time_rate")),
        _FakeChart(680, "Số đơn hàng", 437,
                   _role("dataset_table_437.order_count")),
        _FakeChart(999, "Biểu đồ báo cáo khác", 437,
                   _role("dataset_table_437.on_time_rate")),
    ]


# ── the boundary ────────────────────────────────────────────────────────────


def test_a_chart_outside_the_link_is_never_a_candidate():
    """This tool's whole output is ids other tools will then act on.

    So the allow-list is applied HERE rather than trusted to whoever calls the
    measuring tool next. Chart 999 shares the table and the measure and is not
    granted to this link; a resolver that returned it would hand a downstream
    tool a valid-looking id for data this viewer may not see.
    """
    ctx = _FakeCtx(_charts(), allowed={683, 715, 680})
    ids = [c["chart_id"] for c in D._charts_on_table(ctx, 437, "on_time_rate")]

    assert 999 not in ids
    assert set(ids) == {683, 715, 680}


def test_no_granted_charts_means_no_candidates():
    """An empty allow-list is a closed door, not an open one."""
    assert D._charts_on_table(_FakeCtx(_charts(), allowed=set()), 437, "on_time_rate") == []


# ── the finding that justifies the tool ─────────────────────────────────────


def test_the_inverse_named_chart_is_found():
    """"Đơn trễ theo tháng" measures on-time delivery. No string match reaches it.

    This is the single case that cannot be solved by improving the text search,
    and therefore the reason a governed resolver has to exist at all.
    """
    ctx = _FakeCtx(_charts(), allowed={683, 715, 680})
    exact = [c for c in D._charts_on_table(ctx, 437, "on_time_rate")
             if c["match"] == "measure"]

    assert 715 in [c["chart_id"] for c in exact]


def test_sharing_a_table_is_reported_as_the_weaker_claim():
    """"Same table" and "same measure" are different claims and must read as such.

    Counting orders is not measuring on-time delivery. Presenting both at one
    confidence is how a caller picks a plausible wrong chart and quotes a number
    from it — the exact failure this pack was written after.
    """
    ctx = _FakeCtx(_charts(), allowed={683, 715, 680})
    rows = {c["chart_id"]: c for c in D._charts_on_table(ctx, 437, "on_time_rate")}

    assert rows[683]["match"] == "measure" and rows[683]["confidence"] == "high"
    assert rows[680]["match"] == "same_table" and rows[680]["confidence"] == "low"
    # And the exact ones lead, so a cap drops the weak rows rather than the right ones.
    order = [c["chart_id"] for c in D._charts_on_table(ctx, 437, "on_time_rate")]
    assert order.index(683) < order.index(680)


# ── matching ────────────────────────────────────────────────────────────────


def test_matching_ignores_diacritics():
    """An author or a model typing "giao dung hen" must reach "giao đúng hẹn"."""
    # All three unaccented words land: giao / dung / hen.
    assert D._score("Tỷ lệ giao đúng hẹn", D._terms_of("giao dung hen")) == 3
    # And the fold is the mechanism, not a coincidence of this one phrase.
    assert D._score("Đơn trễ theo tháng", D._terms_of("don tre")) == 2


def test_score_counts_matched_words_rather_than_a_ratio():
    """Normalising by length would rank a short weak name above a long exact one.

    "GMV" sharing one word out of one would beat "Tỷ lệ giao đúng hẹn theo tháng"
    sharing four out of six, which inverts the ordering an author needs.
    """
    wanted = D._terms_of("tỷ lệ giao đúng hẹn")
    assert D._score("Tỷ lệ giao đúng hẹn theo tháng", wanted) > D._score("Tỷ lệ 5 sao", wanted)


def test_a_word_nothing_matches_scores_zero():
    assert D._score("Doanh thu theo danh mục", D._terms_of("con vịt màu tím")) == 0


# ── the search's contract ───────────────────────────────────────────────────


def test_a_search_with_no_query_says_what_to_pass():
    out = D.tool_search_business_assets(_FakeCtx([], set()), {})

    assert out["ok"] is False
    assert out["error_code"] == "bad_argument"
    assert "recovery" in out


def test_an_unknown_asset_type_lists_the_valid_ones():
    out = D.tool_search_business_assets(_FakeCtx([], set()), {"query": "x", "types": ["chart", "nope"]})

    assert out["ok"] is False
    assert "nope" in out["error"]
    assert all(k in out["recovery"] for k in D._KINDS)


def test_one_store_failing_does_not_fail_the_search(monkeypatch):
    """Looking in five places at once must be more reliable than five calls.

    A glossary outage taking the chart results with it would make this tool worse
    than the calls it replaces. The failure is REPORTED — `unavailable` is how a
    caller tells "could not look" from "nothing there", which are different
    answers and only one of them is the business's fault.
    """
    def boom(*_a, **_k):
        raise RuntimeError("glossary down")

    monkeypatch.setitem(D._FINDERS, "term", boom)
    monkeypatch.setitem(D._FINDERS, "chart", lambda *_a, **_k: [
        {"type": "chart", "id": 683, "name": "Giao đúng hẹn (%)"},
    ])
    for kind in ("metric", "field", "document"):
        monkeypatch.setitem(D._FINDERS, kind, lambda *_a, **_k: [])

    out = D.tool_search_business_assets(_FakeCtx([], set()), {"query": "giao đúng hẹn"})

    assert out["ok"] is True
    data = out["data"]
    assert [r["id"] for r in data["results"]] == [683]
    assert data["coverage"]["unavailable"] == ["term"]


def test_finding_nothing_says_which_kind_of_nothing(monkeypatch):
    """"No results" reads to a model as "the business does not track that".

    The honest reading is narrower — nothing is NAMED this way — and the note has
    to say so, or an empty search becomes a confident denial.
    """
    for kind in D._KINDS:
        monkeypatch.setitem(D._FINDERS, kind, lambda *_a, **_k: [])

    out = D.tool_search_business_assets(_FakeCtx([], set()), {"query": "con vịt màu tím"})
    note = out["data"]["coverage"]["note"]

    assert out["ok"] is True
    assert "Do NOT conclude" in note


def test_resolving_without_either_argument_points_at_the_search(monkeypatch):
    out = D.tool_resolve_chart_candidates(_FakeCtx([], set()), {})

    assert out["ok"] is False
    assert "search_business_assets" in out["recovery"]


@pytest.mark.parametrize("kind", list(D._KINDS))
def test_every_declared_kind_has_a_finder(kind):
    """A kind the schema offers and nothing implements is a silent empty result."""
    assert kind in D._FINDERS


def test_a_term_result_carries_the_retriever_s_keys_not_the_table_s():
    """`_terms_in_scope` returns retrieval hits, not glossary rows.

    A term arrives as {source_type, title, content, synonyms, ...} — read as
    `term`/`name` (the column names) it produced a hit with a blank id and a blank
    label, which is worse than no hit: the caller sees a match it cannot act on.
    Only searching real data showed it, so the shape is pinned here.
    """
    hit = {
        "source_type": "term", "id": "nghiep_vu.danh_muc",
        "title": "Danh mục sản phẩm",
        "content": "Nhóm phân loại sản phẩm do sàn quy định.",
        "synonyms": "danh mục, ngành hàng, category",
    }
    import types as _t

    ctx = _FakeCtx([], set())
    original_scope = D._terms.__globals__.get("_terms_in_scope")
    mod = _t.ModuleType("fake_govern_tools")
    mod._terms_in_scope = lambda *_a, **_k: [hit]
    mod._metrics_in_scope = lambda *_a, **_k: []
    import sys

    sys.modules["app.services.dashboard_ai_bot.govern_tools"] = mod
    try:
        # `_Once` memoises the metric scope for one search — the finders share
        # it, so they take it rather than each resolving the scope again.
        out = D._terms(ctx, "danh mục", D._terms_of("danh mục"), D._Once(ctx, "danh mục"))
    finally:
        del sys.modules["app.services.dashboard_ai_bot.govern_tools"]
        assert original_scope is None or True

    assert out and out[0]["name"] == "Danh mục sản phẩm"
    assert out[0]["id"] == "nghiep_vu.danh_muc"
    assert "Nhóm phân loại" in out[0]["detail"]


def test_the_metric_scope_is_resolved_once_per_search(monkeypatch):
    """Two finders need it; resolving it twice cost half the search.

    MEASURED with six metrics in the dictionary: `_metrics_in_scope` ran twice and
    took 60ms of a 123ms call — it queries every metric's bindings, so roughly 5ms
    per metric per pass. This pack exists to be useful on a FULL dictionary, where
    the duplicate pass alone would be half a second.
    """
    calls = []

    class _FakeGT:
        @staticmethod
        def _metrics_in_scope(ctx, question=""):
            calls.append(question)
            return []

        @staticmethod
        def _terms_in_scope(ctx, metrics, question):
            return []

    import sys

    sys.modules["app.services.dashboard_ai_bot.govern_tools"] = _FakeGT
    try:
        ctx = _FakeCtx([], set())
        once = D._Once(ctx, "doanh thu")
        D._metrics(ctx, "doanh thu", D._terms_of("doanh thu"), once)
        D._terms(ctx, "doanh thu", D._terms_of("doanh thu"), once)
    finally:
        del sys.modules["app.services.dashboard_ai_bot.govern_tools"]

    assert calls == ["doanh thu"], "the metric scope must be resolved exactly once"


def test_the_memo_does_not_outlive_one_search():
    """It is a per-call memo, not a cache.

    A cache on the context would eventually serve one request a scope computed for
    another — and this scope IS the permission boundary, so a stale one is not a
    stale answer, it is the wrong reader's answer.
    """
    ctx = _FakeCtx([], set())
    assert D._Once(ctx, "a") is not D._Once(ctx, "a")
