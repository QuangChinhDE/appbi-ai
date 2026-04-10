"""
API router for data source endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status, UploadFile, File
from sqlalchemy.orm import Session
from typing import List, Dict, Any
import io
import csv as csv_module

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core import get_db
from app.core.dependencies import (
    get_current_user,
    require_permission,
    require_view_access,
    require_edit_access,
    require_full_access,
    get_effective_permission,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models import DataSource, Dataset
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    DataSourceCreate,
    DataSourceUpdate,
    DataSourceResponse,
    DataSourceTestRequest,
    DataSourceTestResponse,
    QueryExecuteRequest,
    QueryExecuteResponse,
)
from app.services import DataSourceCRUDService, DataSourceConnectionService
from app.core.logging import get_logger
from app.core.config import settings
from app.services.google_data_access_service import get_google_data_access_status

logger = get_logger(__name__)
router = APIRouter(prefix="/datasources", tags=["datasources"])
_limiter = Limiter(key_func=get_remote_address)


def _build_query_error_detail(exc: Exception) -> dict:
    """Return a user-facing query error payload without hiding the root cause."""
    message = " ".join(str(exc).split()).strip()
    return {
        "message": message or "Query execution failed. Please check your SQL and try again.",
    }


def _normalize_google_oauth_config(
    config: dict[str, Any],
    *,
    current_user: User,
    existing_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized = dict(config or {})
    if normalized.get("auth_mode") != "google_oauth":
        normalized.pop("google_oauth_user_id", None)
        normalized.pop("google_oauth_email", None)
        return normalized

    from app.core.crypto import decrypt_config

    existing = decrypt_config(existing_config or {})
    existing_user_id = str(existing.get("google_oauth_user_id") or "").strip()
    existing_email = str(existing.get("google_oauth_email") or "").strip().lower()
    desired_email = str(normalized.get("google_oauth_email") or "").strip().lower()

    if existing_user_id and existing_email and (not desired_email or desired_email == existing_email):
        normalized["google_oauth_user_id"] = existing_user_id
        normalized["google_oauth_email"] = existing_email
        return normalized

    status_payload = get_google_data_access_status(current_user)
    if not status_payload["configured"]:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Google data access is not configured yet. Ask an admin to set "
                "AUTH_GOOGLE_CLIENT_SECRET and AUTH_GOOGLE_DATA_REDIRECT_URI."
            ),
        )
    if not status_payload["connected"] or not status_payload["email"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Connect your Google account inside AppBI before using Google OAuth "
                "for BigQuery or Google Sheets."
            ),
        )

    normalized["google_oauth_user_id"] = str(current_user.id)
    normalized["google_oauth_email"] = str(status_payload["email"]).strip().lower()
    return normalized


# ── Platform GCP credential info ──────────────────────────────────────────────

@router.get("/platform-gcp-info")
def get_platform_gcp_info(_: User = Depends(get_current_user)):
    """
    Returns whether a platform-level GCP service account is configured.
    If configured, also returns the email so users know which account to share with.
    """
    has_credential = bool((settings.GCP_SERVICE_ACCOUNT_JSON or "").strip())
    email = (settings.GCP_SERVICE_ACCOUNT_EMAIL or "").strip() or None
    return {
        "platform_credential_available": has_credential,
        "service_account_email": email,
    }


# ── Manual datasource: server-side file parsing ───────────────────────────────

def _infer_type(values: list) -> str:
    """Infer column type from a sample of values."""
    samples = [v for v in values if v is not None and str(v).strip() != ''][:20]
    if not samples:
        return 'string'
    num_count = sum(1 for v in samples if _is_number(v))
    if num_count == len(samples):
        return 'number'
    date_count = sum(1 for v in samples if _is_date_like(str(v)))
    if date_count >= len(samples) * 0.8:
        return 'date'
    return 'string'

def _is_number(v) -> bool:
    try:
        float(str(v).replace(',', ''))
        return True
    except (ValueError, TypeError):
        return False

def _is_date_like(s: str) -> bool:
    import re
    return bool(re.match(r'^\d{2,4}[-/]\d{1,2}[-/]\d{1,4}', s.strip()))

def _parse_excel_bytes(content: bytes) -> Dict[str, Any]:
    """Parse all sheets from an Excel file (.xlsx/.xls) using openpyxl."""
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    sheets: Dict[str, Any] = {}
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        all_rows = list(ws.iter_rows(values_only=True))
        if not all_rows:
            sheets[sheet_name] = {'columns': [], 'rows': []}
            continue
        # First non-empty row is the header
        header_row = [str(c).strip() if c is not None else '' for c in all_rows[0]]
        headers = [h if h else f'col{i+1}' for i, h in enumerate(header_row)]
        data_rows = all_rows[1:]
        rows = []
        for r in data_rows:
            row_dict = {}
            has_value = False
            for i, h in enumerate(headers):
                val = r[i] if i < len(r) else None
                # Convert to JSON-serialisable types
                if val is None:
                    row_dict[h] = ''
                elif isinstance(val, (int, float)):
                    row_dict[h] = val
                    has_value = True
                else:
                    str_val = str(val).strip()
                    row_dict[h] = str_val
                    if str_val:
                        has_value = True
            if has_value:
                rows.append(row_dict)
        # Build column metadata
        columns = [
            {'name': h, 'type': _infer_type([r.get(h) for r in rows])}
            for h in headers
        ]
        sheets[sheet_name] = {'columns': columns, 'rows': rows}
    wb.close()
    return sheets

def _parse_csv_bytes(content: bytes, filename: str) -> Dict[str, Any]:
    """Parse a CSV file and return as a single-sheet dict."""
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = content.decode('latin-1')
    reader = csv_module.DictReader(io.StringIO(text))
    rows = [dict(r) for r in reader]
    fieldnames = list(reader.fieldnames or [])
    columns = [
        {'name': h, 'type': _infer_type([r.get(h) for r in rows])}
        for h in fieldnames
    ]
    sheet_name = filename.rsplit('.', 1)[0] or 'Sheet1'
    return {sheet_name: {'columns': columns, 'rows': rows}}


@router.post("/manual/parse-file")
async def parse_manual_file(
    file: UploadFile = File(...),
    _: User = Depends(require_permission("data_sources", "edit")),
):
    """
    Parse an uploaded Excel (.xlsx/.xls) or CSV file server-side.
    Returns: { sheets: { sheetName: { columns: [...], rows: [...] } } }
    """
    allowed = {'.xlsx', '.xls', '.csv'}
    ext = '.' + (file.filename or '').rsplit('.', 1)[-1].lower()
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported file type '{ext}'. Allowed: xlsx, xls, csv")

    content = await file.read()
    if len(content) > 250 * 1024 * 1024:  # 250 MB guard
        raise HTTPException(status_code=400, detail="File too large (max 250 MB)")

    try:
        if ext in ('.xlsx', '.xls'):
            sheets = _parse_excel_bytes(content)
        else:
            sheets = _parse_csv_bytes(content, file.filename or 'data')
    except Exception as e:
        logger.error(f"File parse error: {e}")
        raise HTTPException(status_code=422, detail=f"Failed to parse file: {str(e)}")

    total_rows = sum(len(v['rows']) for v in sheets.values())
    logger.info(f"Parsed '{file.filename}': {len(sheets)} sheet(s), {total_rows} total rows")
    return {'filename': file.filename, 'sheets': sheets}


@router.get("/", response_model=List[DataSourceResponse])
def list_data_sources(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List data sources — filtered by ownership and shares."""
    sources = (
        _owned_or_shared(db, DataSource, ResourceType.DATASOURCE, current_user)
        .offset(skip)
        .limit(limit)
        .all()
    )
    for s in sources:
        s.user_permission = get_effective_permission(db, current_user, s, "data_sources")
    stamp_owner_emails(db, sources)
    return sources


