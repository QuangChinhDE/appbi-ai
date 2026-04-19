"""HTML dashboard import helpers.

This service converts Claude-style HTML dashboard summaries into AppBI-native
charts and dashboards. The import path is intentionally "chart first":
deterministic parsing and validation define the available surface, while AI is
used only to classify ambiguous HTML blocks and propose field mappings inside
that surface.
"""

from __future__ import annotations

import csv as csv_module
import io
import json
import re
import secrets
from difflib import SequenceMatcher
from io import BytesIO
from typing import Any, Dict, Iterable, List, Literal, Optional, Tuple

import openpyxl
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.dependencies import require_edit_access, require_view_access
from app.core.logging import get_logger
from app.models import Dashboard
from app.models.dataset import Dataset, DatasetTable
from app.models.models import Chart, ChartMetadata, ChartType, DashboardChart
from app.models.user import User
from app.schemas.dataset import DatasetCreate, TableCreate
from app.schemas.schemas import DataSourceCreate
from app.services.chart_semantic_service import with_chart_semantic_binding
from app.services.dashboard_service import DEFAULT_DASHBOARD_PAGE
from app.services.dataset_crud import DatasetCRUDService
from app.services.datasource_crud_service import DataSourceCRUDService
from app.services.llm_client import LLMClient
from app.services.template_import_ai_service import build_ai_assist_meta

logger = get_logger(__name__)

SourceMode = Literal["existing_dataset", "upload_excel"]
TargetMode = Literal["new_dashboard", "append_to_dashboard"]

_SUPPORTED_CHART_TYPES = {
    "BAR",
    "HORIZONTAL_BAR",
    "LINE",
    "PIE",
    "TIME_SERIES",
    "TABLE",
    "AREA",
    "STACKED_BAR",
    "GROUPED_BAR",
    "BAR_LINE",
    "SCATTER",
    "KPI",
}
_BLOCK_ROLE_TO_CHART_TYPE = {
    "table": "TABLE",
    "kpi": "KPI",
    "chart": "BAR",
}
_BLOCK_KEYWORD_RE = re.compile(
    r"(chart|graph|plot|viz|visual|trend|timeseries|time series|share|mix|breakdown|composition|rank|top|bottom|kpi|metric|score|summary|table)",
    re.IGNORECASE,
)
_STYLE_PAIR_RE = re.compile(r"\s*([^:]+)\s*:\s*([^;]+)")
_SNAKE_RE = re.compile(r"[^a-z0-9]+")
_WHITESPACE_RE = re.compile(r"\s+")
_FIELD_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _normalize_text(value: Any, *, max_len: int | None = None) -> str:
    text = _WHITESPACE_RE.sub(" ", str(value or "")).strip()
    if max_len and len(text) > max_len:
        return text[: max_len - 3].rstrip() + "..."
    return text


def _normalize_identifier(value: Any) -> str:
    lowered = _normalize_text(value).lower()
    return _SNAKE_RE.sub("_", lowered).strip("_")


def _field_tokens(value: Any) -> set[str]:
    return set(_FIELD_TOKEN_RE.findall(_normalize_identifier(value)))


def _parse_style_map(raw_style: Any) -> Dict[str, str]:
    if isinstance(raw_style, dict):
        return {
            _normalize_identifier(key): _normalize_text(value, max_len=120)
            for key, value in raw_style.items()
            if _normalize_identifier(key) and _normalize_text(value)
        }

    result: Dict[str, str] = {}
    for chunk in str(raw_style or "").split(";"):
        match = _STYLE_PAIR_RE.match(chunk)
        if not match:
            continue
        key = _normalize_identifier(match.group(1))
        value = _normalize_text(match.group(2), max_len=120)
        if key and value:
            result[key] = value
    return result


def _is_number_type(column_type: str) -> bool:
    return str(column_type or "").lower() in {
        "number",
        "integer",
        "float",
        "double",
        "decimal",
        "numeric",
        "bigint",
        "int",
    }


def _is_date_type(column_type: str) -> bool:
    return str(column_type or "").lower() in {
        "date",
        "datetime",
        "timestamp",
        "time",
    }


def _infer_preview_column_type(values: List[Any]) -> str:
    samples = [value for value in values if value is not None and str(value).strip() != ""][:20]
    if not samples:
        return "string"
    number_count = sum(1 for value in samples if _preview_value_is_number(value))
    if number_count == len(samples):
        return "number"
    date_count = sum(1 for value in samples if _preview_value_is_date_like(value))
    if date_count >= len(samples) * 0.8:
        return "date"
    return "string"


def _preview_value_is_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    try:
        float(str(value).replace(",", ""))
        return True
    except (TypeError, ValueError):
        return False


def _preview_value_is_date_like(value: Any) -> bool:
    if hasattr(value, "isoformat"):
        return True
    return bool(re.match(r"^\d{2,4}[-/]\d{1,2}[-/]\d{1,4}", str(value).strip()))


def _coerce_preview_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            return str(value)
    return _normalize_text(value, max_len=500)


def parse_uploaded_source_sheets(
    *,
    file_bytes: bytes,
    filename: Optional[str],
) -> Dict[str, Dict[str, Any]]:
    lower_name = str(filename or "").lower()
    if lower_name.endswith(".csv"):
        return _parse_csv_source_sheets(file_bytes, filename=filename)
    return _parse_excel_source_sheets(file_bytes)


def _parse_excel_source_sheets(file_bytes: bytes) -> Dict[str, Dict[str, Any]]:
    workbook = openpyxl.load_workbook(BytesIO(file_bytes), data_only=True)
    try:
        sheets: Dict[str, Dict[str, Any]] = {}
        for sheet_name in workbook.sheetnames:
            worksheet = workbook[sheet_name]
            all_rows = list(worksheet.iter_rows(values_only=True))
            if not all_rows:
                sheets[sheet_name] = {"columns": [], "rows": []}
                continue

            header_row = [str(cell).strip() if cell is not None else "" for cell in all_rows[0]]
            headers = [header if header else f"col{i + 1}" for i, header in enumerate(header_row)]

            rows: List[Dict[str, Any]] = []
            for raw_row in all_rows[1:]:
                row_payload: Dict[str, Any] = {}
                has_value = False
                for index, header in enumerate(headers):
                    value = raw_row[index] if index < len(raw_row) else None
                    normalized_value = _coerce_preview_cell(value)
                    row_payload[header] = normalized_value
                    if normalized_value not in ("", None):
                        has_value = True
                if has_value:
                    rows.append(row_payload)

            columns = [
                {"name": header, "type": _infer_preview_column_type([row.get(header) for row in rows])}
                for header in headers
            ]
            sheets[sheet_name] = {"columns": columns, "rows": rows}

        return sheets
    finally:
        workbook.close()


def _parse_csv_source_sheets(
    file_bytes: bytes,
    *,
    filename: Optional[str],
) -> Dict[str, Dict[str, Any]]:
    try:
        text = file_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = file_bytes.decode("latin-1")

    reader = csv_module.DictReader(io.StringIO(text))
    rows = [dict(row) for row in reader]
    fieldnames = list(reader.fieldnames or [])
    columns = [
        {"name": header, "type": _infer_preview_column_type([row.get(header) for row in rows])}
        for header in fieldnames
    ]
    sheet_name = str(filename or "Sheet1").rsplit(".", 1)[0] or "Sheet1"
    return {sheet_name: {"columns": columns, "rows": rows}}


def _classify_block_role(block: Dict[str, Any]) -> str:
    explicit_role = _normalize_identifier(block.get("role"))
    if explicit_role in {"title", "section", "chart", "table", "kpi", "text"}:
        return explicit_role

    tag = str(block.get("tag") or "").lower()
    if tag == "table" or isinstance(block.get("table"), dict):
        return "table"
    if tag in {"h1", "h2", "h3"}:
        return "title"

    searchable_text = " ".join(
        [
            _normalize_text(block.get("heading")),
            _normalize_text(block.get("text")),
            " ".join(str(item) for item in (block.get("classes") or [])),
            _normalize_text(block.get("id_attr")),
        ]
    ).lower()
    if "kpi" in searchable_text or "metric" in searchable_text or "score" in searchable_text:
        return "kpi"
    if _BLOCK_KEYWORD_RE.search(searchable_text):
        return "chart"
    return "text"


