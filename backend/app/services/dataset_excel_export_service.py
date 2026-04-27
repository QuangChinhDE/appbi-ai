from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from io import BytesIO
from typing import Any, Callable, Mapping, Sequence

from openpyxl import Workbook

EXCEL_MAX_DATA_ROWS = 1_048_575
_INVALID_SHEET_TITLE_RE = re.compile(r"[\\/*?:\[\]]")


@dataclass
class DatasetTableExcelExportResult:
    content: bytes
    rows_written: int
    truncated: bool
    columns: list[str]


def sanitize_excel_sheet_title(title: str | None) -> str:
    cleaned = _INVALID_SHEET_TITLE_RE.sub(" ", str(title or "")).strip().strip("'")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:31] or "Sheet1"


def _normalize_cell_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo is not None else value
    if isinstance(value, time):
        return value.replace(tzinfo=None) if value.tzinfo is not None else value
    if value is None or isinstance(value, (bool, int, float, str, date)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (dict, list, tuple, set)):
        return json.dumps(value, default=str, separators=(",", ":"))
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _row_to_excel_values(row: Any, columns: Sequence[str]) -> list[Any]:
    if isinstance(row, Mapping):
        return [_normalize_cell_value(row.get(column)) for column in columns]

    if isinstance(row, Sequence) and not isinstance(row, (str, bytes, bytearray)):
        values = [_normalize_cell_value(value) for value in row[: len(columns)]]
        if len(values) < len(columns):
            values.extend([None] * (len(columns) - len(values)))
        return values

    if not columns:
        return [_normalize_cell_value(row)]

    values = [_normalize_cell_value(row)]
    if len(values) < len(columns):
        values.extend([None] * (len(columns) - len(values)))
    return values


def export_dataset_table_to_excel(
    fetch_page: Callable[[int, int], Mapping[str, Any]],
    *,
    sheet_title: str,
    page_size: int = 1000,
    max_rows: int = EXCEL_MAX_DATA_ROWS,
) -> DatasetTableExcelExportResult:
    requested_page_size = min(max(int(page_size or 1000), 1), 1000)
    max_rows = min(max(int(max_rows or EXCEL_MAX_DATA_ROWS), 1), EXCEL_MAX_DATA_ROWS)

    workbook = Workbook(write_only=True)
    worksheet = workbook.create_sheet(title=sanitize_excel_sheet_title(sheet_title))

    offset = 0
    rows_written = 0
    truncated = False
    columns: list[str] = []

    while rows_written < max_rows:
        current_limit = min(requested_page_size, max_rows - rows_written)
        page = fetch_page(current_limit, offset)
        page_columns = [str(column) for column in (page.get("columns") or [])]
        page_rows = list(page.get("rows") or [])

        if not columns:
            columns = page_columns
            if columns:
                worksheet.append(columns)

        if not page_rows:
            break

        for row in page_rows:
            worksheet.append(_row_to_excel_values(row, columns))
            rows_written += 1
            if rows_written >= max_rows:
                truncated = True
                break

        offset += len(page_rows)
        if truncated or len(page_rows) < current_limit:
            break

    buffer = BytesIO()
    workbook.save(buffer)
    return DatasetTableExcelExportResult(
        content=buffer.getvalue(),
        rows_written=rows_written,
        truncated=truncated,
        columns=columns,
    )