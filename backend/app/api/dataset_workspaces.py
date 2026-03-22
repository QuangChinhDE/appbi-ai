"""API endpoints for Dataset Workspaces (Table-based Datasets)"""
from typing import List, Optional
from decimal import Decimal
import re
from datetime import datetime, date
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.dependencies import get_current_user, require_permission, require_edit_access, require_full_access, get_effective_permission
from app.core.permissions import _owned_or_shared
from app.models import DataSource, Chart, DatasetWorkspace, DatasetWorkspaceTable
from app.models.resource_share import ResourceType
from app.models.user import User
from app.schemas import (
    WorkspaceCreate,
    WorkspaceUpdate,
    WorkspaceResponse,
    WorkspaceWithTables,
    TableCreate,
    TableUpdate,
    TableResponse,
    TablePreviewRequest,
    TablePreviewResponse,
    ExecuteQueryRequest,
    ExecuteQueryResponse,
    DatasourceTable,
    WorkspaceColumnMetadata,
)
from app.services import (
    DatasetWorkspaceCRUDService,
    DataSourceConnectionService,
    TableStatsService,
    EmbeddingService,
    AutoTaggingService,
)

router = APIRouter()



# ISO date/datetime patterns for string-based detection
_ISO_DATETIME_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?'
)
_ISO_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


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


# ===== Table Vector Search (must be before /{workspace_id} routes) =====

@router.get("/tables/search", response_model=List[dict])
def search_tables_vector(
    q: str,
    limit: int = Query(10, ge=1, le=20),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Vector similarity search across workspace tables accessible to the user."""
    from app.services.embedding_service import EmbeddingService
    from app.models.dataset_workspace import DatasetWorkspaceTable

    # Build set of workspace IDs the user is allowed to see
    accessible_ws_ids = {
        ws.id
        for ws in _owned_or_shared(db, DatasetWorkspace, ResourceType.WORKSPACE, current_user).all()
    }

    hits = EmbeddingService.search_similar(
        db, q, resource_type="workspace_table", limit=limit
    )
    if not hits:
        return []
    table_ids = [h["resource_id"] for h in hits]
    tables = db.query(DatasetWorkspaceTable).filter(
        DatasetWorkspaceTable.id.in_(table_ids)
    ).all()
    table_map = {t.id: t for t in tables}
    results = []
    for h in hits:
        t = table_map.get(h["resource_id"])
        if t and t.workspace_id in accessible_ws_ids:
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
                "workspace_id": t.workspace_id,
                "display_name": t.display_name,
                "auto_description": t.auto_description,
                "columns": cols,
                "similarity": round(h["similarity"], 4),
            })
    return results


# ===== Workspace Endpoints =====

@router.get("/", response_model=List[WorkspaceResponse])
def list_workspaces(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List dataset workspaces visible to the current user."""
    items = (
        _owned_or_shared(db, DatasetWorkspace, ResourceType.WORKSPACE, current_user)
        .offset(skip)
        .limit(limit)
        .all()
    )
    for item in items:
        item.user_permission = get_effective_permission(db, current_user, item, "workspaces")
    return items


@router.post("/", response_model=WorkspaceResponse, status_code=201)
def create_workspace(
    workspace: WorkspaceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("workspaces", "edit")),
):
    """Create a new dataset workspace"""
    db_workspace = DatasetWorkspaceCRUDService.create_workspace(db, workspace, owner_id=current_user.id)
    return db_workspace


@router.get("/{workspace_id}", response_model=WorkspaceWithTables)
def get_workspace(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a dataset workspace by ID with its tables"""
    workspace = DatasetWorkspaceCRUDService.get_workspace_by_id(
        db, workspace_id, include_tables=True
    )
    
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    
    workspace.user_permission = get_effective_permission(db, current_user, workspace, "workspaces")
    return workspace


@router.put("/{workspace_id}", response_model=WorkspaceResponse)
def update_workspace(
    workspace_id: int,
    workspace: WorkspaceUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a dataset workspace"""
    ws = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == workspace_id).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    require_edit_access(db, current_user, ws, "workspaces")
    db_workspace = DatasetWorkspaceCRUDService.update_workspace(
        db, workspace_id, workspace
    )
    return db_workspace


