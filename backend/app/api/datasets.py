"""API endpoints for Datasets (Table-based Datasets)"""
from typing import Any, Dict, List, Optional
from decimal import Decimal
import re
from types import SimpleNamespace
from datetime import datetime, date
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session

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
)
from app.services import query_cache
from app.services.chart_contracts import normalize_filter_conditions
from app.services.dataset_calendar_service import (
    build_calendar_columns_cache,
    build_calendar_duckdb_sql,
    get_calendar_settings,
    is_generated_calendar_table,
)
from app.services.dataset_table_sql_service import (
    build_live_proxy_table_for_dataset_table,
    DatasetTableSqlError,
    build_dataset_table_duckdb_query,
    build_dataset_table_sql_alias,
    collect_derived_dependency_table_ids,
    get_dataset_table_reference_options,
    is_derived_table,
    preview_dataset_table_duckdb_query,
    validate_and_clean_derived_query,
)
from app.services.dataset_model_service import generate_dataset_model
from app.services.description_pipeline_service import (
    DescriptionPipelineService,
    resolve_session_factory,
)
from app.core.logging import get_logger
from app.services.runtime_modes import datasource_sync_enabled, resolve_dataset_query_mode
from app.services.schema_inference import infer_schema_from_sql
from app.services.live_query_service import (
    build_dataset_table_cache_identifier,
    build_live_base_query_plan,
)
from app.services.type_override_service import (
    audit_type_overrides,
    normalize_type_overrides,
)

router = APIRouter()
logger = get_logger(__name__)


LOOKUP_TABLE_IDENTIFIER_PREFIX = "dataset-table://"



# ISO date/datetime patterns for string-based detection
_ISO_DATETIME_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?'
)
_ISO_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _build_lookup_table_identifier(table_id: int) -> str:
    return f"{LOOKUP_TABLE_IDENTIFIER_PREFIX}{table_id}"


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


