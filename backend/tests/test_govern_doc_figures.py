"""Figures: what they contribute to the index, and what they must never contribute."""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_doc_figures.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.govern_doc_sources.figure_text import (
    alt_is_informative,
    parse_image,
    resolve_figures,
    strip_images,
)

GDOC_IMAGE = (
    "![Google Docs image 3](https://lh7-rt.googleusercontent.com/docsz/"
    "AD_4nXcx4Cq9_8jw18ASKBSm2cl3W3cskN9bXEewUm-Pv6yYA-GdoDbyPusesqdBYuDH)"
)


def fig(text, **kw):
    base = {"kind": "figure", "text": text, "ordinal": 0, "meta": {}}
    base.update(kw)
    return base


# ── the defect this layer exists for ───────────────────────────────────────────

def test_an_exporter_url_never_becomes_indexable_text():
    """13% of this corpus's vectors were base64 URLs from a Google Docs export:
    eleven embedding calls, eleven candidate-pool slots, and a citable "source"
    pointing at a signed URL nobody can read."""
    blocks = [fig(GDOC_IMAGE)]
    info = resolve_figures(blocks)
    assert blocks[0]["text"] == ""
    assert info["no_text"] == 1 and info["described"] == 0


def test_the_url_is_kept_as_structure_not_thrown_away():
    """It is the anchor for a citation and the input a vision pass needs."""
    blocks = [fig(GDOC_IMAGE)]
    resolve_figures(blocks)
    assert blocks[0]["meta"]["src"].startswith("https://lh7-rt.googleusercontent.com")


def test_a_text_less_figure_survives_in_the_tree():
    """Withholding the EMBEDDING is the decision; deleting the figure would also
    delete the ability to cite it and the chance to describe it later."""
    blocks = [fig(GDOC_IMAGE)]
    resolve_figures(blocks)
    assert blocks[0]["kind"] == "figure"


def test_the_chunker_skips_a_figure_with_no_text():
    """The one place that decides what becomes a vector must agree with this
    layer, or the noise comes back in through the projection."""
    from app.services.dashboard_ai_bot.govern_doc_embeddings import build_chunk_rows

    blocks = [
        {"kind": "section", "text": "Mục A", "heading_path": "Mục A", "ordinal": 0},
        {"kind": "figure", "text": "", "heading_path": "Mục A", "ordinal": 1, "meta": {}},
        {"kind": "paragraph", "text": "Đoạn văn thật.", "heading_path": "Mục A", "ordinal": 2},
    ]
    rows, _info = build_chunk_rows("Tài liệu", blocks, child_tokens=400)
    assert all(r["block_kind"] != "figure" for r in rows)
    assert any("Đoạn văn thật" in r["content"] for r in rows)


# ── alt text: exporter noise vs. a human's words ───────────────────────────────

@pytest.mark.parametrize("alt", [
    "Google Docs image 1", "image", "image003", "unnamed", "Hình 2", "figure",
    "Screenshot 2026-02-11 at 14.03.55", "image001.png", "pasted image 20.png",
    "a3f9c81e77bd4410", "so-do.png",
])
def test_placeholder_alt_is_not_content(alt):
    assert alt_is_informative(alt) is False


@pytest.mark.parametrize("alt", [
    "Sơ đồ luồng phê duyệt đơn hàng",
    "Biểu đồ doanh thu thuần theo tháng",
    "Revenue by channel, Q1 2026",
])
def test_a_human_written_alt_is_the_best_description_short_of_looking(alt):
    assert alt_is_informative(alt) is True


def test_an_informative_alt_becomes_the_figure_text():
    blocks = [fig("![Biểu đồ doanh thu thuần theo tháng](https://x/y.png)")]
    info = resolve_figures(blocks)
    assert blocks[0]["text"] == "Biểu đồ doanh thu thuần theo tháng"
    assert info["from_alt"] == 1 and info["described"] == 1


# ── captions ───────────────────────────────────────────────────────────────────

def test_a_caption_below_the_figure_wins_over_the_alt():
    """It is what a human reads to know what the picture shows."""
    blocks = [
        fig("![sơ đồ tổng quan](https://x/y.png)", ordinal=0),
        {"kind": "paragraph", "ordinal": 1,
         "text": "Hình 3: Luồng đồng bộ dữ liệu từ nguồn về kho."},
    ]
    info = resolve_figures(blocks)
    assert "Luồng đồng bộ dữ liệu" in blocks[0]["text"]
    assert info["captioned"] == 1


