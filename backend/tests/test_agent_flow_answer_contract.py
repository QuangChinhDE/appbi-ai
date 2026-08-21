"""The answer contract: a citation the reader cannot follow does not ship."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_answer_contract.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.agent_flows.envelope import CalloutBlock, TextBlock, text_answer
from app.services.agent_flows.runtime.executor import (
    _strip_invented_markers,
    _verify_answer_citations,
)
from app.services.agent_flows.runtime.handlers.agent import _collect_citation
from app.services.agent_flows.runtime.state import RunState

SEARCH_RESULT = {
    "ok": True,
    "results": [{"kind": "document_chunk", "id": 27, "title": "Vận hành & Giao vận"}],
    "citations": [
        {"n": 1, "doc_id": 27, "title": "Vận hành & Giao vận",
         "heading_path": "Vận hành & Giao vận > Cam kết giao đúng hẹn", "page": None,
         "block": 5, "source_version": 6},
        {"n": 2, "doc_id": 26, "title": "Doanh thu, GMV & Giá trị đơn",
         "heading_path": "Doanh thu, GMV & Giá trị đơn > Doanh thu thuần", "page": 3,
         "block": 9, "source_version": 2},
    ],
}


# ── the passages a knowledge search returned must reach the envelope ───────────

def test_a_knowledge_search_produces_citations():
    """`_collect_citation` read only `chart_id` and `document_id` from the tool
    ARGUMENTS, so a search that names no document in its arguments and returns
    eight numbered passages in its result contributed nothing at all."""
    state = RunState()
    _collect_citation(state, "search_knowledge", {"query": "SLA giao hàng"}, SEARCH_RESULT)
    assert len(state.citations) == 2
    assert {c.kind for c in state.citations} == {"document"}


def test_two_passages_from_one_document_are_two_citations():
    """Collapsing them to the document id loses the only part a reader needs."""
    state = RunState()
    result = {"ok": True, "citations": [
        {"n": 1, "doc_id": 27, "block": 5, "title": "T", "heading_path": "T > A"},
        {"n": 2, "doc_id": 27, "block": 40, "title": "T", "heading_path": "T > B"},
    ]}
    _collect_citation(state, "search_knowledge", {}, result)
    assert len(state.citations) == 2
    assert {c.ref for c in state.citations} == {"27:5", "27:40"}


def test_a_citation_carries_the_number_the_model_was_told_to_use():
    """Without it a `[2]` in the answer cannot be resolved back to a passage."""
    state = RunState()
    _collect_citation(state, "search_knowledge", {}, SEARCH_RESULT)
    assert sorted(n for c in state.citations for n in c.used) == ["1", "2"]


def test_a_citation_is_labelled_the_way_a_person_would_name_it():
    state = RunState()
    _collect_citation(state, "search_knowledge", {}, SEARCH_RESULT)
    labels = [c.label for c in state.citations]
    assert "Vận hành & Giao vận › Cam kết giao đúng hẹn" in labels
    assert any("trang 3" in label for label in labels)


def test_the_document_title_is_not_repeated_in_its_own_label():
    state = RunState()
    _collect_citation(state, "search_knowledge", {}, SEARCH_RESULT)
    assert state.citations[0].label.count("Vận hành & Giao vận") == 1


def test_a_failed_search_contributes_nothing():
    state = RunState()
    _collect_citation(state, "search_knowledge", {}, {"ok": False, "citations": []})
    assert state.citations == []


def test_the_existing_chart_citation_still_works():
    """This function had one job before; adding a second must not cost the first."""
    state = RunState()
    _collect_citation(state, "read_report", {"chart_id": 67}, {"ok": True, "name": "Dash67"})
    assert [c.kind for c in state.citations] == ["chart"]
    assert state.citations[0].label == "Dash67"


# ── verification ───────────────────────────────────────────────────────────────

def _state_with_two_sources():
    state = RunState()
    _collect_citation(state, "search_knowledge", {}, SEARCH_RESULT)
    return state


def test_a_correct_citation_passes_untouched():
    state = _state_with_two_sources()
    answer = text_answer("Mục tiêu giao đúng hẹn là ≥ 92% [1].")
    result = _verify_answer_citations(state, answer)
    assert result["ok"] is True
    assert "[1]" in answer.plain_text()
    assert state.notices == []


def test_an_invented_citation_is_removed_and_explained():
    """The marker itself asserts "this came from source 7". Leaving it while
    footnoting elsewhere means the sentence keeps making a false claim about its
    own provenance."""
    state = _state_with_two_sources()
    answer = text_answer("Mục tiêu là ≥ 92% [1] và chi phí giảm 8% [7].")
    _verify_answer_citations(state, answer)
    text = answer.plain_text()
    assert "[7]" not in text
    assert "[1]" in text, "a correct citation must survive"
    assert [n.code for n in state.notices] == ["citations_invented"]


def test_the_sentence_itself_is_never_edited():
    """Removing the model's WORDS over a citation defect would be editing the
    answer, which is not this check's business."""
    state = _state_with_two_sources()
    answer = text_answer("Chi phí giảm 8% [9] theo báo cáo tháng trước.")
    _verify_answer_citations(state, answer)
    text = answer.plain_text()
    assert "Chi phí giảm 8%" in text and "theo báo cáo tháng trước" in text


def test_an_answer_with_no_citations_is_not_an_error():
    """Demanding one per sentence produces decorative citations, which are worse
    than none."""
    state = _state_with_two_sources()
    answer = text_answer("Tài liệu chưa đề cập tới nội dung này.")
    result = _verify_answer_citations(state, answer)
    assert result["ok"] is True
    assert state.notices == []


def test_nothing_is_checked_when_no_passages_were_retrieved():
    """A run that never searched the knowledge base has no numbered sources, and a
    `[1]` in it belongs to something else — a list, a formula, a quote."""
    state = RunState()
    answer = text_answer("Xem bảng [1] ở trên.")
    assert _verify_answer_citations(state, answer) is None
    assert "[1]" in answer.plain_text()


def test_an_invented_marker_in_a_callout_is_also_removed():
    """A callout is prose the viewer reads exactly like a paragraph — and it is the
    block designed to draw the eye."""
    state = _state_with_two_sources()
    from app.services.agent_flows.envelope import Answer

    answer = Answer(blocks=[
        TextBlock(markdown="Chi tiết ở dưới."),
        CalloutBlock(text="Lưu ý: ngưỡng là 92% [8].", tone="warning"),
    ])
    _verify_answer_citations(state, answer)
    assert "[8]" not in answer.plain_text()


def test_only_the_invented_numbers_are_stripped():
    """A blanket strip of every bracketed digit would also delete a correct [1] and
    legitimate brackets from a quoted formula."""
    answer = text_answer("Công thức là a[1] + b[2], nguồn [9].")
    _strip_invented_markers(answer, [9])
    text = answer.plain_text()
    assert "a[1]" in text and "b[2]" in text and "[9]" not in text


def test_stripping_nothing_changes_nothing():
    answer = text_answer("Nguyên văn [1].")
    _strip_invented_markers(answer, [])
    assert answer.plain_text() == "Nguyên văn [1]."
