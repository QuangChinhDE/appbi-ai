"""
CRUD service for charts.
"""
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.models import Chart, ChartType, ChartMetadata, ChartParameter
from app.schemas import ChartCreate, ChartUpdate
from app.schemas import ChartMetadataUpsert, ChartParameterCreate, ChartParameterUpdate
from app.core.logging import get_logger

logger = get_logger(__name__)


# ── Aggregation push-down helpers ─────────────────────────────────────────────

def _sql_literal(value) -> str:
    """Safely escape a Python value as a SQL literal."""
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _build_where_clause(filters) -> str:
    """Build a SQL WHERE clause from a list of {field, operator, value} dicts."""
    if not filters:
        return ''
    parts = []
    for f in (filters or []):
        field = f.get('field', '')
        op = (f.get('operator') or 'eq').lower()
        value = f.get('value')
        if not field:
            continue
        qf = f'"{field}"'
        if op == 'eq':
            parts.append(f'{qf} = {_sql_literal(value)}')
        elif op == 'neq':
            parts.append(f'{qf} != {_sql_literal(value)}')
        elif op == 'gt':
            parts.append(f'{qf} > {_sql_literal(value)}')
        elif op == 'gte':
            parts.append(f'{qf} >= {_sql_literal(value)}')
        elif op == 'lt':
            parts.append(f'{qf} < {_sql_literal(value)}')
        elif op == 'lte':
            parts.append(f'{qf} <= {_sql_literal(value)}')
        elif op == 'between' and isinstance(value, list) and len(value) >= 2:
            lo, hi = value[0], value[1]
            if lo and hi:
                parts.append(f'{qf} BETWEEN {_sql_literal(lo)} AND {_sql_literal(hi)}')
            elif lo:
                parts.append(f'{qf} >= {_sql_literal(lo)}')
            elif hi:
                parts.append(f'{qf} <= {_sql_literal(hi)}')
        elif op == 'in' and isinstance(value, list):
            vals = ', '.join(_sql_literal(v) for v in value)
            parts.append(f'{qf} IN ({vals})')
        elif op == 'in' and isinstance(value, str) and value:
            # Legacy comma-separated string format
            vals = ', '.join(_sql_literal(v.strip()) for v in value.split(',') if v.strip())
            if vals:
                parts.append(f'{qf} IN ({vals})')
        elif op == 'not_in' and isinstance(value, list):
            vals = ', '.join(_sql_literal(v) for v in value)
            parts.append(f'{qf} NOT IN ({vals})')
        elif op == 'not_in' and isinstance(value, str) and value:
            vals = ', '.join(_sql_literal(v.strip()) for v in value.split(',') if v.strip())
            if vals:
                parts.append(f'{qf} NOT IN ({vals})')
        elif op == 'contains' and value is not None:
            esc = str(value).replace("'", "''")
            parts.append(f"{qf} LIKE '%{esc}%'")
        elif op == 'starts_with' and value is not None:
            esc = str(value).replace("'", "''")
            parts.append(f"{qf} LIKE '{esc}%'")
        elif op == 'not_contains' and value is not None:
            esc = str(value).replace("'", "''")
            parts.append(f"{qf} NOT LIKE '%{esc}%'")
        elif op == 'is_null':
            parts.append(f'{qf} IS NULL')
        elif op == 'is_not_null':
            parts.append(f'{qf} IS NOT NULL')
    return ' AND '.join(parts)


def _apply_transformations(view_name: str, transformations) -> str:
    """
    Wrap a DuckDB view name in a CTE that applies server-side transformations
    (add_column, select_columns, rename_columns).  js_formula columns are
    evaluated client-side and are skipped here.

    Returns either the original view_name (no-op) or a subquery string suitable
    for use as a FROM clause, e.g. '(WITH base AS (...) SELECT ...) AS _t'.
    """
    server_transforms = [
        t for t in (transformations or [])
        if t.get('enabled', True) and t.get('type') not in ('js_formula',)
    ]
    if not server_transforms:
        return view_name

    from app.services.transformation_compiler import TransformationCompiler
    compiled_sql, _ = TransformationCompiler.compile_transformations(
        f'SELECT * FROM {view_name}', server_transforms, dialect='duckdb'
    )
    return f'({compiled_sql}) AS _t'


