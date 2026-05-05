"""API endpoints for Datasets (Table-based Datasets)"""
from typing import Any, Dict, List, Optional
from decimal import Decimal
import json
import re
from types import SimpleNamespace
from datetime import datetime, date
from urllib.parse import quote
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session, selectinload

from app.core.database import get_db
from app.core.dependencies import (
    get_current_user,
    require_permission,
    require_view_access,
    require_edit_access,
    require_full_access,
    get_effective_permission,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models import DataSource, Chart, Dashboard, DashboardChart, Dataset, DatasetTable
from app.models.models import DashboardPublicLink
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    DatasetCreate,
    DatasetDictionaryResponse,
    DatasetUpdate,
    DatasetResponse,
    DatasetWithTables,
    TableCreate,
    TableUpdate,
    TableResponse,
    TablePreviewRequest,
    TablePreviewResponse,
    ExecuteQueryRequest,
    ExecuteQueryResponse,
    DatasourceTable,
    DatasetColumnMetadata,
)
from app.services import (
    DatasetCRUDService,
    DataSourceConnectionService,
    EmbeddingService,
    DatasetQualityService,
)
from app.services.dataset_quality_service import QualityRuleConflictError
from app.services import query_cache
from app.services.chart_contracts import normalize_filter_conditions
from app.services.dataset_calendar_service import (
    build_calendar_columns_cache,
    get_calendar_settings,
    is_generated_calendar_table,
)
from app.services.dataset_table_sql_service import (
    build_live_proxy_table_for_dataset_table,
    DatasetTableSqlError,
    build_dataset_table_sql_alias,
    collect_derived_dependency_table_ids,
    get_dataset_table_reference_options,
    is_derived_table,
    validate_and_clean_derived_query,
)
from app.services.dataset_model_service import generate_dataset_model, sync_dataset_model_structure
from app.services.dataset_dictionary_service import (
    build_dictionary_context,
    build_dictionary_stats,
    normalize_dictionary_payload,
)
from app.services.description_pipeline_service import (
    DescriptionPipelineService,
    resolve_session_factory,
)
from app.services.dataset_excel_export_service import (
    EXCEL_MAX_DATA_ROWS,
    export_dataset_table_to_excel,
)
from app.core.logging import get_logger
from app.services.runtime_modes import datasource_sync_enabled
from app.services.schema_inference import infer_schema_from_sql
from app.services.live_query_service import (
    LiveQueryService,
    build_dataset_table_cache_identifier,
    build_live_base_query_plan,
)
from app.services.type_override_service import (
    audit_type_overrides,
    normalize_type_overrides,
)

router = APIRouter()
logger = get_logger(__name__)


def _stamp_dataset_catalog_fields(items: list[Dataset]) -> None:
    for item in items:
        datasource_ids: list[int] = []
        for table in getattr(item, "tables", []) or []:
            datasource_id = getattr(table, "datasource_id", None)
            if isinstance(datasource_id, int) and datasource_id not in datasource_ids:
                datasource_ids.append(datasource_id)
        item.datasource_ids = datasource_ids


LOOKUP_TABLE_IDENTIFIER_PREFIX = "dataset-table://"



# ISO date/datetime patterns for string-based detection
_ISO_DATETIME_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?'
)
_ISO_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _build_lookup_table_identifier(table_id: int) -> str:
    return f"{LOOKUP_TABLE_IDENTIFIER_PREFIX}{table_id}"


def _build_excel_export_filenames(dataset_name: Any, table_name: Any) -> tuple[str, str]:
    base_name = f"{str(dataset_name or 'dataset').strip()}-{str(table_name or 'table').strip()}"
    base_name = re.sub(r"\s+", " ", base_name).strip(" -") or "dataset-table"
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", base_name).strip("._-") or "dataset-table"
    return f"{ascii_name}.xlsx", f"{base_name}.xlsx"


def _dataset_table_lookup_tokens(table: DatasetTable) -> List[str]:
    tokens: List[str] = []
    for candidate in (
        _build_lookup_table_identifier(table.id),
        table.display_name,
        table.source_table_name,
    ):
        text = str(candidate or "").strip()
        if text and text not in tokens:
            tokens.append(text)
    return tokens


def _formula_references_dataset_table(formula: Any, table: DatasetTable) -> bool:
    text = str(formula or "")
    if not text:
        return False
    lowered = text.lower()
    return any(f'"{token}"'.lower() in lowered for token in _dataset_table_lookup_tokens(table))


def _semantic_prefixes_for_table(
    db: Session,
    *,
    dataset_id: int,
    table: DatasetTable,
) -> set[str]:
    from app.models.semantic import SemanticExplore, SemanticModel, SemanticView

    prefixes: set[str] = set()
    base_view = db.query(SemanticView).filter(SemanticView.dataset_table_id == table.id).first()
    if base_view is not None:
        prefixes.add(f"{base_view.name}.")

    if not is_generated_calendar_table(table):
        return prefixes

    model = db.query(SemanticModel).filter(SemanticModel.dataset_id == dataset_id).first()
    if model is None:
        return prefixes

    explores = db.query(SemanticExplore).filter(SemanticExplore.model_id == model.id).all()
    for explore in explores:
        for join in explore.joins or []:
            if join.get("origin") != "auto_calendar":
                continue
            for key in ("view", "calendar_role", "presentation_view"):
                name = str(join.get(key) or "").strip()
                if name:
                    prefixes.add(f"{name}.")
    return prefixes


def _config_references_semantic_prefix(value: Any, prefixes: set[str]) -> bool:
    if isinstance(value, dict):
        for key, nested in value.items():
            if key == "semanticBinding":
                continue
            if _config_references_semantic_prefix(nested, prefixes):
                return True
        return False

    if isinstance(value, list):
        return any(_config_references_semantic_prefix(item, prefixes) for item in value)

    if isinstance(value, str):
        stripped = value.strip()
        return any(stripped.startswith(prefix) for prefix in prefixes)

    return False


def _filter_references_semantic_prefix(filter_obj: Any, dataset_id: int, prefixes: set[str]) -> bool:
    if not isinstance(filter_obj, dict):
        return False

    filter_dataset_id = filter_obj.get("datasetId")
    if filter_dataset_id is not None:
        try:
            if int(filter_dataset_id) != dataset_id:
                return False
        except (TypeError, ValueError):
            pass

    for key in ("semanticField", "fieldKey", "field"):
        value = filter_obj.get(key)
        if isinstance(value, str) and any(value.strip().startswith(prefix) for prefix in prefixes):
            return True

    linked_fields = filter_obj.get("linkedFields")
    if isinstance(linked_fields, list):
        for value in linked_fields:
            if isinstance(value, str) and any(value.strip().startswith(prefix) for prefix in prefixes):
                return True

    return False


def _build_delete_constraint(
    constraint_type: str,
    *,
    object_label: str,
    detail: str,
    **extra: Any,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "type": constraint_type,
        "object_label": object_label,
        "detail": detail,
    }
    for key, value in extra.items():
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        payload[key] = value
    return payload


