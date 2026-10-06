"""
API router for data source endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status, UploadFile, File
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
import io
import csv as csv_module

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core import get_db
from app.core.dependencies import (
    module_floor,
    get_current_user,
    require_permission,
    require_view_access,
    require_edit_access,
    require_full_access,
    get_effective_permission,
)
from app.core.permissions import _owned_or_shared, stamp_owner_emails
from app.models import DataSource
from app.models.resource_share import ResourceType
from app.models.user import User
from app.services.source_errors import describe_source_error
from app.schemas import (
    DataSourceCreate,
    DataSourceUpdate,
    DataSourceResponse,
    DataSourceDraftTestRequest,
    DataSourceTestResponse,
    QueryExecuteRequest,
    QueryExecuteResponse,
    SqlValidateRequest,
    SqlValidateResponse,
)
from app.services import DataSourceCRUDService, DataSourceConnectionService
from app.core.logging import get_logger
from app.core.config import settings
from app.services.source_lifecycle import (
    SourceConfigError,
    SourceInUseError,
    changed_destination_fields,
    claim_google_connection,
    enforce_platform_gcp_policy,
    restore_masked_secrets,
)
from app.services.source_health import record_health, run_connection_test

logger = get_logger(__name__)
router = APIRouter(
    prefix="/datasources", tags=["datasources"],
    dependencies=[module_floor("data_sources")],
)
_limiter = Limiter(key_func=get_remote_address)


def _build_query_error_detail(exc: Exception, config: Any = None) -> dict:
    """Return a user-facing query error payload without hiding the root cause —
    but never the datasource's configured secrets (central redaction)."""
    message = describe_source_error(exc, config) if str(exc).strip() else ""
    return {
        "message": message or "Query execution failed. Please check your SQL and try again.",
    }


def _config_error(exc: Exception, config: Any = None) -> HTTPException:
    """Map a service-layer SourceConfigError / ValueError to HTTP. The message is
    redacted; typed domain codes keep a structured body."""
    status_code = getattr(exc, "status_code", status.HTTP_400_BAD_REQUEST)
    code = getattr(exc, "code", None)
    message = describe_source_error(exc, config)
    if code in ("source_type_immutable", "source_not_tabular", "credential_required"):
        return HTTPException(status_code=status_code, detail={"code": code, "message": message})
    return HTTPException(status_code=status_code, detail=message)


def _stamp_capabilities(sources) -> None:
    """Expose the provider capability model on every DataSource response."""
    from app.services.source_capabilities import capabilities_for
    for ds in sources:
        ds.capabilities = capabilities_for(ds.type)


def _require_tabular(ds: Any, capability: str = "tabular") -> None:
    """F15: refuse a tabular path on a provider without tables (google_docs)."""
    from app.services.source_capabilities import SourceNotTabularError, require_capability
    try:
        require_capability(ds.type, capability)
    except SourceNotTabularError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail={"code": exc.code, "message": str(exc)})


# The ONE secret-restore implementation lives in the service layer; the draft
# test reuses it under this name (no second copy in the router).
_restore_sensitive_config_fields = restore_masked_secrets


# ── Platform GCP credential info ──────────────────────────────────────────────

# ── Source hardening helpers (spec: docs/features/source-core-hardening/spec.md) ──

# Destination fields (WHERE a stored secret is sent) are defined once in
# source_lifecycle.DESTINATION_FIELDS — the draft test and update share it.


def _reuses_stored_secret(config: dict[str, Any], stored: dict[str, Any]) -> bool:
    from app.core.crypto import MASKED_PLACEHOLDER, _SENSITIVE_FIELDS
    for field in _SENSITIVE_FIELDS:
        if config.get(field, None) in ("", None, MASKED_PLACEHOLDER) and stored.get(field):
            return True
    if str(config.get("auth_mode") or "").strip().lower() == "google_oauth" and not config.get("google_pending_id"):
        if stored.get("google_oauth_credentials") or stored.get("google_oauth_user_id"):
            return True
    return False


