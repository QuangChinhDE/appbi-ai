"""Attaching a source is not reading it, and a claim of provenance is checkable.

WHAT WAS OBSERVED, DRIVING THE PRODUCT AS A VIEWER
--------------------------------------------------
The flow "Phân tích doanh thu Olist" grants two tools — `get_chart_data` and
`inspect_filters` — and attaches document 26 to its analyst step. Asked

    "GMV trong báo cáo này được tính thế nào, có gồm phí ship không?"

it answered, after one call to `inspect_filters`:

    "Theo tài liệu 26 — Quy ước tính GMV và phí vận chuyển của Olist,
     GMV không bao gồm phí vận chuyển."

It had never opened the document. That sentence is the AUTHOR'S own one-line note
about why the attachment is there, promoted to a citation. The document says
nothing about shipping, and the semantic layer defines
`gmv = ${total_revenue} + ${total_freight}` — the opposite of the answer.

Three separate things had to be true for that to happen, and each has a test here:

  1. `coverage()` reported the flow as able to answer definition questions,
     because it counted an attachment as a second route to one.
  2. the prompt introduced the attachment list in words that read like contents.
  3. the answer-verification skipped runs that had read nothing — the one case
     where an invented source is both most likely and least detectable.

Granted `describe_semantic_model`, the same question then answered correctly:
"GMV ... bao gồm cả phí vận chuyển ... = Doanh thu + Phí vận chuyển". The answer
was never in the documents; it was in the semantic layer the whole time.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_unreadable.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.agent_flows.contract import Flow, upgrade_body
from app.services.agent_flows.coverage import coverage
from app.services.agent_flows.envelope import Answer, TraceStep
from app.services.agent_flows.runtime import executor


def build(tools: list[str], knowledge: list[dict]) -> Flow:
    body = {
        "name": "t",
        "nodes": [{
            "key": "analyst", "type": "agent", "name": "Phân tích",
            "prompt": "Đọc câu hỏi.",
            "tools": [{"tool": t, "note": ""} for t in tools],
            "knowledge": knowledge,
        }],
    }
    return Flow.model_validate(
        {**upgrade_body(body, key="t", name="t"), "key": "t", "name": "t"})


DOC26 = [{
    "source": "document", "ref": "26",
    "description": "Quy ước tính GMV và phí vận chuyển của Olist.",
}]


# ── 1. coverage stops promising a route that does not exist ────────────────────

def test_an_attached_document_no_tool_can_open_does_not_cover_definitions():
    """The premise was that such a step answers "from the passages it was already
    given". It is given none: an attachment sets the retrieval BOUNDARY and adds
    one line to the prompt. Nothing fetches a passage."""
    cov = coverage(build(["get_chart_data", "inspect_filters"], DOC26))
    assert "definition" in {g["key"] for g in cov["gaps"]}


def test_the_unreadable_source_is_named_with_the_tool_that_would_fix_it():
    cov = coverage(build(["get_chart_data", "inspect_filters"], DOC26))
    assert len(cov["unreadable_sources"]) == 1
    entry = cov["unreadable_sources"][0]
    assert entry["source"] == "document" and entry["ref"] == "26"
    assert "search_knowledge" in entry["needs_any_of"]


def test_a_readable_document_covers_definitions_and_raises_no_warning():
    cov = coverage(build(["search_knowledge"], DOC26))
    assert "definition" in {c["key"] for c in cov["covered"]}
    assert cov["unreadable_sources"] == []


def test_a_semantic_attachment_needs_the_semantic_tool_not_a_document_search():
    """Different sources are opened by different tools, and `search_knowledge`
    does not read the semantic layer."""
    sem = [{"source": "semantic", "ref": "111",
            "description": "Mô hình ngữ nghĩa Olist. Tra khi cần công thức của "
                           "một chỉ số."}]
    assert coverage(build(["search_knowledge"], sem))["unreadable_sources"]
    assert coverage(build(["describe_semantic_model"], sem))["unreadable_sources"] == []


def test_a_flow_with_no_attachments_reports_nothing_to_warn_about():
    assert coverage(build(["get_chart_data"], []))["unreadable_sources"] == []


# ── 2. the prompt says what the list is ────────────────────────────────────────

def test_the_prompt_tells_a_step_with_no_reader_that_it_cannot_open_them():
    from app.services.agent_flows.runtime.handlers.agent import _knowledge_readers

    node = build(["get_chart_data", "inspect_filters"], DOC26).nodes[0]
    assert _knowledge_readers(node) == []


def test_the_prompt_names_the_tool_when_there_is_one():
    from app.services.agent_flows.runtime.handlers.agent import _knowledge_readers

    node = build(["search_knowledge", "get_chart_data"], DOC26).nodes[0]
    assert _knowledge_readers(node) == ["search_knowledge"]


def test_a_reader_for_a_DIFFERENT_source_does_not_count():
    """`describe_semantic_model` opens the semantic layer, not document 26."""
    from app.services.agent_flows.runtime.handlers.agent import _knowledge_readers

    node = build(["describe_semantic_model"], DOC26).nodes[0]
    assert _knowledge_readers(node) == []


# ── 3. a claim of provenance the run cannot support ────────────────────────────

class _State:
    def __init__(self, trace=(), citations=()):
        self.trace = list(trace)
        self.citations = list(citations)
        self.notices: list = []


def _codes(state) -> list[str]:
    return [n.code for n in state.notices]


def _answer(text: str) -> Answer:
    from app.services.agent_flows.envelope import text_answer

    return text_answer(text)


def test_citing_a_document_the_run_never_opened_is_flagged():
    state = _State(trace=[TraceStep(key="analyst", tool_calls=["inspect_filters"])])
    executor._flag_unsupported_attribution(
        state, _answer("Theo tài liệu 26, GMV không bao gồm phí vận chuyển."))
    assert _codes(state) == ["citations_unsupported"]


def test_an_invented_outside_source_is_flagged_too():
    """Once the prompt stopped inviting the first fabrication, the same question
    produced "(Nguồn: Investopedia)" and "(Nguồn: Harvard Business Review)" with
    zero tool calls. Neither carries an `[n]` marker, so neither was a citation as
    far as the old check was concerned — while both read to a viewer as one."""
    state = _State()
    executor._flag_unsupported_attribution(
        state, _answer("GMV thường không gồm phí ship. (Nguồn: Investopedia)"))
    assert _codes(state) == ["citations_unsupported"]


def test_a_run_that_DID_consult_a_definition_tool_is_left_alone():
    """The false positive this rule was first written with. Granted
    `describe_semantic_model`, the answer "GMV = Doanh thu + Phí vận chuyển ...
    Nguồn: Báo cáo nội bộ" is CORRECT and its attribution is true. It collects no
    document citations because the semantic layer is not a document, and warning
    about it would teach an author to distrust a right answer."""
    state = _State(trace=[TraceStep(key="analyst",
                                    tool_calls=["describe_semantic_model"])])
    executor._flag_unsupported_attribution(
        state, _answer("GMV = Doanh thu + Phí vận chuyển. Nguồn: Báo cáo nội bộ."))
    assert _codes(state) == []


def test_attributing_to_the_report_is_not_a_claim_about_a_document():
    """The report IS what a run reads, so "theo báo cáo" is usually true. A rule
    that flagged it would fire on most correct answers."""
    state = _State()
    executor._flag_unsupported_attribution(
        state, _answer("Theo báo cáo, GMV tháng 5 đạt 1,2 tỷ."))
    assert _codes(state) == []


def test_an_ordinary_answer_with_no_attribution_is_not_flagged():
    state = _State()
    executor._flag_unsupported_attribution(
        state, _answer("Doanh thu tăng 12% so với tháng trước."))
    assert _codes(state) == []


def test_the_word_source_inside_a_sentence_is_not_an_attribution():
    """"Nguồn dữ liệu chưa cập nhật" is a statement about freshness."""
    state = _State()
    executor._flag_unsupported_attribution(
        state, _answer("Nguồn dữ liệu chưa cập nhật tới hôm nay."))
    assert _codes(state) == []


def test_a_run_holding_real_citations_is_left_to_the_marker_check():
    """`verify_citations` is the sharper instrument once sources are in hand;
    firing here as well would report the same sentence twice."""
    class _C:
        kind = "document"
        used = [1]

    state = _State(citations=[_C()])
    executor._flag_unsupported_attribution(
        state, _answer("Theo tài liệu 26, GMV gồm phí ship."))
    assert _codes(state) == []