def _dedupe_delete_constraints(constraints: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    unique: List[Dict[str, Any]] = []
    for constraint in constraints:
        key = (
            constraint.get("type"),
            constraint.get("id"),
            constraint.get("table_id"),
            constraint.get("link_id"),
            constraint.get("column"),
            constraint.get("field"),
            constraint.get("name"),
            constraint.get("table_name"),
            constraint.get("object_label"),
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(constraint)
    return unique


def _infer_column_type(col: str, col_index: int, rows: list) -> str:
    """
    Infer the column type from sample row values.
    Samples up to 20 non-null rows for better accuracy.
    Returns: 'boolean' | 'integer' | 'float' | 'date' | 'datetime' | 'string'
    """
    values = []
    for row in rows[:20]:
        if isinstance(row, dict):
            val = row.get(col)
        elif isinstance(row, (list, tuple)):
            val = row[col_index] if col_index < len(row) else None
        else:
            val = None
        if val is not None and val != '':
            values.append(val)

    if not values:
        return "string"

    # Check Python native types first (SQL/Postgres datasources)
    for val in values:
        if isinstance(val, bool):
            return "boolean"
        if isinstance(val, datetime):
            return "datetime"
        if isinstance(val, date):
            return "date"

    # Check if all numeric Python types
    numeric_vals = [v for v in values if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool)]
    if len(numeric_vals) == len(values):
        if all(isinstance(v, int) or (isinstance(v, float) and v == int(v)) for v in numeric_vals):
            return "integer"
        return "float"

    # String-based detection (GG Sheets, Manual Table — all values come as strings)
    str_vals = [str(v).strip() for v in values]

    # Boolean strings
    bool_set = {'true', 'false', '1', '0', 'yes', 'no'}
    if all(v.lower() in bool_set for v in str_vals):
        return "boolean"

    # Integer strings
    if all(re.fullmatch(r'-?\d+', v) for v in str_vals):
        return "integer"

    # Float strings
    if all(re.fullmatch(r'-?\d+[.,]\d+', v) for v in str_vals):
        return "float"

    # Datetime strings (has time component)
    if all(_ISO_DATETIME_RE.match(v) for v in str_vals):
        return "datetime"

    # Date strings
    if all(_ISO_DATE_RE.fullmatch(v) for v in str_vals):
        return "date"

    return "string"


def _build_columns_cache_payload(
    db_table,
    column_metadata: List[DatasetColumnMetadata],
    source_columns: List[str] | None = None,
) -> Dict[str, Any]:
    existing = db_table.columns_cache if isinstance(db_table.columns_cache, dict) else {}
    payload: Dict[str, Any] = {
        **existing,
        "columns": [col.model_dump() for col in column_metadata],
    }
    source_cols = [str(column) for column in (source_columns or []) if str(column).strip()]
    if source_cols:
        payload["source_columns"] = source_cols
        payload["source_signature"] = {
            "source_kind": getattr(db_table, "source_kind", None),
            "source_table_name": getattr(db_table, "source_table_name", None),
            "source_query": getattr(db_table, "source_query", None),
        }
    return payload


def _serialize_cached_rows(rows: list[dict[str, Any]] | None, *, limit: int = 500) -> list[dict[str, Any]]:
    def _serialize_value(value: Any) -> Any:
        if isinstance(value, (datetime, date)):
            return value.isoformat()
        if isinstance(value, Decimal):
            return float(value)
        return value

    serialized: list[dict[str, Any]] = []
    for row in list(rows or [])[: max(1, int(limit))]:
        if not isinstance(row, dict):
            continue
        serialized.append({key: _serialize_value(value) for key, value in row.items()})
    return serialized


def _format_type_audit_error(audits: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    for audit in audits:
        column = audit.get("column") or "unknown"
        invalid_count = int(audit.get("invalid_count") or 0)
        examples = [str(value) for value in (audit.get("invalid_examples") or [])]
        if examples:
            parts.append(
                f'{column}: {invalid_count} giá trị không hợp lệ. Ví dụ: {", ".join(examples)}'
            )
        else:
            parts.append(f"{column}: {invalid_count} giá trị không hợp lệ.")
    return "Không thể đổi kiểu cột vì dữ liệu không cast an toàn. " + " | ".join(parts)


def _normalize_preview_error_message(exc: Exception) -> str:
    return " ".join(str(exc).split()).strip()


def _normalize_source_table_name(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    parts = [
        part.strip().strip('"').strip("'").strip("`")
        for part in text.split(".")
    ]
    return ".".join(part for part in parts if part)


def _source_table_name_matches(expected: Any, actual: Any) -> bool:
    expected_norm = _normalize_source_table_name(expected)
    actual_norm = _normalize_source_table_name(actual)
    if not expected_norm or not actual_norm:
        return False
    return expected_norm == actual_norm or expected_norm.lower() == actual_norm.lower()


def _source_object_label(datasource: Optional[DataSource]) -> str:
    ds_type = getattr(datasource, "type", None)
    ds_type_value = ds_type.value if hasattr(ds_type, "value") else str(ds_type or "")
    if ds_type_value == "google_sheets":
        return "sheet"
    return "table"


def _build_datasource_missing_detail(db_table: DatasetTable) -> Dict[str, Any]:
    return {
        "code": "DATASOURCE_MISSING",
        "message": "The datasource connected to this dataset table no longer exists or is not accessible.",
        "table_id": getattr(db_table, "id", None),
        "table_name": getattr(db_table, "display_name", None) or getattr(db_table, "source_table_name", None),
        "source_table_name": getattr(db_table, "source_table_name", None),
        "datasource_id": getattr(db_table, "datasource_id", None),
    }


def _build_source_table_missing_detail(
    db_table: DatasetTable,
    datasource: Optional[DataSource],
    raw_error: str | None = None,
) -> Dict[str, Any]:
    label = _source_object_label(datasource)
    source_name = getattr(db_table, "source_table_name", None)
    message = (
        f"The source {label} '{source_name}' is no longer available in the connected datasource. "
        f"It may have been deleted or renamed."
    )
    return {
        "code": "SOURCE_TABLE_MISSING",
        "message": message,
        "table_id": getattr(db_table, "id", None),
        "table_name": getattr(db_table, "display_name", None) or source_name,
        "source_table_name": source_name,
        "source_object": label,
        "datasource_id": getattr(db_table, "datasource_id", None),
        "raw_error": raw_error,
    }


def _looks_like_missing_source_table_error(message: str) -> bool:
    lower_msg = (message or "").lower()
    return (
        "not found in spreadsheet" in lower_msg
        or "no such table" in lower_msg
        or "not found: table" in lower_msg
        or "table not found" in lower_msg
        or "sheet not found" in lower_msg
        or ("table with name" in lower_msg and "does not exist" in lower_msg)
        or ("relation" in lower_msg and "does not exist" in lower_msg)
        or ("sheet" in lower_msg and "not found" in lower_msg)
    )


def _build_preview_source_error_detail(
    db_table: DatasetTable,
    datasource: Optional[DataSource],
    exc: Exception,
) -> Optional[Dict[str, Any]]:
    if (
        getattr(db_table, "source_kind", None) != "physical_table"
        or not getattr(db_table, "source_table_name", None)
    ):
        return None

    error_msg = _normalize_preview_error_message(exc)
    if _looks_like_missing_source_table_error(error_msg):
        return _build_source_table_missing_detail(db_table, datasource, error_msg)
    return None


def _is_fixable_preview_error(exc: Exception) -> bool:
    if isinstance(exc, ValueError):
        return True

    lower_msg = _normalize_preview_error_message(exc).lower()
    return any(
        token in lower_msg
        for token in (
            "syntax error",
            "invalidquery",
            "invalid query",
            "parse error",
            "credential",
            "oauth",
            "permission denied",
            "access denied",
            "unauthorized",
            "forbidden",
            "not found",
            "does not exist",
            "no such",
            "scan",
        )
    )


def _preview_live_table_draft(
    datasource: DataSource,
    table_draft: Any,
    *,
    limit: int = 200,
) -> tuple[List[DatasetColumnMetadata], List[Dict[str, Any]]]:
    result = LiveQueryService.execute_preview_query(
        datasource=datasource,
        db_table=table_draft,
        limit=limit,
        offset=0,
    )
    preview_columns = list(result.get("columns") or [])
    preview_rows = list(result.get("rows") or [])
    preview_metadata = [
        DatasetColumnMetadata(
            name=column_name,
            type=_infer_column_type(column_name, index, preview_rows),
            nullable=True,
        )
        for index, column_name in enumerate(preview_columns)
    ]
    return preview_metadata, preview_rows


def _build_table_draft(db_table, table_update) -> Any:
    update_data = table_update.model_dump(exclude_unset=True)
    return SimpleNamespace(
        id=getattr(db_table, "id", None),
        source_kind=getattr(db_table, "source_kind", None),
        source_table_name=getattr(db_table, "source_table_name", None),
        source_query=update_data.get("source_query", getattr(db_table, "source_query", None)),
        display_name=update_data.get("display_name", getattr(db_table, "display_name", None)),
        transformations=update_data.get("transformations", getattr(db_table, "transformations", None)),
        type_overrides=update_data.get("type_overrides", getattr(db_table, "type_overrides", None)),
        columns_cache=getattr(db_table, "columns_cache", None),
    )


def _serialize_table_description(table) -> dict:
    return {
        "auto_description": getattr(table, "auto_description", None),
        "column_descriptions": getattr(table, "column_descriptions", None),
        "common_questions": getattr(table, "common_questions", None),
        "query_aliases": getattr(table, "query_aliases", None),
        "description_source": getattr(table, "description_source", None),
        "description_updated_at": table.description_updated_at.isoformat() if getattr(table, "description_updated_at", None) else None,
        "schema_change_pending": getattr(table, "schema_change_pending", False),
        "generation_status": getattr(table, "generation_status", "idle") or "idle",
        "generation_error": getattr(table, "generation_error", None),
        "generation_requested_at": table.generation_requested_at.isoformat() if getattr(table, "generation_requested_at", None) else None,
        "generation_finished_at": table.generation_finished_at.isoformat() if getattr(table, "generation_finished_at", None) else None,
        "stale_reason": getattr(table, "stale_reason", None),
    }


def _serialize_dataset_dictionary(dataset_obj: Dataset) -> dict:
    dictionary = normalize_dictionary_payload(getattr(dataset_obj, "dictionary", None))
    stats = build_dictionary_stats(dictionary, getattr(dataset_obj, "tables", None) or [])
    return {
        "dictionary": dictionary,
        "dictionary_updated_at": (
            dataset_obj.dictionary_updated_at.isoformat()
            if getattr(dataset_obj, "dictionary_updated_at", None)
            else None
        ),
        "stats": stats,
        "compiled_context": build_dictionary_context(
            dataset_obj,
            getattr(dataset_obj, "tables", None) or [],
        ),
    }


def _sync_dataset_model_safely(db: Session, dataset_id: int) -> None:
    try:
        sync_dataset_model_structure(db, dataset_id, create_model=False)
    except Exception as exc:
        db.rollback()
        logger.warning("Dataset model sync skipped for dataset %s: %s", dataset_id, exc)


def _cleanup_semantic_view_for_table(db: Session, table_id: int) -> None:
    """Delete the SemanticView linked to a DatasetTable and remove every
    explore join that references it.  Must be called BEFORE the DatasetTable
    row is deleted so the FK-backed dataset_table_id is still resolvable."""
    from app.models.semantic import SemanticExplore, SemanticView

    view = db.query(SemanticView).filter(SemanticView.dataset_table_id == table_id).first()
    if view is None:
        return

    view_name = view.name
    if view_name:
        for explore in db.query(SemanticExplore).all():
            old_joins = explore.joins or []
            new_joins = [j for j in old_joins if j.get("view") != view_name]
            if len(new_joins) != len(old_joins):
                explore.joins = new_joins

    db.delete(view)
    db.flush()


def _run_auto_type_detection(table_id: int) -> None:
    """Background job: full-scan inference + apply for newly synced tables."""
    from app.core.database import SessionLocal
    from app.services.column_type_inference_service import (
        apply_suggestions_to_table,
        infer_full_column_types,
    )

    job_db = SessionLocal()
    try:
        table = job_db.query(DatasetTable).filter(DatasetTable.id == table_id).first()
        if not table:
            return
        datasource = job_db.query(DataSource).filter(
            DataSource.id == table.datasource_id
        ).first()
        if not datasource:
            return
        suggestions = infer_full_column_types(datasource, table)
        applied = apply_suggestions_to_table(
            job_db, table, suggestions, overwrite_user_overrides=False
        )
        if applied:
            logger.info(
                "Auto type detection applied %d overrides on table id=%s",
                len(applied),
                table_id,
            )
    except Exception as exc:
        logger.warning(
            "Auto type detection failed for table id=%s: %s", table_id, exc
        )
    finally:
        job_db.close()


def _enqueue_auto_type_detection_if_needed(
    background_tasks: BackgroundTasks,
    db_table: DatasetTable,
) -> None:
    """Only run auto-detect for sources whose schema is unreliable (Sheets, manual)."""
    datasource_id = getattr(db_table, "datasource_id", None)
    if datasource_id is None:
        return
    table_id = getattr(db_table, "id", None)
    if table_id is None:
        return
    ds_type = None
    datasource = getattr(db_table, "datasource", None)
    if datasource is not None:
        ds_type = datasource.type if isinstance(datasource.type, str) else getattr(datasource.type, "value", None)
    if ds_type not in ("google_sheets", "manual"):
        return
    background_tasks.add_task(_run_auto_type_detection, int(table_id))


def _extract_cached_source_columns(db_table: DatasetTable | Any) -> List[str]:
    cache = getattr(db_table, "columns_cache", None)
    if isinstance(cache, dict):
        source_columns = cache.get("source_columns")
        if isinstance(source_columns, list):
            normalized = [str(column) for column in source_columns if str(column).strip()]
            if normalized:
                return normalized
        raw_columns = cache.get("columns")
        if isinstance(raw_columns, list):
            normalized = [
                str(column.get("name") or "").strip()
                for column in raw_columns
                if isinstance(column, dict) and str(column.get("name") or "").strip()
            ]
            if normalized:
                return normalized
    elif isinstance(cache, list):
        normalized = [
            str(column.get("name") or "").strip()
            for column in cache
            if isinstance(column, dict) and str(column.get("name") or "").strip()
        ]
        if normalized:
            return normalized
    return []


def _has_server_side_projection_changes(db_table: DatasetTable | Any) -> bool:
    if normalize_type_overrides(getattr(db_table, "type_overrides", None)):
        return True
    from app.services.transformation_compiler import TransformationCompiler

    return any(
        isinstance(step, dict)
        for step in TransformationCompiler.normalize_server_transformations(
            getattr(db_table, "transformations", None) or []
        )
    )


def _infer_dataset_table_source_columns(
    db: Session,
    dataset_obj: Dataset,
    datasource: Optional[DataSource],
    db_table: DatasetTable | Any,
    *,
    fallback_columns: List[DatasetColumnMetadata] | None = None,
) -> List[str]:
    if is_generated_calendar_table(db_table):
        return [column.name for column in (fallback_columns or []) if str(column.name or "").strip()]

    if is_derived_table(db_table):
        cached = _extract_cached_source_columns(db_table)
        if cached:
            return cached
        return [column.name for column in (fallback_columns or []) if str(column.name or "").strip()]

    if datasource is None:
        cached = _extract_cached_source_columns(db_table)
        if cached:
            return cached
        return [column.name for column in (fallback_columns or []) if str(column.name or "").strip()]

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    inferred_columns: List[Dict[str, Any]] = []
    if db_table.source_kind == "physical_table" and db_table.source_table_name:
        inferred_columns = DataSourceConnectionService.list_columns(
            ds_id=datasource.id,
            ds_type=ds_type,
            config=datasource.config,
            table_name=db_table.source_table_name,
        )
    elif db_table.source_kind == "sql_query" and db_table.source_query:
        inferred_columns = infer_schema_from_sql(
            db=db,
            datasource=datasource,
            sql_query=db_table.source_query,
        )

    normalized = [
        str(column.get("name") or "").strip()
        for column in inferred_columns or []
        if str(column.get("name") or "").strip()
    ]
    if normalized:
        return normalized

    cached = _extract_cached_source_columns(db_table)
    if cached:
        return cached
    return [column.name for column in (fallback_columns or []) if str(column.name or "").strip()]


def _infer_dataset_table_columns(
    db: Session,
    dataset_obj: Dataset,
    datasource: Optional[DataSource],
    db_table: DatasetTable | Any,
) -> List[DatasetColumnMetadata]:
    if is_generated_calendar_table(db_table):
        return [
            DatasetColumnMetadata(
                name=str(column.get("name") or ""),
                type=str(column.get("type") or "string"),
                nullable=bool(column.get("nullable", False)),
            )
            for column in build_calendar_columns_cache()["columns"]
            if str(column.get("name") or "").strip()
        ]

    if _has_server_side_projection_changes(db_table):
        if is_derived_table(db_table):
            datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
            result = LiveQueryService.execute_preview_query(
                datasource=datasource,
                db_table=live_proxy_table,
                limit=200,
                offset=0,
            )
        else:
            if datasource is None:
                raise DatasetTableSqlError("Datasource not found", code="DATASOURCE_NOT_FOUND")
            result = LiveQueryService.execute_preview_query(
                datasource=datasource,
                db_table=db_table,
                limit=200,
                offset=0,
            )

        column_names = list(result.get("columns") or [])
        rows = list(result.get("rows") or [])
        return [
            DatasetColumnMetadata(
                name=column_name,
                type=_infer_column_type(column_name, index, rows),
                nullable=True,
            )
            for index, column_name in enumerate(column_names)
        ]

    if is_derived_table(db_table):
        datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
            db,
            dataset_obj,
            db_table,
        )
        result = LiveQueryService.execute_preview_query(
            datasource=datasource,
            db_table=live_proxy_table,
            limit=200,
            offset=0,
        )
        column_names = list(result.get("columns") or [])
        rows = list(result.get("rows") or [])
        return [
            DatasetColumnMetadata(
                name=column_name,
                type=_infer_column_type(column_name, index, rows),
                nullable=True,
            )
            for index, column_name in enumerate(column_names)
        ]

    if datasource is None:
        raise DatasetTableSqlError("Datasource not found", code="DATASOURCE_NOT_FOUND")

    ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
    inferred_columns: List[Dict[str, Any]] = []
    if db_table.source_kind == "physical_table" and db_table.source_table_name:
        inferred_columns = DataSourceConnectionService.list_columns(
            ds_id=datasource.id,
            ds_type=ds_type,
            config=datasource.config,
            table_name=db_table.source_table_name,
        )
    elif db_table.source_kind == "sql_query" and db_table.source_query:
        inferred_columns = infer_schema_from_sql(
            db=db,
            datasource=datasource,
            sql_query=db_table.source_query,
        )

    normalized: List[DatasetColumnMetadata] = []
    for column in inferred_columns or []:
        name = str(column.get("name") or "").strip()
        if not name:
            continue
        col_type = str(column.get("type") or "string").strip().lower()
        normalized.append(
            DatasetColumnMetadata(
                name=name,
                type=col_type or "string",
                nullable=True,
            )
        )
    return normalized


# ===== Table Vector Search (must be before /{dataset_id} routes) =====

@router.get("/tables/search", response_model=List[dict])
def search_tables_vector(
    q: str,
    limit: int = Query(10, ge=1, le=20),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Vector similarity search across dataset tables accessible to the user."""
    from app.services.embedding_service import EmbeddingService
    from app.models.dataset import DatasetTable

    # Build set of dataset IDs the user is allowed to see
    accessible_ds_ids = {
        ds.id
        for ds in _owned_or_shared(db, Dataset, ResourceType.DATASET, current_user).all()
    }

    hits = EmbeddingService.search_similar(
        db, q, resource_type="dataset_table", limit=limit
    )
    if not hits:
        return []
    table_ids = [h["resource_id"] for h in hits]
    tables = db.query(DatasetTable).filter(
        DatasetTable.id.in_(table_ids)
    ).all()
    table_map = {t.id: t for t in tables}
    results = []
    for h in hits:
        t = table_map.get(h["resource_id"])
        if t and t.dataset_id in accessible_ds_ids:
            cols = []
            if t.column_stats:
                cols = list(t.column_stats.keys())
            elif t.columns_cache:
                cc = t.columns_cache
                if isinstance(cc, dict):
                    cc = cc.get("columns", [])
                cols = [c.get("name", c) if isinstance(c, dict) else c for c in cc]
            results.append({
                "id": t.id,
                "dataset_id": t.dataset_id,
                "display_name": t.display_name,
                "auto_description": t.auto_description,
                "columns": cols,
                "similarity": round(h["similarity"], 4),
            })
    return results


# ===== Dataset Endpoints =====

@router.get("/", response_model=List[DatasetResponse])
def list_datasets(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List datasets visible to the current user."""
    items = (
        _owned_or_shared(db, Dataset, ResourceType.DATASET, current_user)
        .options(
            selectinload(Dataset.tables),
        )
        .filter(Dataset.is_draft.is_(False))
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(db, current_user, item, "datasets")
    _stamp_dataset_catalog_fields(items)
    stamp_owner_emails(db, items)
    return items


@router.post("/", response_model=DatasetResponse, status_code=201)
def create_dataset(
    dataset_in: DatasetCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("datasets", "edit")),
):
    """Create a new dataset"""
    try:
        db_dataset = DatasetCRUDService.create_dataset(db, dataset_in, owner_id=current_user.id)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _sync_dataset_model_safely(db, db_dataset.id)
    db.refresh(db_dataset)
    return db_dataset


@router.get("/{dataset_id}", response_model=DatasetWithTables)
def get_dataset(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a dataset by ID with its tables"""
    dataset_obj = DatasetCRUDService.get_dataset_by_id(
        db, dataset_id, include_tables=True
    )
    
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    
    dataset_obj.user_permission = require_view_access(db, current_user, dataset_obj, "datasets")
    return dataset_obj


@router.put("/{dataset_id}", response_model=DatasetResponse)
def update_dataset(
    dataset_id: int,
    dataset_in: DatasetUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a dataset"""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")
    try:
        db_dataset = DatasetCRUDService.update_dataset(
            db, dataset_id, dataset_in
        )
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if db_dataset:
        _sync_dataset_model_safely(db, dataset_id)
        db.refresh(db_dataset)
    return db_dataset


@router.delete("/{dataset_id}", status_code=204)
def delete_dataset(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a dataset, blocked if any of its tables are used by charts."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_full_access(db, current_user, dataset_obj, "datasets")

    table_ids = [t.id for t in db.query(DatasetTable).filter(
        DatasetTable.dataset_id == dataset_id
    ).all()]

    if table_ids:
        blocking_charts = db.query(Chart).filter(Chart.dataset_table_id.in_(table_ids)).all()
        if blocking_charts:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": f"Dataset \"{dataset_obj.name}\" có bảng đang được sử dụng trong {len(blocking_charts)} biểu đồ và không thể xóa.",
                    "constraints": [
                        {"type": "chart", "id": c.id, "name": c.name}
                        for c in blocking_charts
                    ],
                },
            )

    success = DatasetCRUDService.delete_dataset(db, dataset_id)
    if not success:
        raise HTTPException(status_code=404, detail="Dataset not found")


@router.get("/{dataset_id}/dictionary", response_model=DatasetDictionaryResponse)
def get_dataset_dictionary(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id, include_tables=True)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")
    return _serialize_dataset_dictionary(dataset_obj)


@router.put("/{dataset_id}/dictionary", response_model=DatasetDictionaryResponse)
def update_dataset_dictionary(
    dataset_id: int,
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id, include_tables=True)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    normalized_dictionary = normalize_dictionary_payload(body)
    dataset_obj.dictionary = normalized_dictionary or None
    dataset_obj.dictionary_updated_at = datetime.utcnow()
    db.commit()
    db.refresh(dataset_obj)
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id, include_tables=True)
    return _serialize_dataset_dictionary(dataset_obj)


@router.get("/{dataset_id}/dictionary/context", response_model=DatasetDictionaryResponse)
def get_dataset_dictionary_context(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id, include_tables=True)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")
    return _serialize_dataset_dictionary(dataset_obj)


# ===== Table Endpoints =====

@router.get("/{dataset_id}/tables", response_model=List[TableResponse])
def list_dataset_tables(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all tables in a dataset"""
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    tables = DatasetCRUDService.get_dataset_tables(db, dataset_id)
    return tables


@router.get("/{dataset_id}/tables/source-status")
def get_dataset_table_source_status(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Check whether physical dataset tables still exist in their live datasource."""
    dataset_obj = DatasetCRUDService.get_dataset_by_id(db, dataset_id)
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    tables = DatasetCRUDService.get_dataset_tables(db, dataset_id)
    datasource_ids = sorted(
        {
            int(table.datasource_id)
            for table in tables
            if getattr(table, "datasource_id", None) is not None
        }
    )
    datasources = {
        datasource.id: datasource
        for datasource in (
            db.query(DataSource)
            .filter(DataSource.id.in_(datasource_ids))
            .all()
            if datasource_ids
            else []
        )
    }
    live_table_cache: Dict[int, List[Dict[str, Any]]] = {}
    live_table_errors: Dict[int, str] = {}

    def get_live_tables(datasource: DataSource) -> List[Dict[str, Any]]:
        if datasource.id not in live_table_cache and datasource.id not in live_table_errors:
            ds_type = datasource.type.value if hasattr(datasource.type, "value") else str(datasource.type)
            try:
                live_table_cache[datasource.id] = DataSourceConnectionService.list_tables(
                    ds_type,
                    datasource.config,
                )
            except Exception as exc:
                live_table_errors[datasource.id] = _normalize_preview_error_message(exc)
        return live_table_cache.get(datasource.id, [])

    statuses: List[Dict[str, Any]] = []
    for table in tables:
        base = {
            "table_id": table.id,
            "table_name": table.display_name or table.source_table_name,
            "source_kind": table.source_kind,
            "source_table_name": table.source_table_name,
            "datasource_id": table.datasource_id,
        }
        if table.source_kind != "physical_table" or not table.datasource_id or not table.source_table_name:
            statuses.append({**base, "status": "ok", "code": None, "message": None})
            continue

        datasource = datasources.get(table.datasource_id)
        if not datasource:
            statuses.append({
                **base,
                "status": "error",
                "code": "DATASOURCE_MISSING",
                "message": "The datasource connected to this table no longer exists or is not accessible.",
            })
            continue

        live_tables = get_live_tables(datasource)
        if datasource.id in live_table_errors:
            statuses.append({
                **base,
                "status": "ok",
                "code": "SOURCE_STATUS_UNVERIFIED",
                "message": "Could not verify this table against the connected datasource.",
                "verified": False,
                "raw_error": live_table_errors[datasource.id],
            })
            continue

        exists = any(
            _source_table_name_matches(table.source_table_name, live_table.get("name"))
            for live_table in live_tables
        )
        if exists:
            statuses.append({**base, "status": "ok", "code": None, "message": None})
        else:
            statuses.append({
                **base,
                "status": "missing",
                **_build_source_table_missing_detail(table, datasource),
            })

    return {
        "tables": statuses,
        "checked_at": datetime.utcnow().isoformat() + "Z",
    }


@router.post("/{dataset_id}/tables", status_code=201)
def add_table_to_dataset(
    dataset_id: int,
    table: TableCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a table to a dataset"""
    try:
        ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            raise HTTPException(status_code=404, detail="Dataset not found")
        require_edit_access(db, current_user, ds, "datasets")

        datasource: Optional[DataSource] = None
        inferred_metadata: List[DatasetColumnMetadata] = []
        inferred_rows: List[Dict[str, Any]] = []

        if table.source_kind == "derived_table":
            try:
                table.source_query = validate_and_clean_derived_query(table.source_query or "")
                draft_display_name = str(
                    table.display_name
                    or "Calculated Table"
                ).strip()
                derived_draft = SimpleNamespace(
                    id=None,
                    dataset_id=dataset_id,
                    datasource_id=None,
                    source_kind="derived_table",
                    source_table_name=None,
                    source_query=table.source_query,
                    display_name=draft_display_name,
                    enabled=table.enabled,
                    transformations=table.transformations or [],
                    type_overrides=None,
                    columns_cache=None,
                )
                datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                    db,
                    ds,
                    derived_draft,
                )
                inferred_metadata, inferred_rows = _preview_live_table_draft(
                    datasource,
                    live_proxy_table,
                )
            except DatasetTableSqlError as exc:
                status_code = 422 if getattr(exc, "code", "") == "NOT_SYNCED" else 400
                detail: Any = str(exc)
                if getattr(exc, "code", "") == "NOT_SYNCED":
                    detail = {"code": exc.code, "message": str(exc)}
                raise HTTPException(status_code=status_code, detail=detail)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
        else:
            # Validate datasource exists
            datasource = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
            if not datasource:
                raise HTTPException(status_code=404, detail="Datasource not found")
            require_view_access(db, current_user, datasource, "data_sources")

        # Validate SQL query if source_kind is datasource-backed 'sql_query'
        if table.source_kind == "sql_query":
            from app.services.query_validator import QueryValidator, QueryValidationError
            try:
                # Validate and clean the query
                table.source_query = QueryValidator.validate_and_clean(table.source_query)
                if datasource is None:
                    raise HTTPException(status_code=404, detail="Datasource not found")

                sql_query_draft = SimpleNamespace(
                    id=None,
                    dataset_id=dataset_id,
                    datasource_id=table.datasource_id,
                    source_kind="sql_query",
                    source_table_name=None,
                    source_query=table.source_query,
                    display_name=str(table.display_name or "Untitled Table").strip(),
                    enabled=table.enabled,
                    transformations=table.transformations or [],
                    type_overrides=None,
                    columns_cache=None,
                )
                inferred_metadata, inferred_rows = _preview_live_table_draft(
                    datasource,
                    sql_query_draft,
                )
            except QueryValidationError as e:
                raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                if _is_fixable_preview_error(exc):
                    raise HTTPException(status_code=400, detail=_normalize_preview_error_message(exc)) from exc
                raise
        
        try:
            db_table = DatasetCRUDService.add_table_to_dataset(
                db, dataset_id, table
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        
        if not db_table:
            raise HTTPException(status_code=404, detail="Dataset not found")

        if not datasource_sync_enabled() and db_table.datasource_id is not None:
            db_table.query_mode = "live"
            db.commit()
            db.refresh(db_table)

        # ── Auto-detect table size and set query_mode ──
        if datasource_sync_enabled() and datasource is not None and db_table.source_kind == "physical_table" and db_table.source_table_name:
            try:
                ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
                stn = db_table.source_table_name.strip().strip('"').strip("'")
                if "." in stn:
                    schema_name, tbl_name = stn.split(".", 1)
                    schema_name = schema_name.strip('"').strip("'")
                    tbl_name = tbl_name.strip('"').strip("'")
                else:
                    schema_name = "public" if ds_type == "postgresql" else ""
                    tbl_name = stn

                size_info = LiveQueryService.get_table_size_metadata(
                    ds_type, datasource.config, schema_name, tbl_name,
                )
                if size_info.get("estimated_row_count") or size_info.get("estimated_size_bytes"):
                    db_table.estimated_row_count = size_info.get("estimated_row_count")
                    db_table.estimated_size_bytes = size_info.get("estimated_size_bytes")
                    if LiveQueryService.should_use_live_mode(
                        size_info.get("estimated_row_count"),
                        size_info.get("estimated_size_bytes"),
                    ):
                        db_table.query_mode = "live"
                        logger.info(
                            "Table %s auto-set to live mode (rows=%s, bytes=%s)",
                            db_table.source_table_name,
                            size_info.get("estimated_row_count"),
                            size_info.get("estimated_size_bytes"),
                        )
                    db.commit()
                    db.refresh(db_table)
            except Exception as e:
                logger.warning("Size detection failed for table %s: %s", db_table.source_table_name, e)
        elif datasource is not None and db_table.source_kind == "physical_table" and db_table.source_table_name:
            try:
                ds_type = datasource.type if isinstance(datasource.type, str) else datasource.type.value
                stn = db_table.source_table_name.strip().strip('"').strip("'")
                if "." in stn:
                    schema_name, tbl_name = stn.split(".", 1)
                    schema_name = schema_name.strip('"').strip("'")
                    tbl_name = tbl_name.strip('"').strip("'")
                else:
                    schema_name = "public" if ds_type == "postgresql" else ""
                    tbl_name = stn
                size_info = LiveQueryService.get_table_size_metadata(
                    ds_type, datasource.config, schema_name, tbl_name,
                )
                db_table.estimated_row_count = size_info.get("estimated_row_count")
                db_table.estimated_size_bytes = size_info.get("estimated_size_bytes")
                db.commit()
                db.refresh(db_table)
            except Exception as e:
                logger.warning("Size detection failed for live-only table %s: %s", db_table.source_table_name, e)

        try:
            if not inferred_metadata:
                inferred_metadata = _infer_dataset_table_columns(db, ds, datasource, db_table)
            if inferred_metadata:
                source_columns = _infer_dataset_table_source_columns(
                    db,
                    ds,
                    datasource,
                    db_table,
                    fallback_columns=inferred_metadata,
                )
                db_table = DatasetCRUDService.update_table_cache(
                    db,
                    db_table.id,
                    columns_cache=_build_columns_cache_payload(
                        db_table,
                        inferred_metadata,
                        source_columns=source_columns,
                    ),
                    sample_cache=_serialize_cached_rows(inferred_rows) or None,
                ) or db_table
        except Exception as e:
            logger.warning("Column inference failed for dataset table %s: %s", db_table.id, e)

        # Queue a single AI-description pipeline to avoid duplicate generate/embed work.
        DescriptionPipelineService.enqueue_table_pipeline(
            background_tasks,
            db,
            db_table.id,
            trigger="table_created",
        )

        _enqueue_auto_type_detection_if_needed(background_tasks, db_table)

        _sync_dataset_model_safely(db, dataset_id)
        db.refresh(db_table)

        # Return plain dict instead of model to avoid serialization issues
        return {
            "id": db_table.id,
            "dataset_id": db_table.dataset_id,
            "datasource_id": db_table.datasource_id,
            "source_kind": db_table.source_kind,
            "source_table_name": db_table.source_table_name,
            "source_query": db_table.source_query,
            "display_name": db_table.display_name,
            "enabled": db_table.enabled,
            "transformations": db_table.transformations,
            "columns_cache": db_table.columns_cache,
            "sample_cache": db_table.sample_cache,
            "type_overrides": db_table.type_overrides,
            "column_formats": db_table.column_formats,
            "query_mode": getattr(db_table, 'query_mode', 'synced') or 'synced',
            "estimated_row_count": getattr(db_table, 'estimated_row_count', None),
            "estimated_size_bytes": getattr(db_table, 'estimated_size_bytes', None),
            "created_at": db_table.created_at.isoformat() if db_table.created_at else None,
            "updated_at": db_table.updated_at.isoformat() if db_table.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to add table to dataset")
        raise HTTPException(status_code=500, detail="Failed to add table to dataset.")


@router.put("/{dataset_id}/tables/{table_id}", response_model=TableResponse)
def update_dataset_table(
    dataset_id: int,
    table_id: int,
    table_update: TableUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a table in a dataset"""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")
    # Verify table belongs to dataset
    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")
    if is_generated_calendar_table(db_table):
        raise HTTPException(
            status_code=400,
            detail="Standard Date table is managed by dataset calendar settings and cannot be edited here.",
        )

    # Reject source_query updates on unsupported table kinds
    if table_update.source_query is not None and db_table.source_kind not in {"sql_query", "derived_table"}:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot set source_query on a '{db_table.source_kind}' table.",
        )
    datasource: Optional[DataSource] = None
    preview_metadata: List[DatasetColumnMetadata] = []
    preview_rows: List[Dict[str, Any]] = []

    # Validate SQL query if source_query is being updated
    if table_update.source_query is not None:
        if db_table.source_kind == "derived_table":
            try:
                table_update.source_query = validate_and_clean_derived_query(table_update.source_query)
                table_draft = _build_table_draft(db_table, table_update)
                datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                    db,
                    ds,
                    table_draft,
                )
                preview_metadata, preview_rows = _preview_live_table_draft(
                    datasource,
                    live_proxy_table,
                )
            except DatasetTableSqlError as exc:
                status_code = 422 if getattr(exc, "code", "") == "NOT_SYNCED" else 400
                detail: Any = str(exc)
                if getattr(exc, "code", "") == "NOT_SYNCED":
                    detail = {"code": exc.code, "message": str(exc)}
                raise HTTPException(status_code=status_code, detail=detail)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
        else:
            from app.services.query_validator import QueryValidator, QueryValidationError
            try:
                table_update.source_query = QueryValidator.validate_and_clean(table_update.source_query)
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if not datasource:
                    raise HTTPException(status_code=404, detail="Datasource not found")

                table_draft = _build_table_draft(db_table, table_update)
                preview_metadata, preview_rows = _preview_live_table_draft(
                    datasource,
                    table_draft,
                )
            except QueryValidationError as e:
                raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                if _is_fixable_preview_error(exc):
                    raise HTTPException(status_code=400, detail=_normalize_preview_error_message(exc)) from exc
                raise

    if table_update.type_overrides is not None:
        from app.services.type_override_service import _canonical_column_key

        normalized_overrides = normalize_type_overrides(table_update.type_overrides)
        current_overrides = normalize_type_overrides(getattr(db_table, "type_overrides", None))

        # Resolve override keys against the actual base-query columns. Frontend
        # may send display_name (e.g. "REV FINAL (TRỪ VAT, GỒM BBDS)") while
        # the SQL plan exposes a canonical/safe identifier. Without this remap,
        # save succeeds but the cast layer never matches the column at query
        # time -> SUM falls back to VARCHAR and fails on rows with text.
        if normalized_overrides and db_table.datasource_id is not None:
            try:
                _resolve_ds = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if _resolve_ds is not None:
                    _resolve_draft = _build_table_draft(db_table, table_update)
                    _resolve_plan = build_live_base_query_plan(
                        _resolve_ds, _resolve_draft, apply_type_overrides=False
                    )
                    _avail = [str(c) for c in (_resolve_plan.output_columns or [])]
                    _avail_set = set(_avail)
                    _canon_map = {_canonical_column_key(c): c for c in _avail}
                    remapped: Dict[str, str] = {}
                    for col, tgt in normalized_overrides.items():
                        if col in _avail_set:
                            remapped[col] = tgt
                        else:
                            resolved = _canon_map.get(_canonical_column_key(col))
                            remapped[resolved if resolved else col] = tgt
                    normalized_overrides = remapped
            except Exception:
                # Best-effort remap; fall through to existing audit which will
                # surface a precise "Unknown column" error if still mismatched.
                pass

        changed_overrides = {
            column: target_type
            for column, target_type in normalized_overrides.items()
            if current_overrides.get(column) != target_type
        }

        if changed_overrides:
            if db_table.datasource_id is not None:
                datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
                if not datasource:
                    raise HTTPException(status_code=404, detail="Datasource not found")
                table_draft = _build_table_draft(db_table, table_update)

                try:
                    # Specialty: the audit checks how many rows would FAIL to
                    # cast under the candidate overrides. We must run it
                    # against the raw base query — applying overrides here
                    # would make every check look successful by construction.
                    # Do NOT route through resolve_dataset_table_relation.
                    plan = build_live_base_query_plan(
                        datasource,
                        table_draft,
                        apply_type_overrides=False,
                    )
                    audits = audit_type_overrides(
                        datasource=datasource,
                        table_identifier=build_dataset_table_cache_identifier(table_draft),
                        base_query=plan.sql,
                        candidate_overrides=changed_overrides,
                        available_columns=plan.output_columns,
                        dialect=(
                            datasource.type.value
                            if hasattr(datasource.type, "value")
                            else str(datasource.type)
                        ),
                    )
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc))

                invalid_audits = [audit.to_dict() for audit in audits if audit.invalid_count > 0]
                if invalid_audits:
                    raise HTTPException(
                        status_code=400,
                        detail={
                            "message": _format_type_audit_error(invalid_audits),
                            "type_audit": invalid_audits,
                        },
                    )

        table_update.type_overrides = normalized_overrides

    schema_refresh_requested = any(
        value is not None
        for value in (
            table_update.source_query,
            table_update.transformations,
            table_update.type_overrides,
        )
    )

    if schema_refresh_requested and (
        table_update.transformations is not None or table_update.type_overrides is not None
    ):
        validation_draft = _build_table_draft(db_table, table_update)
        validation_datasource = datasource
        if validation_datasource is None and getattr(validation_draft, "datasource_id", None) is not None:
            validation_datasource = db.query(DataSource).filter(
                DataSource.id == validation_draft.datasource_id
            ).first()
        try:
            preview_metadata = _infer_dataset_table_columns(
                db,
                ds,
                validation_datasource,
                validation_draft,
            )
        except DatasetTableSqlError as exc:
            status_code = 422 if getattr(exc, "code", "") == "NOT_SYNCED" else 400
            detail: Any = str(exc)
            if getattr(exc, "code", "") == "NOT_SYNCED":
                detail = {"code": exc.code, "message": str(exc)}
            raise HTTPException(status_code=status_code, detail=detail)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            if _is_fixable_preview_error(exc):
                raise HTTPException(status_code=400, detail=_normalize_preview_error_message(exc)) from exc
            raise

    try:
        updated_table = DatasetCRUDService.update_table(
            db, table_id, table_update
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated_table and db_table.datasource_id is not None:
        query_cache.invalidate_datasource(db_table.datasource_id)

    if updated_table and schema_refresh_requested:
        datasource = db.query(DataSource).filter(DataSource.id == updated_table.datasource_id).first() if updated_table.datasource_id is not None else None
        try:
            inferred_metadata = preview_metadata or _infer_dataset_table_columns(db, ds, datasource, updated_table)
            if inferred_metadata:
                source_columns = _infer_dataset_table_source_columns(
                    db,
                    ds,
                    datasource,
                    updated_table,
                    fallback_columns=inferred_metadata,
                )
                updated_table = DatasetCRUDService.update_table_cache(
                    db,
                    updated_table.id,
                    columns_cache=_build_columns_cache_payload(
                        updated_table,
                        inferred_metadata,
                        source_columns=source_columns,
                    ),
                    sample_cache=_serialize_cached_rows(preview_rows) or None,
                ) or updated_table
        except Exception as exc:
            logger.warning("Column inference failed after updating table %s: %s", updated_table.id, exc)

    DescriptionPipelineService.enqueue_table_pipeline(
        background_tasks,
        db,
        table_id,
        trigger="table_updated",
    )

    _sync_dataset_model_safely(db, dataset_id)
    if updated_table:
        db.refresh(updated_table)

    return updated_table


@router.delete("/{dataset_id}/tables/{table_id}", status_code=204)
def remove_table_from_dataset(
    dataset_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a table from a dataset, after checking for chart/formula dependencies"""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")
    # Verify table belongs to dataset
    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    dataset_table_ids = [
        int(row[0])
        for row in db.query(DatasetTable.id).filter(DatasetTable.dataset_id == dataset_id).all()
    ]

    # ------------------------------------------------------------------
    # Check 1: charts that directly reference this table
    # ------------------------------------------------------------------
    blocking_charts = (
        db.query(Chart)
        .filter(Chart.dataset_table_id == table_id)
        .all()
    )

    # ------------------------------------------------------------------
    # Check 2: other tables in this dataset whose js_formula
    # transformations reference this table by its display label
    # ------------------------------------------------------------------
    table_label = db_table.display_name or db_table.source_table_name or str(table_id)
    other_tables = (
        db.query(DatasetTable)
        .filter(
            DatasetTable.dataset_id == dataset_id,
            DatasetTable.id != table_id,
        )
        .all()
    )
    blocking_lookups = []
    blocking_calculated_tables = []
    for t in other_tables:
        if is_derived_table(t) and t.source_query:
            depends_on_table = False
            try:
                depends_on_table = table_id in collect_derived_dependency_table_ids(
                    db,
                    dataset_id,
                    t.source_query,
                    exclude_table_id=t.id,
                )
            except DatasetTableSqlError:
                fallback_aliases = {
                    build_dataset_table_sql_alias(table_id).lower(),
                }
                for option in get_dataset_table_reference_options(
                    db,
                    dataset_id,
                    exclude_table_id=t.id,
                    include_disabled=True,
                ):
                    if option.table_id == table_id:
                        fallback_aliases.add(option.alias.lower())
                        break
                depends_on_table = any(alias in str(t.source_query).lower() for alias in fallback_aliases)

            if depends_on_table:
                calculated_name = t.display_name or t.source_table_name or f"Table {t.id}"
                blocking_calculated_tables.append(_build_delete_constraint(
                    "calculated_table",
                    table_id=t.id,
                    table_name=calculated_name,
                    object_label=f'Calculated table "{calculated_name}"',
                    detail="Its SQL still depends on this source table.",
                ))

        transforms = t.transformations or []
        for step in transforms:
            if step.get("type") == "js_formula" and step.get("enabled", True):
                formula = step.get("params", {}).get("formula", "")
                if _formula_references_dataset_table(formula, db_table):
                    lookup_table_name = t.display_name or t.source_table_name or f"Table {t.id}"
                    lookup_column = step.get("params", {}).get("newField", "")
                    blocking_lookups.append(_build_delete_constraint(
                        "lookup",
                        table_id=t.id,
                        table_name=lookup_table_name,
                        column=lookup_column,
                        object_label=(
                            f'Column "{lookup_column}" in table "{lookup_table_name}"'
                            if lookup_column
                            else f'Table "{lookup_table_name}"'
                        ),
                        detail="A LOOKUP or js_formula column here still references this table.",
                    ))
                    break  # one entry per table is enough

    # ------------------------------------------------------------------
    # Check 3: semantic filters / saved config that explicitly reference
    # this table's semantic fields (dashboard filters, public links, or
    # chart configs that store qualified fields).
    # ------------------------------------------------------------------
    semantic_prefixes = _semantic_prefixes_for_table(
        db,
        dataset_id=dataset_id,
        table=db_table,
    )
    blocking_semantic_refs = []
    if semantic_prefixes and dataset_table_ids:
        direct_chart_ids = {chart.id for chart in blocking_charts}
        dataset_charts = (
            db.query(Chart)
            .filter(Chart.dataset_table_id.in_(dataset_table_ids))
            .all()
        )
        for chart in dataset_charts:
            if chart.id in direct_chart_ids:
                continue
            chart_config = chart.config if isinstance(chart.config, dict) else {}
            if _config_references_semantic_prefix(chart_config, semantic_prefixes):
                chart_name = chart.name or f"Chart {chart.id}"
                blocking_semantic_refs.append(_build_delete_constraint(
                    "chart_filter",
                    id=chart.id,
                    name=chart_name,
                    object_label=f'Chart "{chart_name}"',
                    detail="Its saved semantic configuration still references fields from this table.",
                ))

        dashboard_ids = [
            int(row[0])
            for row in (
                db.query(Dashboard.id)
                .join(Dashboard.dashboard_charts)
                .join(DashboardChart.chart)
                .filter(Chart.dataset_table_id.in_(dataset_table_ids))
                .distinct()
                .all()
            )
        ]
        dashboards = (
            db.query(Dashboard)
            .filter(Dashboard.id.in_(dashboard_ids))
            .all()
            if dashboard_ids
            else []
        )
        public_links = (
            db.query(DashboardPublicLink)
            .filter(DashboardPublicLink.dashboard_id.in_(dashboard_ids))
            .all()
            if dashboard_ids
            else []
        )

        for dashboard in dashboards:
            for filter_obj in dashboard.filters_config or []:
                if _filter_references_semantic_prefix(filter_obj, dataset_id, semantic_prefixes):
                    field_name = filter_obj.get("label") or filter_obj.get("semanticField") or filter_obj.get("field")
                    dashboard_name = dashboard.name or f"Dashboard {dashboard.id}"
                    blocking_semantic_refs.append(_build_delete_constraint(
                        "dashboard_filter",
                        id=dashboard.id,
                        name=dashboard_name,
                        field=field_name,
                        object_label=f'Dashboard "{dashboard_name}"',
                        detail=(
                            f'Filter "{field_name}" still references this table.'
                            if field_name
                            else "One of its filters still references this table."
                        ),
                    ))
                    break
            for filter_obj in dashboard.public_filters_config or []:
                if _filter_references_semantic_prefix(filter_obj, dataset_id, semantic_prefixes):
                    field_name = filter_obj.get("label") or filter_obj.get("semanticField") or filter_obj.get("field")
                    dashboard_name = dashboard.name or f"Dashboard {dashboard.id}"
                    blocking_semantic_refs.append(_build_delete_constraint(
                        "public_link_filter",
                        id=dashboard.id,
                        name=dashboard_name,
                        field=field_name,
                        scope="dashboard_public_filters",
                        object_label=f'Dashboard "{dashboard_name}" public filters',
                        detail=(
                            f'Public filter "{field_name}" still references this table.'
                            if field_name
                            else "A public dashboard filter still references this table."
                        ),
                    ))
                    break

        for link in public_links:
            for filter_obj in link.filters_config or []:
                if _filter_references_semantic_prefix(filter_obj, dataset_id, semantic_prefixes):
                    field_name = filter_obj.get("label") or filter_obj.get("semanticField") or filter_obj.get("field")
                    link_name = link.name or f"Public link {link.id}"
                    blocking_semantic_refs.append(_build_delete_constraint(
                        "public_link_filter",
                        id=link.dashboard_id,
                        link_id=link.id,
                        name=link_name,
                        field=field_name,
                        scope="public_link",
                        object_label=f'Public link "{link_name}"',
                        detail=(
                            f'Filter "{field_name}" still references this table.'
                            if field_name
                            else "One of its filters still references this table."
                        ),
                    ))
                    break

    constraints = []
    for ch in blocking_charts:
        chart_name = ch.name or f"Chart {ch.id}"
        constraints.append(_build_delete_constraint(
            "chart",
            id=ch.id,
            name=chart_name,
            object_label=f'Chart "{chart_name}"',
            detail="This chart is built directly from the table you are trying to delete.",
        ))
    constraints.extend(blocking_calculated_tables)
    constraints.extend(blocking_lookups)
    constraints.extend(blocking_semantic_refs)
    constraints = _dedupe_delete_constraints(constraints)

    if constraints:
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"Bảng \"{table_label}\" đang được sử dụng và không thể xóa.",
                "constraints": constraints,
            },
        )

    EmbeddingService.delete_embedding(db, "dataset_table", table_id)

    if is_generated_calendar_table(db_table):
        current_settings = get_calendar_settings(ds, enabled_default=False)
        DatasetCRUDService.update_dataset(
            db,
            dataset_id,
            DatasetUpdate.model_validate({
                "settings": {
                    "calendar_dimension": {
                        **current_settings,
                        "enabled": False,
                    }
                }
            }),
        )
        success = True
    else:
        datasource_id = db_table.datasource_id
        _cleanup_semantic_view_for_table(db, table_id)
        success = DatasetCRUDService.delete_table(db, table_id)
        if datasource_id is not None:
            query_cache.invalidate_datasource(datasource_id)
            if not DatasetCRUDService.dataset_has_datasource_backed_table(db, dataset_id):
                current_settings = get_calendar_settings(ds, enabled_default=False)
                if current_settings.get("enabled"):
                    DatasetCRUDService.update_dataset(
                        db,
                        dataset_id,
                        DatasetUpdate.model_validate({
                            "settings": {
                                "calendar_dimension": {
                                    **current_settings,
                                    "enabled": False,
                                }
                            }
                        }),
                    )
    _sync_dataset_model_safely(db, dataset_id)

    if not success:
        raise HTTPException(status_code=404, detail="Table not found")


@router.post(
    "/{dataset_id}/tables/{table_id}/preview",
    response_model=TablePreviewResponse
)
def preview_dataset_table(
    dataset_id: int,
    table_id: int,
    preview_request: TablePreviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview data from a dataset table with transformations"""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    limit = min(preview_request.limit or 1000, 1000)
    offset = max(preview_request.offset or 0, 0)
    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)})
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail=_build_datasource_missing_detail(db_table))

    # ── Preview directly from live source ──
    try:
        result = LiveQueryService.execute_preview_query(
            datasource=datasource,
            db_table=target_table,
            limit=limit,
            offset=offset,
            filters=[f.model_dump() for f in preview_request.filters] if preview_request.filters else None,
        )
        rows = result["rows"]
        columns = result["columns"]
        column_metadata = []
        for i, col in enumerate(columns):
            col_type = _infer_column_type(col, i, rows)
            column_metadata.append(DatasetColumnMetadata(name=col, type=col_type, nullable=True))

        from app.services.type_override_service import _override_type as _ovr_type
        type_overrides = db_table.type_overrides or {}
        for col_meta in column_metadata:
            if col_meta.name in type_overrides:
                resolved = _ovr_type(type_overrides[col_meta.name])
                if resolved:
                    col_meta.type = resolved

        def serialize_value(val):
            if isinstance(val, (datetime, date)):
                return val.isoformat()
            if isinstance(val, Decimal):
                return float(val)
            return val

        serializable_rows = []
        for row in rows[:500]:
            if isinstance(row, dict):
                serializable_rows.append({k: serialize_value(v) for k, v in row.items()})
            else:
                serializable_rows.append([serialize_value(v) for v in row])

        columns_cache_payload = (
            build_calendar_columns_cache()
            if is_generated_calendar_table(db_table)
            else _build_columns_cache_payload(
                db_table,
                column_metadata,
                source_columns=result.get("source_columns") or [],
            )
        )
        DatasetCRUDService.update_table_cache(
            db, table_id,
            columns_cache=columns_cache_payload,
            sample_cache=serializable_rows,
        )
        _sync_dataset_model_safely(db, dataset_id)

        total = len(rows)
        has_more = len(rows) >= limit
        if is_generated_calendar_table(db_table):
            settings = get_calendar_settings(dataset_obj, enabled_default=False)
            total = (
                date.fromisoformat(settings["end_date"]) - date.fromisoformat(settings["start_date"])
            ).days + 1
            has_more = (offset + len(rows)) < total

        return TablePreviewResponse(
            columns=column_metadata,
            rows=rows,
            total=total,
            has_more=has_more,
        )
    except HTTPException:
        raise
    except ValueError as e:
        detail = _build_preview_source_error_detail(db_table, datasource, e)
        if detail:
            raise HTTPException(status_code=400, detail=detail) from e
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        error_msg = _normalize_preview_error_message(e)
        if _is_fixable_preview_error(e):
            logger.warning("Preview execution error for table %d: %s", table_id, error_msg)
            detail = _build_preview_source_error_detail(db_table, datasource, e)
            if detail:
                raise HTTPException(status_code=400, detail=detail) from e
            if any(kw in error_msg.lower() for kw in ("syntax error", "invalidquery", "invalid query", "parse error")):
                raise HTTPException(status_code=400, detail=f"SQL error: {error_msg}")
            raise HTTPException(status_code=400, detail=error_msg or "Preview query failed.")
        logger.error("Failed to preview table: %s", e)
        raise HTTPException(status_code=500, detail="Failed to preview table.")


