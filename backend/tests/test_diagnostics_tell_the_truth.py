# -*- coding: utf-8 -*-
"""A diagnostic may only recommend an action that is actually applicable.

REPRODUCED DEFECT (P1). `_warn_if_overflowing()` ends every overflow notice with
"Bật 'đọc theo câu hỏi'…" — including when `match_question` is already True. The
author reads advice to switch on a switch that is already on, and the product
looks as though it cannot see its own configuration.

The fix is not a better sentence. The invariant is that remedies are DERIVED from
runtime state, so an inapplicable one cannot be emitted at all.
"""
import types

from app.services.agent_flows.contract import ReportReadNode
from app.services.agent_flows.runtime.handlers.data import _warn_if_overflowing


def state():
    return types.SimpleNamespace(notices=[])


def big_out(n=20):
    """An output comfortably over the downstream ceiling."""
    return {"scope": {}, "charts": [
        {"chart_id": i, "title": "C%d" % i,
         "summary": {"ok": True, "data": {"blob": "x" * 900}}}
        for i in range(n)
    ]}


def notice_of(node, out=None):
    st = state()
    _warn_if_overflowing(node, out or big_out(), st)
    assert st.notices, "expected an overflow diagnostic"
    return st.notices[0]


def remedy_text(n):
    return " ".join([n.text] + list(getattr(n, "remedies", []) or []))


# ── the reported defect ──────────────────────────────────────────────────────

def test_does_not_tell_the_author_to_enable_what_is_already_enabled():
    n = notice_of(ReportReadNode(key="r", output_var="ctx", match_question=True, detail="compact"))
    assert "Bật" not in remedy_text(n) or "đọc theo câu hỏi" not in remedy_text(n), (
        "recommended enabling question matching while it was already on"
    )


def test_still_offers_it_when_it_really_is_off():
    n = notice_of(ReportReadNode(key="r", output_var="ctx", match_question=False, detail="compact"))
    assert "đọc theo câu hỏi" in remedy_text(n), (
        "question matching is off and genuinely would help — it must still be offered"
    )


# ── the same rule for the other controls ─────────────────────────────────────

def test_does_not_suggest_index_when_already_on_index():
    n = notice_of(ReportReadNode(key="r", output_var="ctx", detail="index", match_question=True))
    assert "chỉ mục" not in remedy_text(n)


def test_suggests_index_when_on_full():
    assert "chỉ mục" in remedy_text(
        notice_of(ReportReadNode(key="r", output_var="ctx", detail="full", match_question=True)))


def test_does_not_suggest_fewer_charts_when_an_explicit_list_is_already_set():
    node = ReportReadNode(key="r", output_var="ctx", chart_ids=[1, 2], match_question=False, detail="index")
    n = notice_of(node)
    assert "giảm số" not in remedy_text(n)


# ── the class: never recommend a no-op, and never emit an empty diagnostic ───

def test_every_remedy_offered_is_applicable_in_every_configuration():
    seen = 0
    for mq in (True, False):
        for detail in ("index", "compact", "full"):
            for ids in ([], [1, 2]):
                node = ReportReadNode(key="r", output_var="ctx", match_question=mq, detail=detail,
                                      chart_ids=ids)
                st = state()
                _warn_if_overflowing(node, big_out(), st)
                if not st.notices:
                    continue
                seen += 1
                txt = remedy_text(st.notices[0])
                if mq:
                    assert "đọc theo câu hỏi" not in txt, (mq, detail, ids)
                if detail == "index":
                    assert "chỉ mục" not in txt, (mq, detail, ids)
                if ids:
                    assert "giảm số" not in txt, (mq, detail, ids)
                assert txt.strip(), "a diagnostic with no applicable remedy said nothing"
    assert seen >= 8, "matrix did not actually exercise the diagnostic"


def test_the_diagnostic_is_addressed_to_the_author_not_the_reader():
    """Author maintenance advice must not be mixed into reader-facing notices."""
    n = notice_of(ReportReadNode(key="r", output_var="ctx", match_question=True, detail="compact"))
    assert getattr(n, "audience", None) == "author"


def test_the_advice_is_also_readable_without_a_structured_ui():
    """`remedies` is for a UI that renders actions; not every UI does yet. An
    author must never be shown a problem with no suggested action — that is what
    structuring the advice without also saying it produced."""
    n = notice_of(ReportReadNode(key="r", output_var="ctx", match_question=False,
                                 detail="full"))
    assert n.remedies, "no structured remedies"
    for r in n.remedies:
        assert r in n.text, f"remedy missing from the readable text: {r!r}"


def test_the_prose_still_never_carries_an_inapplicable_remedy():
    n = notice_of(ReportReadNode(key="r", output_var="ctx", match_question=True,
                                 detail="index", chart_ids=[1, 2]))
    assert "đọc theo câu hỏi" not in n.text
    assert "chỉ mục" not in n.text
    assert "giảm số" not in n.text.lower()
    assert n.text.strip(), "an empty diagnostic says nothing"


# ── every remedy must be performable in the product as it stands ─────────────
#
# A diagnostic that recommends an action the author cannot carry out is worse
# than silence: it sends them looking for a control that does not exist. The
# removed one was "chỉ định danh sách biểu đồ" — `chart_ids` is a real field, but
# the builder deliberately exposes no picker for it, because a chart id belongs to
# one report while a flow is meant to stay reusable across bindings. Binding-aware
# asset selection is Wave 3.
#
# Each phrase below is allowed because a control exists for it TODAY:
PERFORMABLE = {
    "đọc theo câu hỏi": "Toggle in the Report Read inspector",
    "Khớp theo": "Query field, shown when question matching is on",
    "Giảm số biểu đồ tối đa": "max_charts NumberField",
    "chi tiết": "detail Select (index / compact / full)",
    "chỉ mục": "detail Select, `index` option",
    "bí danh": "Governed metric / glossary, outside the flow builder but real",
    "Từ điển": "Metrics dictionary",
    "mô tả": "Chart description",
    "khả năng bên dưới": "The candidate list carried in the same notice",
    "chấp nhận": "A decision, not a control",
    "bước sau gọi công cụ": "Tool grants on the answering step",
    "mức gọn nhất": "A statement, not an action",
    "xử lý ở": "A statement, not an action",
}

UNPERFORMABLE = ["chỉ định danh sách biểu đồ", "chart_ids", "danh sách biểu đồ cụ thể"]


def _every_remedy():
    out = []
    for mq in (True, False):
        for detail in ("index", "compact", "full"):
            for ids in ([], [1, 2]):
                node = ReportReadNode(key="r", output_var="ctx", match_question=mq,
                                      detail=detail, chart_ids=ids)
                st = state()
                _warn_if_overflowing(node, big_out(), st)
                for n in st.notices:
                    out.extend(n.remedies)
    return out


def test_no_remedy_recommends_an_action_the_builder_cannot_perform():
    for remedy in _every_remedy():
        low = remedy.lower()
        for banned in UNPERFORMABLE:
            assert banned.lower() not in low, (
                f"remedy recommends an action with no control: {remedy!r}"
            )


def test_every_remedy_maps_to_a_control_that_exists():
    """The allow-list is the documentation: adding a remedy means naming the
    control that performs it, which is the check this invariant needs."""
    for remedy in _every_remedy():
        assert any(k in remedy for k in PERFORMABLE), (
            f"remedy matches no known control — add it to PERFORMABLE with the "
            f"control that performs it, or do not offer it: {remedy!r}"
        )