def _coerce_numberish(value: Any) -> Any:
    if isinstance(value, (int, float)) or value is None:
        return value
    text = _normalize_text(value)
    if not text:
        return None
    compact = text.replace(",", "")
    if re.fullmatch(r"-?\d+(\.\d+)?", compact):
        try:
            return float(compact) if "." in compact else int(compact)
        except ValueError:
            return text
    return text


def _build_source_column_profile(name: str, col_type: str) -> Dict[str, Any]:
    return {
        "name": name,
        "type": str(col_type or "string").lower(),
        "tokens": sorted(_field_tokens(name)),
    }


def _score_field_match(label: str, column: Dict[str, Any]) -> float:
    label_norm = _normalize_identifier(label)
    if not label_norm:
        return 0.0
    column_name = str(column.get("name") or "")
    if label_norm == _normalize_identifier(column_name):
        return 1.0

    label_tokens = _field_tokens(label)
    column_tokens = set(column.get("tokens") or [])
    overlap = len(label_tokens & column_tokens)
    if label_tokens and column_tokens:
        jaccard = overlap / max(len(label_tokens | column_tokens), 1)
    else:
        jaccard = 0.0

    sequence = SequenceMatcher(None, label_norm, _normalize_identifier(column_name)).ratio()
    prefix = 0.15 if label_norm in _normalize_identifier(column_name) or _normalize_identifier(column_name) in label_norm else 0.0
    return max(jaccard + prefix, sequence * 0.9)


def _best_field_match(
    label: str,
    columns: List[Dict[str, Any]],
    *,
    numeric_only: bool = False,
    date_only: bool = False,
    exclude: Iterable[str] | None = None,
) -> Optional[str]:
    excluded = {str(item) for item in (exclude or [])}
    best_name: Optional[str] = None
    best_score = 0.0
    for column in columns:
        column_name = str(column.get("name") or "")
        if not column_name or column_name in excluded:
            continue
        if numeric_only and not _is_number_type(str(column.get("type") or "")):
            continue
        if date_only and not _is_date_type(str(column.get("type") or "")):
            continue
        score = _score_field_match(label, column)
        if score > best_score:
            best_name = column_name
            best_score = score
    if best_score >= 0.48:
        return best_name
    return None


def _unique_dashboard_name(db: Session, requested_name: str) -> str:
    base_name = _normalize_text(requested_name) or "Imported Dashboard"
    candidate = base_name
    suffix = 2
    while db.query(Dashboard).filter(Dashboard.name == candidate).first() is not None:
        candidate = f"{base_name} ({suffix})"
        suffix += 1
    return candidate


def _unique_chart_name(db: Session, owner_id: Any, requested_name: str) -> str:
    base_name = _normalize_text(requested_name) or "Imported Chart"
    candidate = base_name
    suffix = 2
    while True:
        conflict_query = db.query(Chart).filter(Chart.name == candidate)
        if owner_id is None:
            conflict_query = conflict_query.filter(Chart.owner_id.is_(None))
        else:
            conflict_query = conflict_query.filter(Chart.owner_id == owner_id)
        if conflict_query.first() is None:
            return candidate
        candidate = f"{base_name} ({suffix})"
        suffix += 1


def _generate_page_id() -> str:
    return f"page-import-{secrets.token_hex(4)}"


def _source_profile_from_rows(
    *,
    source_mode: SourceMode,
    dataset_id: Optional[int],
    dataset_name: Optional[str],
    dataset_table_id: Optional[int],
    dataset_table_name: Optional[str],
    columns: List[Dict[str, Any]],
    sample_rows: List[Dict[str, Any]],
    row_count: Optional[int] = None,
    uploaded_filename: Optional[str] = None,
) -> Dict[str, Any]:
    normalized_columns = [
        _build_source_column_profile(
            str(column.get("name") or column.get("key") or ""),
            str(column.get("type") or "string"),
        )
        for column in columns
        if str(column.get("name") or column.get("key") or "").strip()
    ]
    numeric_columns = [col["name"] for col in normalized_columns if _is_number_type(col["type"])]
    date_columns = [col["name"] for col in normalized_columns if _is_date_type(col["type"])]
    dimension_columns = [col["name"] for col in normalized_columns if col["name"] not in numeric_columns]

    return {
        "source_mode": source_mode,
        "dataset_id": dataset_id,
        "dataset_name": dataset_name,
        "dataset_table_id": dataset_table_id,
        "dataset_table_name": dataset_table_name,
        "uploaded_filename": uploaded_filename,
        "row_count": row_count,
        "columns": normalized_columns,
        "numeric_columns": numeric_columns,
        "date_columns": date_columns,
        "dimension_columns": dimension_columns,
        "sample_rows": sample_rows[:10],
    }


def _load_existing_source_profile(
    db: Session,
    *,
    current_user: User,
    dataset_table_id: int,
) -> Dict[str, Any]:
    db_table = db.query(DatasetTable).filter(DatasetTable.id == dataset_table_id).first()
    if not db_table:
        raise ValueError("Dataset table not found")

    dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()
    if not dataset_obj:
        raise ValueError("Dataset not found")

    require_view_access(db, current_user, dataset_obj, "datasets")

    columns_cache = db_table.columns_cache if isinstance(db_table.columns_cache, dict) else {}
    cached_columns = columns_cache.get("columns") if isinstance(columns_cache, dict) else None
    sample_rows = list(db_table.sample_cache or [])

    columns: List[Dict[str, Any]]
    if isinstance(cached_columns, list) and cached_columns:
        columns = [
            {
                "name": str(col.get("name") or ""),
                "type": str(col.get("type") or "string"),
            }
            for col in cached_columns
            if str(col.get("name") or "").strip()
        ]
    elif sample_rows:
        first_row = sample_rows[0]
        columns = [
            {
                "name": str(key),
                "type": (
                    "number"
                    if isinstance(value, (int, float))
                    else "date"
                    if hasattr(value, "isoformat")
                    else "string"
                ),
            }
            for key, value in first_row.items()
        ]
    else:
        columns = []

    return _source_profile_from_rows(
        source_mode="existing_dataset",
        dataset_id=dataset_obj.id,
        dataset_name=dataset_obj.name,
        dataset_table_id=db_table.id,
        dataset_table_name=db_table.display_name,
        columns=columns,
        sample_rows=sample_rows[:10],
    )


def _load_uploaded_excel_source_profile(
    *,
    file_bytes: bytes,
    filename: Optional[str],
    sheet_name: Optional[str] = None,
) -> Dict[str, Any]:
    all_sheets = parse_uploaded_source_sheets(file_bytes=file_bytes, filename=filename)
    if not all_sheets:
        raise ValueError("Uploaded file does not contain any sheets or rows.")

    available_sheet_names = list(all_sheets.keys())
    selected_sheet_name = str(sheet_name or "").strip()
    if not selected_sheet_name or selected_sheet_name not in all_sheets:
        selected_sheet_name = available_sheet_names[0]

    sheet_data = all_sheets[selected_sheet_name]
    columns = list(sheet_data.get("columns") or [])
    rows = list(sheet_data.get("rows") or [])
    source_profile = _source_profile_from_rows(
        source_mode="upload_excel",
        dataset_id=None,
        dataset_name=None,
        dataset_table_id=None,
        dataset_table_name=selected_sheet_name,
        columns=columns,
        sample_rows=rows,
        row_count=len(rows),
        uploaded_filename=filename,
    )
    source_profile["available_sheets"] = available_sheet_names
    source_profile["selected_sheet_name"] = selected_sheet_name
    return source_profile