@router.get("/{dataset_id}/tables/{table_id}/export/excel")
def export_dataset_table_excel(
    dataset_id: int,
    table_id: int,
    max_rows: int = Query(EXCEL_MAX_DATA_ROWS, ge=1, le=EXCEL_MAX_DATA_ROWS),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)})
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail="Datasource not found")

    try:
        export_result = export_dataset_table_to_excel(
            lambda limit, offset: LiveQueryService.execute_preview_query(
                datasource=datasource,
                db_table=target_table,
                limit=limit,
                offset=offset,
            ),
            sheet_title=db_table.display_name or db_table.source_table_name or f"Table {table_id}",
            max_rows=max_rows,
        )
        fallback_name, utf8_name = _build_excel_export_filenames(
            dataset_obj.name,
            db_table.display_name or db_table.source_table_name or f"table-{table_id}",
        )
        headers = {
            "Content-Disposition": (
                f"attachment; filename=\"{fallback_name}\"; filename*=UTF-8''{quote(utf8_name)}"
            ),
            "X-AppBI-Export-Rows": str(export_result.rows_written),
        }
        if export_result.truncated:
            headers["X-AppBI-Export-Truncated"] = "true"
        return Response(
            content=export_result.content,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers=headers,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        error_msg = _normalize_preview_error_message(exc)
        if _is_fixable_preview_error(exc):
            logger.warning("Excel export error for table %d: %s", table_id, error_msg)
            raise HTTPException(status_code=400, detail=error_msg or "Excel export failed.") from exc
        logger.error("Failed to export dataset table %d to Excel: %s", table_id, exc)
        raise HTTPException(status_code=500, detail="Failed to export dataset table.") from exc


@router.post(
    "/{dataset_id}/tables/{table_id}/execute",
    response_model=ExecuteQueryResponse
)
def execute_dataset_table_query(
    dataset_id: int,
    table_id: int,
    execute_request: ExecuteQueryRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Execute query on dataset table with dimensions, measures, and filters"""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    # ── Resolve datasource and build live query target ──
    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db,
                dataset_obj,
                db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(
                    status_code=422,
                    detail={"code": exc.code, "message": str(exc)},
                )
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail="Datasource not found")

    # ── Execute aggregation directly against the live source ──
    try:
        measures = [
            {"field": m.field, "agg": m.function}
            for m in (execute_request.measures or [])
        ]
        filters = normalize_filter_conditions(
            [
                {
                    "field": f.field,
                    "operator": f.operator,
                    "value": f.value,
                }
                for f in (execute_request.filters or [])
            ]
        )
        order_by = [
            {
                "field": ob.field,
                "direction": ob.direction,
            }
            for ob in (execute_request.order_by or [])
        ]

        rows = LiveQueryService.execute_dataset_query(
            datasource=datasource,
            db_table=target_table,
            dimensions=execute_request.dimensions or [],
            measures=measures,
            filters=filters,
            order_by=order_by,
            limit=execute_request.limit,
        )

        columns = list(rows[0].keys()) if rows else []
        column_metadata = [
            DatasetColumnMetadata(
                name=col,
                type=_infer_column_type(col, idx, rows),
                nullable=True,
            )
            for idx, col in enumerate(columns)
        ]

        return ExecuteQueryResponse(columns=column_metadata, rows=rows)
    except DatasetTableSqlError as exc:
        if getattr(exc, "code", "") == "NOT_SYNCED":
            raise HTTPException(
                status_code=422,
                detail={"code": exc.code, "message": str(exc)},
            )
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to execute query")
        raise HTTPException(
            status_code=400,
            detail=f"Failed to execute query: {e}",
        )


# ===== Table Description Endpoints =====

@router.get("/{dataset_id}/tables/{table_id}/description")
def get_table_description(
    dataset_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get AI-generated description and knowledge fields for a dataset table."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    return _serialize_table_description(table)


@router.put("/{dataset_id}/tables/{table_id}/description")
def update_table_description(
    dataset_id: int,
    table_id: int,
    body: dict,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update description fields manually. Sets description_source='user' and re-embeds."""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    if "auto_description" in body:
        table.auto_description = body["auto_description"]
    if "column_descriptions" in body:
        table.column_descriptions = body["column_descriptions"]
    if "common_questions" in body:
        table.common_questions = body["common_questions"]
    if "query_aliases" in body:
        table.query_aliases = body["query_aliases"]

    table.description_source = "user"
    table.description_updated_at = datetime.utcnow()
    table.schema_change_pending = False
    table.generation_status = "succeeded"
    table.generation_error = None
    table.generation_requested_at = None
    table.generation_finished_at = datetime.utcnow()
    table.stale_reason = None
    db.commit()

    background_tasks.add_task(
        DescriptionPipelineService.run_table_embedding,
        table_id,
        resolve_session_factory(db),
    )

    return _serialize_table_description(table)


@router.post("/{dataset_id}/tables/{table_id}/description/preview")
def preview_table_description(
    dataset_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Run AI description generation synchronously and return the draft without saving.

    Used by the Dictionary diff modal so users can review and edit the AI output
    before choosing to apply it.
    """
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    from app.services.auto_tagging_service import AutoTaggingService
    ok, payload, error = AutoTaggingService.preview_table_description(db, table_id)
    if not ok:
        raise HTTPException(status_code=502, detail=error or "AI generation failed")
    return payload


@router.post("/{dataset_id}/tables/{table_id}/description/regenerate")
def regenerate_table_description(
    dataset_id: int,
    table_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Force-regenerate AI description for a table, then re-embed."""
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, ds, "datasets")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")

    DescriptionPipelineService.enqueue_table_pipeline(
        background_tasks,
        db,
        table_id,
        trigger="manual_regenerate",
        force=True,
    )

    return {"status": "queued", "generation_status": "queued"}


# ===== Datasource Table List Endpoint =====

@router.get(
    "/datasources/{datasource_id}/tables",
    response_model=List[DatasourceTable],
    tags=["datasources"]
)
def list_datasource_tables(
    datasource_id: int,
    search: Optional[str] = Query(None, description="Search query for table names"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all tables from a datasource"""
    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    require_view_access(db, current_user, datasource, "data_sources")
    
    try:
        tables = DataSourceConnectionService.list_tables(
            datasource.type,
            datasource.config,
            search_query=search
        )
        
        return [
            DatasourceTable(
                name=table["name"],
                schema=table.get("schema"),
                table_type=table.get("type", "table")
            )
            for table in tables
        ]
    
    except Exception as e:
        logger.error(f"Failed to list tables: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to list tables."
        )


# ===== Datasource Table Columns Endpoint =====

@router.get(
    "/datasources/{datasource_id}/tables/columns",
    tags=["datasources"]
)
def list_datasource_table_columns(
    datasource_id: int,
    table: str = Query(..., description="Table name (e.g. public.orders or orders)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return columns for a specific table.
    Return columns for a table by querying the live source schema.
    """
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    require_view_access(db, current_user, datasource, "data_sources")
    try:
        columns = DataSourceConnectionService.list_columns(
            ds_id=datasource.id,
            ds_type=datasource.type,
            config=datasource.config,
            table_name=table,
        )
        return {"columns": columns}
    except Exception as e:
        logger.error(f"Failed to list columns for ds {datasource_id} table {table}: {e}")
        raise HTTPException(status_code=500, detail="Failed to list columns.")


# ============ Dataset Data Model (Semantic Layer) ============

@router.post(
    "/{dataset_id}/generate-model",
    summary="Auto-generate semantic model from dataset tables",
)
def generate_model(
    dataset_id: int,
    force: bool = Query(False, description="Force regenerate (overwrite existing)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Scan all tables in the dataset and auto-generate:
    - SemanticView per table (dimensions + measures from columns_cache)
    - SemanticModel for the dataset
    - SemanticExplores with auto-detected JOINs
    """
    from app.services.dataset_model_service import generate_dataset_model

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    try:
        result = generate_dataset_model(db, dataset_id, force=force)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to generate model for dataset {dataset_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate model: {str(e)}",
        )


@router.get(
    "/{dataset_id}/model",
    summary="Get the semantic model for a dataset",
)
def get_dataset_model_endpoint(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Return the full semantic model for Visual Model UI:
    - All views (with dimensions/measures)
    - All explores (with join definitions)
    """
    from app.services.dataset_model_service import get_dataset_model

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    result = get_dataset_model(db, dataset_id)
    if not result:
        return {
            "model_id": None,
            "dataset_id": dataset_id,
            "dataset_name": dataset_obj.name,
            "views": [],
            "explores": [],
            "generated": False,
        }
    return result


@router.get(
    "/{dataset_id}/model/distinct-values",
    summary="Get distinct values for a semantic field",
)
def get_dataset_model_distinct_values(
    dataset_id: int,
    field: str = Query(..., description="Qualified field name, e.g. orders.country"),
    limit: int = Query(200, ge=1, le=500),
    filters: str | None = Query(
        default=None,
        description="JSON-encoded list of dashboard filter objects used to cascade distinct values.",
    ),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.services.dataset_model_service import get_distinct_field_values

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    filter_context: list[dict] = []
    if filters:
        try:
            parsed_filters = json.loads(filters)
            if not isinstance(parsed_filters, list):
                raise ValueError("filters must be a JSON array")
            filter_context = [item for item in parsed_filters if isinstance(item, dict)]
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid filters parameter: {e}")

    try:
        return {
            "field": field,
            "values": get_distinct_field_values(db, dataset_id, field, limit=limit, filters=filter_context),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to load distinct values for dataset {dataset_id} field {field}: {e}")
        raise HTTPException(status_code=500, detail="Failed to load distinct values.")


@router.put(
    "/{dataset_id}/model/views/{view_id}",
    summary="Update a semantic view (dimensions/measures)",
)
def update_dataset_view(
    dataset_id: int,
    view_id: int,
    update_data: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update dimensions/measures/description of a semantic view.
    Used by the Visual Model editor.
    """
    from app.models.semantic import SemanticView

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    view = db.query(SemanticView).filter(SemanticView.id == view_id).first()
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    # Validate the view belongs to this dataset's tables
    table = db.query(DatasetTable).filter(
        DatasetTable.id == view.dataset_table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table and view.dataset_table_id is not None:
        raise HTTPException(status_code=403, detail="View does not belong to this dataset")
    if view.dataset_table_id is None or (table and is_generated_calendar_table(table)):
        raise HTTPException(status_code=400, detail="System-managed model tables cannot be edited here.")

    allowed_fields = {"dimensions", "measures", "description"}
    for key, value in update_data.items():
        if key in allowed_fields:
            setattr(view, key, value)

    db.commit()
    db.refresh(view)

    return {
        "id": view.id,
        "name": view.name,
        "dataset_table_id": view.dataset_table_id,
        "sql_table_name": view.sql_table_name,
        "dimensions": view.dimensions or [],
        "measures": view.measures or [],
        "description": view.description,
    }


@router.put(
    "/{dataset_id}/model/explores/{explore_id}",
    summary="Update a semantic explore (joins)",
)
def update_dataset_explore(
    dataset_id: int,
    explore_id: int,
    update_data: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update joins/description of a semantic explore.
    Used by the Visual Model editor for join management.
    """
    from app.models.semantic import SemanticExplore, SemanticModel

    dataset_obj = db.query(Dataset).filter(
        Dataset.id == dataset_id
    ).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    explore = db.query(SemanticExplore).filter(SemanticExplore.id == explore_id).first()
    if not explore:
        raise HTTPException(status_code=404, detail="Explore not found")

    # Validate explore belongs to this dataset's model
    model = db.query(SemanticModel).filter(
        SemanticModel.id == explore.model_id,
        SemanticModel.dataset_id == dataset_id,
    ).first()
    if not model:
        raise HTTPException(status_code=403, detail="Explore does not belong to this dataset")

    allowed_fields = {"joins", "description"}
    for key, value in update_data.items():
        if key not in allowed_fields:
            continue
        if key == "joins" and isinstance(value, list):
            managed_joins = [
                join for join in (explore.joins or [])
                if join.get("managed") and join.get("origin") not in {"auto_fk", "auto_calendar"}
            ]
            editable_joins = [
                join for join in value
                if not (join.get("managed") and join.get("origin") not in {"auto_fk", "auto_calendar"})
            ]
            setattr(explore, key, [*managed_joins, *editable_joins])
            continue
        setattr(explore, key, value)

    db.commit()
    db.refresh(explore)

    return {
        "id": explore.id,
        "name": explore.name,
        "base_view_name": explore.base_view_name,
        "base_view_id": explore.base_view_id,
        "joins": explore.joins or [],
        "description": explore.description,
    }


@router.post(
    "/{dataset_id}/model/joins/suggestion",
    summary="Suggest and validate a relationship between two tables",
)
def suggest_model_join(
    dataset_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Inspect two semantic views + columns and suggest the relationship shape.
    Body: {from_view_id, to_view_id, from_column, to_column}
    """
    from app.services.dataset_model_service import suggest_join_relationship

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_view_access(db, current_user, dataset_obj, "datasets")

    required = {"from_view_id", "to_view_id", "from_column", "to_column"}
    missing = required - set(payload.keys())
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing fields: {missing}")

    try:
        return suggest_join_relationship(
            db,
            dataset_id=dataset_id,
            from_view_id=int(payload["from_view_id"]),
            to_view_id=int(payload["to_view_id"]),
            from_column=payload["from_column"],
            to_column=payload["to_column"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to suggest join for dataset {dataset_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/{dataset_id}/model/joins",
    summary="Add or update a relationship between two tables",
)
def add_model_join(
    dataset_id: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Add or update a join/relationship between two semantic views.
    Body: {from_view_id, to_view_id, from_column, to_column, join_type, relationship}
    """
    from app.services.dataset_model_service import add_join

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    required = {"from_view_id", "to_view_id", "from_column", "to_column"}
    missing = required - set(payload.keys())
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing fields: {missing}")

    try:
        alias_value = payload.get("alias")
        if alias_value is not None:
            alias_value = str(alias_value).strip() or None
        result = add_join(
            db,
            dataset_id=dataset_id,
            from_view_id=int(payload["from_view_id"]),
            to_view_id=int(payload["to_view_id"]),
            from_column=payload["from_column"],
            to_column=payload["to_column"],
            join_type=payload.get("join_type", "left"),
            relationship=payload.get("relationship", "many_to_one"),
            alias=alias_value,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to add join for dataset {dataset_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete(
    "/{dataset_id}/model/joins",
    summary="Remove a relationship between two tables",
)
def remove_model_join(
    dataset_id: int,
    from_view_id: int = Query(..., description="SemanticView ID of the source table"),
    to_view_name: str = Query(..., description="View name of the target table"),
    from_column: Optional[str] = Query(None, description="Optional source column for an exact join match"),
    to_column: Optional[str] = Query(None, description="Optional target column for an exact join match"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a join/relationship from one semantic view to another."""
    from app.services.dataset_model_service import remove_join

    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    require_edit_access(db, current_user, dataset_obj, "datasets")

    try:
        result = remove_join(
            db,
            dataset_id,
            from_view_id,
            to_view_name,
            from_column=from_column,
            to_column=to_column,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to remove join for dataset {dataset_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ===== Data Quality Endpoints =====

from app.models.dataset import DatasetQualityRule, DatasetQualityRun
from app.schemas.dataset import (
    QualityRuleCreate,
    QualityRuleBulkCreate,
    QualityRuleUpdate,
    QualityRuleResponse,
    QualityRuleDuplicateRequest,
    QualityRunTriggerResponse,
    QualityRunResponse,
    QualitySummaryResponse,
    QualityRulePreviewRequest,
    QualityRulePreviewResponse,
    QualityRuleTestRequest,
    QualityRuleTestResponse,
)


def _get_dataset_or_404(db: Session, dataset_id: int) -> Dataset:
    ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return ds


# ── Rules ──────────────────────────────────────────────────────────────────

@router.get("/{dataset_id}/quality/summary", response_model=QualitySummaryResponse)
def get_quality_summary(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Aggregated quality summary: rule counts, score, dimension breakdown."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")
    return DatasetQualityService.get_summary(db, dataset_id)


@router.get("/{dataset_id}/quality/rules", response_model=List[QualityRuleResponse])
def list_quality_rules(
    dataset_id: int,
    table_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all quality rules for a dataset, optionally filtered by table."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")
    return DatasetQualityService.list_rules(db, dataset_id, table_id=table_id)


@router.post("/{dataset_id}/quality/rules/preview", response_model=QualityRulePreviewResponse)
def preview_quality_rule(
    dataset_id: int,
    body: QualityRulePreviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview a rule's SQL and descriptions without saving it."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")

    config_dict = body.config.model_dump(exclude_none=True) if body.config else {}
    result = DatasetQualityService.preview_rule(
        db=db,
        dataset_id=dataset_id,
        table_id=body.table_id,
        rule_type=body.rule_type,
        column_name=body.column_name,
        config=config_dict,
    )
    return QualityRulePreviewResponse(**result)


@router.post("/{dataset_id}/quality/rules/test", response_model=QualityRuleTestResponse)
def test_quality_rule(
    dataset_id: int,
    body: QualityRuleTestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Execute a rule preview against live data without saving it."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")

    config_dict = body.config.model_dump(exclude_none=True) if body.config else {}
    result = DatasetQualityService.test_rule(
        db=db,
        dataset_id=dataset_id,
        table_id=body.table_id,
        rule_type=body.rule_type,
        column_name=body.column_name,
        config=config_dict,
    )
    return QualityRuleTestResponse(**result)


@router.post("/{dataset_id}/quality/rules", response_model=QualityRuleResponse, status_code=201)
def create_quality_rule(
    dataset_id: int,
    body: QualityRuleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new quality rule."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    # Verify table belongs to dataset
    table = db.query(DatasetTable).filter(
        DatasetTable.id == body.table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    try:
        return DatasetQualityService.create_rule(db, dataset_id, body)
    except QualityRuleConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{dataset_id}/quality/rules/bulk", response_model=List[QualityRuleResponse], status_code=201)
def create_quality_rules_bulk(
    dataset_id: int,
    body: QualityRuleBulkCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create multiple quality rules in one atomic request. Rolls back on any failure."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    # Verify all referenced tables belong to the dataset
    table_ids = {item.table_id for item in body.rules}
    valid_tables = {
        row.id
        for row in db.query(DatasetTable.id)
        .filter(DatasetTable.id.in_(table_ids), DatasetTable.dataset_id == dataset_id)
        .all()
    }
    missing = table_ids - valid_tables
    if missing:
        raise HTTPException(status_code=404, detail=f"Tables not found in this dataset: {sorted(missing)}")

    try:
        return DatasetQualityService.create_rules_bulk(db, dataset_id, body.rules)
    except QualityRuleConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/{dataset_id}/quality/rules/{rule_id}", response_model=QualityRuleResponse)
def update_quality_rule(
    dataset_id: int,
    rule_id: int,
    body: QualityRuleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a quality rule."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    rule = db.query(DatasetQualityRule).filter(
        DatasetQualityRule.id == rule_id,
        DatasetQualityRule.dataset_id == dataset_id,
    ).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Quality rule not found")

    try:
        return DatasetQualityService.update_rule(db, rule, body)
    except QualityRuleConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/{dataset_id}/quality/rules/{rule_id}", status_code=204)
def delete_quality_rule(
    dataset_id: int,
    rule_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a quality rule."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    rule = db.query(DatasetQualityRule).filter(
        DatasetQualityRule.id == rule_id,
        DatasetQualityRule.dataset_id == dataset_id,
    ).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Quality rule not found")

    DatasetQualityService.delete_rule(db, rule)


@router.post("/{dataset_id}/quality/rules/{rule_id}/duplicate", response_model=QualityRuleResponse, status_code=201)
def duplicate_quality_rule(
    dataset_id: int,
    rule_id: int,
    body: QualityRuleDuplicateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Duplicate a quality rule, optionally to a different table."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    rule = db.query(DatasetQualityRule).filter(
        DatasetQualityRule.id == rule_id,
        DatasetQualityRule.dataset_id == dataset_id,
    ).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Quality rule not found")

    # Validate target table belongs to this dataset
    if body.target_table_id is not None:
        from app.models.dataset import DatasetTable as DT
        target_table = db.query(DT).filter(
            DT.id == body.target_table_id,
            DT.dataset_id == dataset_id,
        ).first()
        if not target_table:
            raise HTTPException(status_code=404, detail="Target table not found in this dataset")

    try:
        return DatasetQualityService.duplicate_rule(
            db, rule,
            target_table_id=body.target_table_id,
            name_suffix=body.name_suffix,
        )
    except QualityRuleConflictError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ── Runs ───────────────────────────────────────────────────────────────────

@router.post(
    "/{dataset_id}/quality/runs",
    response_model=QualityRunTriggerResponse,
    status_code=202,
)
def trigger_quality_run(
    dataset_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Trigger a full quality-check run in the background."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    run = DatasetQualityService.create_run(
        db,
        dataset_id,
        triggered_by_id=str(current_user.id),
    )
    background_tasks.add_task(DatasetQualityService.execute_run, run.id)
    return QualityRunTriggerResponse(run_id=run.id, status=run.status)


@router.get("/{dataset_id}/quality/runs", response_model=List[QualityRunResponse])
def list_quality_runs(
    dataset_id: int,
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List recent quality run history."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")
    return DatasetQualityService.list_runs(db, dataset_id, limit=limit)


@router.get("/{dataset_id}/quality/runs/{run_id}", response_model=QualityRunResponse)
def get_quality_run(
    dataset_id: int,
    run_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a specific quality run result (used for polling)."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")

    run = db.query(DatasetQualityRun).filter(
        DatasetQualityRun.id == run_id,
        DatasetQualityRun.dataset_id == dataset_id,
    ).first()
    if not run:
        raise HTTPException(status_code=404, detail="Quality run not found")
    return run


# ── Schedule / Automation ─────────────────────────────────────────────────

from app.models.dataset import DatasetQualitySchedule
from app.schemas.dataset import (
    QualityScheduleResponse,
    QualityScheduleUpsert,
)


def _schedule_to_response(
    dataset_id: int,
    schedule: Optional[DatasetQualitySchedule],
) -> QualityScheduleResponse:
    if schedule is None:
        return QualityScheduleResponse(dataset_id=dataset_id)
    return QualityScheduleResponse.model_validate(schedule)


@router.get(
    "/{dataset_id}/quality/schedule",
    response_model=QualityScheduleResponse,
)
def get_quality_schedule(
    dataset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Read the automation config for a dataset. Returns a default disabled
    payload when no schedule has been configured yet."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_view_access(db, current_user, ds, "datasets")
    schedule = (
        db.query(DatasetQualitySchedule)
        .filter(DatasetQualitySchedule.dataset_id == dataset_id)
        .first()
    )
    return _schedule_to_response(dataset_id, schedule)


@router.put(
    "/{dataset_id}/quality/schedule",
    response_model=QualityScheduleResponse,
)
def upsert_quality_schedule(
    dataset_id: int,
    body: QualityScheduleUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create or update the automation config for a dataset."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    schedule = (
        db.query(DatasetQualitySchedule)
        .filter(DatasetQualitySchedule.dataset_id == dataset_id)
        .first()
    )
    is_new = schedule is None
    if is_new:
        schedule = DatasetQualitySchedule(
            dataset_id=dataset_id,
            created_by_id=str(current_user.id),
        )
        db.add(schedule)

    schedule.enabled = bool(body.enabled)
    schedule.type = body.type
    schedule.cron = (body.cron or "").strip() or None
    schedule.timezone = (body.timezone or "UTC").strip() or "UTC"
    schedule.recipient_email = body.recipient_email
    schedule.cc_emails = list(body.cc_emails or [])
    schedule.notify_on_success = bool(body.notify_on_success)
    schedule.notify_on_failure = bool(body.notify_on_failure)
    if is_new is False:
        schedule.created_by_id = schedule.created_by_id or str(current_user.id)

    db.commit()
    db.refresh(schedule)

    # Sync the live APScheduler registry to match the DB.
    try:
        from app.services.dataset_quality_scheduler import sync_dataset_schedule
        sync_dataset_schedule(dataset_id)
        db.refresh(schedule)
    except Exception as exc:  # noqa: BLE001
        # Do not fail the API call — scheduler will rebuild on next startup.
        import logging as _logging
        _logging.getLogger(__name__).error(
            "[quality/schedule] sync_dataset_schedule failed: %s", exc
        )

    return _schedule_to_response(dataset_id, schedule)


# ── AI Rule Suggestion ────────────────────────────────────────────────────

from app.schemas.dataset import (
    QualityAISuggestRequest,
    QualityAISuggestResponse,
)


@router.post(
    "/{dataset_id}/quality/ai-suggest",
    response_model=QualityAISuggestResponse,
)
async def ai_suggest_quality_rule(
    dataset_id: int,
    body: QualityAISuggestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Use AI to suggest a quality rule config from a natural-language description."""
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    from app.services.quality_ai_suggest import suggest_quality_rule
    result = await suggest_quality_rule(
        description=body.description,
        table_name=body.table_name,
        columns=[{"name": c.name, "type": c.type} for c in body.columns],
    )
    return result


@router.post("/{dataset_id}/tables/{table_id}/auto-detect-types")
def auto_detect_column_types(
    dataset_id: int,
    table_id: int,
    body: dict | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full-scan inference of best column types and apply non-conflicting suggestions.

    Body (all optional):
      - tolerance: float, max fraction of invalid casts allowed (default 0.001)
      - row_cap: int, override per-dialect default scan cap
      - apply: bool, write suggestions to type_overrides (default True)
      - overwrite_user_overrides: bool, replace existing overrides (default False)
      - columns: list[str], restrict to a subset
    """
    body = body or {}
    ds = _get_dataset_or_404(db, dataset_id)
    require_edit_access(db, current_user, ds, "datasets")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    datasource = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    from app.services.column_type_inference_service import (
        apply_suggestions_to_table,
        infer_full_column_types,
    )

    suggestions = infer_full_column_types(
        datasource,
        table,
        columns=body.get("columns"),
        tolerance=float(body.get("tolerance") or 0.001),
        row_cap=body.get("row_cap"),
    )
    applied: dict[str, str] = {}
    if body.get("apply", True):
        applied = apply_suggestions_to_table(
            db,
            table,
            suggestions,
            overwrite_user_overrides=bool(body.get("overwrite_user_overrides", False)),
        )

    return {
        "applied": applied,
        "suggestions": [s.to_dict() for s in suggestions],
    }


@router.get("/{dataset_id}/tables/{table_id}/columns/{column_name}/summary")
def get_column_summary_endpoint(
    dataset_id: int,
    table_id: int,
    column_name: str,
    top_limit: int = 10,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Kaggle-style summary for a single column: top values or histogram."""
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    table = db.query(DatasetTable).filter(
        DatasetTable.id == table_id,
        DatasetTable.dataset_id == dataset_id,
    ).first()
    if not table:
        raise HTTPException(status_code=404, detail="Table not found")
    datasource = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    from app.services.column_summary_service import get_column_summary

    summary = get_column_summary(datasource, table, column_name, top_limit=int(top_limit))
    return summary.to_dict()


@router.post("/{dataset_id}/tables/{table_id}/profile")
def get_table_profile(
    dataset_id: int,
    table_id: int,
    sample_limit: int = Query(20, ge=1, le=200),
    include_stats: bool = Query(True),
    stats_top_limit: int = Query(5, ge=1, le=20),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bundle schema + sample rows + per-column stats in one call.

    Designed for orchestrator agents (MCP) that need to reason about a table
    without making 1+N round-trips. The response is intentionally compact:

      {
        "table": {id, name, display_name, description, row_count_estimate},
        "columns": [{name, type, nullable, role, description}, ...],
        "sample_rows": [...],   # up to `sample_limit` rows
        "stats": {              # only when include_stats=True
            "<col>": {detected_kind, total_rows, null_count, distinct_count,
                       top_values, min_value, max_value, avg_value, histogram}
        }
      }

    Stats are computed per-column via the existing column_summary service so
    behavior matches the dataset table tooltip exactly.
    """
    dataset_obj = db.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not dataset_obj:
        raise HTTPException(status_code=404, detail="Dataset not found")
    perm = get_effective_permission(db, current_user, dataset_obj, "datasets")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail="Table not found in this dataset")

    datasource: Optional[DataSource] = None
    target_table = db_table

    if is_generated_calendar_table(db_table) or is_derived_table(db_table):
        try:
            datasource, target_table = build_live_proxy_table_for_dataset_table(
                db, dataset_obj, db_table,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(
                    status_code=422,
                    detail={"code": exc.code, "message": str(exc)},
                )
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        datasource = db.query(DataSource).filter(
            DataSource.id == db_table.datasource_id
        ).first()
        if not datasource:
            raise HTTPException(
                status_code=404,
                detail=_build_datasource_missing_detail(db_table),
            )

    try:
        result = LiveQueryService.execute_preview_query(
            datasource=datasource,
            db_table=target_table,
            limit=int(sample_limit),
            offset=0,
            filters=None,
        )
    except Exception as exc:
        logger.warning("Profile preview failed for table %d: %s", table_id, exc)
        raise HTTPException(status_code=400, detail=str(exc))

    rows = result.get("rows") or []
    columns = result.get("columns") or []
    column_metadata: List[DatasetColumnMetadata] = []
    for i, col in enumerate(columns):
        col_type = _infer_column_type(col, i, rows)
        column_metadata.append(
            DatasetColumnMetadata(name=col, type=col_type, nullable=True)
        )

    from app.services.type_override_service import _override_type as _ovr_type
    type_overrides = db_table.type_overrides or {}
    for col_meta in column_metadata:
        if col_meta.name in type_overrides:
            resolved = _ovr_type(type_overrides[col_meta.name])
            if resolved:
                col_meta.type = resolved

    def _serialize(val):
        if isinstance(val, (datetime, date)):
            return val.isoformat()
        if isinstance(val, Decimal):
            return float(val)
        return val

    serialized_rows = []
    for row in rows[: int(sample_limit)]:
        if isinstance(row, dict):
            serialized_rows.append({k: _serialize(v) for k, v in row.items()})
        else:
            serialized_rows.append([_serialize(v) for v in row])

    column_descriptions = db_table.column_descriptions or {}
    columns_payload = [
        {
            "name": col.name,
            "type": col.type,
            "nullable": col.nullable,
            "description": column_descriptions.get(col.name) or "",
        }
        for col in column_metadata
    ]

    payload: Dict[str, Any] = {
        "table": {
            "id": db_table.id,
            "name": db_table.name,
            "display_name": db_table.display_name,
            "description": db_table.auto_description,
            "description_source": db_table.description_source,
            "common_questions": db_table.common_questions or [],
            "estimated_row_count": db_table.estimated_row_count,
        },
        "columns": columns_payload,
        "sample_rows": serialized_rows,
        "sample_size": len(serialized_rows),
    }

    if include_stats:
        from app.services.column_summary_service import get_column_summary

        stats: Dict[str, Any] = {}
        for col in columns_payload:
            try:
                summary = get_column_summary(
                    datasource, target_table, col["name"], top_limit=int(stats_top_limit),
                )
                stats[col["name"]] = summary.to_dict()
            except Exception as exc:
                logger.warning(
                    "Column stats failed for %s.%s: %s",
                    db_table.name, col["name"], exc,
                )
                stats[col["name"]] = {"error": str(exc)}
        payload["stats"] = stats

    return payload
