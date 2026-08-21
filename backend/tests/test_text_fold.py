"""The one folding function must agree with the database's `appbi_unaccent`.

Expectations below are not hand-written: they are the output `appbi_unaccent`
actually produced for these inputs, captured from Postgres. If Python and
Postgres ever diverge, the keyword half of retrieval starts matching things the
application thinks it should not, and missing things it thinks it should — a
class of bug that shows up as "search is a bit off" and takes days to trace.
"""
from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_text_fold.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.core.text_fold import fold_text, fold_tokens, strip_diacritics

#: input -> exactly what `SELECT appbi_unaccent(input)` returned in Postgres.
POSTGRES_UNACCENT = [
    ("Đơn hàng đã thanh toán", "Don hang da thanh toan"),
    ("Tỷ lệ giao đúng hẹn", "Ty le giao dung hen"),
    ("Khách hàng", "Khach hang"),
    ("Doanh thu & GMV", "Doanh thu & GMV"),
    ("Giá trị đơn trung bình", "Gia tri don trung binh"),
    ("Từ vựng & Quy ước", "Tu vung & Quy uoc"),
    ("Điểm đánh giá", "Diem danh gia"),
    ("Phí vận chuyển", "Phi van chuyen"),
    ("ĐƠN HÀNG", "DON HANG"),
    ("2–3 tuần", "2-3 tuan"),
    ("R$ (BRL)", "R$ (BRL)"),
    ("naïve café ß Ø ł", "naive cafe ss O l"),
    ("cấp đơn hàng", "cap don hang"),
]


@pytest.mark.parametrize("raw,expected", POSTGRES_UNACCENT)
def test_strip_diacritics_matches_postgres_unaccent(raw, expected):
    assert strip_diacritics(raw) == expected


def test_d_with_stroke_is_folded():
    """The defect that motivated this module. No Unicode normalisation form
    decomposes U+0111, so twelve helpers built on `normalize()` alone left it
    intact — and every Vietnamese phrase containing it failed to match."""
    assert "đ" not in fold_text("đơn hàng đã thanh toán")
    assert fold_text("Đơn") == "don"


def test_en_dash_folds_to_hyphen():
    """A document written in a word processor says "2–3 tuần"; a person types
    "2-3". Postgres folds both to the same thing and so must we."""
    assert fold_text("2–3 tuần") == fold_text("2-3 tuan")


def test_fold_text_is_lowercase_and_whitespace_collapsed():
    assert fold_text("  Tỷ   LỆ \n giao ") == "ty le giao"


def test_fold_tokens_drops_single_characters():
    """A one-character token matches nearly every passage, so it is noise in a
    keyword match rather than signal."""
    assert fold_tokens("Điểm đánh giá 5 sao") == {"diem", "danh", "gia", "sao"}


def test_folding_is_idempotent():
    for raw, _ in POSTGRES_UNACCENT:
        once = fold_text(raw)
        assert fold_text(once) == once
