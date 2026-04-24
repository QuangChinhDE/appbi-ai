"""Runtime helpers for server-side report template preview evaluation."""

from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace
from typing import Any, Dict, List, Tuple

from app.services.transformation_compiler import TransformationCompiler


def _normalize_filter_value(value: Any, operator: str) -> Any:
    normalized_operator = str(operator or "eq").lower()

    if normalized_operator in {"in", "not_in"}:
        if isinstance(value, (list, tuple, set)):
            return [item for item in value if item not in (None, "")]
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return [value] if value not in (None, "") else []

    if normalized_operator == "between":
        if isinstance(value, (list, tuple)):
            parts = [item for item in value if item not in (None, "")]
            return parts[:2]
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()][:2]
        return []

    return value


def resolve_template_runtime_filters(
    template_filters: List[Dict[str, Any]] | None,
    active_filters: List[Dict[str, Any]] | None,
    *,
    dataset_id: int | None = None,
    table_id: int | None = None,
) -> List[Dict[str, Any]]:
    """Resolve template filter definitions plus active values into query filters."""
    active_values: Dict[str, Any] = {}
    for item in active_filters or []:
        if not isinstance(item, dict):
            continue
        filter_id = str(item.get("filterId") or item.get("filter_id") or "").strip()
        if not filter_id:
            continue
        active_values[filter_id] = item.get("value")

    resolved: List[Dict[str, Any]] = []
    for raw_filter in template_filters or []:
        if not isinstance(raw_filter, dict):
            continue

        filter_id = str(raw_filter.get("id") or "").strip()
        column = str(raw_filter.get("column") or "").strip()
        operator = str(raw_filter.get("operator") or "eq").strip().lower()
        if not filter_id or not column:
            continue

        filter_dataset_id = raw_filter.get("datasetId")
        if dataset_id is not None and filter_dataset_id is not None:
            try:
                if int(filter_dataset_id) != int(dataset_id):
                    continue
            except (TypeError, ValueError):
                continue

        filter_table_id = raw_filter.get("tableId")
        if table_id is not None and filter_table_id is not None:
            try:
                if int(filter_table_id) != int(table_id):
                    continue
            except (TypeError, ValueError):
                continue

        raw_value = active_values.get(filter_id, raw_filter.get("defaultValue"))
        if raw_value in (None, ""):
            continue

        normalized_value = _normalize_filter_value(raw_value, operator)
        if normalized_value in (None, ""):
            continue
        if isinstance(normalized_value, list) and len(normalized_value) == 0:
            continue

        filter_payload: Dict[str, Any] = {
            "field": column,
            "operator": operator,
        }
        if operator not in {"is_null", "is_not_null"}:
            filter_payload["value"] = normalized_value
        resolved.append(filter_payload)

    return resolved


def build_template_manual_writeback_config(
    datasource_config: Dict[str, Any] | None,
    sheet_name: str,
    rows: List[Dict[str, Any]] | None,
    columns: List[Dict[str, Any]] | None,
) -> Dict[str, Any]:
    """Build the next manual datasource snapshot from template entry rows."""
    config = deepcopy(datasource_config or {})
    sheets = deepcopy(config.get("sheets") or {})

    resolved_sheet_name = str(sheet_name or "manual_data").strip() or "manual_data"
    if resolved_sheet_name not in sheets:
        for existing_name in sheets:
            if existing_name.lower() == resolved_sheet_name.lower():
                resolved_sheet_name = existing_name
                break

    sheet_payload = deepcopy(sheets.get(resolved_sheet_name) or {
        "columns": [],
        "rows": [],
    })
    existing_columns = [dict(item) for item in list(sheet_payload.get("columns") or []) if isinstance(item, dict)]
    existing_rows = [dict(item) for item in list(sheet_payload.get("rows") or []) if isinstance(item, dict)]
    existing_column_names = [str(item.get("name") or "").strip() for item in existing_columns if str(item.get("name") or "").strip()]

    editable_columns: List[Tuple[str, Dict[str, Any]]] = []
    for raw_column in columns or []:
        if not isinstance(raw_column, dict):
            continue
        if str(raw_column.get("type") or "raw") in {"formula", "subtotal"}:
            continue

        source_name = str(raw_column.get("sourceColumn") or raw_column.get("key") or "").strip()
        if not source_name:
            continue
        editable_columns.append((source_name, raw_column))
        if source_name not in existing_column_names:
            existing_columns.append({
                "name": source_name,
                "type": "number" if str(raw_column.get("format") or "").lower() in {"integer", "decimal", "percentage"} else "string",
            })
            existing_column_names.append(source_name)

    next_rows: List[Dict[str, Any]] = []
    for index, raw_row in enumerate(rows or []):
        if not isinstance(raw_row, dict):
            continue

        if index < len(existing_rows):
            base_row = dict(existing_rows[index])
        else:
            base_row = {column_name: "" for column_name in existing_column_names}

        for source_name, raw_column in editable_columns:
            fallback_key = str(raw_column.get("key") or "").strip()
            if source_name in raw_row:
                base_row[source_name] = raw_row.get(source_name)
            elif fallback_key and fallback_key in raw_row:
                base_row[source_name] = raw_row.get(fallback_key)
            elif index >= len(existing_rows):
                base_row[source_name] = ""

        next_rows.append(base_row)

    sheets[resolved_sheet_name] = {
        **sheet_payload,
        "columns": existing_columns,
        "rows": next_rows,
    }
    config["sheets"] = sheets
    return config


def build_template_preview_transformations(
    columns: List[Dict[str, Any]] | None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    """Translate template formula columns into dataset ``add_column`` transforms."""
    transformations: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = []
    seen_formula_keys: set[str] = set()

    for raw_column in columns or []:
        if not isinstance(raw_column, dict):
            continue

        key = str(raw_column.get("key") or "").strip()
        expression = str(raw_column.get("expression") or "").strip()
        if not key or not expression:
            continue

        if key in seen_formula_keys:
            errors.append({"key": key, "error": "Duplicate formula key."})
            continue

        is_valid, error = TransformationCompiler.validate_expression(expression)
        if not is_valid:
            errors.append({"key": key, "error": error or "Invalid expression."})
            continue

        transformations.append(
            {
                "type": "add_column",
                "enabled": True,
                "params": {"newField": key, "expression": expression},
            }
        )
        seen_formula_keys.add(key)

    return transformations, errors


def build_template_preview_table_proxy(db_table: Any, columns: List[Dict[str, Any]] | None):
    """Clone a dataset table with template formula transforms appended for preview."""
    existing_transformations = deepcopy(getattr(db_table, "transformations", None) or [])
    formula_transformations, errors = build_template_preview_transformations(columns)
    proxy = SimpleNamespace(
        id=getattr(db_table, "id", None),
        source_kind=getattr(db_table, "source_kind", None),
        source_table_name=getattr(db_table, "source_table_name", None),
        source_query=getattr(db_table, "source_query", None),
        display_name=getattr(db_table, "display_name", None),
        datasource_id=getattr(db_table, "datasource_id", None),
        transformations=[*existing_transformations, *formula_transformations],
        type_overrides=deepcopy(getattr(db_table, "type_overrides", None)),
        column_formats=deepcopy(getattr(db_table, "column_formats", None)),
    )
    return proxy, errors