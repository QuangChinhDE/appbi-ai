"""
API router for data source endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.orm import Session
from typing import List, Dict, Any
import io
import csv as csv_module

from app.core import get_db
from app.models import DataSource, Dataset, DatasetWorkspace
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
import time

logger = get_logger(__name__)
router = APIRouter(prefix="/datasources", tags=["datasources"])


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
async def parse_manual_file(file: UploadFile = File(...)):
    """
    Parse an uploaded Excel (.xlsx/.xls) or CSV file server-side.
    Returns: { sheets: { sheetName: { columns: [...], rows: [...] } } }
    """
    allowed = {'.xlsx', '.xls', '.csv'}
    ext = '.' + (file.filename or '').rsplit('.', 1)[-1].lower()
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported file type '{ext}'. Allowed: xlsx, xls, csv")

    content = await file.read()
    if len(content) > 50 * 1024 * 1024:  # 50 MB guard
        raise HTTPException(status_code=400, detail="File too large (max 50 MB)")

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
    db: Session = Depends(get_db)
):
    """List all data sources with pagination."""
    return DataSourceCRUDService.get_all(db, skip=skip, limit=limit)


@router.get("/{data_source_id}", response_model=DataSourceResponse)
def get_data_source(data_source_id: int, db: Session = Depends(get_db)):
    """Get a data source by ID."""
    data_source = DataSourceCRUDService.get_by_id(db, data_source_id)
    if not data_source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )
    return data_source


@router.post("/", response_model=DataSourceResponse, status_code=status.HTTP_201_CREATED)
def create_data_source(data_source: DataSourceCreate, db: Session = Depends(get_db)):
    """Create a new data source."""
    try:
        return DataSourceCRUDService.create(db, data_source)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.put("/{data_source_id}", response_model=DataSourceResponse)
def update_data_source(
    data_source_id: int,
    data_source_update: DataSourceUpdate,
    db: Session = Depends(get_db)
):
    """Update a data source."""
    try:
        data_source = DataSourceCRUDService.update(db, data_source_id, data_source_update)
        if not data_source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Data source with ID {data_source_id} not found"
            )
        return data_source
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.delete("/{data_source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_data_source(data_source_id: int, db: Session = Depends(get_db)):
    """Delete a data source, blocked if any datasets or workspaces still reference it."""
    datasource = db.query(DataSource).filter(DataSource.id == data_source_id).first()
    if not datasource:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {data_source_id} not found"
        )

    blocking_datasets = db.query(Dataset).filter(Dataset.data_source_id == data_source_id).all()
    blocking_workspaces = db.query(DatasetWorkspace).filter(
        DatasetWorkspace.id.in_(
            db.query(DatasetWorkspace.id)
            .join(DatasetWorkspace.tables)
            .filter_by(datasource_id=data_source_id)
            .distinct()
        )
    ).all()

    constraints = [
        {"type": "dataset", "id": d.id, "name": d.name}
        for d in blocking_datasets
    ] + [
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


@router.post("/test", response_model=DataSourceTestResponse)
def test_data_source_connection(request: DataSourceTestRequest):
    """Test a data source connection."""
    success, message = DataSourceConnectionService.test_connection(
        request.type.value,
        request.config
    )
    return DataSourceTestResponse(success=success, message=message)


@router.post("/query", response_model=QueryExecuteResponse)
def execute_query(request: QueryExecuteRequest, db: Session = Depends(get_db)):
    """Execute an ad-hoc SQL query against a data source."""
    data_source = DataSourceCRUDService.get_by_id(db, request.data_source_id)
    if not data_source:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data source with ID {request.data_source_id} not found"
        )
    
    try:
        start_time = time.time()
        columns, data, execution_time_ms = DataSourceConnectionService.execute_query(
            data_source.type.value,
            data_source.config,
            request.sql_query,
            request.limit
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
            detail=f"Query execution failed: {str(e)}"
        )
