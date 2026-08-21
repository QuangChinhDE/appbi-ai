"""The document AST: the two gates, and the geometry the PDF path infers."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_doc_ast.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.dashboard_ai_bot.govern_doc_ast import (
    AST_VERSION,
    _blocks_from_markdown,
    _blocks_from_structured,
    _table_header,
)
from app.services.govern_doc_sources import pdf_layout

DOC = """# Vận hành & Giao vận

Vận hành tốt là điều kiện để có đánh giá tốt.

## Cam kết giao đúng hẹn (SLA)

Mục tiêu ≥ 92%.

- Đo theo tháng
- Báo cáo đầu tháng sau

## Bảng chỉ tiêu

| Hạng mục | Mục tiêu |
|---|---|
| Doanh thu | 100 tỷ |
"""


# ── the markdown side of the tree ──────────────────────────────────────────────

def test_ordinals_are_assigned_once_at_persist_time():
    """Block ordinals are what make a citation survive a re-chunk: stable for the
    life of a document version, where chunk ids are not. Numbering them in ONE
    place matters — a parser that numbered its own output and a writer that
    renumbered would produce anchors that disagree with the stored tree.
    """
    import inspect

    from app.services.dashboard_ai_bot.govern_doc_ast import persist_ast

    assert "for ordinal, block in enumerate(blocks)" in inspect.getsource(persist_ast)
    # The parser therefore emits document ORDER and no numbers of its own.
    assert all(b.get("ordinal") is None for b in _blocks_from_markdown(DOC))


def test_the_parser_emits_blocks_in_document_order():
    """Ordinals are positions in this list, so the order IS the anchor."""
    texts = [b["text"] for b in _blocks_from_markdown(DOC)]
    assert texts.index("Cam kết giao đúng hẹn (SLA)") < texts.index("Bảng chỉ tiêu")


def test_sections_are_rows_in_the_tree():
    """The chunker projects this tree rather than re-deriving structure from
    markdown. When `parse_blocks` emitted no `section` rows, the projection saw no
    boundaries and merged every section of a document into one chunk."""
    kinds = [b["kind"] for b in _blocks_from_markdown(DOC)]
    assert kinds.count("section") == 3


def test_a_section_row_carries_its_depth():
    blocks = _blocks_from_markdown(DOC)
    sections = [b for b in blocks if b["kind"] == "section"]
    assert sections[0]["level"] == 1
    assert sections[1]["level"] == 2


def test_the_vocabulary_is_paragraph_not_prose():
    """`ck_govern_block_kind` accepts a fixed set. Two names for one concept broke
    the insert on five files' worth of code before they were unified."""
    kinds = {b["kind"] for b in _blocks_from_markdown(DOC)}
    assert "prose" not in kinds
    assert kinds <= {"section", "paragraph", "list", "table", "figure"}


def test_a_list_is_its_own_kind():
    blocks = _blocks_from_markdown(DOC)
    assert any(b["kind"] == "list" and "Đo theo tháng" in b["text"] for b in blocks)


def test_a_table_keeps_a_header_a_fragment_can_reuse():
    header = _table_header("| Hạng mục | Mục tiêu |\n|---|---|\n| Doanh thu | 100 tỷ |")
    assert header is not None and "Hạng mục" in header


def test_prose_is_not_a_table_header():
    assert _table_header("Đoạn văn bình thường.") is None


def test_heading_paths_are_strings_not_lists():
    """It was a list from markdown and a string from the database, and something
    called `.split()` on it. One type, both sides."""
    for block in _blocks_from_markdown(DOC):
        assert isinstance(block.get("heading_path") or "", str)


def test_an_empty_document_produces_no_tree():
    assert _blocks_from_markdown("") == []
    assert _blocks_from_markdown("   \n\n ") == []


# ── the structured (PDF) side ──────────────────────────────────────────────────

def test_structured_blocks_keep_page_and_bbox():
    """A citation that can say "trang 4" is the whole reason the layout pass runs."""
    raw = [
        {"kind": "section", "text": "Chương 1", "page": 4, "level": 1,
         "bbox": [10, 20, 300, 40]},
        {"kind": "paragraph", "text": "Nội dung.", "page": 4,
         "bbox": [10, 45, 300, 90]},
    ]
    blocks = _blocks_from_structured(raw)
    assert blocks[1]["page"] == 4
    assert blocks[1]["bbox"] is not None


def test_structured_input_that_is_garbage_does_not_raise():
    """Extraction output is stored JSON from an older version of this code. A
    tree it cannot read is a reason to fall back, not to fail a save."""
    assert _blocks_from_structured([]) == []
    assert _blocks_from_structured([{"nonsense": 1}]) is not None


# ── the two gates ──────────────────────────────────────────────────────────────

def test_the_ast_version_is_part_of_every_fingerprint():
    """Changing how the tree is built has to rebuild every tree. A chunker change
    that re-indexed NOTHING because the hash did not cover it happened once
    already, and it is invisible until someone measures retrieval."""
    from app.services.dashboard_ai_bot.govern_doc_ast import _hash

    assert _hash("x").startswith(AST_VERSION + ":")


