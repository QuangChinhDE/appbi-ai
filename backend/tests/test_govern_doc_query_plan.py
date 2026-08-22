"""The query planner: split only real multi-part questions, escalate only on a gap."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_query_plan.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.dashboard_ai_bot.govern_doc_query_plan import (
    clauses,
    describe,
    uncovered_clauses,
)


@pytest.mark.parametrize("question", [
    "GMV là gì?",
    "Mục tiêu tỷ lệ giao đúng hẹn là bao nhiêu phần trăm?",
    "delivered_customer_date",
    "AOV",
])
def test_a_single_question_is_not_split(question):
    """Splitting a question that was never two questions turns one good search
    into two worse ones."""
    assert clauses(question) == [question]


def test_a_two_part_question_splits():
    parts = clauses("Mục tiêu giao đúng hẹn là bao nhiêu và điểm đánh giá cần đạt mấy?")
    assert len(parts) == 2
    assert "giao đúng hẹn" in parts[0]
    assert "điểm đánh giá" in parts[1]


def test_scaffolding_only_fragments_are_not_clauses():
    """"và cả" leftovers and trailing particles carry no retrieval signal;
    searching for them would spend an embedding call on noise."""
    assert clauses("GMV là gì và là sao?") == ["GMV là gì và là sao?"]


def test_splitting_is_capped():
    long = " và ".join("chỉ số %s trung bình theo tháng" % n for n in "abcdefg")
    assert len(clauses(long)) <= 4


def test_clauses_keep_their_original_wording():
    """A clause is about to be EMBEDDED, and embeddings are made from words. A
    folded, de-accented clause would be a different question."""
    parts = clauses("Tỷ lệ giao đúng hẹn là bao nhiêu và điểm đánh giá cần đạt mấy?")
    assert any("Tỷ lệ" in p for p in parts)


# ── escalation ──────────────────────────────────────────────────────────────
def _row(content="", heading="", section=""):
    return {"content": content, "heading_path": heading, "section_content": section}


def test_no_escalation_when_every_part_found_evidence():
    rows = [_row("Mục tiêu giao đúng hẹn là 92%."), _row("Điểm đánh giá cần đạt 4.2.")]
    assert uncovered_clauses(
        "Mục tiêu giao đúng hẹn là bao nhiêu và điểm đánh giá cần đạt mấy?", rows
    ) == []


def test_escalation_when_one_part_found_nothing():
    """The half-answer this exists for: a question about two things, passages
    about one of them."""
    rows = [_row("Mục tiêu giao đúng hẹn là 92%.")]
    missing = uncovered_clauses(
        "Mục tiêu giao đúng hẹn là bao nhiêu và chi phí thu hút khách hàng là bao nhiêu?",
        rows,
    )
    assert len(missing) == 1
    assert "chi phí thu hút" in missing[0]


def test_a_single_part_question_never_escalates():
    """Escalation is for parts that went unanswered. A one-part question that
    found nothing is a no-answer, and re-asking the same thing would not help."""
    assert uncovered_clauses("Chính sách nghỉ phép?", []) == []


def test_evidence_in_the_section_counts_as_covered():
    """Small-to-big hands the model the section too, so a clause covered only
    there IS answered — escalating would pay for something already in hand."""
    rows = [_row("Không liên quan.", section="Chi phí thu hút khách hàng mục tiêu 45.")]
    missing = uncovered_clauses(
        "Mục tiêu giao đúng hẹn ra sao và chi phí thu hút khách hàng bao nhiêu?", rows
    )
    assert all("chi phí thu hút" not in m for m in missing)


def test_evidence_in_the_heading_counts_as_covered():
    rows = [_row("— thang 1–5, mục tiêu ≥ 4.2.", heading="Điểm đánh giá trung bình")]
    missing = uncovered_clauses(
        "Điểm đánh giá trung bình là bao nhiêu và giao đúng hẹn thế nào?", rows
    )
    assert all("Điểm đánh giá" not in m for m in missing)


def test_the_plan_is_reportable_even_when_it_did_nothing():
    """A plan nobody can inspect is a plan nobody can trust; "did not expand" is
    information, not an absence of it."""
    plan = describe("GMV là gì?", [_row("GMV là tổng giá trị.")], 0)
    assert plan["expanded"] is False
    assert plan["extra_passes"] == 0
    assert plan["clauses"] == []


def test_the_plan_names_the_parts_it_split_into():
    rows = [_row("Mục tiêu giao đúng hẹn là 92%.")]
    plan = describe(
        "Mục tiêu giao đúng hẹn bao nhiêu và chi phí thu hút khách hàng bao nhiêu?",
        rows, 1,
    )
    assert plan["expanded"] is True
    assert len(plan["clauses"]) == 2
    assert plan["uncovered"]


def test_no_model_call_is_involved():
    """Rewriting with an LLM would add latency, cost and a new egress path that the
    per-document policy would have to cover."""
    import ast
    import inspect

    from app.services.dashboard_ai_bot import govern_doc_query_plan as plan

    # Parsed, not grepped: the module's own docstring EXPLAINS why there is no
    # provider call, and a word search flagged that explanation as a violation.
    tree = ast.parse(inspect.getsource(plan))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
    assert not any(
        any(marker in name for marker in ("embedding", "openai", "provider", "llm"))
        for name in imported
    ), imported


# ── glossary-synonym expansion (W5) ────────────────────────────────────────────

class _GlossaryDb:
    """Two glossary terms, each with its synonyms — the real table's shape."""

    ROWS = [
        ("doanh_thu_thuan", "Doanh thu thuần", ["net revenue", "doanh thu ròng"]),
        ("don_giao_dung_hen", "Đơn giao đúng hẹn",
         ["giao đúng hẹn", "đúng hẹn", "on-time delivery", "OTD"]),
    ]

    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return list(self.ROWS)