def _load_uploaded_multi_source_profiles(
    *,
    files: List[Tuple[bytes, Optional[str]]],
    primary_source_key: Optional[str] = None,
) -> Tuple[Dict[str, Dict[str, Any]], str]:
    """Build source profiles from multiple uploaded Excel/CSV files.

    Returns ``(profiles_by_key, resolved_primary_key)``.
    Key format: ``'{filename}::{sheet_name}'``.
    """
    all_profiles: Dict[str, Dict[str, Any]] = {}
    first_key: Optional[str] = None

    for file_bytes, filename in files:
        safe_filename = filename or "uploaded"
        all_sheets = parse_uploaded_source_sheets(file_bytes=file_bytes, filename=filename)
        for sheet_name, sheet_data in all_sheets.items():
            source_key = f"{safe_filename}::{sheet_name}"
            if first_key is None:
                first_key = source_key
            columns = list(sheet_data.get("columns") or [])
            rows = list(sheet_data.get("rows") or [])
            profile = _source_profile_from_rows(
                source_mode="upload_excel",
                dataset_id=None,
                dataset_name=None,
                dataset_table_id=None,
                dataset_table_name=sheet_name,
                columns=columns,
                sample_rows=rows,
                row_count=len(rows),
                uploaded_filename=safe_filename,
            )
            profile["source_key"] = source_key
            profile["available_sheets"] = []
            all_profiles[source_key] = profile

    all_keys = list(all_profiles.keys())
    for profile in all_profiles.values():
        profile["available_sheets"] = all_keys

    resolved_primary = primary_source_key
    if not resolved_primary or resolved_primary not in all_profiles:
        resolved_primary = first_key or ""
    return all_profiles, resolved_primary


def _plan_quality_score(plan: Dict[str, Any]) -> Tuple[int, int, float, int]:
    """Score a finalized plan for multi-source selection.  Higher is better."""
    fields_count = len(plan.get("source_fields_used") or [])
    type_bonus = 0 if plan.get("final_chart_type") == "TABLE" else 1
    confidence = plan.get("confidence", 0)
    warning_penalty = -len(plan.get("warnings") or [])
    return (fields_count, type_bonus, confidence, warning_penalty)


def _plain_html_excerpt(html_text: str) -> str:
    stripped = re.sub(r"<script[\s\S]*?</script>", " ", html_text, flags=re.IGNORECASE)
    stripped = re.sub(r"<style[\s\S]*?</style>", " ", stripped, flags=re.IGNORECASE)
    stripped = re.sub(r"<[^>]+>", " ", stripped)
    return _normalize_text(stripped, max_len=4000)


def _build_document_summary(
    *,
    html_text: str,
    html_summary: Dict[str, Any] | None,
) -> Dict[str, Any]:
    summary = dict(html_summary or {})
    blocks = summary.get("blocks")
    if not isinstance(blocks, list):
        blocks = []

    normalized_blocks: List[Dict[str, Any]] = []
    for index, raw_block in enumerate(blocks, start=1):
        if not isinstance(raw_block, dict):
            continue
        block_id = str(raw_block.get("id") or f"block-{index}")
        normalized_blocks.append(
            {
                "id": block_id,
                "order": int(raw_block.get("order") or index),
                "tag": str(raw_block.get("tag") or "div").lower(),
                "role": _classify_block_role(raw_block),
                "heading": _normalize_text(raw_block.get("heading"), max_len=160),
                "text": _normalize_text(raw_block.get("text"), max_len=900),
                "classes": [str(item) for item in (raw_block.get("classes") or []) if str(item).strip()],
                "id_attr": _normalize_text(raw_block.get("id_attr"), max_len=120),
                "style": _parse_style_map(raw_block.get("style")),
                "table": raw_block.get("table") if isinstance(raw_block.get("table"), dict) else None,
            }
        )

    if not normalized_blocks and html_text.strip():
        normalized_blocks.append(
            {
                "id": "block-1",
                "order": 1,
                "tag": "div",
                "role": "chart",
                "heading": "",
                "text": _plain_html_excerpt(html_text),
                "classes": [],
                "id_attr": "",
                "style": {},
                "table": None,
            }
        )

    title = _normalize_text(summary.get("title") or summary.get("document_title"), max_len=180)
    if not title:
        title = next(
            (block.get("heading") or block.get("text") for block in normalized_blocks if block.get("role") == "title"),
            "",
        )
    if not title:
        title = "Imported Dashboard"

    return {
        "title": title,
        "blocks": sorted(normalized_blocks, key=lambda item: (item.get("order", 0), item.get("id", ""))),
        "html_excerpt": _plain_html_excerpt(html_text),
    }


