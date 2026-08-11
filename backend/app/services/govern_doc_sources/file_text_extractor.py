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


def _pdf_pages_with_tables(data: bytes) -> list[str]:
    """Page markdown with tables preserved as tables.

    pypdf returns a flat stream of words, so a financial table collapses into
    "Doanh thu / 100 ty / 92 ty" with no way to tell which number is the target
    and which is actual — the exact mistake that matters most in a BI product.
    pdfplumber knows where the table cells are, so we render those as markdown
    and take the remaining prose from outside the table areas.
    """
    import pdfplumber

    pages: list[str] = []
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

            if parts:
                pages.append(f"## Page {index}\n\n" + "\n\n".join(parts))
    return pages


def _extract_pdf(data: bytes) -> str:
    """Prefer layout-aware extraction; fall back to a plain text read.

    pdfplumber is slower and can choke on unusual PDFs, so pypdf remains the
    safety net — a document that yields flat text is still far better than an
    upload that fails outright.
    """
    try:
        pages = _pdf_pages_with_tables(data)
        if pages:
            return "\n\n".join(pages)
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