class _BrokenDb:
    def execute(self, *a, **k):
        raise RuntimeError("no glossary table here")


def _rows(*texts):
    return [{"heading_path": "", "content": t, "section_content": ""} for t in texts]


def test_a_term_asked_in_english_expands_to_its_vietnamese_forms():
    """The reader asks about "net revenue" and the document says "doanh thu thuần".
    Embeddings sometimes bridge that and sometimes do not; the glossary knows for
    certain, because somebody wrote the synonyms down."""
    from app.services.dashboard_ai_bot.govern_doc_query_plan import glossary_variants

    out = glossary_variants(_GlossaryDb(), "net revenue tháng này là bao nhiêu",
                            _rows("Chỉ số này được chốt vào ngày làm việc thứ ba."))
    assert "Doanh thu thuần" in out
    assert "doanh thu ròng" in out


def test_no_expansion_when_the_evidence_already_uses_the_wording():
    """An ordinary question about revenue must not pay for a second retrieval pass
    it does not need."""
    from app.services.dashboard_ai_bot.govern_doc_query_plan import glossary_variants

    out = glossary_variants(_GlossaryDb(), "net revenue là gì",
                            _rows("Doanh thu thuần là tổng giá trị hàng hoá trừ hoàn tiền."))
    assert out == []


def test_a_question_naming_no_glossary_term_expands_to_nothing():
    from app.services.dashboard_ai_bot.govern_doc_query_plan import glossary_variants

    assert glossary_variants(_GlossaryDb(), "quy trình nghỉ phép ra sao",
                             _rows("Nội dung không liên quan.")) == []


def test_the_form_the_question_already_used_is_not_returned():
    """Re-querying the exact words that just failed is a wasted embedding."""
    from app.services.dashboard_ai_bot.govern_doc_query_plan import glossary_variants

    out = glossary_variants(_GlossaryDb(), "on-time delivery bao nhiêu phần trăm",
                            _rows("Không có thông tin liên quan."))
    assert "on-time delivery" not in out
    assert any("hẹn" in v for v in out)


def test_expansion_is_bounded():
    """Each variant is another query embedding."""
    from app.services.dashboard_ai_bot.govern_doc_query_plan import (
        _MAX_CLAUSES,
        glossary_variants,
    )

    out = glossary_variants(_GlossaryDb(), "net revenue và on-time delivery",
                            _rows("Không liên quan."))
    assert len(out) <= _MAX_CLAUSES


def test_a_missing_glossary_table_is_not_an_error():
    """This is an enhancement, never a dependency: a deployment without a glossary
    must still answer questions."""
    from app.services.dashboard_ai_bot.govern_doc_query_plan import glossary_variants

    assert glossary_variants(_BrokenDb(), "net revenue", _rows("x")) == []


def test_an_empty_question_expands_to_nothing():
    from app.services.dashboard_ai_bot.govern_doc_query_plan import glossary_variants

    assert glossary_variants(_GlossaryDb(), "", _rows("x")) == []