def test_the_chunker_gate_covers_the_ast_fingerprint():
    """Gate two must re-chunk when the tree changed, and only then."""
    import inspect

    from app.services.dashboard_ai_bot.govern_doc_embeddings import index_cache_key

    assert 'getattr(doc, "ast_hash", None)' in inspect.getsource(index_cache_key)


def test_the_staleness_report_and_the_gate_use_one_key():
    """They were computed separately and drifted: the reporter kept the old format
    and every document read as stale while search worked perfectly."""
    import inspect

    from app.services.dashboard_ai_bot.govern_doc_embeddings import index_is_stale

    assert "index_cache_key(doc, model, dimensions)" in inspect.getsource(index_is_stale)


# ── page geometry ──────────────────────────────────────────────────────────────

def line(text, *, size=10.0, top=100.0, bold=False, x0=50.0, x1=300.0):
    return {"text": text, "size": size, "bold": bold, "x0": x0, "x1": x1,
            "top": top, "bottom": top + size * 1.2}


def test_the_body_size_is_the_mode_not_the_mean():
    """A page with one enormous title would drag a mean upwards, and then nothing
    on the page would look like a heading."""
    lines = [line("T" * 10, size=28.0)] + [line("x" * 90, size=10.0) for _ in range(8)]
    assert pdf_layout.body_size(lines) == 10.0


def test_a_larger_line_is_a_heading_and_deeper_means_smaller():
    base = 10.0
    assert pdf_layout._heading_level(17.0, base, False, "Chương 1") == 1
    assert pdf_layout._heading_level(13.5, base, False, "Mục 1.1") == 2
    assert pdf_layout._heading_level(11.8, base, False, "Tiểu mục") == 3
    assert pdf_layout._heading_level(10.0, base, False, "Câu văn thường") == 0


def test_a_bold_short_line_is_a_heading_when_the_document_never_varies_size():
    assert pdf_layout._heading_level(10.0, 10.0, True, "Cam kết giao hàng") == 3


def test_a_long_emphasised_sentence_is_not_a_heading():
    """Promoting it would put a whole paragraph into every citation."""
    sentence = "Đây là một câu rất dài được in đậm nhưng vẫn là một câu văn " * 3
    assert pdf_layout._heading_level(14.0, 10.0, True, sentence) == 0


def test_a_bold_line_ending_in_a_full_stop_is_a_sentence():
    assert pdf_layout._heading_level(10.0, 10.0, True, "Đây là một câu.") == 0


@pytest.mark.parametrize("text", ["- Điểm một", "• Điểm hai", "1. Điểm ba", "2) Bốn"])
def test_bullets_and_numbers_are_lists(text):
    assert pdf_layout._looks_like_list(text) is True


@pytest.mark.parametrize("text", ["Đoạn văn.", "2026 là năm tài chính", ""])
def test_prose_is_not_a_list(text):
    assert pdf_layout._looks_like_list(text) is False


def test_two_columns_are_detected_from_a_gutter():
    """Reading a two-column page left-to-right interleaves two unrelated texts, and
    every chunk from it is nonsense."""
    words = ([{"x0": 40.0, "x1": 250.0}] * 40) + ([{"x0": 320.0, "x1": 540.0}] * 40)
    columns = pdf_layout._cluster_columns(words, 595.0)
    assert len(columns) == 2


def test_a_single_column_page_stays_one_column():
    words = [{"x0": 40.0, "x1": 540.0}] * 60
    assert len(pdf_layout._cluster_columns(words, 595.0)) == 1


def test_a_heading_ends_the_paragraph_before_it():
    """Otherwise a paragraph carries the title above it, and the citation names the
    previous section."""
    lines = [
        line("Đoạn văn thuộc mục trước.", top=100.0),
        line("Mục Mới", size=16.0, top=140.0, bold=True),
        line("Đoạn văn thuộc mục mới.", top=170.0),
    ]
    blocks = pdf_layout._blocks_from_lines(lines, page=1, column=0, base_size=10.0)
    kinds = [b.kind for b in blocks]
    assert kinds == ["paragraph", "section", "paragraph"]
    assert "Mục Mới" not in blocks[0].text and "Mục Mới" not in blocks[2].text


def test_a_vertical_gap_splits_two_paragraphs():
    lines = [line("Câu một.", top=100.0), line("Câu hai.", top=160.0)]
    blocks = pdf_layout._blocks_from_lines(lines, page=1, column=0, base_size=10.0)
    assert len(blocks) == 2


def test_consecutive_lines_join_into_one_paragraph():
    lines = [line("Nửa câu đầu", top=100.0), line("nửa câu sau.", top=112.0)]
    blocks = pdf_layout._blocks_from_lines(lines, page=1, column=0, base_size=10.0)
    assert len(blocks) == 1
    assert blocks[0].text == "Nửa câu đầu nửa câu sau."
