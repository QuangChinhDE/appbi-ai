"""Extract plain/markdown-ish text from an uploaded file (PDF/DOCX/XLSX) for a
Govern Knowledge Doc with source_type == 'file'. Dispatches by extension;
each branch is independent so a failure in one format never affects another.
Never raises — always returns {ok, text, error}.
"""
from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

_MAX_XLSX_ROWS_PER_SHEET = 500  # a doc body is prose, not a dataset — keep it readable


def _extract_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages = [(page.extract_text() or "").strip() for page in reader.pages]
    return "\n\n".join(p for p in pages if p)


def _extract_docx(data: bytes) -> str:
    import docx

    document = docx.Document(io.BytesIO(data))
    blocks = [p.text.strip() for p in document.paragraphs if p.text.strip()]
    for table in document.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                blocks.append(" | ".join(cells))
    return "\n\n".join(blocks)


def _extract_xlsx(data: bytes) -> str:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sections: list[str] = []
    for ws in wb.worksheets:
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= _MAX_XLSX_ROWS_PER_SHEET:
                rows.append(f"… ({ws.max_row} rows total, truncated)")
                break
            cells = [str(c) if c is not None else "" for c in row]
            if any(cells):
                rows.append(" | ".join(cells))
        if rows:
            sections.append(f"## {ws.title}\n\n" + "\n".join(rows))
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
    except Exception as exc:  # noqa: BLE001
        logger.warning("file_text_extractor: failed extracting %s", filename, exc_info=True)
        return {"ok": False, "error": f"Failed to read {ext} file: {exc}"}
    if not text:
        return {"ok": False, "error": "No readable text found in this file."}
    return {"ok": True, "text": text}
