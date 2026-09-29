"""Render every page of an exported report PDF for review, and measure its fill.

    python e2e/acceptance/tools/pdf_review.py <file.pdf>

Writes <file>-page<N>.jpg next to the PDF and prints, per page, how far down
the content reaches (below the header band) and the tallest empty band inside
the content — the numbers behind "no half-empty sheet, no cut section". The
pages still have to be LOOKED AT: this measures space, not legibility.
Needs PyMuPDF (`pip install pymupdf`).
"""
from __future__ import annotations

import json
import sys

import fitz  # PyMuPDF


def page_fill(pix: "fitz.Pixmap", threshold: int = 245) -> dict:
    w, h, n = pix.width, pix.height, pix.n
    samples = pix.samples
    inked = []
    for y in range(h):
        row = samples[y * w * n:(y + 1) * w * n]
        dark = sum(1 for i in range(0, len(row), n) if min(row[i:i + min(3, n)]) < threshold)
        inked.append(dark > w * 0.004)
    rows = [y for y, ink in enumerate(inked) if ink]
    if not rows:
        return {"content_bottom": 0.0, "largest_gap": 1.0, "blank": True}
    top, bottom = rows[0], rows[-1]
    gap = run = 0
    for y in range(top, bottom + 1):
        run = 0 if inked[y] else run + 1
        gap = max(gap, run)
    return {"content_bottom": round(bottom / h, 3), "largest_gap": round(gap / h, 3), "blank": False}


def main() -> int:
    src = sys.argv[1]
    doc = fitz.open(src)
    report = []
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=80)
        name = src.replace(".pdf", f"-page{i + 1}.png")
        pix.save(name)
        report.append({"page": i + 1, "image": name, **page_fill(pix)})
    print(json.dumps({"pages": doc.page_count, "report": report}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
