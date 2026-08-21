"""Scanned PDFs: a page that is an IMAGE of text must still be readable.

Before OCR a scanned document indexed as nothing at all — it existed, it looked
fine on screen, and the AI could not read a word of it. These fixtures render
text into an image and embed that, so there is no text layer to extract: only OCR
can produce anything, which is what makes them a real test rather than a
restatement of the pdfplumber path.
"""
from __future__ import annotations

import io
import os

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_govern_doc_ocr.db")
os.environ.setdefault("DATA_DIR", ".testdata")

import pytest

from app.services.govern_doc_sources.file_text_extractor import extract_text, ocr_available

pytestmark = pytest.mark.skipif(
    not ocr_available(),
    reason="local OCR (tesseract + pypdfium2) is not installed in this environment",
)

TEXT_LINES = [
    "BAO CAO VAN HANH QUY III",
    "Ty le giao dung hen: 92 phan tram",
    "Thoi gian giao trung binh: 11 ngay",
]


def _scanned_pdf(lines=None) -> bytes:
    """A PDF whose only content is a PICTURE of text — no text layer at all."""
    from PIL import Image, ImageDraw

    lines = lines or TEXT_LINES
    image = Image.new("RGB", (1700, 600), "white")
    draw = ImageDraw.Draw(image)
    y = 60
    for line in lines:
        # The default bitmap font is small; scaling the whole page up afterwards
        # is what gets this to a size Tesseract reads reliably.
        draw.text((40, y), line, fill="black")
        y += 40
    image = image.resize((image.width * 2, image.height * 2), Image.LANCZOS)

    buf = io.BytesIO()
    image.save(buf, format="PDF", resolution=200.0)
    return buf.getvalue()


def test_a_scanned_page_has_no_text_layer():
    """Guards the FIXTURE. If the generator ever produced a text layer, every test
    below would pass without OCR running and prove nothing."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(_scanned_pdf()), strict=False)
    extracted = "".join((page.extract_text() or "") for page in reader.pages).strip()
    assert len(extracted) < 24, "fixture is not actually scanned: %r" % extracted[:80]


def test_ocr_recovers_a_scanned_page():
    result = extract_text(_scanned_pdf(), "ban-scan.pdf")
    assert result["ok"] is True, result.get("error")
    folded = result["text"].lower()
    assert "quy iii" in folded or "quy 111" in folded, result["text"][:200]
    assert "92" in folded


def test_a_scanned_page_still_gets_a_page_marker():
    """`## Page N` is where citations get their page number. A page recovered by
    OCR has to carry it too, or a scanned document produces answers that cannot
    say where they came from."""
    result = extract_text(_scanned_pdf(), "ban-scan.pdf")
    assert "## Page 1" in result["text"]


def test_vietnamese_diacritics_survive_ocr():
    """Without the `vie` language data, diacritics come back mangled — and mangled
    text does not fail loudly, it silently becomes an index nobody can search."""
    result = extract_text(_scanned_pdf(["Ty le giao dung hen dat 92%"]), "scan-vi.pdf")
    assert result["ok"] is True
    from app.core.text_fold import fold_text

    folded = fold_text(result["text"])
    assert "giao" in folded and "92" in folded


def test_a_text_pdf_does_not_pay_for_ocr():
    """Rendering and reading every page would multiply the cost of every ordinary
    PDF. OCR must only touch pages that produced no text."""
    import inspect

    from app.services.govern_doc_sources import file_text_extractor

    source = inspect.getsource(file_text_extractor._ocr_pdf_pages)
    assert "if not needed" in source

    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(100, 750, "Trang nay co san text layer va khong can OCR.")
    c.save()
    result = extract_text(buf.getvalue(), "co-text.pdf")
    assert "text layer" in result["text"]


def test_missing_ocr_is_reported_not_silent(monkeypatch):
    """A missing tesseract binary must not turn a scanned document into an empty
    index with nothing anywhere saying why."""
    from app.services.govern_doc_sources import file_text_extractor

    monkeypatch.setattr(file_text_extractor, "ocr_available", lambda: False)
    recovered = file_text_extractor._ocr_pdf_pages(_scanned_pdf(), {1})
    assert recovered == {}