@router.get("/{data_source_id}", response_model=DataSourceResponse)
def get_data_source(
    data_source_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a data source by ID."""
    data_source = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not data_source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )
    data_source.user_permission = require_view_access(db, current_user, data_source, "data_sources")
    return data_source


@router.post("/", response_model=DataSourceResponse, status_code=status.HTTP_201_CREATED)
def create_data_source(
    data_source: DataSourceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("data_sources", "edit")),
):
    """Create a new data source."""
    try:
        data_source.config = _normalize_google_oauth_config(
            data_source.config,
            current_user=current_user,
        )
        return DataSourceCRUDService.create(db, data_source, owner_id=current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{data_source_id}", response_model=DataSourceResponse)
def update_data_source(
    data_source_id: int,
    data_source_update: DataSourceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a data source."""
    ds = db.query(DataSource).filter(DataSource.id == data_source_id).first()
    if not ds:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Data source with ID {data_source_id} not found")
    require_edit_access(db, current_user, ds, "data_sources")
    try:
        if data_source_update.config is not None:
            data_source_update.config = _normalize_google_oauth_config(
                data_source_update.config,
                current_user=current_user,
                existing_config=ds.config,
            )
        data_source = DataSourceCRUDService.update(db, data_source_id, data_source_update)
        return data_source
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{data_source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_data_source(
    data_source_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a data source, blocked if any datasets still reference it."""
    datasource = db.query(DataSource).filter(DataSource.id == data_source_id).first()
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )
    require_full_access(db, current_user, datasource, "data_sources")

    blocking_datasets = db.query(Dataset).filter(
        Dataset.id.in_(
            db.query(Dataset.id)
            .join(Dataset.tables)
            .filter_by(datasource_id=data_source_id)
            .distinct()
        )
    ).all()

    constraints = [
        {"type": "dataset", "id": ds.id, "name": ds.name}
        for ds in blocking_datasets
    ]

    if constraints:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": f"Data source \"{datasource.name}\" đang được sử dụng và không thể xóa.",
                "constraints": constraints,
            },
        )

    success = DataSourceCRUDService.delete(db, data_source_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )


@router.post("/test", response_model=DataSourceTestResponse)
def test_data_source_connection(
    request: DataSourceTestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("data_sources", "view")),
):
    """Test a data source connection."""
    config = dict(request.config)

    # When editing an existing datasource, sensitive fields are cleared to ''
    # by the frontend (sanitizeConfigForForm strips the '__stored__' sentinel).
    # Re-fill them from the DB so the real (encrypted) credentials are used.
    if request.data_source_id is not None:
        from app.core.crypto import _SENSITIVE_FIELDS, MASKED_PLACEHOLDER
        db_ds = DataSourceCRUDService.get_by_id(db, request.data_source_id)
        if db_ds and db_ds.config:
            stored = dict(db_ds.config)
            for field in _SENSITIVE_FIELDS:
                if config.get(field, None) in ('', None, MASKED_PLACEHOLDER):
                    if stored.get(field):
                        config[field] = stored[field]  # keep encrypted value from DB

    config = _normalize_google_oauth_config(
        config,
        current_user=current_user,
        existing_config=db_ds.config if request.data_source_id is not None and db_ds else None,
    )

    success, message = DataSourceConnectionService.test_connection(
        request.type.value,
        config
    )
    return DataSourceTestResponse(success=success, message=message)


@router.post("/query", response_model=QueryExecuteResponse)
@_limiter.limit("20/minute")
def execute_query(
    request: Request,
    body: QueryExecuteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Execute an ad-hoc SQL query against a data source."""
    data_source = DataSourceCRUDService.get_by_id(db, body.data_source_id)
    if not data_source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {body.data_source_id} not found"
        )
    require_view_access(db, current_user, data_source, "data_sources")

    try:
        columns, data, execution_time_ms = DataSourceConnectionService.execute_query(
            data_source.type.value,
            data_source.config,
            body.sql_query,
            body.limit,
            timeout_seconds=body.timeout_seconds or 30,
        )
        
        return QueryExecuteResponse(
            columns=columns,
            data=data,
            row_count=len(data),
            execution_time_ms=execution_time_ms
        )
    except Exception as e:
        logger.exception("Query execution failed for datasource %s", body.data_source_id)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_build_query_error_detail(e),
        )


# ── Schema Browser ────────────────────────────────────────────────────────────

@router.get("/{data_source_id}/schema")
def get_schema_browser(
    data_source_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return schema tree: schemas → tables/views with row count estimates."""
    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="Data source not found")
    require_view_access(db, current_user, ds, "data_sources")
    try:
        schemas = DataSourceConnectionService.get_schema_browser(ds.type.value, ds.config)
        return {"schemas": schemas}
    except Exception as e:
        logger.error(f"Schema browser failed for ds {data_source_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve schema. Please check the connection.")


@router.get("/{data_source_id}/tables/{schema_name}/{table_name}")
def get_table_detail(
    data_source_id: int,
    schema_name: str,
    table_name: str,
    preview_rows: int = 5,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return column metadata (with PK/FK/IDX) and quick preview for a table."""
    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="Data source not found")
    require_view_access(db, current_user, ds, "data_sources")
    try:
        detail = DataSourceConnectionService.get_table_detail(
            ds.type.value, ds.config, schema_name, table_name, preview_rows
        )
        return detail
    except Exception as e:
        logger.error(f"Table detail failed for {schema_name}.{table_name}: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve table details.")


@router.get("/{data_source_id}/tables/{schema_name}/{table_name}/watermarks")
def get_watermark_candidates(
    data_source_id: int,
    schema_name: str,
    table_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List columns usable as watermark (timestamp/date/integer) for incremental sync."""
    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="Data source not found")
    require_view_access(db, current_user, ds, "data_sources")
    try:
        candidates = DataSourceConnectionService.get_watermark_candidates(
            ds.type.value, ds.config, schema_name, table_name
        )
        return {"columns": candidates}
    except Exception as e:
        logger.error(f"Watermark candidates failed for {schema_name}.{table_name}: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve watermark candidates.")