def test_the_next_paragraph_is_not_stolen_as_a_caption():
    """Ordinary prose after an image is about the topic, not about the image.
    Taking it would duplicate it into two chunks and mislabel one of them."""
    blocks = [
        fig(GDOC_IMAGE, ordinal=0),
        {"kind": "paragraph", "ordinal": 1,
         "text": "Doanh thu thuần được chốt vào ngày làm việc thứ ba của tháng."},
    ]
    resolve_figures(blocks)
    assert blocks[0]["text"] == ""


def test_a_geometric_caption_from_the_pdf_layout_is_respected():
    """The PDF path finds captions by position; this layer must not overwrite it."""
    blocks = [fig("", meta={"caption": "Biểu đồ 4: tỷ lệ giao đúng hẹn theo vùng",
                            "caption_from": "below"})]
    resolve_figures(blocks)
    assert blocks[0]["text"].startswith("Biểu đồ 4")


def test_a_label_too_short_to_describe_anything_is_not_a_caption():
    blocks = [fig("![x](https://a/b.png)", ordinal=0),
              {"kind": "paragraph", "ordinal": 1, "text": "Hình 1"}]
    resolve_figures(blocks)
    assert blocks[0]["text"] == ""


def test_prose_on_the_same_line_as_the_image_is_kept():
    blocks = [fig("![](https://x/y.png) Kiến trúc xử lý tài liệu tri thức")]
    resolve_figures(blocks)
    assert "Kiến trúc xử lý tài liệu" in blocks[0]["text"]


# ── the helpers ────────────────────────────────────────────────────────────────

def test_parse_image_separates_alt_from_src():
    out = parse_image('![Sơ đồ](https://x/y.png "tiêu đề")')
    assert out == {"alt": "Sơ đồ", "src": "https://x/y.png"}


def test_parse_image_returns_none_for_prose():
    assert parse_image("Đoạn văn bình thường.") is None


def test_strip_images_leaves_a_sentence_that_mentions_a_picture():
    assert strip_images("Xem ![sơ đồ](https://x/y.png) ở trên.") == "Xem ở trên."


# ── the vision gate ────────────────────────────────────────────────────────────

class _Doc:
    id = 1
    title = "Tài liệu"
    sensitivity = None

    def __init__(self, policy):
        self.external_processing = policy


class _Db:
    def execute(self, *a, **k):
        return self

    def first(self):
        return None

    def commit(self):
        pass

    def rollback(self):
        pass


def test_vision_refuses_on_the_default_policy():
    """A picture in a BI document is often the most sensitive artifact in it — a
    revenue chart with a labelled axis, a screenshot of a customer record. It goes
    out only on an explicit 'full', never on the default."""
    from app.services.govern_doc_sources.figure_vision import describe_figures

    out = describe_figures(_Db(), _Doc("embedding"), [fig("", meta={"src": "https://x/y.png"})])
    assert out["described"] == 0
    assert out["reason"] == "policy_embedding"


def test_vision_refuses_when_processing_is_switched_off_entirely():
    from app.services.govern_doc_sources.figure_vision import describe_figures

    out = describe_figures(_Db(), _Doc("none"), [fig("", meta={"src": "https://x/y.png"})])
    assert out["reason"] == "policy_none"


def test_nothing_to_describe_is_reported_distinctly_from_being_forbidden():
    """"0 figures described" has four different causes and four different fixes;
    a report that cannot tell them apart sends someone to read the source."""
    from app.services.govern_doc_sources.figure_vision import describe_figures

    out = describe_figures(_Db(), _Doc("full"), [fig("đã có mô tả")])
    assert out["reason"] == "no_figures_without_text"


def test_the_policy_is_part_of_the_ast_fingerprint():
    """Otherwise granting 'full' leaves the old description-less tree in place —
    a permission change that never took effect."""
    import inspect

    from app.services.dashboard_ai_bot import govern_doc_ast

    source = inspect.getsource(govern_doc_ast.source_blocks)
    assert "processing_policy(doc)" in source
