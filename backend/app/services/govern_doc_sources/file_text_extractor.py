"""Extract markdown-ish text from uploaded PDF/DOCX/XLSX Knowledge Doc files.

The public contract is intentionally small: never raise, always return
{ok, text, error}. Callers decide whether to store the source blob.
"""
from __future__ import annotations

import io
import logging
from zipfile import BadZipFile

logger = logging.getLogger(__name__)

_MAX_XLSX_ROWS_PER_SHEET = 500
_MAX_XLSX_COLS_PER_SHEET = 50


def _md_cell(value) -> str:
    text = "" if value is None else str(value)
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>").replace("|", "\\|").strip()


def _markdown_table(rows: list[list[str]]) -> str:
    rows = [r for r in rows if any(c for c in r)]
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = [
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    out.extend("| " + " | ".join(r) + " |" for r in rows[1:])
    return "\n".join(out)


def _pdf_pages_with_tables(data: bytes) -> tuple[list[tuple[int, str]], set[int]]:
    """Page markdown with tables preserved as tables.

    pypdf returns a flat stream of words, so a financial table collapses into
    "Doanh thu / 100 ty / 92 ty" with no way to tell which number is the target
    and which is actual — the exact mistake that matters most in a BI product.
    pdfplumber knows where the table cells are, so we render those as markdown
    and take the remaining prose from outside the table areas.
    """
    import pdfplumber

    pages: list[tuple[int, str]] = []
    empty_pages: set[int] = set()
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            parts: list[str] = []
            try:
                found = page.find_tables()
            except Exception:  # noqa: BLE001
                found = []

            # Prose = words that do NOT sit inside a detected table, so table
            # cells are not duplicated once as text and once as a table.
            try:
                if found:
                    boxes = [t.bbox for t in found]

                    def outside(obj):
                        cx = (obj["x0"] + obj["x1"]) / 2
                        cy = (obj["top"] + obj["bottom"]) / 2
                        return not any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in boxes)

                    prose = (page.filter(outside).extract_text() or "").strip()
                else:
                    prose = (page.extract_text() or "").strip()
            except Exception:  # noqa: BLE001
                prose = (page.extract_text() or "").strip()
            if prose:
                parts.append(prose)

            for table in found:
                try:
                    rows = table.extract()
                except Exception:  # noqa: BLE001
                    continue
                md = _markdown_table([[_md_cell(c) for c in (row or [])] for row in (rows or [])])
                if md:
                    parts.append(md)

            joined = "\n\n".join(parts).strip()
            if len(joined) >= _OCR_TEXT_FLOOR:
                pages.append((index, f"## Page {index}\n\n{joined}"))
            else:
                # Kept as a candidate for OCR rather than dropped. Silently
                # skipping it is how a scanned document became an empty index.
                empty_pages.add(index)
    return pages, empty_pages


#: A page yielding fewer than this many characters of extractable text is treated
#: as an IMAGE of a page rather than a page of text. Scanned pages are not empty —
#: they usually carry a few stray glyphs from a letterhead or a page number — so a
#: strict zero would miss most of them.
_OCR_TEXT_FLOOR = 24

#: Render scale. Tesseract wants roughly 300 DPI; PDF user space is 72 DPI.
_OCR_SCALE = 300 / 72


def ocr_available() -> bool:
    """Whether local OCR can run. Reported rather than assumed, because a missing
    tesseract binary makes scanned documents silently index as empty."""
    try:
        import pypdfium2  # noqa: F401
        import pytesseract

        pytesseract.get_tesseract_version()
        return True
    except Exception:  # noqa: BLE001
        return False


def _ocr_pdf_page(pdf, page_index: int) -> str:
    """Read one page as an image, LOCALLY.

    Local by design. A cloud OCR service would send the page IMAGE — everything
    visible on the page, not just its prose — to a third party, and that is what
    `external_processing = 'full'` exists to authorise. Tesseract here means a
    scanned document becomes searchable with nothing leaving the building, so no
    permission is required and none is claimed.

    Vietnamese first in the language list, with English as a fallback for the
    mixed-language documents this corpus is full of. Without `vie`, diacritics
    come back mangled — and mangled text does not fail loudly, it just quietly
    becomes an index nobody can search.
    """
    import pytesseract

    page = pdf[page_index]
    bitmap = page.render(scale=_OCR_SCALE)
    try:
        image = bitmap.to_pil()
    finally:
        close = getattr(bitmap, "close", None)
        if close:
            close()
    return (pytesseract.image_to_string(image, lang="vie+eng") or "").strip()


