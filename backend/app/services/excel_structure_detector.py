"""
Smart Excel Structure Detector — V1 (Rule-based, no AI).

Analyzes an uploaded Excel file and auto-detects:
  - Header zone (company name, report title, exchange rate)
  - Column group rows (merged header cells)
  - Data header row (column names)
  - Data rows + subtotal/group rows
  - Footer zone (notes, signature boxes)

Returns an AnalysisResult dict that the frontend can preview / edit
before confirming template creation.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field, asdict
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

import openpyxl
from openpyxl.worksheet.worksheet import Worksheet

from app.services.excel_parser import (
    _build_merge_map,
    _color_hex,
    _col_width_px,
    _row_height_px,
    _border_sides,
    _is_row_empty,
    USABLE_W,
    MIN_COL_WIDTH_PX,
)

# ── Constants ─────────────────────────────────────────────────────────

_SIGNATURE_KEYWORDS = {
    "ky ten", "chu ky", "ký tên", "chữ ký", "signature",
    "nguoi lap", "người lập", "prepared by", "made by",
    "ke toan", "kế toán", "accountant",
    "giam doc", "giám đốc", "director",
    "truong phong", "trưởng phòng", "manager",
    "phe duyet", "phê duyệt", "approved",
    "xac nhan", "xác nhận", "confirmed",
}

_META_KEYWORDS = {
    "ty gia", "tỷ giá", "exchange", "rate",
    "ky bao cao", "kỳ báo cáo", "period",
    "ngay", "ngày", "date", "thang", "tháng", "nam", "năm",
}

_CURRENCY_PATTERNS = re.compile(
    r'\b(USD|KIP|VND|LAK|THB|EUR|JPY|CNY|đồng|dong)\b', re.IGNORECASE,
)


# ── Row classification ────────────────────────────────────────────────

@dataclass
class _RowInfo:
    row_idx: int
    non_empty_count: int = 0
    numeric_count: int = 0
    bold_count: int = 0
    non_empty_bold_count: int = 0
    merge_spans: list = field(default_factory=list)
    max_merge_span: int = 0
    max_text_len: int = 0
    bg_color: Optional[str] = None
    total_visible_cells: int = 0
    is_empty: bool = True
    numeric_ratio: float = 0.0
    fill_ratio: float = 0.0
    all_bold: bool = False
    texts: list = field(default_factory=list)


def _classify_row(
    ws: Worksheet,
    r: int,
    min_col: int,
    max_col: int,
    anchor_map: Dict,
    hidden_set: set,
    num_cols: int,
) -> _RowInfo:
    """Compute metrics for a single row."""
    info = _RowInfo(row_idx=r)
    for c in range(min_col, max_col + 1):
        if (r, c) in hidden_set:
            continue
        cell = ws.cell(row=r, column=c)
        text = str(cell.value).strip() if cell.value is not None else ""
        info.total_visible_cells += 1

        if text:
            info.non_empty_count += 1
            info.max_text_len = max(info.max_text_len, len(text))
            info.texts.append(text)
        if _is_numeric_text(text):
            info.numeric_count += 1
        font = cell.font
        if font and font.bold:
            info.bold_count += 1
            if text:
                info.non_empty_bold_count += 1
        if (r, c) in anchor_map:
            _, cs = anchor_map[(r, c)]
            if cs > 1:
                info.merge_spans.append(cs)
                info.max_merge_span = max(info.max_merge_span, cs)
        if info.bg_color is None and cell.fill:
            bg = _color_hex(cell.fill.fgColor)
            if bg:
                info.bg_color = bg

    info.is_empty = info.non_empty_count == 0
    info.numeric_ratio = (
        info.numeric_count / info.non_empty_count
        if info.non_empty_count > 0
        else 0.0
    )
    info.fill_ratio = info.non_empty_count / max(num_cols, 1)
    info.all_bold = (
        info.non_empty_bold_count > 0
        and info.non_empty_bold_count == info.non_empty_count
    )
    return info


# ── Number / type helpers ─────────────────────────────────────────────

def _is_numeric_text(text: str) -> bool:
    """Check if text looks like a number (handles commas, spaces, parens)."""
    if not text:
        return False
    cleaned = text.replace(",", "").replace(" ", "").replace("\u00a0", "")
    cleaned = cleaned.strip()
    if cleaned.startswith("(") and cleaned.endswith(")"):
        cleaned = cleaned[1:-1]
    if cleaned.endswith("%"):
        cleaned = cleaned[:-1]
    if cleaned in ("-", "—", "–", ""):
        return False
    try:
        float(cleaned)
        return True
    except ValueError:
        return False


def _infer_column_type(
    values: List[str],
) -> Tuple[str, str, Optional[str], bool]:
    """
    Sample values and infer (format, align, suffix, highlight_negative).

    Returns: (format, align, suffix, highlight_negative)
    """
    samples = [v for v in values if v and v not in ("-", "—", "–", "0")][:20]
    if not samples:
        return "text", "left", None, False

    num_count = sum(1 for v in samples if _is_numeric_text(v))
    pct_count = sum(1 for v in samples if "%" in v)
    has_negative = any(
        v.startswith("-") or v.startswith("(")
        for v in samples
        if _is_numeric_text(v)
    )

    # Percentage
    if pct_count >= len(samples) * 0.5:
        return "percentage", "right", "%", has_negative

    # Numeric
    if num_count >= len(samples) * 0.6:
        # Check decimal
        decimal_count = sum(
            1 for v in samples
            if _is_numeric_text(v) and "." in v.replace(",", "")
        )
        fmt = "decimal" if decimal_count > len(samples) * 0.3 else "integer"

        # Detect currency suffix from values
        suffix = None
        all_text = " ".join(samples)
        m = _CURRENCY_PATTERNS.search(all_text)
        if m:
            suffix = m.group(1).upper()

        return fmt, "right", suffix, has_negative

    return "text", "left", None, False


def _to_snake_case(label: str) -> str:
    """Convert label to snake_case key, stripping diacritics."""
    # Normalize unicode → decompose diacritics
    nfkd = unicodedata.normalize("NFKD", label)
    ascii_only = nfkd.encode("ascii", "ignore").decode("ascii")
    # Replace non-alnum with underscore
    result = re.sub(r"[^a-zA-Z0-9]+", "_", ascii_only)
    result = result.strip("_").lower()
    return result or "col"


def _luminance(hex_color: str) -> float:
    """Compute relative luminance of a hex color."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        return 0.5
    r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255