def _candidate_blocks(document_summary: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    candidates: List[Dict[str, Any]] = []
    ignored: List[Dict[str, Any]] = []
    for block in document_summary.get("blocks") or []:
        role = block.get("role")
        has_table = isinstance(block.get("table"), dict)
        text = _normalize_text(block.get("text"))
        heading = _normalize_text(block.get("heading"))
        if role in {"chart", "table", "kpi"} or has_table:
            candidates.append(block)
            continue
        if role == "title":
            ignored.append({"block_id": block["id"], "reason": "Document title block"})
            continue
        if len(text) < 40 and not heading:
            ignored.append({"block_id": block["id"], "reason": "Too little content"})
            continue
        if _BLOCK_KEYWORD_RE.search(f"{heading} {text}"):
            candidates.append({**block, "role": "chart"})
        else:
            ignored.append({"block_id": block["id"], "reason": "Narrative block not converted in chart-first import"})
    return candidates[:20], ignored


def _fallback_chart_kind(block: Dict[str, Any], source_profile: Dict[str, Any]) -> str:
    role = str(block.get("role") or "")
    if role == "table":
        return "TABLE"
    if role == "kpi":
        return "KPI"

    title_text = " ".join(
        filter(
            None,
            [
                _normalize_text(block.get("heading")),
                _normalize_text(block.get("text")),
            ],
        )
    ).lower()
    if any(token in title_text for token in ("trend", "monthly", "over time", "timeline", "daily", "weekly")) and source_profile.get("date_columns"):
        return "TIME_SERIES"
    if any(token in title_text for token in ("share", "mix", "composition", "%")):
        return "PIE"
    if any(token in title_text for token in ("kpi", "total", "avg", "average", "ratio", "score")):
        return "KPI"
    if any(token in title_text for token in ("top", "bottom", "rank", "ranking")):
        return "BAR"
    if source_profile.get("date_columns") and source_profile.get("numeric_columns"):
        return "TIME_SERIES"
    return "BAR" if source_profile.get("numeric_columns") else "TABLE"


def _fallback_field_mapping(block: Dict[str, Any], source_profile: Dict[str, Any], chart_type: str) -> Dict[str, Any]:
    columns = list(source_profile.get("columns") or [])
    numeric_columns = list(source_profile.get("numeric_columns") or [])
    date_columns = list(source_profile.get("date_columns") or [])
    dimension_columns = list(source_profile.get("dimension_columns") or [])
    table_summary = block.get("table") if isinstance(block.get("table"), dict) else {}
    headers = [str(item) for item in (table_summary.get("headers") or []) if str(item).strip()]
    label_context = " ".join(headers[:4]) or block.get("heading") or block.get("text") or ""

    primary_metric = _best_field_match(label_context, columns, numeric_only=True) or (numeric_columns[0] if numeric_columns else None)
    secondary_metric = None
    if primary_metric:
        secondary_metric = next((name for name in numeric_columns if name != primary_metric), None)

    primary_dimension = (
        _best_field_match(label_context, columns, date_only=True)
        or _best_field_match(label_context, columns)
        or (date_columns[0] if date_columns else None)
        or (dimension_columns[0] if dimension_columns else None)
    )

    breakdown = None
    if chart_type == "STACKED_BAR":
        breakdown = next((name for name in dimension_columns if name != primary_dimension), None)

    mapping: Dict[str, Any] = {
        "dimension": primary_dimension,
        "timeField": primary_dimension if chart_type == "TIME_SERIES" and primary_dimension in date_columns else None,
        "metrics": ([{"field": primary_metric, "agg": "sum"}] if primary_metric else []),
        "breakdown": breakdown,
        "lineMetric": {"field": secondary_metric, "agg": "sum"} if chart_type == "BAR_LINE" and secondary_metric else None,
        "selectedColumns": [col.get("name") for col in columns[: min(len(columns), 8)] if col.get("name")],
        "scatterX": numeric_columns[0] if chart_type == "SCATTER" and len(numeric_columns) >= 1 else None,
        "scatterY": numeric_columns[1] if chart_type == "SCATTER" and len(numeric_columns) >= 2 else None,
    }

    if chart_type == "KPI" and not mapping["metrics"] and numeric_columns:
        mapping["metrics"] = [{"field": numeric_columns[0], "agg": "sum"}]
    if chart_type == "PIE" and not mapping["dimension"] and dimension_columns:
        mapping["dimension"] = dimension_columns[0]
    if chart_type == "TABLE" and headers:
        matched_headers: List[str] = []
        for header in headers:
            matched = _best_field_match(header, columns)
            if matched and matched not in matched_headers:
                matched_headers.append(matched)
        if matched_headers:
            mapping["selectedColumns"] = matched_headers
    return mapping


def _size_hint_from_block(block: Dict[str, Any], chart_type: str) -> str:
    style = block.get("style") or {}
    width_value = str(style.get("width") or style.get("grid_column") or "").lower()
    text = " ".join(
        [
            _normalize_text(block.get("heading")),
            _normalize_text(block.get("text")),
            " ".join(block.get("classes") or []),
        ]
    ).lower()
    if chart_type == "KPI":
        return "kpi"
    if chart_type == "TABLE":
        return "full"
    if "100%" in width_value or "full" in text or "wide" in text:
        return "full"
    if any(token in width_value for token in ("50%", "1 / span 6", "half")) or "half" in text:
        return "half"
    if any(token in text for token in ("small", "mini", "compact")):
        return "third"
    return "half"


def _layout_dimensions(chart_type: str, size_hint: str) -> Tuple[int, int]:
    if chart_type == "KPI":
        return 3, 3
    if chart_type == "TABLE":
        return 12, 6
    if size_hint == "full":
        return 12, 5
    if size_hint == "third":
        return 4, 4
    return 6, 4


def _assign_layouts(plans: List[Dict[str, Any]]) -> None:
    heights = [0] * 12
    for plan in plans:
        chart_type = str(plan.get("final_chart_type") or "BAR")
        size_hint = str(plan.get("size_hint") or "half")
        width, height = _layout_dimensions(chart_type, size_hint)
        best_x = 0
        best_y = 0
        best_score: Tuple[int, int] | None = None
        for x in range(0, 12 - width + 1):
            y = max(heights[x : x + width])
            score = (y, x)
            if best_score is None or score < best_score:
                best_score = score
                best_x = x
                best_y = y
        for index in range(best_x, best_x + width):
            heights[index] = best_y + height
        plan["layout"] = {"x": best_x, "y": best_y, "w": width, "h": height}


def _sanitize_metric(metric: Any, source_profile: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(metric, dict):
        return None
    field = str(metric.get("field") or "").strip()
    if field not in source_profile.get("numeric_columns", []):
        return None
    agg = str(metric.get("agg") or "sum").lower()
    if agg not in {"sum", "avg", "count", "min", "max", "count_distinct"}:
        agg = "sum"
    return {"field": field, "agg": agg}


def _finalize_plan(
    *,
    block: Dict[str, Any],
    raw_plan: Dict[str, Any] | None,
    source_profile: Dict[str, Any],
) -> Dict[str, Any]:
    suggested_type = str((raw_plan or {}).get("suggested_chart_type") or (raw_plan or {}).get("final_chart_type") or _fallback_chart_kind(block, source_profile)).upper()
    original_chart_type = str((raw_plan or {}).get("original_chart_type") or _BLOCK_ROLE_TO_CHART_TYPE.get(str(block.get("role") or ""), "unknown")).upper()

    fallback_type = _fallback_chart_kind(block, source_profile)
    final_chart_type = suggested_type if suggested_type in _SUPPORTED_CHART_TYPES else fallback_type
    changed_chart_type = final_chart_type != suggested_type and bool(suggested_type)

    raw_mapping = (raw_plan or {}).get("field_mapping") if isinstance((raw_plan or {}).get("field_mapping"), dict) else {}
    fallback_mapping = _fallback_field_mapping(block, source_profile, final_chart_type)
    dimension = str(raw_mapping.get("dimension") or "").strip() if isinstance(raw_mapping, dict) else ""
    time_field = str(raw_mapping.get("timeField") or "").strip() if isinstance(raw_mapping, dict) else ""
    breakdown = str(raw_mapping.get("breakdown") or "").strip() if isinstance(raw_mapping, dict) else ""
    selected_columns = [
        str(item).strip()
        for item in (raw_mapping.get("selectedColumns") or [])
        if str(item).strip() in {col["name"] for col in source_profile.get("columns", [])}
    ] if isinstance(raw_mapping, dict) else []

    if dimension and dimension not in {col["name"] for col in source_profile.get("columns", [])}:
        dimension = ""
    if time_field and time_field not in source_profile.get("date_columns", []):
        time_field = ""
    if breakdown and breakdown not in {col["name"] for col in source_profile.get("columns", [])}:
        breakdown = ""

    metrics = [
        metric
        for metric in (_sanitize_metric(item, source_profile) for item in (raw_mapping.get("metrics") or []))
        if metric
    ] if isinstance(raw_mapping, dict) else []
    if not metrics:
        metrics = list(fallback_mapping.get("metrics") or [])

    line_metric = _sanitize_metric(raw_mapping.get("lineMetric"), source_profile) if isinstance(raw_mapping, dict) else None
    if final_chart_type == "BAR_LINE" and not line_metric:
        fallback_line = fallback_mapping.get("lineMetric")
        line_metric = fallback_line if isinstance(fallback_line, dict) else None

    scatter_x = str(raw_mapping.get("scatterX") or "").strip() if isinstance(raw_mapping, dict) else ""
    scatter_y = str(raw_mapping.get("scatterY") or "").strip() if isinstance(raw_mapping, dict) else ""
    if final_chart_type == "SCATTER":
        if scatter_x not in source_profile.get("numeric_columns", []):
            scatter_x = str(fallback_mapping.get("scatterX") or "")
        if scatter_y not in source_profile.get("numeric_columns", []):
            scatter_y = str(fallback_mapping.get("scatterY") or "")

    # Final contract validation per chart type.
    warnings: List[str] = []
    conversion_note = _normalize_text((raw_plan or {}).get("conversion_note"), max_len=240)

    if final_chart_type == "TABLE":
        selected_columns = selected_columns or list(fallback_mapping.get("selectedColumns") or [])
        if not selected_columns:
            selected_columns = [col["name"] for col in source_profile.get("columns", [])[: min(8, len(source_profile.get("columns", [])))]]
    elif final_chart_type == "KPI":
        if not metrics:
            final_chart_type = "TABLE"
            selected_columns = list(fallback_mapping.get("selectedColumns") or [])
            changed_chart_type = True
            conversion_note = conversion_note or "Converted to TABLE because no numeric field could power a KPI."
    elif final_chart_type == "TIME_SERIES":
        if not time_field:
            time_field = str(fallback_mapping.get("timeField") or "")
        if not time_field or not metrics:
            final_chart_type = "BAR" if metrics else "TABLE"
            changed_chart_type = True
            conversion_note = conversion_note or "Converted from TIME_SERIES because the selected source did not expose a valid date/value mapping."
    elif final_chart_type == "PIE":
        if not dimension:
            dimension = str(fallback_mapping.get("dimension") or "")
        if not dimension or not metrics:
            final_chart_type = "BAR" if metrics else "TABLE"
            changed_chart_type = True
            conversion_note = conversion_note or "Converted from PIE because the selected source did not expose both a label field and a numeric value."
    elif final_chart_type == "SCATTER":
        if not scatter_x or not scatter_y:
            final_chart_type = "TABLE"
            changed_chart_type = True
            conversion_note = conversion_note or "Converted from SCATTER because two numeric fields were not available."
    elif final_chart_type == "STACKED_BAR":
        if not dimension:
            dimension = str(fallback_mapping.get("dimension") or "")
        if not breakdown:
            breakdown = str(fallback_mapping.get("breakdown") or "")
        if not dimension or not breakdown or not metrics:
            final_chart_type = "BAR" if metrics else "TABLE"
            changed_chart_type = True
            conversion_note = conversion_note or "Converted from STACKED_BAR because the source could not supply dimension, stack field, and metric together."
    elif final_chart_type == "BAR_LINE":
        if not dimension:
            dimension = str(fallback_mapping.get("dimension") or "")
        if not metrics or not line_metric:
            final_chart_type = "BAR" if metrics else "TABLE"
            changed_chart_type = True
            conversion_note = conversion_note or "Converted from BAR_LINE because the source did not expose both bar and line measures."
    else:
        if final_chart_type != "TABLE" and not dimension:
            dimension = str(fallback_mapping.get("dimension") or "")
        if final_chart_type != "TABLE" and not metrics:
            final_chart_type = "TABLE"
            changed_chart_type = True
            conversion_note = conversion_note or f"Converted to TABLE because the source did not expose a numeric measure for {suggested_type or final_chart_type}."

    if changed_chart_type and not conversion_note:
        conversion_note = f"Requested {suggested_type or original_chart_type}, imported as {final_chart_type} to fit the native dashboard canvas."

    title = _normalize_text((raw_plan or {}).get("title") or block.get("heading") or block.get("text"), max_len=160) or f"Imported {final_chart_type.title()}"
    rationale = _normalize_text((raw_plan or {}).get("reasoning") or (raw_plan or {}).get("rationale"), max_len=260)
    confidence_raw = (raw_plan or {}).get("confidence")
    try:
        confidence = max(0.05, min(float(confidence_raw), 0.99))
    except (TypeError, ValueError):
        confidence = 0.62 if rationale else 0.5

    size_hint = str((raw_plan or {}).get("size_hint") or _size_hint_from_block(block, final_chart_type)).lower()
    if size_hint not in {"full", "half", "third", "kpi"}:
        size_hint = _size_hint_from_block(block, final_chart_type)

    source_fields_used = sorted(
        {
            *([dimension] if dimension else []),
            *([time_field] if time_field else []),
            *([breakdown] if breakdown else []),
            *([scatter_x] if scatter_x else []),
            *([scatter_y] if scatter_y else []),
            *([item.get("field") for item in metrics if item.get("field")]),
            *([line_metric.get("field")] if isinstance(line_metric, dict) and line_metric.get("field") else []),
            *(selected_columns or []),
        }
    )
    if not source_fields_used:
        warnings.append("No field mapping could be validated for this block.")

    role_config: Dict[str, Any] = {"metrics": metrics}
    if dimension:
        role_config["dimension"] = dimension
    if breakdown:
        role_config["breakdown"] = breakdown
    if final_chart_type == "TIME_SERIES" and time_field:
        role_config["timeField"] = time_field
        if not role_config.get("dimension"):
            role_config["dimension"] = time_field
    if final_chart_type == "BAR_LINE" and line_metric:
        role_config["lineMetric"] = line_metric
    if final_chart_type == "TABLE":
        role_config["selectedColumns"] = selected_columns
    if final_chart_type == "SCATTER":
        role_config["scatterX"] = scatter_x
        role_config["scatterY"] = scatter_y

    return {
        "block_id": block["id"],
        "order": block.get("order", 0),
        "title": title,
        "block_role": block.get("role"),
        "source_excerpt": _normalize_text(block.get("text"), max_len=280),
        "original_chart_type": original_chart_type,
        "requested_chart_type": suggested_type,
        "final_chart_type": final_chart_type,
        "changed_chart_type": changed_chart_type,
        "conversion_note": conversion_note or None,
        "rationale": rationale or None,
        "confidence": round(confidence, 2),
        "size_hint": size_hint,
        "source_fields_used": source_fields_used,
        "warnings": warnings,
        "role_config": role_config,
        "style_config": {"chartTitle": title},
    }


def _complete_json_with_import_provider(
    prompt: str,
    *,
    system_prompt: str,
    max_tokens: int = 1800,
) -> Optional[Dict[str, Any]]:
    provider = settings.template_import_ai_provider
    model = settings.template_import_ai_model
    if provider == "unavailable":
        return None

    if provider == "gemini":
        try:
            import google.generativeai as genai

            genai.configure(api_key=settings.GEMINI_API_KEY)
            client = genai.GenerativeModel(
                model_name=model,
                system_instruction=system_prompt,
                generation_config={
                    "temperature": 0.2,
                    "max_output_tokens": max_tokens,
                    "response_mime_type": "application/json",
                },
            )
            response = client.generate_content(prompt)
            text = getattr(response, "text", "") or ""
            if not text:
                for candidate in getattr(response, "candidates", []) or []:
                    content = getattr(candidate, "content", None)
                    for part in getattr(content, "parts", []) or []:
                        part_text = getattr(part, "text", "") or ""
                        if part_text:
                            text = part_text
                            break
                    if text:
                        break
            if not text:
                return None
            return json.loads(text)
        except Exception:
            logger.warning("Dashboard HTML import Gemini call failed", exc_info=True)
            return None

    return LLMClient.complete_json(prompt, system=system_prompt, model=model, max_tokens=max_tokens)


def _validate_calculated_fields(
    calculated_fields: List[Dict[str, Any]],
    source_columns: List[str],
) -> List[Dict[str, Any]]:
    """Validate AI-suggested calculated fields, keeping only safe ones."""
    from app.services.transformation_compiler import TransformationCompiler

    valid: List[Dict[str, Any]] = []
    seen_names: set = set()
    all_known_columns = set(source_columns)

    for field in calculated_fields:
        if not isinstance(field, dict):
            continue
        name = str(field.get("name") or "").strip()
        expression = str(field.get("expression") or "").strip()
        if not name or not expression or name in seen_names:
            continue

        is_valid, error = TransformationCompiler.validate_expression(expression)
        if not is_valid:
            logger.warning("Skipping calculated field '%s': %s", name, error)
            continue

        seen_names.add(name)
        all_known_columns.add(name)
        valid.append({
            "name": name,
            "expression": expression,
            "label": str(field.get("label") or field.get("description") or name),
            "source_key": field.get("source_key"),
        })

    return valid


def _ai_chart_plans(
    *,
    document_summary: Dict[str, Any],
    source_profile: Dict[str, Any],
) -> Tuple[Optional[List[Dict[str, Any]]], List[Dict[str, Any]], Dict[str, Any]]:
    """Return ``(charts, calculated_fields, ai_meta)``."""
    if settings.template_import_ai_provider == "unavailable":
        return None, [], build_ai_assist_meta(
            requested=True,
            applied=False,
            status="unavailable",
            message="No AI provider configured for HTML dashboard import.",
        )

    candidates, _ignored = _candidate_blocks(document_summary)
    if not candidates:
        return None, [], build_ai_assist_meta(
            requested=True,
            applied=False,
            status="failed",
            message="No chart-like blocks were detected in the HTML summary.",
        )

    source_col_names = [col.get("name") for col in (source_profile.get("columns") or [])]

    prompt = json.dumps(
        {
            "task": "Map HTML dashboard blocks into AppBI-native chart plans. When the HTML references metrics that do not exist directly in the source columns, propose calculated_fields with SQL-safe expressions to derive them.",
            "supported_chart_types": sorted(_SUPPORTED_CHART_TYPES),
            "rules": [
                "Stay inside the supported chart types list.",
                "Use fields from source_profile.columns OR from calculated_fields you define.",
                "If the HTML implies a metric not directly in the source (e.g. percentage, cumulative sum, profit = revenue - cost, remaining = budget - spent), create a calculated_field for it.",
                "Calculated field expressions must be simple SQL-safe math: +, -, *, /, ROUND(), COALESCE(), IF(condition, true_val, false_val). No SELECT/FROM/JOIN.",
                "Calculated field names must be valid SQL identifiers (no spaces, no special chars).",
                "If the HTML implies a chart AppBI does not support, choose the closest supported chart type and explain it in conversion_note.",
                "Skip narrative-only blocks by omitting them from charts.",
                "Prefer TABLE when confidence is low or when the block behaves like a wide data table.",
                "KPI requires one numeric metric. TIME_SERIES requires one date field and one numeric metric. PIE requires one dimension and one numeric metric.",
                "BAR_LINE requires one dimension plus one bar metric and one line metric.",
                "SCATTER requires two numeric fields.",
            ],
            "document_summary": {
                "title": document_summary.get("title"),
                "html_excerpt": document_summary.get("html_excerpt"),
                "blocks": [
                    {
                        "id": block.get("id"),
                        "order": block.get("order"),
                        "role": block.get("role"),
                        "heading": block.get("heading"),
                        "text": block.get("text"),
                        "classes": block.get("classes"),
                        "style": block.get("style"),
                        "table": block.get("table"),
                    }
                    for block in candidates[:16]
                ],
            },
            "source_profile": {
                "dataset_name": source_profile.get("dataset_name"),
                "dataset_table_name": source_profile.get("dataset_table_name"),
                "columns": [
                    {"name": item.get("name"), "type": item.get("type")}
                    for item in (source_profile.get("columns") or [])
                ],
                "numeric_columns": source_profile.get("numeric_columns"),
                "date_columns": source_profile.get("date_columns"),
                "sample_rows": source_profile.get("sample_rows"),
            },
            "return_json_shape": {
                "dashboard_title": "string",
                "calculated_fields": [
                    {
                        "name": "ValidSQLIdentifier",
                        "expression": "col_a / col_b * 100",
                        "label": "Human readable label",
                        "source_key": "optional source_key for multi-source",
                    }
                ],
                "charts": [
                    {
                        "block_id": "string",
                        "title": "string",
                        "original_chart_type": "string",
                        "suggested_chart_type": "BAR|HORIZONTAL_BAR|LINE|PIE|TIME_SERIES|TABLE|AREA|STACKED_BAR|GROUPED_BAR|BAR_LINE|SCATTER|KPI",
                        "field_mapping": {
                            "dimension": "string | null",
                            "timeField": "string | null",
                            "metrics": [{"field": "string", "agg": "sum|avg|count|min|max|count_distinct"}],
                            "breakdown": "string | null",
                            "lineMetric": {"field": "string", "agg": "sum|avg|count|min|max|count_distinct"} ,
                            "selectedColumns": ["string"],
                            "scatterX": "string | null",
                            "scatterY": "string | null",
                        },
                        "confidence": 0.0,
                        "size_hint": "full|half|third|kpi",
                        "reasoning": "string",
                        "conversion_note": "string | null",
                    }
                ],
            },
        },
        ensure_ascii=False,
    )

    system_prompt = (
        "You convert HTML dashboard summaries into AppBI-native chart plans. "
        "When the raw data lacks a metric the HTML dashboard displays (like percentages, totals, differences, cumulative values), "
        "define it as a calculated_field with a SQL-safe expression before referencing it in charts. "
        "Be conservative. Stay inside the supported chart types. "
        "When the HTML is too rich for the native canvas, adapt it to the closest chart the system already supports."
    )

    payload = _complete_json_with_import_provider(prompt, system_prompt=system_prompt, max_tokens=3000)
    if not isinstance(payload, dict):
        return None, [], build_ai_assist_meta(
            requested=True,
            applied=False,
            status="failed",
            provider=settings.template_import_ai_provider,
            model=settings.template_import_ai_model,
            message="AI provider did not return a usable chart plan payload.",
        )

    charts = payload.get("charts")
    if not isinstance(charts, list):
        return None, [], build_ai_assist_meta(
            requested=True,
            applied=False,
            status="failed",
            provider=settings.template_import_ai_provider,
            model=settings.template_import_ai_model,
            message="AI payload did not include a charts array.",
        )

    raw_calc_fields = payload.get("calculated_fields") or []
    if not isinstance(raw_calc_fields, list):
        raw_calc_fields = []
    validated_calc_fields = _validate_calculated_fields(raw_calc_fields, source_col_names)

    return charts, validated_calc_fields, build_ai_assist_meta(
        requested=True,
        applied=True,
        status="applied",
        provider=settings.template_import_ai_provider,
        model=settings.template_import_ai_model,
        message="AI refined HTML block classification, field mapping, and calculated fields inside the native dashboard/chart contract.",
    )


def analyze_dashboard_html_import(
    *,
    html_text: str,
    html_summary: Dict[str, Any] | None,
    source_profile: Dict[str, Any],
    all_source_profiles: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    document_summary = _build_document_summary(html_text=html_text, html_summary=html_summary)
    candidates, ignored = _candidate_blocks(document_summary)

    ai_plans, calculated_fields, ai_meta = _ai_chart_plans(
        document_summary=document_summary,
        source_profile=source_profile,
    )
    ai_lookup = {
        str(item.get("block_id")): item
        for item in (ai_plans or [])
        if isinstance(item, dict) and str(item.get("block_id") or "").strip()
    }

    # Enrich source profiles with calculated field names so _finalize_plan accepts them
    def _enrich_profile(profile: Dict[str, Any], calc_fields: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not calc_fields:
            return profile
        enriched = dict(profile)
        existing_cols = list(enriched.get("columns") or [])
        existing_names = {col.get("name") for col in existing_cols}
        for cf in calc_fields:
            if cf["name"] not in existing_names:
                existing_cols.append({"name": cf["name"], "type": "number"})
        enriched["columns"] = existing_cols
        existing_numeric = list(enriched.get("numeric_columns") or [])
        for cf in calc_fields:
            if cf["name"] not in existing_numeric:
                existing_numeric.append(cf["name"])
        enriched["numeric_columns"] = existing_numeric
        return enriched

    enriched_profile = _enrich_profile(source_profile, calculated_fields)
    enriched_all = None
    if all_source_profiles:
        enriched_all = {k: _enrich_profile(v, calculated_fields) for k, v in all_source_profiles.items()}

    use_multi = enriched_all and len(enriched_all) > 1
    finalized_plans: List[Dict[str, Any]] = []
    for block in candidates:
        if use_multi:
            best_plan: Optional[Dict[str, Any]] = None
            for key, profile in enriched_all.items():
                plan = _finalize_plan(
                    block=block,
                    raw_plan=ai_lookup.get(block["id"]),
                    source_profile=profile,
                )
                plan["source_key"] = key
                if best_plan is None or _plan_quality_score(plan) > _plan_quality_score(best_plan):
                    best_plan = plan
            if best_plan is not None:
                finalized_plans.append(best_plan)
        else:
            plan = _finalize_plan(
                block=block,
                raw_plan=ai_lookup.get(block["id"]),
                source_profile=enriched_profile,
            )
            finalized_plans.append(plan)

    finalized_plans = [plan for plan in finalized_plans if plan.get("source_fields_used") or plan.get("final_chart_type") == "TABLE"]
    finalized_plans.sort(key=lambda item: (item.get("order", 0), item.get("block_id", "")))
    _assign_layouts(finalized_plans)

    warnings: List[str] = []
    if not finalized_plans:
        warnings.append("No chart plans could be validated from the imported HTML and selected source.")
    if any(plan.get("changed_chart_type") for plan in finalized_plans):
        warnings.append("One or more HTML visuals were adapted to the closest supported AppBI chart type.")
    warnings.append("Narrative HTML blocks are ignored in this MVP; the import focuses on chart tiles and layout.")

    return {
        "suggested_dashboard_name": _normalize_text(document_summary.get("title"), max_len=180) or "Imported Dashboard",
        "document_title": document_summary.get("title"),
        "source_profile": source_profile,
        "chart_plans": finalized_plans,
        "calculated_fields": calculated_fields,
        "ignored_blocks": ignored,
        "warnings": warnings,
        "ai_meta": ai_meta,
    }


def create_manual_dataset_from_excel_source(
    db: Session,
    *,
    current_user: User,
    file_bytes: bytes,
    filename: Optional[str],
    requested_name: Optional[str],
    selected_sheet_name: Optional[str] = None,
) -> Tuple[int, int]:
    all_sheets = parse_uploaded_source_sheets(file_bytes=file_bytes, filename=filename)
    if not all_sheets:
        raise ValueError("Uploaded Excel source does not contain usable data rows.")

    available_sheet_names = list(all_sheets.keys())
    primary_sheet_name = str(selected_sheet_name or "").strip()
    if not primary_sheet_name or primary_sheet_name not in all_sheets:
        primary_sheet_name = available_sheet_names[0]

    if not any((sheet_payload.get("rows") or []) for sheet_payload in all_sheets.values()):
        raise ValueError("Uploaded Excel source does not contain usable data rows.")

    base_name = _normalize_text(requested_name) or _normalize_text(primary_sheet_name) or "Imported Data"
    datasource_name = f"[Dashboard Import] {base_name}"
    data_source = DataSourceCRUDService.create(
        db,
        DataSourceCreate(
            name=datasource_name,
            type="manual",
            config={"sheets": all_sheets},
        ),
        owner_id=current_user.id,
    )

    dataset = DatasetCRUDService.create_dataset(
        db,
        DatasetCreate(name=base_name),
        owner_id=current_user.id,
    )

    primary_table_id: Optional[int] = None
    for sheet_name, sheet_data in all_sheets.items():
        if not (sheet_data.get("columns") or []):
            continue
        table = DatasetCRUDService.add_table_to_dataset(
            db,
            dataset.id,
            TableCreate(
                datasource_id=data_source.id,
                source_kind="physical_table",
                source_table_name=sheet_name,
                display_name=sheet_name,
            ),
        )
        if table is None:
            raise ValueError(f"Failed to attach sheet '{sheet_name}' as a dataset table.")
        if sheet_name == primary_sheet_name:
            primary_table_id = table.id

    if primary_table_id is None:
        raise ValueError("Failed to resolve a primary sheet/table for chart creation.")
    return dataset.id, primary_table_id


def create_manual_dataset_from_multi_excel_source(
    db: Session,
    *,
    current_user: User,
    files: List[Tuple[bytes, Optional[str]]],
    requested_name: Optional[str],
) -> Tuple[int, Dict[str, int]]:
    """Create a dataset from multiple Excel/CSV files.

    Returns ``(dataset_id, source_key_to_table_id_map)``.
    """
    all_sheet_data: Dict[str, Dict[str, Any]] = {}
    source_key_to_safe_name: Dict[str, str] = {}

    for file_bytes, filename in files:
        safe_filename = filename or "uploaded"
        sheets = parse_uploaded_source_sheets(file_bytes=file_bytes, filename=filename)
        for sheet_name, sheet_data in sheets.items():
            source_key = f"{safe_filename}::{sheet_name}"
            # DuckDB cannot handle '::' in table names — use ' - ' for storage
            safe_storage_name = f"{safe_filename} - {sheet_name}"
            all_sheet_data[source_key] = sheet_data
            source_key_to_safe_name[source_key] = safe_storage_name

    if not all_sheet_data:
        raise ValueError("Uploaded files do not contain usable data rows.")
    if not any((data.get("rows") or []) for data in all_sheet_data.values()):
        raise ValueError("Uploaded files do not contain usable data rows.")

    # Build config with DuckDB-safe keys (no '::')
    safe_config_sheets = {
        source_key_to_safe_name[k]: v for k, v in all_sheet_data.items()
    }

    base_name = _normalize_text(requested_name) or "Imported Data"
    datasource_name = f"[Dashboard Import] {base_name}"
    data_source = DataSourceCRUDService.create(
        db,
        DataSourceCreate(
            name=datasource_name,
            type="manual",
            config={"sheets": safe_config_sheets},
        ),
        owner_id=current_user.id,
    )

    dataset = DatasetCRUDService.create_dataset(
        db,
        DatasetCreate(name=base_name),
        owner_id=current_user.id,
    )

    sheet_name_counts: Dict[str, int] = {}
    for source_key in all_sheet_data:
        _, sheet_name = source_key.rsplit("::", 1) if "::" in source_key else ("", source_key)
        sheet_name_counts[sheet_name] = sheet_name_counts.get(sheet_name, 0) + 1

    table_id_map: Dict[str, int] = {}
    for source_key, sheet_data in all_sheet_data.items():
        if not (sheet_data.get("columns") or []):
            continue
        if "::" in source_key:
            filename_part, sheet_name = source_key.rsplit("::", 1)
        else:
            filename_part, sheet_name = "", source_key
        if sheet_name_counts.get(sheet_name, 0) > 1 and filename_part:
            display_name = f"{sheet_name} ({filename_part})"
        else:
            display_name = sheet_name

        safe_name = source_key_to_safe_name[source_key]
        table = DatasetCRUDService.add_table_to_dataset(
            db,
            dataset.id,
            TableCreate(
                datasource_id=data_source.id,
                source_kind="physical_table",
                source_table_name=safe_name,
                display_name=display_name,
            ),
        )
        if table is None:
            raise ValueError(f"Failed to attach '{display_name}' as a dataset table.")
        table_id_map[source_key] = table.id

    if not table_id_map:
        raise ValueError("No usable sheets found in uploaded files.")
    return dataset.id, table_id_map


def _build_chart_config(plan: Dict[str, Any], dataset_id: Optional[int]) -> Dict[str, Any]:
    role_config = dict(plan.get("role_config") or {})
    return {
        "dataset_id": dataset_id,
        "filters": [],
        "baseFilters": [],
        "chartType": plan.get("final_chart_type"),
        "queryMode": "generated",
        "roleConfig": role_config,
        "generatedRoleConfig": role_config,
        "customRoleConfig": {"metrics": []},
        "styleConfig": dict(plan.get("style_config") or {}),
    }


def _apply_calculated_fields_to_tables(
    db: Session,
    *,
    calculated_fields: List[Dict[str, Any]],
    table_id_map: Dict[str, int],
    default_table_id: Optional[int],
) -> None:
    """Inject ``add_column`` transformation steps into dataset tables for AI-suggested calculated fields."""
    from app.services.transformation_compiler import TransformationCompiler

    # Group fields by target table
    table_fields: Dict[int, List[Dict[str, Any]]] = {}
    for cf in calculated_fields:
        if not isinstance(cf, dict):
            continue
        name = str(cf.get("name") or "").strip()
        expression = str(cf.get("expression") or "").strip()
        if not name or not expression:
            continue

        is_valid, _ = TransformationCompiler.validate_expression(expression)
        if not is_valid:
            continue

        source_key = cf.get("source_key")
        if source_key and source_key in table_id_map:
            tid = table_id_map[source_key]
        elif default_table_id:
            tid = default_table_id
        else:
            # Apply to all tables as fallback
            for tid_val in (table_id_map.values() if table_id_map else []):
                table_fields.setdefault(tid_val, []).append(cf)
            continue
        table_fields.setdefault(tid, []).append(cf)

    for table_id, fields in table_fields.items():
        db_table = db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
        if not db_table:
            continue

        existing_transforms = list(db_table.transformations or [])
        existing_calc_names = {
            t.get("params", {}).get("newField")
            for t in existing_transforms
            if t.get("type") == "add_column"
        }

        for cf in fields:
            field_name = cf["name"]
            if field_name in existing_calc_names:
                continue
            existing_transforms.append({
                "type": "add_column",
                "enabled": True,
                "params": {
                    "newField": field_name,
                    "expression": cf["expression"],
                },
            })
            existing_calc_names.add(field_name)

            # Update columns_cache with the new calculated column
            cols_cache = list(db_table.columns_cache or [])
            if not any(c.get("name") == field_name for c in cols_cache):
                cols_cache.append({
                    "name": field_name,
                    "type": "number",
                    "nullable": True,
                    "is_calculated": True,
                    "description": cf.get("label") or field_name,
                })
                db_table.columns_cache = cols_cache

        db_table.transformations = existing_transforms
        db.flush()


def build_dashboard_from_import(
    db: Session,
    *,
    current_user: User,
    analysis: Dict[str, Any],
    source_mode: SourceMode,
    dataset_table_id: Optional[int],
    source_bytes: Optional[bytes],
    source_filename: Optional[str],
    source_files: Optional[List[Tuple[bytes, Optional[str]]]] = None,
    selected_sheet_name: Optional[str],
    dashboard_name: Optional[str],
    target_mode: TargetMode,
    target_dashboard_id: Optional[int],
    included_block_ids: List[str],
) -> Dict[str, Any]:
    chart_plans = [plan for plan in (analysis.get("chart_plans") or []) if isinstance(plan, dict)]
    if included_block_ids:
        selected_ids = {str(item) for item in included_block_ids}
        chart_plans = [plan for plan in chart_plans if str(plan.get("block_id")) in selected_ids]
    if not chart_plans:
        raise ValueError("No chart plans were selected for build.")

    resolved_dataset_table_id = dataset_table_id
    resolved_dataset_id: Optional[int] = None
    table_id_map: Dict[str, int] = {}

    if source_mode == "existing_dataset":
        if resolved_dataset_table_id is None:
            raise ValueError("dataset_table_id is required when building from an existing source.")
        db_table = db.query(DatasetTable).filter(DatasetTable.id == resolved_dataset_table_id).first()
        if not db_table:
            raise ValueError("Dataset table not found.")
        dataset_obj = db.query(Dataset).filter(Dataset.id == db_table.dataset_id).first()
        if not dataset_obj:
            raise ValueError("Dataset not found.")
        require_view_access(db, current_user, dataset_obj, "datasets")
        resolved_dataset_id = dataset_obj.id
    else:
        dataset_permission = (current_user.permissions or {}).get("datasets", "none")
        if dataset_permission not in {"edit", "full"}:
            raise ValueError("Creating a temporary dataset from Excel requires datasets edit permission.")

        if source_files and len(source_files) > 0:
            resolved_dataset_id, table_id_map = create_manual_dataset_from_multi_excel_source(
                db,
                current_user=current_user,
                files=source_files,
                requested_name=dashboard_name or analysis.get("suggested_dashboard_name"),
            )
            resolved_dataset_table_id = next(iter(table_id_map.values())) if table_id_map else None
        elif source_bytes:
            resolved_dataset_id, resolved_dataset_table_id = create_manual_dataset_from_excel_source(
                db,
                current_user=current_user,
                file_bytes=source_bytes,
                filename=source_filename,
                requested_name=dashboard_name or analysis.get("suggested_dashboard_name"),
                selected_sheet_name=selected_sheet_name or analysis.get("source_profile", {}).get("selected_sheet_name"),
            )
        else:
            raise ValueError("Uploaded Excel source is no longer available. Please analyze again.")

    if resolved_dataset_table_id is None and not table_id_map:
        raise ValueError("No dataset table is available for chart creation.")

    # Apply AI-suggested calculated fields as transformation steps
    calc_fields = analysis.get("calculated_fields") or []
    if calc_fields and isinstance(calc_fields, list):
        _apply_calculated_fields_to_tables(
            db,
            calculated_fields=calc_fields,
            table_id_map=table_id_map,
            default_table_id=resolved_dataset_table_id,
        )

    created_charts: List[Chart] = []
    type_changes: List[Dict[str, Any]] = []

    for index, plan in enumerate(chart_plans, start=1):
        display_title = _normalize_text(plan.get("title"), max_len=160) or f"Imported Chart {index}"
        internal_name = _unique_chart_name(db, current_user.id, display_title)
        chart_description_parts = [
            _normalize_text(plan.get("rationale"), max_len=400),
            _normalize_text(plan.get("conversion_note"), max_len=280),
            _normalize_text(plan.get("source_excerpt"), max_len=320),
        ]
        chart_description = "\n\n".join(part for part in chart_description_parts if part)

        chart_table_id = resolved_dataset_table_id
        if table_id_map:
            plan_source_key = plan.get("source_key")
            if plan_source_key and plan_source_key in table_id_map:
                chart_table_id = table_id_map[plan_source_key]

        chart_config = with_chart_semantic_binding(
            db,
            chart_table_id,
            _build_chart_config(plan, resolved_dataset_id),
            auto_generate=True,
        )
        db_chart = Chart(
            name=internal_name,
            description=chart_description or None,
            dataset_table_id=chart_table_id,
            chart_type=ChartType(str(plan.get("final_chart_type") or "TABLE").upper()),
            config=chart_config,
            owner_id=current_user.id,
        )
        db.add(db_chart)
        db.flush()
        created_charts.append(db_chart)

        if plan.get("changed_chart_type"):
            type_changes.append(
                {
                    "block_id": plan.get("block_id"),
                    "title": display_title,
                    "from": plan.get("requested_chart_type") or plan.get("original_chart_type"),
                    "to": plan.get("final_chart_type"),
                    "note": plan.get("conversion_note"),
                }
            )

        metadata_tags = [
            f"import-html:{plan.get('block_role')}",
            f"import-html:{str(plan.get('final_chart_type') or '').lower()}",
        ]
        db.add(
            ChartMetadata(
                chart_id=db_chart.id,
                domain="html_import",
                intent=str(plan.get("final_chart_type") or "").lower(),
                metrics=[item.get("field") for item in (plan.get("role_config", {}).get("metrics") or []) if item.get("field")],
                dimensions=[field for field in [plan.get("role_config", {}).get("dimension"), plan.get("role_config", {}).get("timeField")] if field],
                tags=[tag for tag in metadata_tags if tag],
            )
        )

    import_page_name = _normalize_text(analysis.get("document_title") or dashboard_name or analysis.get("suggested_dashboard_name"), max_len=80) or "Imported Page"
    dashboard_obj: Dashboard
    page_id: str

    if target_mode == "append_to_dashboard":
        if target_dashboard_id is None:
            raise ValueError("target_dashboard_id is required when appending to a dashboard.")
        dashboard_obj = db.query(Dashboard).filter(Dashboard.id == target_dashboard_id).first()
        if not dashboard_obj:
            raise ValueError("Target dashboard not found.")
        require_edit_access(db, current_user, dashboard_obj, "dashboards")
        pages = list(dashboard_obj.pages_config or [DEFAULT_DASHBOARD_PAGE])
        page_id = _generate_page_id()
        pages.append({"id": page_id, "name": import_page_name})
        dashboard_obj.pages_config = pages
    else:
        resolved_dashboard_name = _unique_dashboard_name(
            db,
            dashboard_name or analysis.get("suggested_dashboard_name") or "Imported Dashboard",
        )
        page_id = _generate_page_id()
        dashboard_obj = Dashboard(
            name=resolved_dashboard_name,
            description="Imported from HTML dashboard layout",
            owner_id=current_user.id,
            filters_config=[],
            public_filters_config=[],
            pages_config=[{"id": page_id, "name": import_page_name}],
        )
        db.add(dashboard_obj)
        db.flush()

    for chart_obj, plan in zip(created_charts, chart_plans):
        layout = dict(plan.get("layout") or {})
        dashboard_chart = DashboardChart(
            dashboard_id=dashboard_obj.id,
            chart_id=chart_obj.id,
            layout={
                "x": int(layout.get("x", 0)),
                "y": int(layout.get("y", 0)),
                "w": int(layout.get("w", 6)),
                "h": int(layout.get("h", 4)),
                "pageId": page_id,
                "custom_title": _normalize_text(plan.get("title"), max_len=160) or chart_obj.name,
            },
            parameters={},
        )
        db.add(dashboard_chart)

    db.commit()
    db.refresh(dashboard_obj)

    from app.services.dashboard_service import DashboardService

    hydrated_dashboard = DashboardService.get_by_id(db, dashboard_obj.id)
    return {
        "dashboard": hydrated_dashboard,
        "dashboard_id": dashboard_obj.id,
        "created_chart_count": len(created_charts),
        "type_changes": type_changes,
        "page_id": page_id,
        "page_name": import_page_name,
        "dataset_id": resolved_dataset_id,
        "dataset_table_id": resolved_dataset_table_id,
        "dataset_table_ids": table_id_map if table_id_map else None,
    }
