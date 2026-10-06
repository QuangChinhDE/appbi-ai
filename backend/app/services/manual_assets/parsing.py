"""Bounded parsing of uploaded CSV / XLSX files into sheets.

Every limit is a named setting (``MANUAL_UPLOAD_*``) and is enforced WHILE
reading, so an oversized file is refused before it is fully materialised.

Output per sheet: ``{"columns": [{"name", "type"}], "rows": [dict, ...]}``.

Rules (deterministic, documented):

* Headers: first row. Blank header -> ``column_N`` (N = 1-based position).
  Duplicates -> ``name_2``, ``name_3`` ... skipping any name already taken.
  Width = the right-most non-empty cell across header AND data, so a value
  under a blank header is never dropped.
* Rows with no non-empty cell are skipped.
* Cell values: XLSX read with ``data_only=True`` — a formula cell yields the
  value Excel last cached for it (no formula evaluation). int/float/bool are
  kept; a datetime with a midnight time becomes ``YYYY-MM-DD``, otherwise
  ``YYYY-MM-DD HH:MM:SS``; date -> ISO date; anything else ``str(v).strip()``;
  empty -> ``""``. CSV values are strings.
* Column type (``number`` / ``date`` / ``string``) from the first 200 non-empty
  values: all numeric (thousands commas ignored) -> number; >= 80% matching
  ``^\\d{2,4}[-/]\\d{1,2}[-/]\\d{1,4}`` -> date; otherwise string.
* CSV: decoded as UTF-8 (BOM aware) / UTF-16 (BOM); otherwise the
  charset-normalizer best guess (only for >= 1 KB, never BOM-less UTF-16/32),
  then cp1252, then latin-1. Delimiter sniffed
  among ``, ; TAB |`` (default comma).
"""
from __future__ import annotations

import csv
import datetime as _dt
import io
import re
import zipfile
from typing import Any, Dict, IO, List, Optional, Tuple

from app.core.config import settings


class ManualUploadError(ValueError):
    """Safe, user-facing ingestion error (message never carries parser internals)."""

    def __init__(self, message: str, code: str = "invalid_file", status_code: int = 422):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


ALLOWED_EXTENSIONS = (".csv", ".xlsx")
_DATE_RE = re.compile(r"^\d{2,4}[-/]\d{1,2}[-/]\d{1,4}")
_TYPE_SAMPLE = 200


def file_extension(filename: Optional[str]) -> str:
    name = str(filename or "")
    return ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""


def check_extension(filename: Optional[str]) -> str:
    ext = file_extension(filename)
    if ext not in ALLOWED_EXTENSIONS:
        raise ManualUploadError(
            "Unsupported file type. Upload a .csv or .xlsx file "
            "(legacy .xls is not supported — save it as .xlsx first).",
            code="unsupported_type", status_code=400,
        )
    return ext


# ── helpers ──────────────────────────────────────────────────────────────────