@router.delete("/{workspace_id}", status_code=204)
def delete_workspace(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a dataset workspace, blocked if any of its tables are used by charts."""
    workspace = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    require_full_access(db, current_user, workspace, "workspaces")

    table_ids = [t.id for t in db.query(DatasetWorkspaceTable).filter(
        DatasetWorkspaceTable.workspace_id == workspace_id
    ).all()]

    if table_ids:
        blocking_charts = db.query(Chart).filter(Chart.workspace_table_id.in_(table_ids)).all()
        if blocking_charts:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": f"Workspace \"{workspace.name}\" có bảng đang được sử dụng trong {len(blocking_charts)} biểu đồ và không thể xóa.",
                    "constraints": [
                        {"type": "chart", "id": c.id, "name": c.name}
                        for c in blocking_charts
                    ],
                },
            )

    success = DatasetWorkspaceCRUDService.delete_workspace(db, workspace_id)
    if not success:
        raise HTTPException(status_code=404, detail="Workspace not found")


# ===== Table Endpoints =====

@router.get("/{workspace_id}/tables", response_model=List[TableResponse])
def list_workspace_tables(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all tables in a workspace"""
    workspace = DatasetWorkspaceCRUDService.get_workspace_by_id(db, workspace_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    perm = get_effective_permission(db, current_user, workspace, "workspaces")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    tables = DatasetWorkspaceCRUDService.get_workspace_tables(db, workspace_id)
    return tables


@router.post("/{workspace_id}/tables", status_code=201)
def add_table_to_workspace(
    workspace_id: int,
    table: TableCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a table to a workspace"""
    try:
        ws = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == workspace_id).first()
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")
        require_edit_access(db, current_user, ws, "workspaces")

        # Validate datasource exists
        datasource = db.query(DataSource).filter(DataSource.id == table.datasource_id).first()
        if not datasource:
            raise HTTPException(status_code=404, detail="Datasource not found")
        
        # Validate SQL query if source_kind is 'sql_query'
        if table.source_kind == "sql_query":
            from app.services.query_validator import QueryValidator, QueryValidationError
            try:
                # Validate and clean the query
                table.source_query = QueryValidator.validate_and_clean(table.source_query)
            except QueryValidationError as e:
                raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")
        
        db_table = DatasetWorkspaceCRUDService.add_table_to_workspace(
            db, workspace_id, table
        )
        
        if not db_table:
            raise HTTPException(status_code=404, detail="Workspace not found")

        # Compute column stats, auto-description, and embeddings in background
        background_tasks.add_task(TableStatsService.update_table_stats, db, db_table.id)
        background_tasks.add_task(AutoTaggingService.describe_table, db, db_table.id)
        background_tasks.add_task(EmbeddingService.embed_table, db, db_table.id)

        # Return plain dict instead of model to avoid serialization issues
        return {
            "id": db_table.id,
            "workspace_id": db_table.workspace_id,
            "datasource_id": db_table.datasource_id,
            "source_kind": db_table.source_kind,
            "source_table_name": db_table.source_table_name,
            "source_query": db_table.source_query,
            "display_name": db_table.display_name,
            "enabled": db_table.enabled,
            "transformations": db_table.transformations,
            "columns_cache": db_table.columns_cache,
            "sample_cache": db_table.sample_cache,
            "created_at": db_table.created_at.isoformat() if db_table.created_at else None,
            "updated_at": db_table.updated_at.isoformat() if db_table.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{workspace_id}/tables/{table_id}", response_model=TableResponse)
def update_workspace_table(
    workspace_id: int,
    table_id: int,
    table_update: TableUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a table in a workspace"""
    ws = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == workspace_id).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    require_edit_access(db, current_user, ws, "workspaces")
    # Verify table belongs to workspace
    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Table not found in this workspace")

    # Validate SQL query if source_query is being updated
    if table_update.source_query is not None:
        from app.services.query_validator import QueryValidator, QueryValidationError
        try:
            table_update.source_query = QueryValidator.validate_and_clean(table_update.source_query)
        except QueryValidationError as e:
            raise HTTPException(status_code=400, detail=f"Invalid SQL query: {str(e)}")

    updated_table = DatasetWorkspaceCRUDService.update_table(
        db, table_id, table_update
    )

    # Recompute stats, auto-description, and embeddings when table definition changes
    background_tasks.add_task(TableStatsService.update_table_stats, db, table_id)
    background_tasks.add_task(AutoTaggingService.describe_table, db, table_id)
    background_tasks.add_task(EmbeddingService.embed_table, db, table_id)

    return updated_table


@router.delete("/{workspace_id}/tables/{table_id}", status_code=204)
def remove_table_from_workspace(
    workspace_id: int,
    table_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove a table from a workspace, after checking for chart/formula dependencies"""
    ws = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == workspace_id).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    require_edit_access(db, current_user, ws, "workspaces")
    # Verify table belongs to workspace
    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Table not found in this workspace")

    # ------------------------------------------------------------------
    # Check 1: charts that directly reference this table
    # ------------------------------------------------------------------
    blocking_charts = (
        db.query(Chart)
        .filter(Chart.workspace_table_id == table_id)
        .all()
    )

    # ------------------------------------------------------------------
    # Check 2: other tables in this workspace whose js_formula
    # transformations reference this table by its display label
    # ------------------------------------------------------------------
    table_label = db_table.display_name or db_table.source_table_name or str(table_id)
    other_tables = (
        db.query(DatasetWorkspaceTable)
        .filter(
            DatasetWorkspaceTable.workspace_id == workspace_id,
            DatasetWorkspaceTable.id != table_id,
        )
        .all()
    )
    blocking_lookups = []
    for t in other_tables:
        transforms = t.transformations or []
        for step in transforms:
            if step.get("type") == "js_formula" and step.get("enabled", True):
                formula = step.get("params", {}).get("formula", "")
                if table_label and f'"{table_label}"' in formula:
                    blocking_lookups.append({
                        "type": "lookup",
                        "table_id": t.id,
                        "table_name": t.display_name or t.source_table_name,
                        "column": step.get("params", {}).get("newField", ""),
                    })
                    break  # one entry per table is enough

    constraints = []
    for ch in blocking_charts:
        constraints.append({
            "type": "chart",
            "id": ch.id,
            "name": ch.name,
        })
    constraints.extend(blocking_lookups)

    if constraints:
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"Bảng \"{table_label}\" đang được sử dụng và không thể xóa.",
                "constraints": constraints,
            },
        )

    EmbeddingService.delete_embedding(db, "workspace_table", table_id)
    success = DatasetWorkspaceCRUDService.delete_table(db, table_id)

    if not success:
        raise HTTPException(status_code=404, detail="Table not found")


@router.post(
    "/{workspace_id}/tables/{table_id}/preview",
    response_model=TablePreviewResponse
)
def preview_workspace_table(
    workspace_id: int,
    table_id: int,
    preview_request: TablePreviewRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Preview data from a workspace table with transformations"""
    workspace = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    perm = get_effective_permission(db, current_user, workspace, "workspaces")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Table not found in this workspace")
    
    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    
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
                WorkspaceColumnMetadata(
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
            if isinstance(val, (datetime, date)):
                return val.isoformat()
            return val
        
        # Convert rows to serializable format
        serializable_rows = []
        for row in rows[:500]:  # Keep up to 500 rows for LOOKUP support
            if isinstance(row, dict):
                serializable_rows.append({k: serialize_value(v) for k, v in row.items()})
            else:
                serializable_rows.append([serialize_value(v) for v in row])
        
        # Cache results
        DatasetWorkspaceCRUDService.update_table_cache(
            db,
            table_id,
            columns_cache={"columns": [col.model_dump() for col in column_metadata]},
            sample_cache=serializable_rows
        )
        
        return TablePreviewResponse(
            columns=column_metadata,
            rows=rows,
            total=total,
            has_more=has_more
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to preview table: {str(e)}"
        )


@router.post(
    "/{workspace_id}/tables/{table_id}/execute",
    response_model=ExecuteQueryResponse
)
def execute_workspace_table_query(
    workspace_id: int,
    table_id: int,
    execute_request: ExecuteQueryRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Execute query on workspace table with dimensions, measures, and filters"""
    workspace = db.query(DatasetWorkspace).filter(DatasetWorkspace.id == workspace_id).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    perm = get_effective_permission(db, current_user, workspace, "workspaces")
    if perm == "none":
        raise HTTPException(status_code=403, detail="Access denied")

    db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
    if not db_table or db_table.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail="Table not found in this workspace")

    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    
    # Build base_table — requires synced DuckDB view
    from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
    from app.services.duckdb_engine import DuckDBEngine

    if db_table.source_kind == "sql_query":
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

    if not select_parts:
        select_parts.append("*")

    select_clause = ", ".join(select_parts)

    # Build query — inline values with SQL-safe escaping (single-quote doubling).
    # DuckDB does not support psycopg2-style %s placeholders; column names are
    # already injection-safe (validated whitelist + double-quoted identifiers).
    def _quote_value(v: str) -> str:
        """Wrap a string value in single quotes, escaping internal single quotes."""
        return "'" + str(v).replace("'", "''") + "'"

    query = f"SELECT {select_clause} FROM {base_table}"

    # Add WHERE clause
    if execute_request.filters:
        where_conditions = []
        for filter_cond in execute_request.filters:
            quoted_field = _validate_column(filter_cond.field, "filter field")
            # operator validated by Pydantic enum: = != > < >= <= LIKE IN
            op = filter_cond.operator.upper()
            if op == 'LIKE':
                safe_val = filter_cond.value.replace("'", "''")
                where_conditions.append(f"{quoted_field} LIKE '%{safe_val}%'")
            elif op == 'IN':
                values = [v.strip() for v in filter_cond.value.split(',') if v.strip()]
                if not values:
                    continue
                quoted_values = ", ".join(_quote_value(v) for v in values)
                where_conditions.append(f"{quoted_field} IN ({quoted_values})")
            else:
                where_conditions.append(f"{quoted_field} {filter_cond.operator} {_quote_value(filter_cond.value)}")

        if where_conditions:
            query += " WHERE " + " AND ".join(where_conditions)

    # Add GROUP BY for dimensions
    if execute_request.dimensions and execute_request.measures:
        # dimensions are already validated + quoted above; rebuild the list
        quoted_dims = [_validate_column(d, "dimension") for d in execute_request.dimensions]
        query += f" GROUP BY {', '.join(quoted_dims)}"

    # Add ORDER BY — field validated + quoted, direction constrained by Pydantic
    if execute_request.order_by:
        order_parts = []
        for ob in execute_request.order_by:
            quoted_col = _validate_column(ob.field, "order_by field")
            direction = ob.direction.upper() if ob.direction.upper() in ("ASC", "DESC") else "DESC"
            order_parts.append(f"{quoted_col} {direction}")
        query += " ORDER BY " + ", ".join(order_parts)

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
                WorkspaceColumnMetadata(
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
        raise HTTPException(
            status_code=500,
            detail=f"Failed to execute query: {str(e)}"
        )


# ===== Datasource Table List Endpoint =====

@router.get(
    "/datasources/{datasource_id}/tables",
    response_model=List[DatasourceTable],
    tags=["datasources"]
)
def list_datasource_tables(
    datasource_id: int,
    search: Optional[str] = Query(None, description="Search query for table names"),
    db: Session = Depends(get_db)
):
    """List all tables from a datasource"""
    # Get datasource
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    
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
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list tables: {str(e)}"
        )


# ===== Datasource Table Columns Endpoint =====

@router.get(
    "/datasources/{datasource_id}/tables/columns",
    tags=["datasources"]
)
def list_datasource_table_columns(
    datasource_id: int,
    table: str = Query(..., description="Table name (e.g. public.orders or orders)"),
    db: Session = Depends(get_db)
):
    """
    Return columns for a specific table.
    Tries DuckDB synced view first; falls back to live source schema query.
    """
    datasource = db.query(DataSource).filter(DataSource.id == datasource_id).first()
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")
    try:
        columns = DataSourceConnectionService.list_columns(
            ds_id=datasource.id,
            ds_type=datasource.type,
            config=datasource.config,
            table_name=table,
        )
        return {"columns": columns}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list columns: {str(e)}")