def _strip_unset_secrets(config: dict[str, Any]) -> dict[str, Any]:
    """A draft WITHOUT a source id: a blank/masked secret means no secret."""
    from app.core.crypto import MASKED_PLACEHOLDER, _SENSITIVE_FIELDS
    cleaned = dict(config or {})
    for field in _SENSITIVE_FIELDS:
        if cleaned.get(field, None) in ("", None, MASKED_PLACEHOLDER):
            cleaned.pop(field, None)
    return cleaned


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


# ── Manual datasource: bounded upload → staged Parquet assets ─────────────────

_MANUAL_UPLOAD_CHUNK = 1024 * 1024


@router.post("/manual/parse-file")
async def parse_manual_file(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("data_sources", "edit")),
):
    """
    Parse an uploaded .xlsx or .csv file into STAGED assets (one per sheet).

    Returns ``{filename, sheets: {name: {asset_id, columns, row_count,
    preview_rows, preview_truncated}}, limits}`` — never the full rows. Create
    / update the manual source with ``config.sheets[name].asset_id`` to bind.
    Limits: settings.MANUAL_UPLOAD_* (see manual_assets/parsing.py).
    """
    import tempfile
    from app.services.manual_assets.parsing import ManualUploadError, check_extension, parse_file
    from app.services.manual_assets.service import gc_expired_staged, stage_sheets

    max_bytes = settings.MANUAL_UPLOAD_MAX_BYTES
    max_mb = max_bytes // (1024 * 1024)
    try:
        ext = check_extension(file.filename)
    except ManualUploadError as exc:
        raise HTTPException(status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)})
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes + 64 * 1024:
        raise HTTPException(status_code=413, detail={"code": "file_too_large", "message": f"File is larger than {max_mb} MB."})

    spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    try:
        total = 0
        while True:
            chunk = await file.read(_MANUAL_UPLOAD_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status_code=413, detail={"code": "file_too_large", "message": f"File is larger than {max_mb} MB."})
            spool.write(chunk)
        if total == 0:
            raise HTTPException(status_code=422, detail={"code": "empty_file", "message": "The file is empty."})
        spool.seek(0)
        try:
            _, sheets = parse_file(spool, file.filename)
        except ManualUploadError as exc:
            raise HTTPException(status_code=exc.status_code, detail={"code": exc.code, "message": str(exc)})
        except Exception:
            logger.warning("manual_upload.parse_failed ext=%s", ext, exc_info=True)
            raise HTTPException(status_code=422, detail={"code": "invalid_file", "message": "The file could not be read. Check that it is a valid .csv or .xlsx file."})
    finally:
        spool.close()
        await file.close()

    if not sheets:
        raise HTTPException(status_code=422, detail={"code": "no_sheets", "message": "The file contains no sheets."})
    media_type = (
        "text/csv" if ext == ".csv"
        else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    try:
        gc_expired_staged(db)
        staged = stage_sheets(db, sheets, owner_id=current_user.id, filename=file.filename, media_type=media_type)
        db.commit()
    except Exception:
        db.rollback()  # removes any file written for this upload
        logger.error("manual_upload.stage_failed", exc_info=True)
        raise HTTPException(status_code=500, detail={"code": "storage_failed", "message": "The file could not be stored. Try again."})

    total_rows = sum(v["row_count"] for v in staged.values())
    logger.info("manual_upload.staged sheets=%s rows=%s bytes=%s", len(staged), total_rows, total)
    return {
        "filename": file.filename,
        "sheets": staged,
        "limits": {
            "max_bytes": max_bytes,
            "max_rows": settings.MANUAL_UPLOAD_MAX_ROWS,
            "max_columns": settings.MANUAL_UPLOAD_MAX_COLUMNS,
            "preview_rows": settings.MANUAL_UPLOAD_PREVIEW_ROWS,
        },
    }


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
    _stamp_capabilities(sources)
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
    _stamp_capabilities([data_source])
    stamp_owner_emails(db, [data_source])
    return data_source


@router.post("/", response_model=DataSourceResponse, status_code=status.HTTP_201_CREATED)
def create_data_source(
    data_source: DataSourceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("data_sources", "edit")),
):
    """Create a new data source (pipeline: DataSourceCRUDService.create)."""
    try:
        created = DataSourceCRUDService.create(
            db, data_source, owner_id=current_user.id, actor=current_user, test_connection=True,
        )
    except ValueError as e:  # SourceConfigError included
        raise _config_error(e, data_source.config)
    created.user_permission = get_effective_permission(db, current_user, created, "data_sources")
    _stamp_capabilities([created])
    stamp_owner_emails(db, [created])
    return created


