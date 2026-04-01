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
from app.models import DataSource, DatasetWorkspace
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
import time

logger = get_logger(__name__)
router = APIRouter(prefix="/datasources", tags=["datasources"])
_limiter = Limiter(key_func=get_remote_address)


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
    """Delete a data source, blocked if any datasets or workspaces still reference it."""
    datasource = db.query(DataSource).filter(DataSource.id == data_source_id).first()
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )
    require_full_access(db, current_user, datasource, "data_sources")

    blocking_workspaces = db.query(DatasetWorkspace).filter(
        DatasetWorkspace.id.in_(
            db.query(DatasetWorkspace.id)
            .join(DatasetWorkspace.tables)
            .filter_by(datasource_id=data_source_id)
            .distinct()
        )
    ).all()

    constraints = [
        {"type": "workspace", "id": w.id, "name": w.name}
        for w in blocking_workspaces
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

    # Clean up parquet files and DuckDB views for the deleted datasource
    from app.services.sync_engine import cleanup_datasource_data
    cleanup_datasource_data(data_source_id)


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
        start_time = time.time()
        columns, data, execution_time_ms = DataSourceConnectionService.execute_query(
            data_source.type.value,
            data_source.config,
            body.sql_query,
            body.limit
        )
        
        return QueryExecuteResponse(
            columns=columns,
            data=data,
            row_count=len(data),
            execution_time_ms=execution_time_ms
        )
    except Exception as e:
        logger.error(f"Query execution failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Query execution failed. Please check your SQL and try again."
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


# ── Sync Config ───────────────────────────────────────────────────────────────

@router.get("/{data_source_id}/sync-config")
def get_sync_config(
    data_source_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return stored sync configuration for the data source."""
    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="Data source not found")
    require_view_access(db, current_user, ds, "data_sources")
    return {"sync_config": ds.sync_config or {}}


@router.put("/{data_source_id}/sync-config")
def save_sync_config(
    data_source_id: int,
    body: Dict[str, Any],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Persist sync configuration for the data source and update the scheduler."""
    from sqlalchemy import update as sa_update
    from app.models import DataSource as DSModel
    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="Data source not found")
    require_edit_access(db, current_user, ds, "data_sources")
    sync_config = body.get("sync_config", body)  # accept both {sync_config: {...}} and raw
    ds.sync_config = sync_config
    db.commit()
    db.refresh(ds)
    # Notify scheduler so the new schedule takes effect immediately
    try:
        from app.services.sync_scheduler import register_datasource
        register_datasource(data_source_id, ds.sync_config or {})
    except Exception as e:
        logger.warning(f"Scheduler update skipped: {e}")
    return {"sync_config": ds.sync_config}


# ── Sync Jobs ─────────────────────────────────────────────────────────────────

@router.get("/{data_source_id}/sync-jobs")
def list_sync_jobs(
    data_source_id: int,
    limit: int = 10,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List recent sync job history for a data source."""
    from app.models import SyncJob
    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="Data source not found")
    require_view_access(db, current_user, ds, "data_sources")
    jobs = (
        db.query(SyncJob)
        .filter(SyncJob.data_source_id == data_source_id)
        .order_by(SyncJob.started_at.desc())
        .limit(limit)
        .all()
    )
    return {
        "jobs": [
            {
                "id": j.id,
                "status": j.status,
                "mode": j.mode,
                "started_at": j.started_at.isoformat() if j.started_at else None,
                "finished_at": j.finished_at.isoformat() if j.finished_at else None,
                "duration_seconds": (
                    (j.finished_at - j.started_at).total_seconds()
                    if j.finished_at and j.started_at else None
                ),
                "rows_synced": j.rows_synced,
                "rows_failed": j.rows_failed,
                "error_message": j.error_message,
                "triggered_by": j.triggered_by,
            }
            for j in jobs
        ]
    }


@router.post("/{data_source_id}/sync", status_code=202)
def trigger_sync(
    data_source_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Trigger an immediate manual sync for a data source."""
    from app.models import SyncJob
    from app.services.sync_engine import trigger_sync as run_sync
    from datetime import datetime, timezone

    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="Data source not found")
    require_edit_access(db, current_user, ds, "data_sources")

    # Reject if a job is already running
    running = (
        db.query(SyncJob)
        .filter(SyncJob.data_source_id == data_source_id, SyncJob.status == "running")
        .first()
    )
    if running:
        raise HTTPException(
            status_code=409,
            detail=f"A sync job is already running (job #{running.id}). Wait for it to finish.",
        )

    job = SyncJob(
        data_source_id=data_source_id,
        status="running",
        mode="manual",
        triggered_by="manual",
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # Fire and forget — runs in a daemon thread
    run_sync(data_source_id, job.id)
    logger.info(f"Manual sync triggered for datasource {data_source_id}, job_id={job.id}")
    return {"job_id": job.id, "status": "running", "message": "Sync started"}
