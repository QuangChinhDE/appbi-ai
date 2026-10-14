# -*- coding: utf-8 -*-
"""Vietnamese business questions against the real resolver and a realistic report.

The deployment's Olist report carries ENGLISH chart identifiers and Vietnamese
governed metrics. Nothing translates between them, deliberately: the bridge is
governed vocabulary — a metric's name and display label — not an LLM.

This exercises the REAL path. `_lexical`, `_semantic`, the strength rule and the
metric -> chart bridge all run; only the two tool CALLS are stubbed, with payloads
shaped exactly like `search_business_assets` and `resolve_chart_candidates`
return. Stubbing `_semantic` itself would prove nothing about the bridge, which is
the part that was missing before Wave 2 and the part a threshold could break.

The fixture is the deployment's own vocabulary, read from its database on
2026-09-21: six governed metrics, Vietnamese names, English-ish chart titles.
"""
import pytest

from app.services.agent_flows import resolver

#: The Olist report's charts, as the binding allows them.
ALLOWED = [678, 679, 680, 681, 682, 683]

#: Governed metrics exactly as this deployment stores them: `id` is the machine
#: name the bridge matches on, `name` the display label an author wrote.
GOVERNED = [
    ("doanh_thu_san_pham", "Doanh thu sản phẩm", 679),
    ("so_don_hang", "Số đơn hàng", 680),
    ("gia_tri_don_trung_binh", "Giá trị đơn trung bình", 681),
    ("ty_le_giao_dung_hen", "Tỷ lệ giao đúng hẹn", 683),
    ("gmv_tong_gia_tri_giao_dich", "GMV — Tổng giá trị giao dịch", 678),
    ("diem_danh_gia_trung_binh", "Điểm đánh giá trung bình", 682),
]

#: English chart titles, so a match cannot come from the chart name.
CHART_TITLES = {
    678: "Olist · GMV (goods + freight) · page-1",
    679: "Olist · Product revenue by month · page-1",
    680: "Olist · Orders by status · page-1",
    681: "Olist · Average order value · page-1",
    682: "Olist · Review score · page-1",
    683: "Olist · On-time delivery (%) · page-1",
}


def make_call(*, lexical_matches=False):
    """Stands in for `tool_registry.execute` only — every resolver decision above
    it is the real code."""
    from app.services.agent_flows.tools.packs.discover import _score, _terms_of

    def call(tool, args):
        if tool == "list_charts":
            # The English titles genuinely do not match a Vietnamese question, so
            # the lexical pass reports a miss and the semantic pass must carry it.
            if lexical_matches:
                return {"ok": True, "data": {"selection": {"status": "matched",
                                                           "selected_ids": [683]}}}
            return {"ok": True, "data": {"selection": {"status": "none",
                                                       "selected_ids": []}}}
        if tool == "search_business_assets":
            wanted = _terms_of(args.get("query") or "")
            hits = []
            for ident, label, _chart in GOVERNED:
                # `search_business_assets` ranks anything sharing a token; the
                # resolver's own threshold is what must separate signal from noise.
                if _score(ident + " " + label, wanted):
                    hits.append({"type": "metric", "id": ident, "name": label})
            return {"ok": True, "data": {"results": hits}}
        if tool == "resolve_chart_candidates":
            ident = args.get("metric") or args.get("measure")
            for name, _label, chart in GOVERNED:
                if name == ident:
                    return {"ok": True, "data": {"candidates": [
                        {"chart_id": chart, "chart_name": CHART_TITLES[chart],
                         "match": "measure", "confidence": "high"}]}}
            return {"ok": True, "data": {"candidates": []}}
        return {"ok": False, "error": "unexpected tool " + tool}

    return call


def resolve(question, **kw):
    return resolver.resolve_charts(question, ALLOWED, call=make_call(**kw))


# ── the four questions the brief names ──────────────────────────────────────

@pytest.mark.parametrize("question, chart_id, via", [
    ("doanh thu theo tháng", 679, "doanh_thu_san_pham"),
    ("số đơn hàng", 680, "so_don_hang"),
    ("giá trị đơn hàng trung bình", 681, "gia_tri_don_trung_binh"),
    ("tỷ lệ giao đúng hạn", 683, "ty_le_giao_dung_hen"),
])
def test_a_vietnamese_question_reaches_an_english_chart(question, chart_id, via):
    got = resolve(question)
    assert got["status"] == "semantic", (
        f"{question!r} did not resolve — status {got['status']}. If the governed "
        f"vocabulary for {via!r} is missing, that is a VOCABULARY GAP to report, "
        f"not a reason to lower the resolver's threshold."
    )
    assert chart_id in got["chart_ids"]
    assert any(c.get("concept") == via for c in got["candidates"])


def test_the_match_comes_through_governed_vocabulary_not_the_chart_title():
    """"tỷ lệ giao đúng hạn" vs the metric's "đúng hẹn" and the chart's English
    "On-time delivery (%)" — the bridge is the metric, and this proves it."""
    got = resolve("tỷ lệ giao đúng hạn")
    assert got["status"] == "semantic"
    assert got["candidates"][0]["via"] == "metric"
    assert "On-time delivery" in got["candidates"][0]["chart_name"]


# ── and the threshold still holds on the real path ──────────────────────────

@pytest.mark.parametrize("question", [
    "thời tiết Hà Nội hôm nay", "what is the weather today?",
])
def test_an_off_domain_question_still_resolves_to_nothing(question):
    """Same code path, same fixture: the vocabulary bridge must not become a way
    back in for questions the report has nothing to say about."""
    assert resolve(question)["status"] == "none"


def test_an_exact_lexical_hit_short_circuits_before_the_vocabulary():
    got = resolve("On-time delivery", lexical_matches=True)
    assert got["status"] == "exact" and got["chart_ids"] == [683]


def test_resolution_is_still_bounded_by_what_the_binding_allows():
    """The bridge may narrow scope and never widen it."""
    got = resolver.resolve_charts("số đơn hàng", [678], call=make_call())
    assert 680 not in got["chart_ids"]


def test_a_genuine_tie_is_still_ambiguous():
    """The dominance rule must not become "always pick the first". Two concepts
    matching the question equally well is exactly what ambiguity is for."""
    def call(tool, args):
        if tool == "list_charts":
            return {"ok": True, "data": {"selection": {"status": "none", "selected_ids": []}}}
        if tool == "search_business_assets":
            # Both share exactly "doanh thu" with the question.
            return {"ok": True, "data": {"results": [
                {"type": "metric", "id": "doanh_thu_san_pham", "name": "Doanh thu sản phẩm"},
                {"type": "metric", "id": "doanh_thu_dich_vu", "name": "Doanh thu dịch vụ"},
            ]}}
        ident = args.get("metric")
        chart = 679 if ident == "doanh_thu_san_pham" else 680
        return {"ok": True, "data": {"candidates": [
            {"chart_id": chart, "chart_name": CHART_TITLES[chart], "match": "measure"}]}}

    got = resolver.resolve_charts("doanh thu", ALLOWED, call=call)
    assert got["status"] == "ambiguous"
    assert got["chart_ids"] == []
    assert len(got["concepts"]) == 2