def _build_agg_query(base_table: str, chart_type: str, role_config: dict, filters: list):
    """
    Build a DuckDB GROUP BY query from chart roleConfig.

    Returns (sql, pre_aggregated):
      pre_aggregated=True  → backend handled aggregation; frontend must skip applyGroupByAgg()
      pre_aggregated=False → fallback SELECT *, frontend does its own aggregation
    """
    if not role_config:
        return f'SELECT * FROM {base_table} LIMIT 1000', False

    ctype = str(getattr(chart_type, 'value', chart_type) or '').upper()
    dimension = role_config.get('dimension')
    time_field = role_config.get('timeField')
    metrics = role_config.get('metrics') or []
    breakdown = role_config.get('breakdown')
    selected_cols = role_config.get('selectedColumns')

    where_clause = _build_where_clause(filters)
    where_sql = f' WHERE {where_clause}' if where_clause else ''

    # TABLE: optional column selection, capped at 500 rows for HTTP delivery.
    # UI shows at most 50-200 rows; 500 gives headroom without sending MBs of JSON.
    if ctype == 'TABLE':
        cols = ', '.join(f'"{c}"' for c in selected_cols) if selected_cols else '*'
        return f'SELECT {cols} FROM {base_table}{where_sql} LIMIT 500', True

    # SCATTER: raw points up to 5 000
    if ctype == 'SCATTER':
        sx, sy = role_config.get('scatterX'), role_config.get('scatterY')
        if sx and sy:
            return f'SELECT "{sx}", "{sy}" FROM {base_table}{where_sql} LIMIT 5000', True
        return f'SELECT * FROM {base_table}{where_sql} LIMIT 5000', True

    # All other chart types: GROUP BY aggregation
    group_field = dimension or time_field
    if not metrics:
        return f'SELECT * FROM {base_table}{where_sql} LIMIT 1000', False

    select_parts = []
    group_by_parts = []

    if group_field:
        select_parts.append(f'"{group_field}"')
        group_by_parts.append(f'"{group_field}"')
    if breakdown:
        select_parts.append(f'"{breakdown}"')
        group_by_parts.append(f'"{breakdown}"')

    for m in metrics:
        field = m.get('field', '')
        agg = (m.get('agg') or 'sum').upper().replace(' ', '_')
        if not field:
            continue
        if agg == 'COUNT_DISTINCT':
            select_parts.append(f'COUNT(DISTINCT "{field}") AS "count_distinct__{field}"')
        elif agg == 'COUNT':
            select_parts.append(f'COUNT("{field}") AS "count__{field}"')
        elif agg == 'AVG':
            select_parts.append(f'AVG("{field}") AS "avg__{field}"')
        elif agg == 'MIN':
            select_parts.append(f'MIN("{field}") AS "min__{field}"')
        elif agg == 'MAX':
            select_parts.append(f'MAX("{field}") AS "max__{field}"')
        else:  # SUM (default)
            select_parts.append(f'SUM("{field}") AS "sum__{field}"')

    if not select_parts:
        return f'SELECT * FROM {base_table}{where_sql} LIMIT 1000', False

    sql = f"SELECT {', '.join(select_parts)} FROM {base_table}{where_sql}"
    if group_by_parts:
        sql += f" GROUP BY {', '.join(group_by_parts)}"

    # BI best practice: ORDER BY the first metric DESC so the chart shows
    # the most significant groups first, and cap at 10 000 groups to avoid
    # sending millions of rows when a high-cardinality column is used as
    # the dimension (e.g. customer_id with 10M unique values).
    first_metric_alias = None
    for m in metrics:
        field = m.get('field', '')
        agg = (m.get('agg') or 'sum').upper().replace(' ', '_')
        if not field:
            continue
        if agg == 'COUNT_DISTINCT':
            first_metric_alias = f'"count_distinct__{field}"'
        elif agg == 'COUNT':
            first_metric_alias = f'"count__{field}"'
        elif agg == 'AVG':
            first_metric_alias = f'"avg__{field}"'
        elif agg == 'MIN':
            first_metric_alias = f'"min__{field}"'
        elif agg == 'MAX':
            first_metric_alias = f'"max__{field}"'
        else:
            first_metric_alias = f'"sum__{field}"'
        break

    if first_metric_alias and group_by_parts:
        sql += f" ORDER BY {first_metric_alias} DESC"
    sql += " LIMIT 10000"
    return sql, True