def _is_number(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    try:
        float(str(v).replace(",", ""))
        return True
    except (ValueError, TypeError):
        return False


def infer_column_type(values: List[Any]) -> str:
    samples = [v for v in values if v is not None and str(v).strip() != ""][:_TYPE_SAMPLE]
    if not samples:
        return "string"
    if all(_is_number(v) for v in samples):
        return "number"
    if sum(1 for v in samples if _DATE_RE.match(str(v).strip())) >= len(samples) * 0.8:
        return "date"
    return "string"


def unique_headers(raw: List[Any], width: int) -> List[str]:
    out: List[str] = []
    taken: set = set()
    # Reserve every explicit header first so a generated name never collides
    # with a real one that appears later.
    explicit = [str(raw[i]).strip() if i < len(raw) and raw[i] is not None else "" for i in range(width)]
    reserved = {h.lower() for h in explicit if h}
    for i, h in enumerate(explicit):
        if not h:
            base, n = f"column_{i + 1}", 1
            cand = base
            while cand.lower() in taken or (cand.lower() in reserved):
                n += 1
                cand = f"{base}_{n}"
        else:
            cand, n = h, 1
            while cand.lower() in taken:
                n += 1
                cand = f"{h}_{n}"
        taken.add(cand.lower())
        out.append(cand)
    return out


def _normalise_cell(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, bool) or isinstance(v, (int, float)):
        return v
    if isinstance(v, _dt.datetime):
        if v.time() == _dt.time(0, 0):
            return v.date().isoformat()
        return v.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(v, _dt.date):
        return v.isoformat()
    if isinstance(v, _dt.time):
        return v.strftime("%H:%M:%S")
    return str(v).strip()


class _Budget:
    def __init__(self) -> None:
        self.total_cells = 0

    def add(self, n: int) -> None:
        self.total_cells += n
        if self.total_cells > settings.MANUAL_UPLOAD_MAX_TOTAL_CELLS:
            raise ManualUploadError(
                f"File has more than {settings.MANUAL_UPLOAD_MAX_TOTAL_CELLS:,} cells in total. "
                "Split it into smaller files.", code="too_many_cells",
            )


def _build_sheet(sheet: str, raw_rows: List[List[Any]]) -> Dict[str, Any]:
    """raw_rows[0] is the header row; cells already normalised."""
    if not raw_rows:
        return {"columns": [], "rows": []}
    width = 0
    for r in raw_rows:
        for i in range(len(r) - 1, -1, -1):
            if r[i] not in ("", None):
                width = max(width, i + 1)
                break
    if width > settings.MANUAL_UPLOAD_MAX_COLUMNS:
        raise ManualUploadError(
            f"Sheet '{sheet}' has {width} columns; the limit is {settings.MANUAL_UPLOAD_MAX_COLUMNS}.",
            code="too_many_columns",
        )
    headers = unique_headers(raw_rows[0], width)
    rows = []
    for r in raw_rows[1:]:
        rows.append({h: (r[i] if i < len(r) else "") for i, h in enumerate(headers)})
    columns = [{"name": h, "type": infer_column_type([row[h] for row in rows])} for h in headers]
    return {"columns": columns, "rows": rows}


def _accept_row(sheet: str, cells: List[Any], data_rows: int, budget: _Budget) -> bool:
    """Validate one normalised row; return False for an all-empty row."""
    if not any(c not in ("", None) for c in cells):
        return False
    if len(cells) > settings.MANUAL_UPLOAD_MAX_COLUMNS:
        # Trailing empties are allowed; a value past the limit is not.
        if any(c not in ("", None) for c in cells[settings.MANUAL_UPLOAD_MAX_COLUMNS:]):
            raise ManualUploadError(
                f"Sheet '{sheet}' has more than {settings.MANUAL_UPLOAD_MAX_COLUMNS} columns.",
                code="too_many_columns",
            )
    for col, c in enumerate(cells):
        if isinstance(c, str) and len(c) > settings.MANUAL_UPLOAD_MAX_CELL_CHARS:
            raise ManualUploadError(
                f"Sheet '{sheet}', row {data_rows + 1}, column {col + 1}: cell is longer than "
                f"{settings.MANUAL_UPLOAD_MAX_CELL_CHARS:,} characters.", code="cell_too_large",
            )
    if data_rows > settings.MANUAL_UPLOAD_MAX_ROWS:
        raise ManualUploadError(
            f"Sheet '{sheet}' has more than {settings.MANUAL_UPLOAD_MAX_ROWS:,} rows.",
            code="too_many_rows",
        )
    budget.add(len(cells))
    return True


# ── XLSX ─────────────────────────────────────────────────────────────────────

def check_xlsx_container(fh: IO[bytes]) -> None:
    """Zip-bomb / container guard BEFORE openpyxl touches the file."""
    try:
        with zipfile.ZipFile(fh) as zf:
            infos = zf.infolist()
    except (zipfile.BadZipFile, OSError, ValueError):
        raise ManualUploadError("The file is not a valid .xlsx workbook (it may be corrupt or an old .xls).")
    finally:
        fh.seek(0)
    if len(infos) > 10_000:
        raise ManualUploadError("The workbook has too many internal parts.", code="archive_too_large")
    total = 0
    for info in infos:
        total += int(info.file_size)
        if total > settings.MANUAL_UPLOAD_MAX_UNCOMPRESSED_BYTES:
            raise ManualUploadError(
                "The workbook expands to more than "
                f"{settings.MANUAL_UPLOAD_MAX_UNCOMPRESSED_BYTES // (1024 * 1024)} MB when opened.",
                code="archive_too_large",
            )
        if info.file_size > 1024 * 1024:
            ratio = info.file_size / max(1, info.compress_size)
            if ratio > settings.MANUAL_UPLOAD_MAX_COMPRESSION_RATIO:
                raise ManualUploadError(
                    "The workbook is compressed suspiciously well and was refused.",
                    code="archive_ratio",
                )


def parse_xlsx(fh: IO[bytes]) -> Dict[str, Dict[str, Any]]:
    check_xlsx_container(fh)
    import openpyxl

    try:
        wb = openpyxl.load_workbook(fh, read_only=True, data_only=True)
    except ManualUploadError:
        raise
    except Exception:
        raise ManualUploadError("The .xlsx workbook could not be read (it may be corrupt).")
    budget = _Budget()
    sheets: Dict[str, Dict[str, Any]] = {}
    try:
        names = list(wb.sheetnames)
        if len(names) > settings.MANUAL_UPLOAD_MAX_SHEETS:
            raise ManualUploadError(
                f"The workbook has {len(names)} sheets; the limit is {settings.MANUAL_UPLOAD_MAX_SHEETS}.",
                code="too_many_sheets",
            )
        for name in names:
            ws = wb[name]
            raw: List[List[Any]] = []
            header_seen = False
            data_rows = 0
            try:
                for values in ws.iter_rows(values_only=True):
                    cells = [_normalise_cell(v) for v in values]
                    if not header_seen:
                        if not any(c not in ("", None) for c in cells):
                            continue  # leading blank rows before the header
                        header_seen = True
                        _accept_row(name, cells, 0, budget)
                        raw.append(cells)
                        continue
                    if _accept_row(name, cells, data_rows + 1, budget):
                        data_rows += 1
                        raw.append(cells)
            except ManualUploadError:
                raise
            except Exception:
                raise ManualUploadError(f"Sheet '{name}' could not be read (the workbook may be corrupt).")
            sheets[name] = _build_sheet(name, raw)
    finally:
        wb.close()
    return sheets


# ── CSV ──────────────────────────────────────────────────────────────────────

def _decode_csv(content: bytes) -> str:
    if content.startswith(b"\xff\xfe") or content.startswith(b"\xfe\xff"):
        try:
            return content.decode("utf-16")
        except UnicodeDecodeError:
            pass
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        pass
    try:
        from charset_normalizer import from_bytes

        # Guessing is unreliable on short inputs and BOM-less UTF-16/32 is a
        # common false positive, so only trust it on >= 1 KB, never for those.
        if len(content) >= 1024:
            best = from_bytes(content[: 2 * 1024 * 1024]).best()
            enc = (best.encoding if best is not None else "") or ""
            if enc and not enc.lower().startswith(("utf_16", "utf_32", "utf-16", "utf-32")):
                return content.decode(enc)
    except Exception:
        pass
    try:
        return content.decode("cp1252")
    except UnicodeDecodeError:
        return content.decode("latin-1")


def sheet_name_from_filename(filename: Optional[str]) -> str:
    stem = str(filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    stem = stem.rsplit(".", 1)[0].strip()
    stem = re.sub(r"[\x00-\x1f]", "", stem)[:120]
    return stem or "Sheet1"


def parse_csv(content: bytes, filename: Optional[str]) -> Dict[str, Dict[str, Any]]:
    if b"\x00" in content[:4096] and not (content.startswith(b"\xff\xfe") or content.startswith(b"\xfe\xff")):
        raise ManualUploadError("The .csv file looks binary, not text.")
    text = _decode_csv(content)
    sample = text[:65536]
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        delimiter = ","
    sheet = sheet_name_from_filename(filename)
    old_limit = csv.field_size_limit()
    csv.field_size_limit(settings.MANUAL_UPLOAD_MAX_CELL_CHARS + 1)
    budget = _Budget()
    raw: List[List[Any]] = []
    data_rows = 0
    try:
        reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
        header_seen = False
        for row in reader:
            cells = [c.strip() for c in row]
            if not header_seen:
                if not any(cells):
                    continue
                header_seen = True
                _accept_row(sheet, cells, 0, budget)
                raw.append(cells)
                continue
            if _accept_row(sheet, cells, data_rows + 1, budget):
                data_rows += 1
                raw.append(cells)
    except csv.Error:
        raise ManualUploadError(
            f"The .csv file is malformed or a cell is longer than "
            f"{settings.MANUAL_UPLOAD_MAX_CELL_CHARS:,} characters.", code="cell_too_large",
        )
    finally:
        csv.field_size_limit(old_limit)
    return {sheet: _build_sheet(sheet, raw)}


def parse_file(fh: IO[bytes], filename: Optional[str]) -> Tuple[str, Dict[str, Dict[str, Any]]]:
    ext = check_extension(filename)
    if ext == ".xlsx":
        return ext, parse_xlsx(fh)
    return ext, parse_csv(fh.read(), filename)