def _contains_keyword(texts: List[str], keywords: set) -> bool:
    """Check if any text in list contains a keyword."""
    joined = " ".join(texts).lower()
    return any(kw in joined for kw in keywords)


# ── Main analyzer ─────────────────────────────────────────────────────

def analyze_excel_structure(
    file_bytes: bytes,
    sheet_name: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Analyze an Excel file and return detected structure.

    Returns a dict suitable for JSON serialization with keys:
        header_lines, report_title, report_meta, column_groups,
        columns, group_by_column, show_subtotals, footer_lines,
        signature_count, signature_labels, theme,
        recommended_table_schema, data_preview, total_data_rows,
        confidence, sheet_names, analyzed_sheet
    """

    wb = openpyxl.load_workbook(BytesIO(file_bytes), data_only=True)
    all_sheet_names = wb.sheetnames

    if sheet_name and sheet_name in all_sheet_names:
        ws = wb[sheet_name]
    else:
        ws = wb.active
        sheet_name = ws.title

    min_row = ws.min_row or 1
    max_row = ws.max_row or 1
    min_col = ws.min_column or 1
    max_col = ws.max_column or 1
    num_cols = max_col - min_col + 1

    anchor_map, hidden_set = _build_merge_map(ws)

    # ── Phase 1: Classify every row ──────────────────────────────────
    row_infos: Dict[int, _RowInfo] = {}
    for r in range(min_row, max_row + 1):
        row_infos[r] = _classify_row(ws, r, min_col, max_col, anchor_map, hidden_set, num_cols)

    # ── Phase 2: Find data header row ────────────────────────────────
    data_header_row = _find_data_header_row(row_infos, min_row, max_row, num_cols)

    if data_header_row is None:
        # Fallback: cannot detect structure, return minimal result
        return _minimal_result(ws, all_sheet_names, sheet_name, row_infos, min_row, max_row, min_col, max_col, num_cols)

    # ── Phase 3: Header zone (above data header) ─────────────────────
    header_lines, report_title, report_meta, column_groups = _detect_header_zone(
        ws, row_infos, anchor_map, min_row, data_header_row, min_col, max_col, num_cols,
    )

    # ── Phase 4: Columns from data header row ────────────────────────
    columns, col_indices = _detect_columns(
        ws, data_header_row, min_col, max_col, anchor_map, hidden_set,
    )

    # ── Phase 5: Data zone + subtotals ───────────────────────────────
    data_start = data_header_row + 1
    data_end, group_by_column, show_subtotals, subtotal_bg = _detect_data_zone(
        ws, row_infos, data_start, max_row, columns, min_col,
    )

    # ── Phase 6: Footer zone ─────────────────────────────────────────
    footer_lines, signature_count, signature_labels = _detect_footer(
        ws, row_infos, data_end + 1, max_row, min_col, max_col,
    )

    # ── Phase 7: Column type inference from data ─────────────────────
    _enrich_columns_with_data(ws, columns, col_indices, data_start, data_end)

    # ── Phase 8: Column groups mapping ───────────────────────────────
    mapped_groups = _map_column_groups_to_columns(column_groups, col_indices, min_col, columns)

    # ── Phase 9: Theme extraction ────────────────────────────────────
    theme = _extract_theme(row_infos, data_header_row, subtotal_bg)

    # ── Phase 10: Recommended table schema ───────────────────────────
    table_schema = [
        {
            "name": c["key"],
            "display_name": c["label"],
            "type": "number" if c["format"] in ("integer", "decimal", "percentage") else "string",
        }
        for c in columns
    ]

    # ── Phase 11: Data preview (first 5 rows) ────────────────────────
    data_preview = _extract_data_preview(ws, columns, col_indices, data_start, min(data_start + 4, data_end))

    # ── Phase 12: Confidence score ───────────────────────────────────
    total_data_rows = max(0, data_end - data_start + 1)
    confidence = _compute_confidence(
        data_header_row is not None,
        total_data_rows,
        len(header_lines),
        len(mapped_groups),
        show_subtotals,
        signature_count,
        columns,
    )

    return {
        "header_lines": header_lines,
        "report_title": report_title,
        "report_meta": report_meta,
        "column_groups": mapped_groups,
        "columns": columns,
        "group_by_column": group_by_column,
        "show_subtotals": show_subtotals,
        "footer_lines": footer_lines,
        "signature_count": signature_count,
        "signature_labels": signature_labels,
        "theme": theme,
        "recommended_table_schema": table_schema,
        "data_preview": data_preview,
        "total_data_rows": total_data_rows,
        "confidence": round(confidence, 2),
        "sheet_names": all_sheet_names,
        "analyzed_sheet": sheet_name,
    }


# ── Phase 2: Data header row detection ────────────────────────────────

def _find_data_header_row(
    row_infos: Dict[int, _RowInfo],
    min_row: int,
    max_row: int,
    num_cols: int,
) -> Optional[int]:
    """Find the data header row — the row where column names live."""
    rows = sorted(row_infos.keys())

    for i, r in enumerate(rows):
        info = row_infos[r]
        if info.is_empty:
            continue

        # Candidate: many non-empty short-text cells, few merges, low numeric ratio
        if (
            info.non_empty_count >= max(3, num_cols * 0.3)
            and info.max_text_len <= 50
            and info.numeric_ratio < 0.35
            and info.max_merge_span <= 2
        ):
            # Verify: next non-empty row should have higher numeric ratio
            for j in range(i + 1, min(i + 4, len(rows))):
                next_info = row_infos[rows[j]]
                if next_info.is_empty:
                    continue
                if next_info.numeric_ratio > 0.25 or next_info.non_empty_count >= info.non_empty_count * 0.5:
                    return r
                break

    # Fallback: first row with many cells
    for r in rows:
        info = row_infos[r]
        if info.non_empty_count >= max(3, num_cols * 0.4) and not info.is_empty:
            return r
    return None


# ── Phase 3: Header zone ─────────────────────────────────────────────

def _detect_header_zone(
    ws: Worksheet,
    row_infos: Dict[int, _RowInfo],
    anchor_map: Dict,
    min_row: int,
    data_header_row: int,
    min_col: int,
    max_col: int,
    num_cols: int,
) -> Tuple[List[Dict], str, Optional[str], List[Dict]]:
    """Detect header lines, title, meta, and column group rows above data header."""
    header_lines: List[Dict] = []
    report_title = ""
    report_meta: Optional[str] = None
    column_groups_raw: List[Dict] = []

    if data_header_row <= min_row:
        return header_lines, report_title, report_meta, column_groups_raw

    # Scan rows above data header, bottom-up to find column groups first
    rows_above = [r for r in range(min_row, data_header_row) if r in row_infos and not row_infos[r].is_empty]

    # Column group rows: immediately above data header, have partial merges
    col_group_rows = []
    for r in reversed(rows_above):
        info = row_infos[r]
        has_partial_merges = (
            len(info.merge_spans) >= 2
            and all(s <= num_cols * 0.7 for s in info.merge_spans)
        )
        if has_partial_merges and info.non_empty_count >= 2:
            col_group_rows.insert(0, r)
        else:
            break  # Stop once we hit non-column-group rows

    # Extract column groups
    for gr in col_group_rows:
        for c in range(min_col, max_col + 1):
            if (gr, c) in anchor_map:
                rs, cs = anchor_map[(gr, c)]
                if cs >= 2:
                    cell = ws.cell(row=gr, column=c)
                    text = str(cell.value).strip() if cell.value is not None else ""
                    if text:
                        column_groups_raw.append({
                            "label": text,
                            "start_col": c,
                            "col_span": cs,
                        })

    # Header rows: everything above column group rows
    header_rows = [r for r in rows_above if r not in col_group_rows]

    # Find title: row with widest merge or largest text that's bold
    best_title_row = None
    best_title_score = 0
    for r in header_rows:
        info = row_infos[r]
        score = info.max_merge_span * 2 + (1 if info.all_bold else 0)
        if score > best_title_score and info.non_empty_count > 0:
            best_title_score = score
            best_title_row = r

    for r in header_rows:
        info = row_infos[r]
        if info.is_empty:
            continue

        row_text = " ".join(info.texts).strip()
        if not row_text:
            continue

        # Check if this is the title row
        if r == best_title_row and best_title_score > 2:
            report_title = row_text
            continue

        # Check if meta (exchange rate, period)
        if _contains_keyword(info.texts, _META_KEYWORDS) and report_meta is None:
            report_meta = row_text
            continue

        # Regular header line
        right_text = None
        if len(info.texts) >= 2:
            # Detect 2-column header: left text + right text
            left_texts = []
            right_texts = []
            mid = (min_col + max_col) // 2
            for c in range(min_col, max_col + 1):
                cell = ws.cell(row=r, column=c)
                text = str(cell.value).strip() if cell.value is not None else ""
                if text:
                    if c <= mid:
                        left_texts.append(text)
                    else:
                        right_texts.append(text)
            if left_texts and right_texts:
                row_text = " ".join(left_texts)
                right_text = " ".join(right_texts)

        font_size = "base"
        if info.max_merge_span >= num_cols * 0.5:
            font_size = "lg"
        elif info.non_empty_count <= 2:
            font_size = "sm"

        header_lines.append({
            "text": row_text,
            "right_text": right_text,
            "align": "left",
            "bold": info.all_bold,
            "font_size": font_size,
        })

    # If no explicit title found, use first bold header line
    if not report_title and header_lines:
        for i, hl in enumerate(header_lines):
            if hl.get("bold"):
                report_title = hl["text"]
                header_lines.pop(i)
                break

    return header_lines, report_title, report_meta, column_groups_raw


# ── Phase 4: Column detection ────────────────────────────────────────

def _detect_columns(
    ws: Worksheet,
    data_header_row: int,
    min_col: int,
    max_col: int,
    anchor_map: Dict,
    hidden_set: set,
) -> Tuple[List[Dict], List[int]]:
    """Extract column definitions from the data header row."""
    columns: List[Dict] = []
    col_indices: List[int] = []  # 1-based Excel column indices

    for c in range(min_col, max_col + 1):
        if (data_header_row, c) in hidden_set:
            continue
        cell = ws.cell(row=data_header_row, column=c)
        text = str(cell.value).strip() if cell.value is not None else ""
        if not text:
            continue

        key = _to_snake_case(text)
        # Ensure unique keys
        existing_keys = [col["key"] for col in columns]
        if key in existing_keys:
            key = f"{key}_{len(columns) + 1}"
        if not key:
            key = f"col_{len(columns) + 1}"

        width = _col_width_px(ws, c)

        columns.append({
            "label": text,
            "key": key,
            "inferred_type": "text",
            "width_px": round(width, 1),
            "align": "left",
            "format": "text",
            "suffix": None,
            "bold": False,
            "highlight_negative": False,
            "source_col_idx": c,
        })
        col_indices.append(c)

    return columns, col_indices


# ── Phase 5: Data zone + subtotal detection ──────────────────────────

def _detect_data_zone(
    ws: Worksheet,
    row_infos: Dict[int, _RowInfo],
    data_start: int,
    max_row: int,
    columns: List[Dict],
    min_col: int,
) -> Tuple[int, Optional[str], bool, Optional[str]]:
    """
    Detect data end, group-by column, subtotals.
    Returns: (data_end_row, group_by_column, show_subtotals, subtotal_bg)
    """
    data_end = data_start
    subtotal_rows: List[int] = []
    consecutive_empty = 0
    expected_fill = len(columns)

    for r in range(data_start, max_row + 1):
        info = row_infos.get(r)
        if info is None or info.is_empty:
            consecutive_empty += 1
            if consecutive_empty >= 2:
                break
            continue
        consecutive_empty = 0

        # Check if this looks like a data or subtotal row
        if info.non_empty_count >= expected_fill * 0.3:
            data_end = r
            # Subtotal: bold row with different pattern
            if (
                info.all_bold
                and info.non_empty_count < expected_fill * 0.8
                and info.numeric_ratio > 0.3
            ):
                subtotal_rows.append(r)
        elif info.fill_ratio < 0.15:
            # Very sparse row — likely end of data
            break
        else:
            data_end = r

    # Determine group-by column from subtotal rows
    group_by_column: Optional[str] = None
    show_subtotals = len(subtotal_rows) > 0
    subtotal_bg: Optional[str] = None

    if subtotal_rows and columns:
        subtotal_bg = row_infos.get(subtotal_rows[0], _RowInfo(0)).bg_color
        # Group-by: find the leftmost text column that has value in subtotal rows
        for col in columns:
            ci = col["source_col_idx"]
            cell = ws.cell(row=subtotal_rows[0], column=ci)
            text = str(cell.value).strip() if cell.value is not None else ""
            if text and not _is_numeric_text(text):
                group_by_column = col["key"]
                break

    return data_end, group_by_column, show_subtotals, subtotal_bg


# ── Phase 6: Footer detection ────────────────────────────────────────

def _detect_footer(
    ws: Worksheet,
    row_infos: Dict[int, _RowInfo],
    footer_start: int,
    max_row: int,
    min_col: int,
    max_col: int,
) -> Tuple[List[str], int, List[str]]:
    """Detect footer lines and signature slots."""
    footer_lines: List[str] = []
    signature_count = 0
    signature_labels: List[str] = []

    for r in range(footer_start, max_row + 1):
        info = row_infos.get(r)
        if info is None or info.is_empty:
            continue

        # Check for signature keywords
        if _contains_keyword(info.texts, _SIGNATURE_KEYWORDS):
            # These texts are likely signature labels
            for text in info.texts:
                text_lower = text.lower()
                if any(kw in text_lower for kw in _SIGNATURE_KEYWORDS):
                    signature_labels.append(text)
                    signature_count += 1
            continue

        # Check for bordered empty cells (signature boxes)
        bordered_empty = 0
        for c in range(min_col, max_col + 1):
            cell = ws.cell(row=r, column=c)
            text = str(cell.value).strip() if cell.value is not None else ""
            borders = _border_sides(cell.border)
            if not text and borders and borders.get("bottom"):
                bordered_empty += 1

        if bordered_empty >= 2:
            if not signature_count:
                signature_count = bordered_empty
            continue

        # Regular footer text
        row_text = " ".join(info.texts).strip()
        if row_text:
            footer_lines.append(row_text)

    return footer_lines, signature_count, signature_labels


# ── Phase 7: Enrich columns with data samples ────────────────────────

def _enrich_columns_with_data(
    ws: Worksheet,
    columns: List[Dict],
    col_indices: List[int],
    data_start: int,
    data_end: int,
) -> None:
    """Sample data rows to infer column types, formats, suffixes."""
    sample_end = min(data_start + 19, data_end)

    for i, col in enumerate(columns):
        ci = col_indices[i]
        values: List[str] = []
        for r in range(data_start, sample_end + 1):
            cell = ws.cell(row=r, column=ci)
            text = str(cell.value).strip() if cell.value is not None else ""
            values.append(text)

        fmt, align, suffix, highlight_neg = _infer_column_type(values)
        col["format"] = fmt
        col["inferred_type"] = fmt
        col["align"] = align
        col["highlight_negative"] = highlight_neg
        if suffix:
            col["suffix"] = suffix

        # Also check header label for currency hints
        if not col["suffix"]:
            m = _CURRENCY_PATTERNS.search(col["label"])
            if m:
                col["suffix"] = m.group(1).upper()


# ── Phase 8: Map column groups ───────────────────────────────────────

def _map_column_groups_to_columns(
    raw_groups: List[Dict],
    col_indices: List[int],
    min_col: int,
    columns: List[Dict],
) -> List[Dict]:
    """Map raw column groups (Excel col ranges) to detected column indices."""
    mapped: List[Dict] = []
    for g in raw_groups:
        start_excel = g["start_col"]
        end_excel = start_excel + g["col_span"] - 1

        # Find which detected columns fall in this range
        start_idx = None
        span = 0
        for i, ci in enumerate(col_indices):
            if start_excel <= ci <= end_excel:
                if start_idx is None:
                    start_idx = i
                span += 1

        if start_idx is not None and span > 0:
            mapped.append({
                "label": g["label"],
                "start_col_idx": start_idx,
                "span": span,
            })

    return mapped


# ── Phase 9: Theme extraction ────────────────────────────────────────

def _extract_theme(
    row_infos: Dict[int, _RowInfo],
    data_header_row: int,
    subtotal_bg: Optional[str],
) -> Dict[str, str]:
    """Extract theme colors from the data header row and subtotal rows."""
    header_info = row_infos.get(data_header_row)
    header_bg = header_info.bg_color if header_info else None

    if not header_bg:
        header_bg = "#073763"

    header_text = "#ffffff" if _luminance(header_bg) < 0.5 else "#000000"

    theme = {
        "header_bg": header_bg,
        "header_text": header_text,
        "group_bg": "#c9daf8",
        "group_text": "#073763",
        "subtotal_bg": subtotal_bg or "#dbeafe",
        "subtotal_text": "#1e40af",
        "accent_color": header_bg,
    }
    return theme


# ── Phase 11: Data preview ───────────────────────────────────────────

def _extract_data_preview(
    ws: Worksheet,
    columns: List[Dict],
    col_indices: List[int],
    data_start: int,
    data_end: int,
) -> List[Dict[str, Any]]:
    """Extract first N data rows for preview."""
    preview: List[Dict[str, Any]] = []
    for r in range(data_start, data_end + 1):
        row_data: Dict[str, Any] = {}
        for i, col in enumerate(columns):
            ci = col_indices[i]
            cell = ws.cell(row=r, column=ci)
            val = cell.value
            if val is None:
                row_data[col["key"]] = ""
            elif isinstance(val, (int, float)):
                row_data[col["key"]] = val
            else:
                row_data[col["key"]] = str(val).strip()
        preview.append(row_data)
    return preview


# ── Phase 12: Confidence score ───────────────────────────────────────

def _compute_confidence(
    header_found: bool,
    total_data_rows: int,
    num_header_lines: int,
    num_col_groups: int,
    show_subtotals: bool,
    signature_count: int,
    columns: List[Dict],
) -> float:
    """Compute confidence score 0.0 - 1.0."""
    score = 0.0
    if header_found:
        score += 0.30
    if total_data_rows >= 3:
        score += 0.20
    if num_header_lines > 0:
        score += 0.10
    if num_col_groups > 0:
        score += 0.10
    if show_subtotals:
        score += 0.10
    if signature_count > 0:
        score += 0.10
    num_typed = sum(1 for c in columns if c["format"] != "text")
    if num_typed >= len(columns) * 0.3:
        score += 0.10
    return min(score, 1.0)


# ── CSV analyzer ─────────────────────────────────────────────────────

def analyze_csv_structure(
    file_bytes: bytes,
    filename: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Analyze a CSV file.  CSV has no formatting, so detection is simpler:
    first row = headers, remaining = data, no merged cells / groups / footer.
    """
    import csv
    import io

    # Decode
    try:
        text = file_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = file_bytes.decode("latin-1")

    reader = csv.reader(io.StringIO(text))
    all_rows = list(reader)
    if not all_rows:
        sheet_name = (filename or "data").rsplit(".", 1)[0]
        return {
            "header_lines": [], "report_title": "", "report_meta": None,
            "column_groups": [], "columns": [], "group_by_column": None,
            "show_subtotals": False, "footer_lines": [],
            "signature_count": 0, "signature_labels": [],
            "theme": _default_theme(),
            "recommended_table_schema": [], "data_preview": [],
            "total_data_rows": 0, "confidence": 0.1,
            "sheet_names": [sheet_name], "analyzed_sheet": sheet_name,
        }

    sheet_name = (filename or "data").rsplit(".", 1)[0]

    # Skip leading empty rows or rows that look like headers (non-tabular)
    header_zone_lines: List[Dict] = []
    data_header_idx = 0
    report_title = ""

    # Heuristic: the "data header" row is the first row where most cells have short text
    for i, row in enumerate(all_rows):
        non_empty = [c.strip() for c in row if c.strip()]
        if len(non_empty) >= 3 and all(len(c) <= 50 for c in non_empty):
            # Check if next row has numeric data
            if i + 1 < len(all_rows):
                next_non_empty = [c.strip() for c in all_rows[i + 1] if c.strip()]
                numeric_count = sum(1 for c in next_non_empty if _is_numeric_text(c))
                if numeric_count > len(next_non_empty) * 0.2 or i == 0:
                    data_header_idx = i
                    break
        # This row is part of header zone
        row_text = ",".join(c.strip() for c in row if c.strip())
        if row_text:
            if not report_title and len(row_text) > 10:
                report_title = row_text
            else:
                header_zone_lines.append({
                    "text": row_text, "right_text": None,
                    "align": "left", "bold": False, "font_size": "base",
                })

    # Extract columns
    header_row = all_rows[data_header_idx]
    columns: List[Dict] = []
    for ci, cell_text in enumerate(header_row):
        label = cell_text.strip()
        if not label:
            continue
        key = _to_snake_case(label) or f"col_{ci + 1}"
        existing_keys = [c["key"] for c in columns]
        if key in existing_keys:
            key = f"{key}_{ci + 1}"
        columns.append({
            "label": label, "key": key, "inferred_type": "text",
            "width_px": 120, "align": "left", "format": "text",
            "suffix": None, "bold": False, "highlight_negative": False,
            "source_col_idx": ci,
        })

    # Sample data rows for type inference
    data_rows = all_rows[data_header_idx + 1:]
    for col in columns:
        ci = col["source_col_idx"]
        values = []
        for row in data_rows[:20]:
            if ci < len(row):
                values.append(row[ci].strip())
        fmt, align, suffix, hl_neg = _infer_column_type(values)
        col["format"] = fmt
        col["inferred_type"] = fmt
        col["align"] = align
        col["highlight_negative"] = hl_neg
        if suffix:
            col["suffix"] = suffix

    # Data preview
    preview: List[Dict[str, Any]] = []
    for row in data_rows[:5]:
        row_dict: Dict[str, Any] = {}
        for col in columns:
            ci = col["source_col_idx"]
            val = row[ci].strip() if ci < len(row) else ""
            if _is_numeric_text(val):
                try:
                    cleaned = val.replace(",", "").replace(" ", "").replace("\xa0", "")
                    row_dict[col["key"]] = float(cleaned) if "." in cleaned else int(cleaned)
                except ValueError:
                    row_dict[col["key"]] = val
            else:
                row_dict[col["key"]] = val
        preview.append(row_dict)

    table_schema = [
        {"name": c["key"], "display_name": c["label"],
         "type": "number" if c["format"] in ("integer", "decimal", "percentage") else "string"}
        for c in columns
    ]

    total_data_rows = len(data_rows)
    confidence = 0.3
    if total_data_rows >= 3:
        confidence += 0.2
    if len(columns) >= 3:
        confidence += 0.2
    num_typed = sum(1 for c in columns if c["format"] != "text")
    if num_typed >= len(columns) * 0.3:
        confidence += 0.1

    return {
        "header_lines": header_zone_lines,
        "report_title": report_title,
        "report_meta": None,
        "column_groups": [],
        "columns": columns,
        "group_by_column": None,
        "show_subtotals": False,
        "footer_lines": [],
        "signature_count": 0,
        "signature_labels": [],
        "theme": _default_theme(),
        "recommended_table_schema": table_schema,
        "data_preview": preview,
        "total_data_rows": total_data_rows,
        "confidence": round(min(confidence, 1.0), 2),
        "sheet_names": [sheet_name],
        "analyzed_sheet": sheet_name,
    }


def _default_theme() -> Dict[str, str]:
    return {
        "header_bg": "#073763", "header_text": "#ffffff",
        "group_bg": "#c9daf8", "group_text": "#073763",
        "subtotal_bg": "#dbeafe", "subtotal_text": "#1e40af",
        "accent_color": "#073763",
    }


# ── Fallback: Minimal result ─────────────────────────────────────────

def _minimal_result(
    ws: Worksheet,
    all_sheet_names: List[str],
    sheet_name: str,
    row_infos: Dict[int, _RowInfo],
    min_row: int,
    max_row: int,
    min_col: int,
    max_col: int,
    num_cols: int,
) -> Dict[str, Any]:
    """Return a minimal result when structure detection fails."""
    # Use first non-empty row as columns
    columns = []
    col_indices = []
    for r in range(min_row, max_row + 1):
        info = row_infos.get(r)
        if info and not info.is_empty:
            for c in range(min_col, max_col + 1):
                cell = ws.cell(row=r, column=c)
                text = str(cell.value).strip() if cell.value is not None else ""
                if text:
                    key = _to_snake_case(text) or f"col_{len(columns)+1}"
                    columns.append({
                        "label": text, "key": key, "inferred_type": "text",
                        "width_px": 120, "align": "left", "format": "text",
                        "suffix": None, "bold": False, "highlight_negative": False,
                        "source_col_idx": c,
                    })
                    col_indices.append(c)
            break

    return {
        "header_lines": [],
        "report_title": "",
        "report_meta": None,
        "column_groups": [],
        "columns": columns,
        "group_by_column": None,
        "show_subtotals": False,
        "footer_lines": [],
        "signature_count": 0,
        "signature_labels": [],
        "theme": {"header_bg": "#073763", "header_text": "#ffffff",
                  "group_bg": "#c9daf8", "group_text": "#073763",
                  "subtotal_bg": "#dbeafe", "subtotal_text": "#1e40af",
                  "accent_color": "#073763"},
        "recommended_table_schema": [
            {"name": c["key"], "display_name": c["label"], "type": "string"}
            for c in columns
        ],
        "data_preview": [],
        "total_data_rows": 0,
        "confidence": 0.1,
        "sheet_names": all_sheet_names,
        "analyzed_sheet": sheet_name,
    }