def _ocr_pdf_pages(data: bytes, needed: set[int]) -> dict[int, str]:
    """OCR only the pages that produced no text. Rendering and reading a page is
    expensive; doing it for pages that already extracted cleanly would multiply
    the cost of every ordinary PDF for no gain."""
    if not needed:
        return {}
    if not ocr_available():
        logger.warning(
            "file_text_extractor: %s page(s) have no extractable text and local OCR "
            "is unavailable — those pages will not be indexed", len(needed),
        )
        return {}
    out: dict[int, str] = {}
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(io.BytesIO(data))
        try:
            for index in sorted(needed):
                if index - 1 >= len(pdf):
                    continue
                try:
                    text = _ocr_pdf_page(pdf, index - 1)
                except Exception:  # noqa: BLE001 — one bad page must not lose the rest
                    logger.warning("file_text_extractor: OCR failed on page %s", index, exc_info=True)
                    continue
                if len(text) >= _OCR_TEXT_FLOOR:
                    out[index] = text
        finally:
            pdf.close()
    except Exception:  # noqa: BLE001
        logger.warning("file_text_extractor: OCR pass failed", exc_info=True)
    if out:
        logger.info("file_text_extractor: OCR recovered %s scanned page(s)", len(out))
    return out


def _extract_pdf(data: bytes) -> str:
    """Prefer layout-aware extraction; fall back to a plain text read.

    pdfplumber is slower and can choke on unusual PDFs, so pypdf remains the
    safety net — a document that yields flat text is still far better than an
    upload that fails outright.
    """
    try:
        pages, empty_pages = _pdf_pages_with_tables(data)
        # A page with no extractable text is an IMAGE of a page. That is the whole
        # scanned-PDF case, and before OCR it indexed as nothing at all — the
        # document existed, looked fine on screen, and the AI could not read a
        # word of it.
        recovered = _ocr_pdf_pages(data, empty_pages)
        for index, text in recovered.items():
            pages.append((index, f"## Page {index}\n\n{text}"))
        if pages:
            return "\n\n".join(text for _index, text in sorted(pages))
    except Exception:  # noqa: BLE001
        logger.warning("file_text_extractor: pdfplumber failed, falling back to pypdf", exc_info=True)

    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data), strict=False)
    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")
        except Exception:  # noqa: BLE001
            logger.info("file_text_extractor: encrypted PDF could not be opened with an empty password")

    pages = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:  # noqa: BLE001
            logger.warning("file_text_extractor: failed extracting PDF page %s", index, exc_info=True)
            continue
        if text:
            pages.append(f"## Page {index}\n\n{text}")
    return "\n\n".join(pages)


def _extract_docx(data: bytes) -> str:
    import docx

    document = docx.Document(io.BytesIO(data))
    blocks: list[str] = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        style = (getattr(paragraph.style, "name", "") or "").lower()
        if style.startswith("heading"):
            digits = "".join(ch for ch in style if ch.isdigit())
            level = max(1, min(6, int(digits or "2")))
            blocks.append(f"{'#' * level} {text}")
        elif style.startswith("list"):
            blocks.append(f"- {text}")
        else:
            blocks.append(text)

    for table in document.tables:
        table_md = _markdown_table([[_md_cell(cell.text) for cell in row.cells] for row in table.rows])
        if table_md:
            blocks.append(table_md)

    images: list[str] = []
    for rel in document.part.rels.values():
        if "image" in getattr(rel, "reltype", ""):
            images.append(getattr(rel, "target_ref", "") or getattr(rel, "rId", "image"))
    if images:
        blocks.append("## Embedded images\n\n" + "\n".join(f"- {name}" for name in images))

    return "\n\n".join(blocks)


def _extract_xlsx(data: bytes) -> str:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sections: list[str] = []
    for ws in wb.worksheets:
        rows: list[list[str]] = []
        for index, row in enumerate(ws.iter_rows(values_only=True)):
            if index >= _MAX_XLSX_ROWS_PER_SHEET:
                rows.append([f"... ({ws.max_row} rows total, truncated)"])
                break
            cells = [_md_cell(value) for value in row[:_MAX_XLSX_COLS_PER_SHEET]]
            if any(cells):
                rows.append(cells)
        table_md = _markdown_table(rows)
        if table_md:
            sections.append(f"## {ws.title}\n\n{table_md}")
    return "\n\n".join(sections)


_EXTRACTORS = {".pdf": _extract_pdf, ".docx": _extract_docx, ".xlsx": _extract_xlsx}


def extract_text(data: bytes, filename: str) -> dict:
    """Returns {ok, text, error}."""
    ext = "." + (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""
    extractor = _EXTRACTORS.get(ext)
    if not extractor:
        return {"ok": False, "error": f"Unsupported file type '{ext or filename}'. Allowed: .pdf, .docx, .xlsx"}
    try:
        text = (extractor(data) or "").strip()
    except BadZipFile:
        logger.warning("file_text_extractor: invalid Office zip for %s", filename, exc_info=True)
        return {
            "ok": False,
            "error": f"{ext} file is not a valid Office Open XML file. If this is an older .xls file, save it as .xlsx and upload again.",
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("file_text_extractor: failed extracting %s", filename, exc_info=True)
        return {"ok": False, "error": f"Failed to read {ext} file: {exc}"}
    if not text:
        return {"ok": False, "error": "No readable text found in this file."}
    return {"ok": True, "text": text}