class ChartService:
    """Service for chart operations."""
    
    @staticmethod
    def get_all(db: Session, skip: int = 0, limit: int = 50) -> List[Chart]:
        """Get all charts with pagination."""
        return db.query(Chart).offset(skip).limit(limit).all()
    
    @staticmethod
    def get_by_id(db: Session, chart_id: int) -> Optional[Chart]:
        """Get a chart by ID."""
        return db.query(Chart).filter(Chart.id == chart_id).first()
    
    @staticmethod
    def get_by_name(db: Session, name: str) -> Optional[Chart]:
        """Get a chart by name."""
        return db.query(Chart).filter(Chart.name == name).first()
    
    @staticmethod
    def create(db: Session, chart: ChartCreate, owner_id=None) -> Chart:
        """Create a new chart."""
        if chart.workspace_table_id is not None:
            # Verify workspace table exists
            from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService
            table = DatasetWorkspaceCRUDService.get_table_by_id(db, chart.workspace_table_id)
            if not table:
                raise ValueError(f"Workspace table with ID {chart.workspace_table_id} not found")

        try:
            db_chart = Chart(
                name=chart.name,
                description=chart.description,
                workspace_table_id=chart.workspace_table_id,
                chart_type=ChartType(chart.chart_type.value),
                config=chart.config,
                owner_id=owner_id,
            )
            db.add(db_chart)
            db.commit()
            db.refresh(db_chart)
            logger.info(f"Created chart: {chart.name}")
            return db_chart
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Chart with name '{chart.name}' already exists")
    
    @staticmethod
    def update(
        db: Session,
        chart_id: int,
        chart_update: ChartUpdate
    ) -> Optional[Chart]:
        """Update a chart."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            return None
        
        try:
            update_data = chart_update.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                if field == "chart_type" and value:
                    setattr(db_chart, field, ChartType(value.value))
                else:
                    setattr(db_chart, field, value)
            
            db.commit()
            db.refresh(db_chart)
            logger.info(f"Updated chart: {db_chart.name}")
            return db_chart
        except IntegrityError:
            db.rollback()
            raise ValueError(f"Chart with name '{chart_update.name}' already exists")
    
    @staticmethod
    def delete(db: Session, chart_id: int) -> bool:
        """Delete a chart."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            return False
        
        db.delete(db_chart)
        db.commit()
        logger.info(f"Deleted chart: {db_chart.name}")
        return True
    
    @staticmethod
    def get_chart_data(db: Session, chart_id: int, extra_filters: list | None = None):
        """Get chart configuration with data."""
        db_chart = ChartService.get_by_id(db, chart_id)
        if not db_chart:
            raise ValueError(f"Chart with ID {chart_id} not found")

        # Prefer direct workspace_table_id FK over config-embedded source
        if db_chart.workspace_table_id is not None:
            from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService
            from app.services.datasource_service import DataSourceConnectionService
            from app.models.models import DataSource

            db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, db_chart.workspace_table_id)
            if not db_table:
                raise ValueError("Workspace table not found")

            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise ValueError("Data source not found")

            role_config = (db_chart.config or {}).get('roleConfig', {})
            filters = (db_chart.config or {}).get('filters', [])

            # ── LIVE mode: query source directly with aggregation ──
            query_mode = getattr(db_table, 'query_mode', 'synced') or 'synced'
            if query_mode == 'live':
                from app.services.live_query_service import LiveQueryService
                result = LiveQueryService.execute_chart_query(
                    datasource, db_table, db_chart.chart_type,
                    role_config, filters, extra_filters=extra_filters,
                )
                return {
                    "chart": db_chart,
                    "data": result["data"],
                    "pre_aggregated": result["pre_aggregated"],
                }

            # ── SYNCED mode: use DuckDB local cache ──
            from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
            from app.services.duckdb_engine import DuckDBEngine

            # Merge extra_filters from dashboard into stored filters
            all_filters = list(filters or [])
            if extra_filters:
                all_filters.extend(extra_filters)

            if db_table.source_kind == "sql_query":
                if not db_table.source_query:
                    raise ValueError("Table has no SQL query")
                # Try DuckDB synced cache first
                rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query)
                if rewritten:
                    try:
                        base_table = f"({rewritten}) AS _q"
                        agg_sql, pre_agg = _build_agg_query(base_table, db_chart.chart_type, role_config, all_filters)
                        rows = DuckDBEngine.query(agg_sql)
                        return {"chart": db_chart, "data": rows, "pre_aggregated": pre_agg}
                    except Exception:
                        pass  # fall through to live query
                # Live fallback: execute SQL directly against the datasource
                _, rows, _ = DataSourceConnectionService.execute_query(
                    datasource.type, datasource.config, db_table.source_query, limit=1000
                )
                return {"chart": db_chart, "data": rows, "pre_aggregated": False}
            elif db_table.source_kind == "physical_table":
                if not db_table.source_table_name:
                    raise ValueError("Table has no physical table name")
                # Use DuckDB synced cache if available — avoids live source round-trip
                view_name = get_synced_view(datasource.id, db_table.source_table_name)
                if view_name:
                    base_table = _apply_transformations(view_name, db_table.transformations)
                    agg_sql, pre_agg = _build_agg_query(base_table, db_chart.chart_type, role_config, all_filters)
                    rows = DuckDBEngine.query(agg_sql)
                    return {"chart": db_chart, "data": rows, "pre_aggregated": pre_agg}
                # Live fallback: use fetch_table_data so table names with spaces work
                stn = db_table.source_table_name.strip().strip('"').strip("'")
                if "." in stn:
                    _schema, _table = stn.split(".", 1)
                    _schema = _schema.strip('"').strip("'")
                    _table = _table.strip('"').strip("'")
                else:
                    _schema, _table = "default", stn
                _, rows = DataSourceConnectionService.fetch_table_data(
                    datasource.type, datasource.config, _schema, _table, limit=1000
                )
                return {"chart": db_chart, "data": rows, "pre_aggregated": False}
            else:
                raise ValueError(f"Unsupported source_kind: {db_table.source_kind}")

        # Fallback: check config for legacy workspace_table source
        config = db_chart.config or {}
        if isinstance(config, dict) and config.get('source', {}).get('kind') == 'workspace_table':
            from app.services.dataset_workspace_crud import DatasetWorkspaceCRUDService
            from app.services.datasource_service import DataSourceConnectionService
            from app.models.models import DataSource

            workspace_id = config['source'].get('workspaceId')
            table_id = config['source'].get('tableId')

            if not workspace_id or not table_id:
                raise ValueError("Invalid workspace table source in chart config")

            db_table = DatasetWorkspaceCRUDService.get_table_by_id(db, table_id)
            if not db_table or db_table.workspace_id != workspace_id:
                raise ValueError("Table not found in workspace")

            datasource = db.query(DataSource).filter(DataSource.id == db_table.datasource_id).first()
            if not datasource:
                raise ValueError("Data source not found")

            role_config = (db_chart.config or {}).get('roleConfig', {})
            filters = (db_chart.config or {}).get('filters', [])

            # ── LIVE mode: query source directly with aggregation ──
            query_mode = getattr(db_table, 'query_mode', 'synced') or 'synced'
            if query_mode == 'live':
                from app.services.live_query_service import LiveQueryService
                result = LiveQueryService.execute_chart_query(
                    datasource, db_table, db_chart.chart_type,
                    role_config, filters, extra_filters=extra_filters,
                )
                return {
                    "chart": db_chart,
                    "data": result["data"],
                    "pre_aggregated": result["pre_aggregated"],
                }

            # ── SYNCED mode: use DuckDB local cache ──
            from app.services.sync_engine import get_synced_view, rewrite_sql_for_duckdb
            from app.services.duckdb_engine import DuckDBEngine

            all_filters = list(filters or [])
            if extra_filters:
                all_filters.extend(extra_filters)

            if db_table.source_kind == "sql_query":
                if not db_table.source_query:
                    raise ValueError("Table has no SQL query")
                # Try DuckDB synced cache first
                rewritten = rewrite_sql_for_duckdb(datasource.id, db_table.source_query)
                if rewritten:
                    try:
                        base_table = f"({rewritten}) AS _q"
                        agg_sql, pre_agg = _build_agg_query(base_table, db_chart.chart_type, role_config, all_filters)
                        rows = DuckDBEngine.query(agg_sql)
                        return {"chart": db_chart, "data": rows, "pre_aggregated": pre_agg}
                    except Exception:
                        pass  # fall through to live query
                # Live fallback: execute SQL directly against the datasource
                _, rows, _ = DataSourceConnectionService.execute_query(
                    datasource.type, datasource.config, db_table.source_query, limit=1000
                )
                return {"chart": db_chart, "data": rows, "pre_aggregated": False}
            elif db_table.source_kind == "physical_table":
                if not db_table.source_table_name:
                    raise ValueError("Table has no physical table")
                # Use DuckDB synced cache if available — avoids live source round-trip
                view_name = get_synced_view(datasource.id, db_table.source_table_name)
                if view_name:
                    base_table = _apply_transformations(view_name, db_table.transformations)
                    agg_sql, pre_agg = _build_agg_query(base_table, db_chart.chart_type, role_config, all_filters)
                    rows = DuckDBEngine.query(agg_sql)
                    return {"chart": db_chart, "data": rows, "pre_aggregated": pre_agg}
                # Live fallback: use fetch_table_data so table names with spaces work
                stn = db_table.source_table_name.strip().strip('"').strip("'")
                if "." in stn:
                    _schema, _table = stn.split(".", 1)
                    _schema = _schema.strip('"').strip("'")
                    _table = _table.strip('"').strip("'")
                else:
                    _schema, _table = "default", stn
                _, rows = DataSourceConnectionService.fetch_table_data(
                    datasource.type, datasource.config, _schema, _table, limit=1000
                )
                return {"chart": db_chart, "data": rows, "pre_aggregated": False}
            else:
                raise ValueError(f"Unsupported source_kind: {db_table.source_kind}")

        raise ValueError("Chart has no data source configured")

    # -----------------------------------------------------------------------
    # Metadata CRUD
    # -----------------------------------------------------------------------

    @staticmethod
    def upsert_metadata(db: Session, chart_id: int, data: ChartMetadataUpsert) -> ChartMetadata:
        """Create or replace semantic metadata for a chart."""
        existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if existing:
            for field, value in data.model_dump(exclude_unset=False).items():
                setattr(existing, field, value)
            db.commit()
            db.refresh(existing)
            return existing
        new_meta = ChartMetadata(
            chart_id=chart_id,
            domain=data.domain,
            intent=data.intent,
            metrics=data.metrics or [],
            dimensions=data.dimensions or [],
            tags=data.tags or [],
        )
        db.add(new_meta)
        db.commit()
        db.refresh(new_meta)
        return new_meta

    @staticmethod
    def get_metadata(db: Session, chart_id: int) -> Optional[ChartMetadata]:
        """Get metadata for a chart."""
        return db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()

    @staticmethod
    def delete_metadata(db: Session, chart_id: int) -> bool:
        """Delete metadata for a chart."""
        existing = db.query(ChartMetadata).filter(ChartMetadata.chart_id == chart_id).first()
        if not existing:
            return False
        db.delete(existing)
        db.commit()
        return True

    # -----------------------------------------------------------------------
    # Parameter CRUD
    # -----------------------------------------------------------------------

    @staticmethod
    def get_parameters(db: Session, chart_id: int) -> List[ChartParameter]:
        """Get all parameter definitions for a chart."""
        return db.query(ChartParameter).filter(ChartParameter.chart_id == chart_id).all()

    @staticmethod
    def replace_parameters(db: Session, chart_id: int, params: List[ChartParameterCreate]) -> List[ChartParameter]:
        """Replace all parameter definitions for a chart (bulk upsert)."""
        db.query(ChartParameter).filter(ChartParameter.chart_id == chart_id).delete()
        new_params = [
            ChartParameter(
                chart_id=chart_id,
                parameter_name=p.parameter_name,
                parameter_type=p.parameter_type,
                column_mapping=p.column_mapping,
                default_value=p.default_value,
                description=p.description,
            )
            for p in params
        ]
        db.add_all(new_params)
        db.commit()
        for p in new_params:
            db.refresh(p)
        return new_params

    @staticmethod
    def add_parameter(db: Session, chart_id: int, data: ChartParameterCreate) -> ChartParameter:
        """Add a single parameter definition to a chart."""
        param = ChartParameter(
            chart_id=chart_id,
            parameter_name=data.parameter_name,
            parameter_type=data.parameter_type,
            column_mapping=data.column_mapping,
            default_value=data.default_value,
            description=data.description,
        )
        db.add(param)
        db.commit()
        db.refresh(param)
        return param

    @staticmethod
    def update_parameter(
        db: Session, chart_id: int, param_id: int, data: ChartParameterUpdate
    ) -> Optional[ChartParameter]:
        """Update a parameter definition."""
        param = db.query(ChartParameter).filter(
            ChartParameter.id == param_id,
            ChartParameter.chart_id == chart_id,
        ).first()
        if not param:
            return None
        for field, value in data.model_dump(exclude_unset=True).items():
            setattr(param, field, value)
        db.commit()
        db.refresh(param)
        return param

    @staticmethod
    def delete_parameter(db: Session, chart_id: int, param_id: int) -> bool:
        """Delete a parameter definition."""
        param = db.query(ChartParameter).filter(
            ChartParameter.id == param_id,
            ChartParameter.chart_id == chart_id,
        ).first()
        if not param:
            return False
        db.delete(param)
        db.commit()
        return True