def _sync_dataset_model_safely(db: Session, dataset_id: int) -> None:
    try:
        generate_dataset_model(db, dataset_id, force=False)
    except Exception as exc:
        logger.warning("Dataset model sync skipped for dataset %s: %s", dataset_id, exc)


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

    if is_derived_table(db_table):
        try:
            column_names, rows = preview_dataset_table_duckdb_query(
                db,
                dataset_obj,
                db_table,
                limit=200,
                offset=0,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") != "NOT_SYNCED":
                raise
            from app.services.live_query_service import LiveQueryService

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
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(db, current_user, item, "datasets")
    stamp_owner_emails(db, items)
    return items


@router.post("/", response_model=DatasetResponse, status_code=201)
def create_dataset(
    dataset_in: DatasetCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("datasets", "edit")),
):
    """Create a new dataset"""
    db_dataset = DatasetCRUDService.create_dataset(db, dataset_in, owner_id=current_user.id)
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
    db_dataset = DatasetCRUDService.update_dataset(
        db, dataset_id, dataset_in
    )
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
                preview_columns, preview_rows = preview_dataset_table_duckdb_query(
                    db,
                    ds,
                    derived_draft,
                    limit=200,
                    offset=0,
                )
                inferred_metadata = [
                    DatasetColumnMetadata(
                        name=column_name,
                        type=_infer_column_type(column_name, index, preview_rows),
                        nullable=True,
                    )
                    for index, column_name in enumerate(preview_columns)
                ]
                inferred_rows = preview_rows
            except DatasetTableSqlError as exc:
                if getattr(exc, "code", "") != "NOT_SYNCED":
                    status_code = 422 if getattr(exc, "code", "") == "NOT_SYNCED" else 400
                    detail: Any = str(exc)
                    if getattr(exc, "code", "") == "NOT_SYNCED":
                        detail = {"code": exc.code, "message": str(exc)}
                    raise HTTPException(status_code=status_code, detail=detail)

                try:
                    from app.services.live_query_service import LiveQueryService

                    datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                        db,
                        ds,
                        derived_draft,
                    )
                    result = LiveQueryService.execute_preview_query(
                        datasource=datasource,
                        db_table=live_proxy_table,
                        limit=200,
                        offset=0,
                    )
                    preview_columns = list(result.get("columns") or [])
                    preview_rows = list(result.get("rows") or [])
                    inferred_metadata = [
                        DatasetColumnMetadata(
                            name=column_name,
                            type=_infer_column_type(column_name, index, preview_rows),
                            nullable=True,
                        )
                        for index, column_name in enumerate(preview_columns)
                    ]
                    inferred_rows = preview_rows
                except DatasetTableSqlError as live_exc:
                    status_code = 422 if getattr(live_exc, "code", "") == "NOT_SYNCED" else 400
                    detail: Any = str(live_exc)
                    if getattr(live_exc, "code", "") == "NOT_SYNCED":
                        detail = {"code": live_exc.code, "message": str(live_exc)}
                    raise HTTPException(status_code=status_code, detail=detail)
                except ValueError as live_exc:
                    raise HTTPException(status_code=400, detail=str(live_exc))
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
            except QueryValidationError as e:
                raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")
        
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
                from app.services.live_query_service import LiveQueryService
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
                from app.services.live_query_service import LiveQueryService
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
                db_table = DatasetCRUDService.update_table_cache(
                    db,
                    db_table.id,
                    columns_cache=_build_columns_cache_payload(
                        db_table,
                        inferred_metadata,
                        source_columns=[column.name for column in inferred_metadata],
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
    preview_metadata: List[DatasetColumnMetadata] = []
    preview_rows: List[Dict[str, Any]] = []

    # Validate SQL query if source_query is being updated
    if table_update.source_query is not None:
        if db_table.source_kind == "derived_table":
            try:
                table_update.source_query = validate_and_clean_derived_query(table_update.source_query)
                table_draft = _build_table_draft(db_table, table_update)
                preview_columns, preview_rows = preview_dataset_table_duckdb_query(
                    db,
                    ds,
                    table_draft,
                    limit=200,
                    offset=0,
                )
                preview_metadata = [
                    DatasetColumnMetadata(
                        name=column_name,
                        type=_infer_column_type(column_name, index, preview_rows),
                        nullable=True,
                    )
                    for index, column_name in enumerate(preview_columns)
                ]
            except DatasetTableSqlError as exc:
                if getattr(exc, "code", "") != "NOT_SYNCED":
                    status_code = 422 if getattr(exc, "code", "") == "NOT_SYNCED" else 400
                    detail: Any = str(exc)
                    if getattr(exc, "code", "") == "NOT_SYNCED":
                        detail = {"code": exc.code, "message": str(exc)}
                    raise HTTPException(status_code=status_code, detail=detail)

                try:
                    from app.services.live_query_service import LiveQueryService

                    datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                        db,
                        ds,
                        table_draft,
                    )
                    result = LiveQueryService.execute_preview_query(
                        datasource=datasource,
                        db_table=live_proxy_table,
                        limit=200,
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
                except DatasetTableSqlError as live_exc:
                    status_code = 422 if getattr(live_exc, "code", "") == "NOT_SYNCED" else 400
                    detail: Any = str(live_exc)
                    if getattr(live_exc, "code", "") == "NOT_SYNCED":
                        detail = {"code": live_exc.code, "message": str(live_exc)}
                    raise HTTPException(status_code=status_code, detail=detail)
                except ValueError as live_exc:
                    raise HTTPException(status_code=400, detail=str(live_exc))
        else:
            from app.services.query_validator import QueryValidator, QueryValidationError
            try:
                table_update.source_query = QueryValidator.validate_and_clean(table_update.source_query)
            except QueryValidationError as e:
                raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")

    if table_update.type_overrides is not None:
        normalized_overrides = normalize_type_overrides(table_update.type_overrides)
        current_overrides = normalize_type_overrides(getattr(db_table, "type_overrides", None))
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

    try:
        updated_table = DatasetCRUDService.update_table(
            db, table_id, table_update
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated_table and db_table.datasource_id is not None:
        query_cache.invalidate_datasource(db_table.datasource_id)

    if updated_table and table_update.source_query is not None:
        datasource = db.query(DataSource).filter(DataSource.id == updated_table.datasource_id).first() if updated_table.datasource_id is not None else None
        try:
            inferred_metadata = preview_metadata or _infer_dataset_table_columns(db, ds, datasource, updated_table)
            if inferred_metadata:
                updated_table = DatasetCRUDService.update_table_cache(
                    db,
                    updated_table.id,
                    columns_cache=_build_columns_cache_payload(
                        updated_table,
                        inferred_metadata,
                        source_columns=[column.name for column in inferred_metadata],
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
        success = DatasetCRUDService.delete_table(db, table_id)
        if datasource_id is not None:
            query_cache.invalidate_datasource(datasource_id)
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

    if is_generated_calendar_table(db_table):
        from app.services.duckdb_engine import DuckDBEngine

        settings = get_calendar_settings(dataset_obj, enabled_default=False)
        base_query = build_calendar_duckdb_sql(settings)
        limit = min(preview_request.limit or 100, 1000)
        offset = max(preview_request.offset or 0, 0)
        query = f"SELECT * FROM ({base_query}) AS generated_calendar LIMIT {limit}"
        if offset:
            query += f" OFFSET {offset}"

        rows = DuckDBEngine.query(query)
        cached_columns = build_calendar_columns_cache()["columns"]
        column_metadata = [
            DatasetColumnMetadata(
                name=str(column.get("name")),
                type=str(column.get("type")),
                nullable=bool(column.get("nullable", False)),
            )
            for column in cached_columns
        ]

        def serialize_value(val):
            if isinstance(val, (datetime, date)):
                return val.isoformat()
            if isinstance(val, Decimal):
                return float(val)
            return val

        serializable_rows = [{k: serialize_value(v) for k, v in row.items()} for row in rows[:500]]
        DatasetCRUDService.update_table_cache(
            db,
            table_id,
            columns_cache=build_calendar_columns_cache(),
            sample_cache=serializable_rows,
        )
        _sync_dataset_model_safely(db, dataset_id)

        total = (
            date.fromisoformat(settings["end_date"]) - date.fromisoformat(settings["start_date"])
        ).days + 1
        return TablePreviewResponse(
            columns=column_metadata,
            rows=rows,
            total=total,
            has_more=(offset + len(rows)) < total,
        )

    if is_derived_table(db_table):
        try:
            limit = min(preview_request.limit or 100, 1000)
            offset = max(preview_request.offset or 0, 0)
            try:
                columns, rows = preview_dataset_table_duckdb_query(
                    db,
                    dataset_obj,
                    db_table,
                    limit=limit,
                    offset=offset,
                )
            except DatasetTableSqlError as exc:
                if getattr(exc, "code", "") != "NOT_SYNCED":
                    raise
                from app.services.live_query_service import LiveQueryService

                datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                    db,
                    dataset_obj,
                    db_table,
                )
                result = LiveQueryService.execute_preview_query(
                    datasource=datasource,
                    db_table=live_proxy_table,
                    limit=limit,
                    offset=offset,
                )
                columns = list(result.get("columns") or [])
                rows = list(result.get("rows") or [])
            column_metadata = [
                DatasetColumnMetadata(
                    name=column_name,
                    type=_infer_column_type(column_name, index, rows),
                    nullable=True,
                )
                for index, column_name in enumerate(columns)
            ]
            DatasetCRUDService.update_table_cache(
                db,
                table_id,
                columns_cache=_build_columns_cache_payload(
                    db_table,
                    column_metadata,
                    source_columns=columns,
                ),
                sample_cache=_serialize_cached_rows(rows),
            )
            _sync_dataset_model_safely(db, dataset_id)

            return TablePreviewResponse(
                columns=column_metadata,
                rows=rows,
                total=len(rows),
                has_more=len(rows) >= limit,
            )
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)})
            raise HTTPException(status_code=400, detail=str(exc))
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("Failed to preview calculated table %s: %s", table_id, exc)
            raise HTTPException(status_code=500, detail="Failed to preview calculated table.")
    
    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    # ── LIVE mode: preview directly from source ──
    query_mode = resolve_dataset_query_mode(db_table)
    if query_mode == 'live':
        try:
            from app.services.live_query_service import LiveQueryService
            limit = preview_request.limit or 1000
            limit = min(limit, 1000)
            result = LiveQueryService.execute_preview_query(
                datasource=datasource,
                db_table=db_table,
                limit=limit,
                offset=preview_request.offset or 0,
            )
            rows = result["rows"]
            columns = result["columns"]
            column_metadata = []
            for i, col in enumerate(columns):
                col_type = _infer_column_type(col, i, rows)
                column_metadata.append(DatasetColumnMetadata(name=col, type=col_type, nullable=True))

            type_overrides = db_table.type_overrides or {}
            for col_meta in column_metadata:
                if col_meta.name in type_overrides:
                    col_meta.type = type_overrides[col_meta.name]

            def serialize_value(val):
                from datetime import datetime, date
                from decimal import Decimal
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

            DatasetCRUDService.update_table_cache(
                db, table_id,
                columns_cache=_build_columns_cache_payload(
                    db_table,
                    column_metadata,
                    source_columns=result.get("source_columns") or [],
                ),
                sample_cache=serializable_rows,
            )
            _sync_dataset_model_safely(db, dataset_id)

            return TablePreviewResponse(
                columns=column_metadata,
                rows=rows,
                total=len(rows),
                has_more=len(rows) >= limit,
            )
        except HTTPException:
            raise
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.error("Failed to live-preview table: %s", e)
            raise HTTPException(status_code=500, detail="Failed to preview table from live source.")
    
    # ── SYNCED mode: use DuckDB ──
    # Build base query — requires DuckDB synced view (raises 422 NOT_SYNCED if not synced)
    from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
    from app.services.duckdb_engine import DuckDBEngine
    from app.services.transformation_compiler import TransformationCompiler

    try:
        if db_table.source_kind == "sql_query":
            if not db_table.source_query:
                raise HTTPException(status_code=400, detail="Table has source_kind='sql_query' but source_query is NULL")
            rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query)
            if rewritten is None:
                raise HTTPException(status_code=422, detail={"code": "NOT_SYNCED", "message": "Table not synced to DuckDB"})
            base_query = f"SELECT * FROM ({rewritten}) AS _base"
        else:
            if not db_table.source_table_name:
                raise HTTPException(status_code=400, detail="Table has source_kind='physical_table' but source_table_name is NULL")
            view_name = get_synced_view(datasource.id, db_table.source_table_name)
            if view_name is None:
                raise HTTPException(status_code=422, detail={"code": "NOT_SYNCED", "message": "Table not synced to DuckDB"})
            base_query = f"SELECT * FROM {view_name}"

        # Apply transformations (TransformationCompiler generates DuckDB-compatible SQL)
        if db_table.transformations:
            transformations = db_table.transformations if isinstance(db_table.transformations, list) else []
            query, _ = TransformationCompiler.compile_transformations(
                base_query, transformations, dialect="duckdb"
            )
        else:
            query = base_query

        if preview_request.limit:
            query += f" LIMIT {preview_request.limit}"
        else:
            query += " LIMIT 1000"
        if preview_request.offset:
            query += f" OFFSET {preview_request.offset}"

        with DuckDBEngine.read_conn() as _conn:
            _result = _conn.execute(query)
        col_names = [d[0] for d in _result.description] if _result.description else []
        raw_rows = _result.fetchall()
        rows = [dict(zip(col_names, r)) for r in raw_rows]
        columns = col_names
        
        # Infer column types
        column_metadata = []
        for i, col in enumerate(columns):
            col_type = _infer_column_type(col, i, rows)
            column_metadata.append(
                DatasetColumnMetadata(
                    name=col,
                    type=col_type,
                    nullable=True
                )
            )
        
        # Apply user-defined type overrides
        type_overrides = db_table.type_overrides or {}
        for col_meta in column_metadata:
            if col_meta.name in type_overrides:
                col_meta.type = type_overrides[col_meta.name]
        
        # Get total count (approximate for now)
        # In production, run a COUNT query
        total = len(rows)
        has_more = len(rows) >= preview_request.limit
        
        # Serialize rows for JSON storage (convert datetime, date, etc.)
        def serialize_value(val):
            """Convert non-JSON-serializable values to strings"""
            from datetime import datetime, date
            from decimal import Decimal
            if isinstance(val, (datetime, date)):
                return val.isoformat()
            if isinstance(val, Decimal):
                return float(val)
            return val
        
        # Convert rows to serializable format
        serializable_rows = []
        for row in rows[:500]:  # Keep up to 500 rows for LOOKUP support
            if isinstance(row, dict):
                serializable_rows.append({k: serialize_value(v) for k, v in row.items()})
            else:
                serializable_rows.append([serialize_value(v) for v in row])
        
        # Cache results
        DatasetCRUDService.update_table_cache(
            db,
            table_id,
            columns_cache={"columns": [col.model_dump() for col in column_metadata]},
            sample_cache=serializable_rows
        )
        _sync_dataset_model_safely(db, dataset_id)
        
        return TablePreviewResponse(
            columns=column_metadata,
            rows=rows,
            total=total,
            has_more=has_more
        )

    except HTTPException:
        raise
    except Exception as e:
        import re as _re
        err = str(e)
        _binder = _re.search(r'Referenced table "([^"]+)" not found', err)
        if _binder:
            tname = _binder.group(1)
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "NOT_SYNCED",
                    "message": f"Table '{tname}' has not been synced from the datasource yet. Please sync the datasource first.",
                }
            )
        logger.error(f"Failed to preview table: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to preview table."
        )


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

    if is_generated_calendar_table(db_table):
        from app.services.duckdb_engine import DuckDBEngine

        settings = get_calendar_settings(dataset_obj, enabled_default=False)
        base_table = f"({build_calendar_duckdb_sql(settings)}) AS base_table"
        allowed_columns = {column["name"] for column in build_calendar_columns_cache()["columns"]}

        def _validate_calendar_column(col_name: str, context: str) -> str:
            if col_name not in allowed_columns:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid {context}: '{col_name}' is not a column of this table",
                )
            return '"' + col_name.replace('"', '""') + '"'

        def _sql_literal(v: Any) -> str:
            if v is None:
                return "NULL"
            if isinstance(v, bool):
                return "TRUE" if v else "FALSE"
            if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
                return str(v)
            return "'" + str(v).replace("'", "''") + "'"

        select_parts = []
        output_columns = []
        if execute_request.dimensions:
            for dim in execute_request.dimensions:
                quoted_dim = _validate_calendar_column(dim, "dimension")
                select_parts.append(quoted_dim)
                output_columns.append(quoted_dim)

        if execute_request.measures:
            for measure in execute_request.measures:
                quoted_col = _validate_calendar_column(measure.field, "measure field")
                agg_func = measure.function.upper()
                alias = '"' + f"{measure.field}_{measure.function}".replace('"', '""') + '"'
                output_columns.append(alias)
                if agg_func == "COUNT_DISTINCT":
                    select_parts.append(f"COUNT(DISTINCT {quoted_col}) AS {alias}")
                else:
                    select_parts.append(f"{agg_func}({quoted_col}) AS {alias}")

        if not select_parts:
            select_parts.append("*")

        query = f"SELECT {', '.join(select_parts)} FROM {base_table}"

        if execute_request.filters:
            normalized_filters = normalize_filter_conditions(
                [
                    {
                        "field": item.field,
                        "operator": item.operator,
                        "value": item.value,
                    }
                    for item in execute_request.filters
                ]
            )
            where_conditions = []
            for filter_cond in normalized_filters:
                quoted_field = _validate_calendar_column(filter_cond["field"], "filter field")
                op = str(filter_cond.get("operator") or "").lower()
                value = filter_cond.get("value")
                if op == "eq":
                    where_conditions.append(f"{quoted_field} = {_sql_literal(value)}")
                elif op == "neq":
                    where_conditions.append(f"{quoted_field} != {_sql_literal(value)}")
                elif op == "gt":
                    where_conditions.append(f"{quoted_field} > {_sql_literal(value)}")
                elif op == "gte":
                    where_conditions.append(f"{quoted_field} >= {_sql_literal(value)}")
                elif op == "lt":
                    where_conditions.append(f"{quoted_field} < {_sql_literal(value)}")
                elif op == "lte":
                    where_conditions.append(f"{quoted_field} <= {_sql_literal(value)}")
                elif op == "between" and isinstance(value, list) and len(value) >= 2:
                    lo, hi = value[0], value[1]
                    if lo not in ("", None) and hi not in ("", None):
                        where_conditions.append(f"{quoted_field} BETWEEN {_sql_literal(lo)} AND {_sql_literal(hi)}")
                    elif lo not in ("", None):
                        where_conditions.append(f"{quoted_field} >= {_sql_literal(lo)}")
                    elif hi not in ("", None):
                        where_conditions.append(f"{quoted_field} <= {_sql_literal(hi)}")
                elif op in {"in", "not_in"}:
                    values = value if isinstance(value, list) else []
                    if isinstance(value, str):
                        values = [v.strip() for v in value.split(",") if v.strip()]
                    if not values:
                        continue
                    quoted_values = ", ".join(_sql_literal(v) for v in values)
                    comparator = "NOT IN" if op == "not_in" else "IN"
                    where_conditions.append(f"{quoted_field} {comparator} ({quoted_values})")
                elif op in {"like", "contains", "not_contains", "starts_with"} and value is not None:
                    escaped = str(value).replace("'", "''")
                    if op == "starts_with":
                        where_conditions.append(f"{quoted_field} LIKE '{escaped}%'")
                    elif op == "not_contains":
                        where_conditions.append(f"{quoted_field} NOT LIKE '%{escaped}%'")
                    else:
                        where_conditions.append(f"{quoted_field} LIKE '%{escaped}%'")
                elif op == "is_null":
                    where_conditions.append(f"{quoted_field} IS NULL")
                elif op == "is_not_null":
                    where_conditions.append(f"{quoted_field} IS NOT NULL")

            if where_conditions:
                query += " WHERE " + " AND ".join(where_conditions)

        preserve_group_order = bool(
            execute_request.dimensions and execute_request.measures and not execute_request.order_by
        )
        if execute_request.dimensions and execute_request.measures:
            quoted_dims = [_validate_calendar_column(d, "dimension") for d in execute_request.dimensions]
            if preserve_group_order:
                ordered_base_table = (
                    '(SELECT *, ROW_NUMBER() OVER () AS "__appbi_row_order" '
                    f'FROM {base_table}) AS _appbi_ordered'
                )
                query = (
                    f"SELECT {', '.join(select_parts)}, MIN(\"__appbi_row_order\") AS \"__appbi_group_order\" "
                    f"FROM {ordered_base_table}"
                )
                if execute_request.filters and where_conditions:
                    query += " WHERE " + " AND ".join(where_conditions)
            query += f" GROUP BY {', '.join(quoted_dims)}"

        measure_aliases = {
            f"{metric.field}_{metric.function}"
            for metric in (execute_request.measures or [])
        }
        if execute_request.order_by:
            order_parts = []
            for order_item in execute_request.order_by:
                if order_item.field in measure_aliases:
                    quoted_col = '"' + order_item.field.replace('"', '""') + '"'
                else:
                    quoted_col = _validate_calendar_column(order_item.field, "order_by field")
                direction = order_item.direction.upper() if order_item.direction.upper() in ("ASC", "DESC") else "DESC"
                order_parts.append(f"{quoted_col} {direction}")
            query += " ORDER BY " + ", ".join(order_parts)
        elif preserve_group_order:
            query = (
                f"SELECT {', '.join(output_columns)} "
                f"FROM ({query}) AS _appbi_grouped "
                'ORDER BY "__appbi_group_order" ASC'
            )

        query += f" LIMIT {execute_request.limit}"

        try:
            rows = DuckDBEngine.query(query)
            columns = list(rows[0].keys()) if rows else []
            column_metadata = [
                DatasetColumnMetadata(
                    name=column,
                    type=_infer_column_type(column, idx, rows),
                    nullable=True,
                )
                for idx, column in enumerate(columns)
            ]
            return ExecuteQueryResponse(columns=column_metadata, rows=rows)
        except HTTPException:
            raise
        except Exception as exc:
            logger.error("Failed to execute generated calendar query: %s", exc)
            raise HTTPException(status_code=500, detail="Failed to execute query.")

    datasource: Optional[DataSource] = None
    query_mode = "synced"
    if not is_derived_table(db_table):
        datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail="Datasource not found")
        query_mode = resolve_dataset_query_mode(db_table)

    # ── LIVE mode: execute aggregation directly against source ──
    if query_mode == 'live':
        try:
            from app.services.live_query_service import LiveQueryService

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
                db_table=db_table,
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
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Failed to execute live query: %s", e)
            raise HTTPException(status_code=500, detail="Failed to execute query on live source.")
    
    # ── SYNCED mode: use DuckDB ──
    # Build base_table — requires synced DuckDB view
    from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
    from app.services.duckdb_engine import DuckDBEngine

    if is_derived_table(db_table):
        try:
            base_table = f"({build_dataset_table_duckdb_query(db, dataset_obj, db_table)}) AS base_table"
        except DatasetTableSqlError as exc:
            if getattr(exc, "code", "") == "NOT_SYNCED":
                try:
                    from app.services.live_query_service import LiveQueryService

                    datasource, live_proxy_table = build_live_proxy_table_for_dataset_table(
                        db,
                        dataset_obj,
                        db_table,
                    )
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
                        db_table=live_proxy_table,
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
                except DatasetTableSqlError as live_exc:
                    raise HTTPException(
                        status_code=422 if getattr(live_exc, "code", "") == "NOT_SYNCED" else 400,
                        detail={"code": live_exc.code, "message": str(live_exc)}
                        if getattr(live_exc, "code", "") == "NOT_SYNCED"
                        else str(live_exc),
                    )
                except ValueError as live_exc:
                    raise HTTPException(status_code=400, detail=str(live_exc))
            raise HTTPException(status_code=400, detail=str(exc))
    elif db_table.source_kind == "sql_query":
        if not db_table.source_query:
            raise HTTPException(status_code=400, detail="Table has source_kind='sql_query' but source_query is NULL")
        rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query)
        if rewritten is None:
            raise HTTPException(status_code=422, detail={"code": "NOT_SYNCED", "message": "Table not synced to DuckDB"})
        base_table = f"({rewritten}) AS base_table"
    else:
        if not db_table.source_table_name:
            raise HTTPException(status_code=400, detail="Table has source_kind='physical_table' but source_table_name is NULL")
        view_name = get_synced_view(datasource.id, db_table.source_table_name)
        if view_name is None:
            raise HTTPException(status_code=422, detail={"code": "NOT_SYNCED", "message": "Table not synced to DuckDB"})
        base_table = view_name

    # --- Security: build column whitelist from columns_cache ---
    # columns_cache is populated by the preview endpoint; if missing we skip whitelist validation
    # (SELECT * path below still avoids injection since we only quote identifiers).
    allowed_columns: set | None = None
    if db_table.columns_cache:
        raw_cols = db_table.columns_cache
        if isinstance(raw_cols, dict) and "columns" in raw_cols:
            raw_cols = raw_cols["columns"]
        allowed_columns = {
            c["name"] if isinstance(c, dict) else str(c)
            for c in raw_cols
        }

    def _validate_column(col_name: str, context: str) -> str:
        """Raise 400 if col_name is not in whitelist, return double-quoted identifier."""
        if allowed_columns is not None and col_name not in allowed_columns:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid {context}: '{col_name}' is not a column of this table"
            )
        # Quote identifier to prevent injection even when whitelist is unavailable
        return '"' + col_name.replace('"', '""') + '"'

    # Build SELECT clause with dimensions and measures
    select_parts = []

    # Add dimensions
    if execute_request.dimensions:
        for dim in execute_request.dimensions:
            select_parts.append(_validate_column(dim, "dimension"))

    # Add measures (aggregations)
    if execute_request.measures:
        for measure in execute_request.measures:
            quoted_col = _validate_column(measure.field, "measure field")
            # measure.function is already validated by Pydantic pattern constraint
            agg_func = measure.function.upper()
            alias = '"' + f"{measure.field}_{measure.function}".replace('"', '""') + '"'
            if agg_func == 'COUNT_DISTINCT':
                select_parts.append(f"COUNT(DISTINCT {quoted_col}) AS {alias}")
            else:
                select_parts.append(f"{agg_func}({quoted_col}) AS {alias}")

    output_columns: list[str] = []
    if execute_request.dimensions:
        for dim in execute_request.dimensions:
            output_columns.append(_validate_column(dim, "dimension"))

    if execute_request.measures:
        for m in execute_request.measures:
            output_columns.append('"' + f"{m.field}_{m.function}".replace('"', '""') + '"')

    if not select_parts:
        select_parts.append("*")

    select_clause = ", ".join(select_parts)

    # Build query — inline values with SQL-safe escaping (single-quote doubling).
    # DuckDB does not support psycopg2-style %s placeholders; column names are
    # already injection-safe (validated whitelist + double-quoted identifiers).
    def _sql_literal(v: Any) -> str:
        """Render a SQL literal for the synced DuckDB path."""
        if v is None:
            return "NULL"
        if isinstance(v, bool):
            return "TRUE" if v else "FALSE"
        if isinstance(v, (int, float, Decimal)) and not isinstance(v, bool):
            return str(v)
        return "'" + str(v).replace("'", "''") + "'"

    query = f"SELECT {select_clause} FROM {base_table}"

    # Add WHERE clause
    if execute_request.filters:
        normalized_filters = normalize_filter_conditions(
            [
                {
                    "field": item.field,
                    "operator": item.operator,
                    "value": item.value,
                }
                for item in execute_request.filters
            ]
        )
        where_conditions = []
        for filter_cond in normalized_filters:
            quoted_field = _validate_column(filter_cond["field"], "filter field")
            op = str(filter_cond.get("operator") or "").lower()
            value = filter_cond.get("value")
            if op == "eq":
                where_conditions.append(f"{quoted_field} = {_sql_literal(value)}")
            elif op == "neq":
                where_conditions.append(f"{quoted_field} != {_sql_literal(value)}")
            elif op == "gt":
                where_conditions.append(f"{quoted_field} > {_sql_literal(value)}")
            elif op == "gte":
                where_conditions.append(f"{quoted_field} >= {_sql_literal(value)}")
            elif op == "lt":
                where_conditions.append(f"{quoted_field} < {_sql_literal(value)}")
            elif op == "lte":
                where_conditions.append(f"{quoted_field} <= {_sql_literal(value)}")
            elif op == "between" and isinstance(value, list) and len(value) >= 2:
                lo, hi = value[0], value[1]
                if lo not in ("", None) and hi not in ("", None):
                    where_conditions.append(f"{quoted_field} BETWEEN {_sql_literal(lo)} AND {_sql_literal(hi)}")
                elif lo not in ("", None):
                    where_conditions.append(f"{quoted_field} >= {_sql_literal(lo)}")
                elif hi not in ("", None):
                    where_conditions.append(f"{quoted_field} <= {_sql_literal(hi)}")
            elif op in {"in", "not_in"}:
                values = value if isinstance(value, list) else []
                if isinstance(value, str):
                    values = [v.strip() for v in value.split(",") if v.strip()]
                if not values:
                    continue
                quoted_values = ", ".join(_sql_literal(v) for v in values)
                comparator = "NOT IN" if op == "not_in" else "IN"
                where_conditions.append(f"{quoted_field} {comparator} ({quoted_values})")
            elif op in {"like", "contains", "not_contains", "starts_with"} and value is not None:
                escaped = str(value).replace("'", "''")
                if op == "starts_with":
                    where_conditions.append(f"{quoted_field} LIKE '{escaped}%'")
                elif op == "not_contains":
                    where_conditions.append(f"{quoted_field} NOT LIKE '%{escaped}%'")
                else:
                    where_conditions.append(f"{quoted_field} LIKE '%{escaped}%'")
            elif op == "is_null":
                where_conditions.append(f"{quoted_field} IS NULL")
            elif op == "is_not_null":
                where_conditions.append(f"{quoted_field} IS NOT NULL")

        if where_conditions:
            query += " WHERE " + " AND ".join(where_conditions)

    # Add GROUP BY for dimensions
    preserve_group_order = bool(
        execute_request.dimensions and execute_request.measures and not execute_request.order_by
    )
    if execute_request.dimensions and execute_request.measures:
        # dimensions are already validated + quoted above; rebuild the list
        quoted_dims = [_validate_column(d, "dimension") for d in execute_request.dimensions]
        if preserve_group_order:
            ordered_base_table = (
                '(SELECT *, ROW_NUMBER() OVER () AS "__appbi_row_order" '
                f'FROM {base_table}) AS _appbi_ordered'
            )
            query = (
                f'SELECT {select_clause}, MIN("__appbi_row_order") AS "__appbi_group_order" '
                f'FROM {ordered_base_table}'
            )
            if execute_request.filters and where_conditions:
                query += " WHERE " + " AND ".join(where_conditions)
        query += f" GROUP BY {', '.join(quoted_dims)}"

    # Build set of valid measure aliases so ORDER BY can reference them
    measure_aliases: set = set()
    if execute_request.measures:
        for m in execute_request.measures:
            measure_aliases.add(f"{m.field}_{m.function}")

    # Add ORDER BY — field validated + quoted, direction constrained by Pydantic
    if execute_request.order_by:
        order_parts = []
        for ob in execute_request.order_by:
            if ob.field in measure_aliases:
                # Measure alias — already safe (constructed from validated field + function)
                quoted_col = '"' + ob.field.replace('"', '""') + '"'
            else:
                quoted_col = _validate_column(ob.field, "order_by field")
            direction = ob.direction.upper() if ob.direction.upper() in ("ASC", "DESC") else "DESC"
            order_parts.append(f"{quoted_col} {direction}")
        query += " ORDER BY " + ", ".join(order_parts)
    elif preserve_group_order:
        query = (
            f"SELECT {', '.join(output_columns)} "
            f'FROM ({query}) AS _appbi_grouped '
            'ORDER BY "__appbi_group_order" ASC'
        )

    # Add LIMIT — integer, already constrained by Pydantic (ge=1, le=10000)
    query += f" LIMIT {execute_request.limit}"

    try:
        with DuckDBEngine.read_conn() as _conn:
            _result = _conn.execute(query)
        col_names = [d[0] for d in _result.description] if _result.description else []
        raw_rows = _result.fetchall()
        rows = [dict(zip(col_names, r)) for r in raw_rows]
        columns = col_names

        # Infer column types
        column_metadata = []
        for i, col in enumerate(columns):
            col_type = "string"
            if rows and len(rows) > 0:
                if isinstance(rows[0], dict):
                    val = rows[0].get(col)
                else:
                    val = rows[0][i] if i < len(rows[0]) else None

                if isinstance(val, bool):
                    col_type = "boolean"
                elif isinstance(val, (int, float, Decimal)):
                    col_type = "number"

            column_metadata.append(
                DatasetColumnMetadata(
                    name=col,
                    type=col_type,
                    nullable=True
                )
            )

        return ExecuteQueryResponse(
            columns=column_metadata,
            rows=rows
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to execute query: {e}")
        raise HTTPException(
            status_code=500,
            detail="Failed to execute query."
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
    Tries DuckDB synced view first; falls back to live source schema query.
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

    try:
        return {
            "field": field,
            "values": get_distinct_field_values(db, dataset_id, field, limit=limit),
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
                if join.get("managed") or join.get("origin") in {"auto_fk", "auto_calendar"}
            ]
            manual_joins = [
                join for join in value
                if not join.get("managed") and join.get("origin") not in {"auto_fk", "auto_calendar"}
            ]
            setattr(explore, key, [*managed_joins, *manual_joins])
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
        result = add_join(
            db,
            dataset_id=dataset_id,
            from_view_id=int(payload["from_view_id"]),
            to_view_id=int(payload["to_view_id"]),
            from_column=payload["from_column"],
            to_column=payload["to_column"],
            join_type=payload.get("join_type", "left"),
            relationship=payload.get("relationship", "many_to_one"),
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
