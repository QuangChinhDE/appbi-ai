"""The Context Assembler: what the model actually reads."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_doc_context.db")
os.environ.setdefault("DATA_DIR", ".testdata")

from app.services.dashboard_ai_bot.govern_doc_context import (
    DEFAULT_TOKEN_BUDGET,
    assemble,
    cite_label,
    render,
    verify_citations,
)


class _Db:
    """No neighbours. The assembler must work without them — they are context,
    not a dependency."""

    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return []


class _NeighbourDb:
    """One block either side of ordinal 5 in document 1."""

    def execute(self, *a, **k):
        return self

    def fetchall(self):
        return [
            (1, 4, "Câu trước đó.", "A > B", "paragraph"),
            (1, 6, "Câu sau đó.", "A > B", "paragraph"),
        ]


def _row(**kw):
    base = {
        "doc_id": 1, "title": "Vận hành & Giao vận", "content": "Mục tiêu ≥ 92%.",
        "heading_path": "Vận hành & Giao vận > Cam kết giao đúng hẹn",
        "page": None, "block_from": 5, "block_to": 5, "section_index": 0,
        "section_content": None, "trust": "authored", "block_kind": "paragraph",
    }
    base.update(kw)
    return base


def test_sources_are_numbered_so_an_answer_can_cite_them():
    out = assemble(_Db(), [_row(), _row(doc_id=2, block_from=9, block_to=9, title="Trải nghiệm")])
    assert [s["n"] for s in out["sources"]] == [1, 2]
    assert "[1]" in out["text"] and "[2]" in out["text"]


def test_the_citation_names_where_not_which_chunk():
    """"the fourth chunk" is not an answer to "where does this come from"."""
    label = cite_label(_row(page=4))
    assert "Cam kết giao đúng hẹn" in label
    assert "trang 4" in label


def test_the_title_is_not_repeated_when_the_heading_path_starts_with_it():
    assert cite_label(_row()).count("Vận hành & Giao vận") == 1


def test_a_table_carries_its_header_into_the_context():
    """A row of numbers whose columns nobody can name is worse than no row."""
    out = assemble(_Db(), [_row(
        block_kind="table",
        table_header="| Hạng mục | Mục tiêu |\n|---|---|",
        content="| Doanh thu | 100 tỷ |",
    )])
    assert "Hạng mục" in out["sources"][0]["text"]


def test_neighbouring_blocks_are_pulled_in():
    """The sentence that answers a question is often beside the one that matched."""
    text = assemble(_NeighbourDb(), [_row()])["sources"][0]["text"]
    assert "Câu trước đó" in text and "Câu sau đó" in text


def test_the_same_block_is_never_paid_for_twice():
    """A chunk and its own neighbour, or two clause passes finding the same block,
    would otherwise spend the budget saying the same thing."""
    assert len(assemble(_Db(), [_row(), _row()])["sources"]) == 1


def test_one_section_of_context_is_added_once():
    rows = [
        _row(section_content="Toàn bộ mục về SLA."),
        _row(block_from=6, block_to=6, content="Câu khác.", section_content="Toàn bộ mục về SLA."),
    ]
    out = assemble(_Db(), rows)
    assert len([s for s in out["sources"] if s.get("section_text")]) == 1


def test_section_text_is_skipped_when_it_only_repeats_the_passage():
    out = assemble(_Db(), [_row(section_content="Mục tiêu ≥ 92%.")])
    assert out["sources"][0]["section_text"] is None


def test_the_budget_is_a_token_budget_and_overflow_is_reported():
    """It used to be `content[:420]` — a character cut with no relationship to the
    model's window, and silent about what it dropped."""
    rows = [_row(block_from=i, block_to=i, content="câu dài " * 60) for i in range(40)]
    out = assemble(_Db(), rows, token_budget=300)
    assert out["dropped"] > 0 and out["truncated"] is True
    assert len(out["sources"]) < len(rows)


def test_default_budget_is_stated_in_tokens():
    assert DEFAULT_TOKEN_BUDGET >= 500


def test_external_content_is_framed_as_untrusted_in_the_text():
    """A passage crawled from a public page is written by whoever controls that
    page. A model that cannot see that treats it as house policy."""
    assert "NGOÀI" in assemble(_Db(), [_row(trust="external")])["text"]


def test_the_ssot_page_is_named_as_such():
    assert "SSOT" in assemble(_Db(), [_row(is_metric_home=True)])["text"]


def test_the_instruction_to_abstain_travels_with_the_passages():
    """Term coverage cannot separate answerable from unanswerable (measured), so
    abstention has to be asked of the model reading them."""
    text = assemble(_Db(), [_row()])["text"]
    assert "chưa đề cập" in text
    assert "không suy đoán" in text


def test_no_sources_means_no_context_rather_than_an_empty_frame():
    out = assemble(_Db(), [])
    assert out["text"] == "" and out["sources"] == [] and out["citations"] == []
    assert render([]) == ""


def test_an_invented_citation_is_detected():
    """A model citing [7] when six sources were given has produced a reference
    nobody can check, which is the failure citations exist to prevent."""
    sources = assemble(_Db(), [_row()])["sources"]
    assert verify_citations("Theo [1].", sources)["ok"] is True
    bad = verify_citations("Theo [7].", sources)
    assert bad["ok"] is False and bad["invented"] == [7]


def test_an_uncited_answer_is_flagged_without_being_called_invalid():
    """Not every sentence needs a citation; an answer with NONE while sources were
    provided is worth surfacing, not rejecting."""
    sources = assemble(_Db(), [_row()])["sources"]
    result = verify_citations("Không dẫn gì cả.", sources)
    assert result["uncited"] is True and result["ok"] is True