@router.put("/{data_source_id}", response_model=DataSourceResponse)
def update_data_source(
    data_source_id: int,
    data_source_update: DataSourceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a data source. Object `edit`. All config handling — secret
    restore, auth-mode rules, validation, Google claim, policy, connection test,
    persist, invalidation — is the service's single chokepoint."""
    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Data source with ID {data_source_id} not found")
    require_edit_access(db, current_user, ds, "data_sources")
    stored_config = dict(ds.config or {})
    try:
        data_source = DataSourceCRUDService.update(
            db, data_source_id, data_source_update,
            actor_id=current_user.id, actor=current_user, test_connection=True,
        )
    except ValueError as e:
        raise _config_error(e, data_source_update.config or stored_config)
    if data_source is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Data source with ID {data_source_id} not found")
    data_source.user_permission = get_effective_permission(db, current_user, data_source, "data_sources")
    _stamp_capabilities([data_source])
    stamp_owner_emails(db, [data_source])
    return data_source


@router.delete("/{data_source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_data_source(
    data_source_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a data source. Object `full`. 409 with structured blockers
    ({code: source_in_use, message, blockers: [{kind, id, name}]}) while a
    Dataset, a hosted snapshot or a Knowledge Doc depends on it."""
    datasource = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )
    require_full_access(db, current_user, datasource, "data_sources")
    try:
        DataSourceCRUDService.delete(db, data_source_id, actor_id=current_user.id)
    except SourceInUseError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=e.to_detail())


@router.post("/test-draft", response_model=DataSourceTestResponse)
def test_draft_data_source_connection(
    request: DataSourceDraftTestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("data_sources", "edit")),
):
    """Test a config that is not (yet) saved — the create/edit form.

    Module `edit` is required. A blank or masked secret is NOT a secret, unless
    `data_source_id` is given; then the caller needs object `edit` on that source,
    the type must equal the persisted type, and every destination field (host,
    port, database, username, schema, project, spreadsheet, dataset, auth mode,
    Google identity) must equal the persisted value — a stored secret is never
    paired with a destination the caller chose (spec: draft test invariant)."""
    ds_type = request.type.value
    config = dict(request.config or {})
    from app.services.datasource_service import PLATFORM_GCP_APPROVAL_FIELD
    config.pop(PLATFORM_GCP_APPROVAL_FIELD, None)

    existing_config = None
    if request.data_source_id is not None:
        db_ds = DataSourceCRUDService.get_by_id(db, request.data_source_id)
        if db_ds is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data source not found")
        # Checked BEFORE any stored secret is looked at.
        require_edit_access(db, current_user, db_ds, "data_sources")
        persisted_type = db_ds.type.value if hasattr(db_ds.type, "value") else str(db_ds.type)
        stored = dict(db_ds.config or {})
        if _reuses_stored_secret(config, stored):
            if persisted_type != ds_type:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="A stored credential can only be tested against its own source type.",
                )
            changed = changed_destination_fields(config, stored)
            if changed:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        "The connection details changed, so the stored credential cannot be reused. "
                        "Enter the credential again to test the new destination."
                    ),
                )
            config = _restore_sensitive_config_fields(config, stored)
            existing_config = stored
            if stored.get(PLATFORM_GCP_APPROVAL_FIELD):
                config[PLATFORM_GCP_APPROVAL_FIELD] = stored[PLATFORM_GCP_APPROVAL_FIELD]
        else:
            config = _strip_unset_secrets(config)
    else:
        config = _strip_unset_secrets(config)

    try:
        if ds_type in ("bigquery", "google_sheets", "google_docs"):
            # A draft test only PEEKS a fresh consent handle; a save consumes it.
            config = claim_google_connection(
                db, config, actor=current_user, existing_config=existing_config, consume=False,
            )
        config = enforce_platform_gcp_policy(ds_type, config, current_user, existing_config)
    except SourceConfigError as e:
        raise _config_error(e, config)

    # Structured and redacted (F16) — never a raw driver message.
    return DataSourceTestResponse(**run_connection_test(ds_type, config))


@router.post("/{data_source_id}/test", response_model=DataSourceTestResponse)
def test_saved_data_source_connection(
    data_source_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Retest a SAVED source. Object `edit` required. Type, destination and
    secret come ONLY from the persisted row — the request carries nothing.
    The result is persisted as the source's last health."""
    db_ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if db_ds is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data source not found")
    require_edit_access(db, current_user, db_ds, "data_sources")
    ds_type = db_ds.type.value if hasattr(db_ds.type, "value") else str(db_ds.type)
    config = dict(db_ds.config or {})
    result = run_connection_test(ds_type, config)
    record_health(db, db_ds, result, actor_id=current_user.id)
    return DataSourceTestResponse(**result)


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
    # Raw SQL against a source = object edit (spec permission mapping).
    require_edit_access(db, current_user, data_source, "data_sources")
    _require_tabular(data_source, "query")

    try:
        result = DataSourceConnectionService.execute_user_query(
            data_source.type.value,
            data_source.config,
            body.sql_query,
            body.limit,
            timeout_seconds=body.timeout_seconds or 30,
        )

        return QueryExecuteResponse(
            columns=result["columns"],
            data=result["data"],
            row_count=len(result["data"]),
            execution_time_ms=result["execution_time_ms"],
            truncated=result["truncated"],
            row_limit=result["row_limit"],
        )
    except Exception as e:
        # No logger.exception: the traceback would carry the raw driver message.
        logger.error("Query execution failed source_id=%s provider=%s cause=%s",
                     body.data_source_id, data_source.type.value,
                     describe_source_error(e, data_source.config))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_build_query_error_detail(e, data_source.config),
        )


@router.post("/validate-sql", response_model=SqlValidateResponse)
@_limiter.limit("30/minute")
def validate_sql(
    request: Request,
    body: SqlValidateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Validate a SQL query against a datasource without returning data.

    Sends the query wrapped in a dry-run construct (LIMIT 0, EXPLAIN, etc.)
    to the actual database engine so the user receives real error messages
    from their specific RDBMS dialect.
    """
    data_source = DataSourceCRUDService.get_by_id(db, body.data_source_id)
    if not data_source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {body.data_source_id} not found",
        )
    # Raw SQL against a source = object edit (spec permission mapping).
    require_edit_access(db, current_user, data_source, "data_sources")
    _require_tabular(data_source, "query")

    ds_type = (
        data_source.type if isinstance(data_source.type, str) else data_source.type.value
    )

    # Client-side safety check first
    from app.services.query_validator import QueryValidator, QueryValidationError

    try:
        cleaned = QueryValidator.validate_and_clean(body.sql_query)
    except QueryValidationError as exc:
        return SqlValidateResponse(valid=False, error=str(exc), dialect=ds_type)

    # Parse/plan without running the statement in full: LIMIT 0 wrapper in a
    # READ ONLY transaction (PG/MySQL) or a BigQuery dry run.
    try:
        DataSourceConnectionService.validate_user_sql(ds_type, data_source.config, cleaned)
        return SqlValidateResponse(valid=True, error=None, dialect=ds_type)
    except Exception as exc:
        error_msg = describe_source_error(exc, data_source.config)
        return SqlValidateResponse(valid=False, error=error_msg, dialect=ds_type)


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
    _require_tabular(ds, "discover")
    try:
        schemas = DataSourceConnectionService.get_schema_browser(ds.type.value, ds.config)
        return {"schemas": schemas}
    except Exception as e:
        from app.services.source_errors import describe_source_error
        logger.error("Schema browser failed (ds=%s): %s", data_source_id, describe_source_error(e, ds.config))

        raise HTTPException(status_code=400, detail=(
            f"Không đọc được schema từ nguồn: {describe_source_error(e, ds.config)}"))


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
    _require_tabular(ds, "discover")
    try:
        detail = DataSourceConnectionService.get_table_detail(
            ds.type.value, ds.config, schema_name, table_name, preview_rows
        )
        return detail
    except Exception as e:
        logger.error("Table detail failed for %s.%s: %s", schema_name, table_name,
                     describe_source_error(e, ds.config))
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
    _require_tabular(ds, "discover")
    try:
        candidates = DataSourceConnectionService.get_watermark_candidates(
            ds.type.value, ds.config, schema_name, table_name
        )
        return {"columns": candidates}
    except Exception as e:
        logger.error("Watermark candidates failed for %s.%s: %s", schema_name, table_name,
                     describe_source_error(e, ds.config))
        raise HTTPException(status_code=500, detail="Failed to retrieve watermark candidates.")


# ── Google Sheets write / structure endpoints ─────────────────────────────────
# These endpoints expose full CRUD on a connected Google Sheets datasource so
# that MCP tools (and the workboard builder) can manage sheet tabs and row data
# without requiring direct Google API access from the client.

def _require_gsheets_ds(data_source_id: int, db: Session, current_user: User):
    """Load + authorize a google_sheets datasource; raise 404/403/400 on error."""
    from app.models import DataSource
    from app.core.crypto import decrypt_config
    from app.services.google_sheets_connector import create_google_sheets_connector

    ds = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not ds:
        raise HTTPException(status_code=404, detail="Data source not found")
    require_view_access(db, current_user, ds, "data_sources")

    ds_type = ds.type.value if hasattr(ds.type, "value") else str(ds.type or "")
    if ds_type != "google_sheets":
        raise HTTPException(
            status_code=400,
            detail=f"Data source {data_source_id} is type '{ds_type}', not 'google_sheets'.",
        )
    cfg = decrypt_config(ds.config)
    spreadsheet_id = (cfg.get("spreadsheet_id") or "").strip()
    if not spreadsheet_id:
        raise HTTPException(status_code=400, detail="Datasource missing spreadsheet_id")
    try:
        connector = create_google_sheets_connector(cfg)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    return connector, spreadsheet_id, ds


@router.get("/{data_source_id}/gsheets/sheets")
def list_gsheets_tabs(
    data_source_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all sheet tabs in the connected Google Spreadsheet."""
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    try:
        sheets = connector.list_sheets(spreadsheet_id)
        return {"spreadsheet_id": spreadsheet_id, "sheets": sheets}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


class GSheetCreateRequest(BaseModel):
    sheet_name: str
    headers: Optional[List[str]] = None  # column names for row 1


@router.post("/{data_source_id}/gsheets/sheets", status_code=status.HTTP_201_CREATED)
def create_gsheets_tab(
    data_source_id: int,
    body: GSheetCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new sheet tab in the connected Google Spreadsheet.

    Optionally writes a header row (column names) as the first row so the
    sheet is immediately ready for workboard form submissions.
    """
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        result = connector.create_sheet(spreadsheet_id, body.sheet_name, body.headers)
        return {"spreadsheet_id": spreadsheet_id, **result}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


@router.get("/{data_source_id}/gsheets/{sheet_name}/rows")
def read_gsheets_rows(
    data_source_id: int,
    sheet_name: str,
    limit: int = 200,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Read rows from a sheet tab. Returns columns + rows list."""
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    try:
        data = connector.get_sheet_data(spreadsheet_id, sheet_name=sheet_name)
        rows = data.get("rows") or []
        if limit:
            rows = rows[:limit]
        return {
            "spreadsheet_id": spreadsheet_id,
            "sheet_name": sheet_name,
            "columns": data.get("columns") or [],
            "rows": rows,
            "row_count": len(rows),
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


class GSheetAppendRequest(BaseModel):
    values: Dict[str, Any]  # {column_name: value}


class GSheetAppendBatchRequest(BaseModel):
    rows: List[Dict[str, Any]]  # list of {column_name: value}


class GSheetImportCsvRequest(BaseModel):
    csv_data: str  # raw CSV text; first row = headers


@router.post("/{data_source_id}/gsheets/{sheet_name}/rows", status_code=status.HTTP_201_CREATED)
def append_gsheets_row(
    data_source_id: int,
    sheet_name: str,
    body: GSheetAppendRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Append a new row to a sheet tab.

    ``values`` must be a dict mapping column names (header row) to values.
    Columns not present in the payload receive an empty string.
    """
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        row = connector.append_row(spreadsheet_id, sheet_name, body.values)
        return {"ok": True, "sheet_name": sheet_name, "row": row}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


@router.post("/{data_source_id}/gsheets/{sheet_name}/rows/batch", status_code=status.HTTP_201_CREATED)
def append_gsheets_rows_batch(
    data_source_id: int,
    sheet_name: str,
    body: GSheetAppendBatchRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Append multiple rows to a sheet tab in a single API call.

    ``rows`` is a list of dicts mapping column names to values.
    All rows are written in one Google Sheets API request.
    """
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        result = connector.append_rows(spreadsheet_id, sheet_name, body.rows)
        return {"ok": True, "sheet_name": sheet_name, **result}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


@router.post("/{data_source_id}/gsheets/{sheet_name}/import-csv", status_code=status.HTTP_200_OK)
def import_csv_to_gsheet(
    data_source_id: int,
    sheet_name: str,
    body: GSheetImportCsvRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Replace the content of a sheet tab with parsed CSV data.

    The first CSV row is treated as the header. Existing data is overwritten.
    """
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        result = connector.import_csv(spreadsheet_id, sheet_name, body.csv_data)
        return {"ok": True, **result}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


class GSheetUpdateRequest(BaseModel):
    pk: Dict[str, Any]       # {pk_column: pk_value} — used to find the row
    values: Dict[str, Any]   # {column_name: new_value}


@router.patch("/{data_source_id}/gsheets/{sheet_name}/rows")
def update_gsheets_row(
    data_source_id: int,
    sheet_name: str,
    body: GSheetUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a row in a sheet tab identified by a primary-key dict.

    ``pk`` identifies the row (e.g. ``{"id": "ROW-001"}``).
    ``values`` provides the columns to overwrite; other columns are unchanged.
    """
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        row = connector.update_row_by_pk(spreadsheet_id, sheet_name, body.pk, body.values)
        return {"ok": True, "sheet_name": sheet_name, "row": row}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


class GSheetDeleteRequest(BaseModel):
    pk: Dict[str, Any]


class GSheetRenameColumnRequest(BaseModel):
    old_name: str
    new_name: str


class GSheetRenameTabRequest(BaseModel):
    new_name: str  # {pk_column: pk_value}


@router.delete("/{data_source_id}/gsheets/{sheet_name}/rows")
def delete_gsheets_row(
    data_source_id: int,
    sheet_name: str,
    body: GSheetDeleteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a row from a sheet tab identified by a primary-key dict."""
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        row_num = connector.delete_row_by_pk(spreadsheet_id, sheet_name, body.pk)
        return {"ok": True, "sheet_name": sheet_name, "deleted_row": row_num}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


@router.patch("/{data_source_id}/gsheets/{sheet_name}/headers")
def rename_gsheets_column(
    data_source_id: int,
    sheet_name: str,
    body: GSheetRenameColumnRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Rename a column header (row 1 cell) in a GSheet tab."""
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        result = connector.rename_column(spreadsheet_id, sheet_name, body.old_name, body.new_name)
        return {"ok": True, **result}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


@router.patch("/{data_source_id}/gsheets/{sheet_name}")
def rename_gsheets_tab(
    data_source_id: int,
    sheet_name: str,
    body: GSheetRenameTabRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Rename a GSheet tab (changes the tab title in the spreadsheet)."""
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        result = connector.rename_tab(spreadsheet_id, sheet_name, body.new_name)
        return {"ok": True, **result}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))


@router.delete("/{data_source_id}/gsheets/{sheet_name}/rows/all")
def clear_gsheets_rows(
    data_source_id: int,
    sheet_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Clear all data rows (row 2+) from a GSheet tab, preserving the header row."""
    connector, spreadsheet_id, ds = _require_gsheets_ds(data_source_id, db, current_user)
    # Direct upstream Sheets mutation = object full (spec permission mapping).
    require_full_access(db, current_user, ds, "data_sources")
    try:
        result = connector.clear_data_rows(spreadsheet_id, sheet_name)
        return {"ok": True, **result}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=describe_source_error(exc, ds.config))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=describe_source_error(exc, ds.config))
