"""The block model: structure, tables, and the properties citations depend on."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_doc_blocks.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.dashboard_ai_bot.govern_doc_blocks import (
    context_prefix,
    estimate_tokens,
    heading_path_text,
    parse_blocks,
)


def project(body, *, child_tokens=4000):
    """Markdown through the SAME projection the indexer uses.

    `build_sections`/`merge_children` are gone: sections are now rows in the AST
    and the chunker projects that AST rather than re-deriving structure. These
    tests go through the real projection so they cannot pass against a code path
    production does not use.
    """
    from app.services.dashboard_ai_bot.govern_doc_ast import _blocks_from_markdown
    from app.services.dashboard_ai_bot.govern_doc_embeddings import build_chunk_rows

    blocks = [{**b, "ordinal": i} for i, b in enumerate(_blocks_from_markdown(body))]
    rows, _info = build_chunk_rows(None, blocks, child_tokens=child_tokens)
    return rows

DOC = """# Vận hành & Giao vận

Vận hành tốt là điều kiện để có đánh giá tốt.

## Cam kết giao đúng hẹn (SLA)

Mục tiêu ≥ 92%.

## Bảng chỉ tiêu

| Hạng mục | Mục tiêu | Thực tế |
|---|---|---|
| Doanh thu | 100 tỷ | 92 tỷ |
| Chi phí | 60 tỷ | 58 tỷ |

Ghi chú sau bảng.
"""


def test_heading_path_tracks_nesting():
    blocks = parse_blocks(DOC)
    paths = {heading_path_text(b.heading_path) for b in blocks}
    assert "Vận hành & Giao vận" in paths
    assert "Vận hành & Giao vận > Cam kết giao đúng hẹn (SLA)" in paths


def test_a_deeper_heading_does_not_inherit_a_sibling():
    """`##` after `##` replaces, it does not nest. A citation that names the wrong
    section is worse than one that names none."""
    blocks = parse_blocks(DOC)
    sla = next(b for b in blocks if "92%" in b.text)
    assert heading_path_text(sla.heading_path).endswith("Cam kết giao đúng hẹn (SLA)")
    assert "Bảng chỉ tiêu" not in heading_path_text(sla.heading_path)


def test_table_is_one_block_and_keeps_its_header():
    blocks = parse_blocks(DOC)
    tables = [b for b in blocks if b.kind == "table"]
    assert len(tables) == 1
    assert "Hạng mục" in tables[0].text
    assert "Doanh thu" in tables[0].text and "Chi phí" in tables[0].text


def test_prose_after_a_table_is_not_swallowed_into_it():
    blocks = parse_blocks(DOC)
    assert any(b.kind != "table" and "Ghi chú sau bảng" in b.text for b in blocks)


def test_a_table_never_merges_with_prose():
    """A table mixed into a prose chunk destroys the signal a reader needs to
    interpret the numbers, and makes both harder to read."""
    for row in project(DOC):
        if row["block_kind"] == "table":
            assert "Ghi chú sau bảng" not in row["content"]


def test_a_table_chunk_carries_its_header():
    """So the assembler can always show the columns, whatever it received."""
    rows = [r for r in project(DOC) if r["block_kind"] == "table"]
    assert rows and all(r.get("table_header") for r in rows)


def test_oversized_table_splits_by_row_with_the_header_repeated():
    """The single worst failure for a BI knowledge base is a table fragment with
    no header: a row of numbers whose columns nobody can name."""
    rows = "\n".join("| Mục %d | %d tỷ | %d tỷ |" % (i, i, i + 1) for i in range(40))
    body = "## Bảng lớn\n\n| Hạng mục | Mục tiêu | Thực tế |\n|---|---|---|\n" + rows
    tables = [r for r in project(body, child_tokens=60) if r["block_kind"] == "table"]
    assert len(tables) > 1, "a 40-row table should not stay in one 60-token chunk"
    for piece in tables:
        assert "Hạng mục" in piece["content"], "a fragment lost its header"
    # Every fragment still points at the ONE block it came from: splitting for
    # size must not invent structure the document does not have.
    assert len({(r["block_from"], r["block_to"]) for r in tables}) == 1


def test_page_headings_become_page_numbers_not_headings():
    """The PDF extractor emits `## Page N`. Those are coordinates, not sections —
    leaving them in the heading path makes every citation read "Page 3"."""
    body = "## Page 3\n\nNội dung trang ba.\n\n## Page 4\n\nNội dung trang bốn."
    blocks = parse_blocks(body)
    assert {b.page for b in blocks} == {3, 4}
    assert all("Page" not in heading_path_text(b.heading_path) for b in blocks)


def test_embed_tokens_are_stripped_and_wikilinks_keep_their_words():
    blocks = parse_blocks("Giá trị {{metric:gmv}} theo [[Tổng quan|báo cáo]].")
    text = " ".join(b.text for b in blocks)
    assert "{{" not in text
    assert "báo cáo" in text


def test_chunks_never_straddle_a_heading():
    """A passage spanning two sections belongs to neither, and its citation would
    name the wrong one."""
    for row in project(DOC, child_tokens=10_000):
        assert not ("Vận hành tốt" in row["content"] and "92%" in row["content"])


def test_a_figure_keeps_its_kind():
    """Merging used to set every multi-block chunk to "paragraph", which left a corpus
    with seven images reporting zero figures — you cannot caption what you cannot
    identify."""
    rows = project(
        "## Ảnh\n\n![sơ đồ](https://x/y.png)\n\nĐoạn văn kèm theo."
    )
    assert any(r["block_kind"] == "figure" for r in rows)


def test_context_prefix_is_title_and_path_only():
    """Every field in the prefix is part of the hashed embedded string, so each one
    added is a field whose edit re-embeds the whole document."""
    prefix = context_prefix("HDSD API", ("A", "B"), 4)
    assert prefix == "HDSD API > A > B > trang 4"
    assert context_prefix(None, (), None) == ""


def test_token_estimate_is_monotone_and_never_zero_for_text():
    assert estimate_tokens("") == 0
    assert estimate_tokens("x") >= 1
    assert estimate_tokens("x" * 100) > estimate_tokens("x" * 10)


@pytest.mark.parametrize("body", ["", "   \n\n  "])
def test_empty_bodies_produce_nothing(body):
    assert project(body, child_tokens=200) == []
