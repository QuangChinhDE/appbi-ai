"""
Semantic Query Engine v2
Advanced SQL generation with pivots, window functions, calculated fields, and more
"""
from typing import List, Tuple, Dict, Any, Optional
from sqlalchemy.orm import Session
from app.models.semantic import SemanticView, SemanticExplore
from app.schemas.semantic import (
    WindowFunctionDefinition,
    CalculatedFieldDefinition,
    SortDefinition,
    TopNDefinition,
    PivotedColumn
)
import re


class SemanticQueryEngineV2:
    """
    Advanced SQL generation engine for semantic queries
    Supports: pivots, window functions, calculated fields, time grains, top N
    """
    
    def __init__(self, db: Session, database_type: str = "postgresql"):
        self.db = db
        self.database_type = database_type.lower()
        self.views_cache: Dict[str, SemanticView] = {}
        self.warnings: List[str] = []
    
    def generate_sql(
        self,
        explore_name: str,
        dimensions: List[str],
        measures: List[str],
        filters: Dict[str, Any],
        pivots: List[str] = None,
        sorts: List[Dict[str, str]] = None,
        limit: int = 500,
        window_functions: List[Dict[str, Any]] = None,
        calculated_fields: List[Dict[str, Any]] = None,
        time_grains: Dict[str, str] = None,
        top_n: Optional[Dict[str, Any]] = None
    ) -> Tuple[str, List[str], List[PivotedColumn]]:
        """
        Generate SQL from semantic query definition (v2)
        
        Returns:
            Tuple of (sql, columns, pivoted_columns)
        """
        self.warnings = []
        pivots = pivots or []
        sorts = sorts or []
        window_functions = window_functions or []
        calculated_fields = calculated_fields or []
        time_grains = time_grains or {}
        
        # Validate pivot limitation (only 1 pivot supported in v2)
        if len(pivots) > 1:
            raise ValueError("Only one pivot dimension is supported in v2")
        
        # Load explore definition
        explore = self.db.query(SemanticExplore).filter(
            SemanticExplore.name == explore_name
        ).first()
        
        if not explore:
            raise ValueError(f"Explore '{explore_name}' not found")
        
        # Load all referenced views
        self._load_views(dimensions + measures + pivots)
        
        # Fetch pivot values if pivoting
        pivot_values = []
        pivot_metadata = []
        if pivots:
            pivot_dim = pivots[0]
            pivot_values = self._fetch_pivot_values(explore, pivot_dim, filters)
            if not pivot_values:
                self.warnings.append(f"No distinct values found for pivot dimension: {pivot_dim}")
        
        # Build SELECT clause
        select_parts, column_names = self._build_select_clause(
            dimensions, measures, pivots, pivot_values, 
            window_functions, calculated_fields, time_grains
        )
        
        # Build pivot metadata
        if pivots and pivot_values:
            for measure_name in measures:
                for pval in pivot_values:
                    pivot_metadata.append(PivotedColumn(
                        base_field=pivots[0],
                        value=str(pval),
                        alias=self._pivot_column_alias(measure_name, pval)
                    ))
        
        # Build FROM/JOIN clause
        from_clause = self._build_from_clause(explore)
        
        # Build WHERE clause
        where_clause = self._build_where_clause(filters, time_grains)
        
        # Build GROUP BY clause
        group_by_clause = self._build_group_by_clause(dimensions, measures, pivots, time_grains)
        
        # Build ORDER BY clause
        order_by_clause = self._build_order_by_clause(sorts, measures, top_n)
        
        # Build LIMIT clause
        limit_clause = f"LIMIT {limit}" if limit else ""
        
        # Assemble SQL
        sql_parts = [
            "SELECT",
            "  " + ",\n  ".join(select_parts),
            from_clause,
        ]
        
        if where_clause:
            sql_parts.append(where_clause)
        
        if group_by_clause:
            sql_parts.append(group_by_clause)
        
        if order_by_clause:
            sql_parts.append(order_by_clause)
        
        if limit_clause:
            sql_parts.append(limit_clause)
        
        sql = "\n".join(sql_parts)
        
        return sql, column_names, pivot_metadata
    
    def _load_views(self, field_refs: List[str]):
        """Load all views referenced in field names"""
        view_names = set()
        for field_ref in field_refs:
            if '.' in field_ref:
                view_name, _ = self._parse_field_ref(field_ref)
                view_names.add(view_name)
        
        for view_name in view_names:
            if view_name not in self.views_cache:
                view = self.db.query(SemanticView).filter(
                    SemanticView.name == view_name
                ).first()
                if not view:
                    raise ValueError(f"View '{view_name}' not found")
                self.views_cache[view_name] = view
    
    def _fetch_pivot_values(
        self, 
        explore: SemanticExplore, 
        pivot_field: str,
        filters: Dict[str, Any]
    ) -> List[str]:
        """Fetch distinct values for pivot dimension"""
        # Build a simple query to get distinct values
        view_name, field_name = self._parse_field_ref(pivot_field)
        view = self.views_cache.get(view_name)
        if not view:
            return []
        
        # Find dimension definition
        dim_def = next((d for d in view.dimensions if d['name'] == field_name), None)
        if not dim_def:
            return []
        
        # Render dimension SQL
        dim_sql = self._render_dimension(pivot_field, view_name)
        
        # Build simple query
        from_clause = self._build_from_clause(explore)
        where_clause = self._build_where_clause(filters, {})
        
        query = f"SELECT DISTINCT {dim_sql} AS pval {from_clause}"
        if where_clause:
            query += f" {where_clause}"
        query += " ORDER BY pval LIMIT 100"  # Limit pivot values
        
        # Execute query to get values
        try:
            result = self.db.execute(query)
            return [str(row[0]) for row in result if row[0] is not None]
        except Exception as e:
            self.warnings.append(f"Failed to fetch pivot values: {str(e)}")
            return []
    
    def _build_select_clause(
        self,
        dimensions: List[str],
        measures: List[str],
        pivots: List[str],
        pivot_values: List[str],
        window_functions: List[Dict[str, Any]],
        calculated_fields: List[Dict[str, Any]],
        time_grains: Dict[str, str]
    ) -> Tuple[List[str], List[str]]:
        """Build SELECT clause with all features"""
        select_parts = []
        column_names = []
        
        # Non-pivoted dimensions
        non_pivot_dims = [d for d in dimensions if d not in pivots]
        
        for dim_field in non_pivot_dims:
            view_name, field_name = self._parse_field_ref(dim_field)
            
            # Apply time grain if specified
            if dim_field in time_grains:
                dim_sql = self._render_dimension_with_time_grain(
                    dim_field, view_name, time_grains[dim_field]
                )
            else:
                dim_sql = self._render_dimension(dim_field, view_name)
            
            alias = self._safe_alias(dim_field)
            select_parts.append(f"{dim_sql} AS {alias}")
            column_names.append(alias)
        
        # Measures (with or without pivots)
        if pivots and pivot_values:
            # Pivoted measures
            for measure_field in measures:
                for pval in pivot_values:
                    pivot_sql = self._render_pivoted_measure(
                        measure_field, pivots[0], pval
                    )
                    alias = self._pivot_column_alias(measure_field, pval)
                    select_parts.append(f"{pivot_sql} AS {alias}")
                    column_names.append(alias)
        else:
            # Regular measures
            for measure_field in measures:
                measure_sql = self._render_measure(measure_field)
                alias = self._safe_alias(measure_field)
                select_parts.append(f"{measure_sql} AS {alias}")
                column_names.append(alias)
        
        # Window functions
        for wf in window_functions:
            wf_sql = self._render_window_function(wf)
            alias = self._safe_alias(wf['name'])
            select_parts.append(f"{wf_sql} AS {alias}")
            column_names.append(alias)
        
        # Calculated fields
        for cf in calculated_fields:
            cf_sql = self._render_calculated_field(cf, dimensions, measures)
            alias = self._safe_alias(cf['name'])
            select_parts.append(f"{cf_sql} AS {alias}")
            column_names.append(alias)
        
        return select_parts, column_names
    
    def _render_dimension(self, field_ref: str, view_alias: str) -> str:
        """Render dimension SQL"""
        view_name, field_name = self._parse_field_ref(field_ref)
        view = self.views_cache.get(view_name)
        
        if not view:
            raise ValueError(f"View '{view_name}' not found")
        
        dim_def = next((d for d in view.dimensions if d['name'] == field_name), None)
        if not dim_def:
            raise ValueError(f"Dimension '{field_name}' not found in view '{view_name}'")
        
        sql_template = dim_def.get('sql') or f"${{TABLE}}.{field_name}"
        return self._render_sql_template(sql_template, view_alias)
    
    def _render_dimension_with_time_grain(
        self, 
        field_ref: str, 
        view_alias: str, 
        grain: str
    ) -> str:
        """Render dimension with time grain applied"""
        base_sql = self._render_dimension(field_ref, view_alias)
        
        if self.database_type == "bigquery":
            grain_map = {
                "day": "DAY",
                "week": "WEEK",
                "month": "MONTH",
                "quarter": "QUARTER",
                "year": "YEAR"
            }
            return f"TIMESTAMP_TRUNC({base_sql}, {grain_map.get(grain, 'DAY')})"
        else:  # PostgreSQL
            return f"DATE_TRUNC('{grain}', {base_sql})"
    
    def _render_measure(self, field_ref: str) -> str:
        """Render measure SQL with aggregation"""
        view_name, field_name = self._parse_field_ref(field_ref)
        view = self.views_cache.get(view_name)
        
        if not view:
            raise ValueError(f"View '{view_name}' not found")
        
        measure_def = next((m for m in view.measures if m['name'] == field_name), None)
        if not measure_def:
            raise ValueError(f"Measure '{field_name}' not found in view '{view_name}'")
        
        measure_type = measure_def.get('type', 'count')
        sql_template = measure_def.get('sql', '*')
        base_sql = self._render_sql_template(sql_template, view_name)
        
        if measure_type == "count":
            return f"COUNT({base_sql})"
        elif measure_type == "sum":
            return f"SUM({base_sql})"
        elif measure_type == "avg":
            return f"AVG({base_sql})"
        elif measure_type == "min":
            return f"MIN({base_sql})"
        elif measure_type == "max":
            return f"MAX({base_sql})"
        elif measure_type == "count_distinct":
            return f"COUNT(DISTINCT {base_sql})"
        elif measure_type == "percent_of_total":
            # Percentage of total using window function
            return f"SUM({base_sql}) / SUM(SUM({base_sql})) OVER () * 100"
        else:
            return f"SUM({base_sql})"  # Default fallback
    
    def _render_pivoted_measure(
        self, 
        measure_field: str, 
        pivot_field: str, 
        pivot_value: str
    ) -> str:
        """Render measure with CASE for pivot"""
        view_name, field_name = self._parse_field_ref(measure_field)
        view = self.views_cache.get(view_name)
        
        measure_def = next((m for m in view.measures if m['name'] == field_name), None)
        if not measure_def:
            raise ValueError(f"Measure '{field_name}' not found")
        
        measure_type = measure_def.get('type', 'sum')
        sql_template = measure_def.get('sql', '*')
        base_sql = self._render_sql_template(sql_template, view_name)
        
        # Get pivot dimension SQL
        pivot_view_name, pivot_field_name = self._parse_field_ref(pivot_field)
        pivot_sql = self._render_dimension(pivot_field, pivot_view_name)
        
        # Build CASE expression
        if measure_type in ["sum", "avg"]:
            # SUM/AVG: CASE WHEN pivot = value THEN base_sql ELSE 0 END wrapped in SUM/AVG
            agg_func = measure_type.upper()
            case_expr = f"CASE WHEN {pivot_sql} = '{pivot_value}' THEN {base_sql} ELSE 0 END"
            return f"{agg_func}({case_expr})"
        elif measure_type == "count":
            # COUNT: CASE WHEN pivot = value THEN 1 ELSE 0 END wrapped in SUM
            case_expr = f"CASE WHEN {pivot_sql} = '{pivot_value}' THEN 1 ELSE 0 END"
            return f"SUM({case_expr})"
        elif measure_type == "count_distinct":
            # COUNT DISTINCT with pivot: not straightforward, use CASE
            case_expr = f"CASE WHEN {pivot_sql} = '{pivot_value}' THEN {base_sql} ELSE NULL END"
            return f"COUNT(DISTINCT {case_expr})"
        else:
            # Default: SUM with CASE
            case_expr = f"CASE WHEN {pivot_sql} = '{pivot_value}' THEN {base_sql} ELSE 0 END"
            return f"SUM({case_expr})"
    
    def _render_window_function(self, wf_def: Dict[str, Any]) -> str:
        """Render window function SQL"""
        wf_type = wf_def['type']
        base_measure = wf_def.get('base_measure')
        partition_by = wf_def.get('partition_by', [])
        order_by = wf_def.get('order_by', [])
        
        # Build OVER clause
        over_parts = []
        
        if partition_by:
            partition_exprs = [
                self._render_dimension(dim, self._parse_field_ref(dim)[0])
                for dim in partition_by
            ]
            over_parts.append(f"PARTITION BY {', '.join(partition_exprs)}")
        
        if order_by:
            order_exprs = [
                self._render_dimension(dim, self._parse_field_ref(dim)[0])
                for dim in order_by
            ]
            over_parts.append(f"ORDER BY {', '.join(order_exprs)}")
        
        over_clause = " ".join(over_parts) if over_parts else ""
        
        # Build window function
        if wf_type == "running_sum":
            if not base_measure:
                raise ValueError("running_sum requires base_measure")
            measure_sql = self._render_measure(base_measure)
            frame = "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" if order_by else ""
            return f"SUM({measure_sql}) OVER ({over_clause} {frame})"
        
        elif wf_type == "running_avg":
            if not base_measure:
                raise ValueError("running_avg requires base_measure")
            measure_sql = self._render_measure(base_measure)
            frame = "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW" if order_by else ""
            return f"AVG({measure_sql}) OVER ({over_clause} {frame})"
        
        elif wf_type == "rank":
            return f"RANK() OVER ({over_clause})"
        
        elif wf_type == "dense_rank":
            return f"DENSE_RANK() OVER ({over_clause})"
        
        elif wf_type == "row_number":
            return f"ROW_NUMBER() OVER ({over_clause})"
        
        else:
            raise ValueError(f"Unsupported window function type: {wf_type}")
    
    def _render_calculated_field(
        self, 
        cf_def: Dict[str, Any],
        dimensions: List[str],
        measures: List[str]
    ) -> str:
        """Render calculated field with ${field} substitution"""
        sql_template = cf_def['sql']
        
        # Validate safety
        self._validate_calculated_field_safety(sql_template)
        
        # Find all ${view.field} references
        pattern = r'\$\{([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\}'
        matches = re.findall(pattern, sql_template)
        
        # Replace each reference
        result = sql_template
        for field_ref in matches:
            # Check if it's a dimension or measure
            if field_ref in dimensions:
                view_name, _ = self._parse_field_ref(field_ref)
                replacement = self._render_dimension(field_ref, view_name)
            elif field_ref in measures:
                replacement = self._render_measure(field_ref)
            else:
                raise ValueError(f"Unknown field reference in calculated field: {field_ref}")
            
            result = result.replace(f"${{{field_ref}}}", replacement)
        
        return f"({result})"
    
    def _validate_calculated_field_safety(self, sql: str):
        """Validate calculated field SQL for safety"""
        sql_upper = sql.upper()
        dangerous_keywords = [
            'DROP', 'DELETE', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 
            'TRUNCATE', 'EXEC', 'EXECUTE', ';'
        ]
        
        for keyword in dangerous_keywords:
            if keyword in sql_upper:
                raise ValueError(f"Calculated field contains forbidden keyword: {keyword}")
    
    def _build_from_clause(self, explore: SemanticExplore) -> str:
        """Build FROM and JOIN clauses"""
        base_view = self.views_cache.get(explore.base_view_name)
        if not base_view:
            raise ValueError(f"Base view '{explore.base_view_name}' not found")
        
        # Determine base table name
        base_table = base_view.sql_table_name or explore.base_view_name
        from_clause = f"FROM {base_table} AS {explore.base_view_name}"
        
        # Add joins
        for join_def in explore.joins:
            join_type = join_def.get('type', 'left').upper()
            join_view_name = join_def['view']
            join_condition = join_def['sql_on']
            
            # Get joined view table name
            join_view = self.views_cache.get(join_view_name)
            if join_view:
                join_table = join_view.sql_table_name or join_view_name
            else:
                join_table = join_view_name
            
            # Render join condition (may have ${view.field} placeholders)
            join_condition_rendered = self._render_join_condition(join_condition)
            
            from_clause += f"\n{join_type} JOIN {join_table} AS {join_view_name} ON {join_condition_rendered}"
        
        return from_clause
    
    def _render_join_condition(self, condition: str) -> str:
        """Render join condition with field references"""
        # Replace ${view.field} with view.field
        pattern = r'\$\{([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\}'
        
        def replace_field(match):
            field_ref = match.group(1)
            view_name, field_name = self._parse_field_ref(field_ref)
            return f"{view_name}.{field_name}"
        
        return re.sub(pattern, replace_field, condition)
    
    def _build_where_clause(self, filters: Dict[str, Any], time_grains: Dict[str, str]) -> str:
        """Build WHERE clause from filters"""
        if not filters:
            return ""
        
        conditions = []
        for field_ref, filter_def in filters.items():
            operator = filter_def.get('operator', 'eq')
            value = filter_def.get('value')
            
            view_name, _ = self._parse_field_ref(field_ref)
            
            # Apply time grain if specified
            if field_ref in time_grains:
                field_sql = self._render_dimension_with_time_grain(
                    field_ref, view_name, time_grains[field_ref]
                )
            else:
                field_sql = self._render_dimension(field_ref, view_name)
            
            # Build condition based on operator
            if operator == "eq":
                conditions.append(f"{field_sql} = '{value}'")
            elif operator == "ne":
                conditions.append(f"{field_sql} != '{value}'")
            elif operator == "gt":
                conditions.append(f"{field_sql} > '{value}'")
            elif operator == "gte":
                conditions.append(f"{field_sql} >= '{value}'")
            elif operator == "lt":
                conditions.append(f"{field_sql} < '{value}'")
            elif operator == "lte":
                conditions.append(f"{field_sql} <= '{value}'")
            elif operator == "in":
                values_str = ", ".join([f"'{v}'" for v in value])
                conditions.append(f"{field_sql} IN ({values_str})")
            elif operator == "not_in":
                values_str = ", ".join([f"'{v}'" for v in value])
                conditions.append(f"{field_sql} NOT IN ({values_str})")
            elif operator == "contains":
                conditions.append(f"{field_sql} LIKE '%{value}%'")
            elif operator == "starts_with":
                conditions.append(f"{field_sql} LIKE '{value}%'")
            elif operator == "ends_with":
                conditions.append(f"{field_sql} LIKE '%{value}'")
        
        if conditions:
            return "WHERE\n  " + " AND\n  ".join(conditions)
        return ""
    
    def _build_group_by_clause(
        self, 
        dimensions: List[str], 
        measures: List[str],
        pivots: List[str],
        time_grains: Dict[str, str]
    ) -> str:
        """Build GROUP BY clause"""
        if not measures:
            return ""
        
        # Non-pivoted dimensions
        non_pivot_dims = [d for d in dimensions if d not in pivots]
        
        if not non_pivot_dims:
            return ""
        
        # Use positional GROUP BY
        group_by_positions = [str(i+1) for i in range(len(non_pivot_dims))]
        return f"GROUP BY {', '.join(group_by_positions)}"
    
    def _build_order_by_clause(
        self, 
        sorts: List[Dict[str, str]], 
        measures: List[str],
        top_n: Optional[Dict[str, Any]]
    ) -> str:
        """Build ORDER BY clause"""
        # If top_n specified, use it for ordering
        if top_n:
            field = top_n['field']
            alias = self._safe_alias(field)
            return f"ORDER BY {alias} DESC"
        
        # Use explicit sorts
        if sorts:
            order_parts = []
            for sort in sorts:
                field = sort.get('field')
                direction = sort.get('direction', 'asc').upper()
                alias = self._safe_alias(field)
                order_parts.append(f"{alias} {direction}")
            return "ORDER BY " + ", ".join(order_parts)
        
        # Default: order by first measure DESC
        if measures:
            first_measure = measures[0]
            alias = self._safe_alias(first_measure)
            return f"ORDER BY {alias} DESC"
        
        return ""
    
    def _parse_field_ref(self, field_ref: str) -> Tuple[str, str]:
        """Parse 'view.field' into (view_name, field_name)"""
        if '.' not in field_ref:
            raise ValueError(f"Invalid field reference: {field_ref} (must be view.field)")
        
        parts = field_ref.split('.', 1)
        return parts[0], parts[1]
    
    def _render_sql_template(self, template: str, view_alias: str) -> str:
        """Replace ${TABLE} with actual view alias"""
        return template.replace("${TABLE}", view_alias)
    
    def _safe_alias(self, field_ref: str) -> str:
        """Generate safe SQL alias from field reference"""
        return field_ref.replace('.', '_')
    
    def _pivot_column_alias(self, measure_field: str, pivot_value: str) -> str:
        """Generate alias for pivoted column"""
        safe_measure = self._safe_alias(measure_field)
        safe_value = re.sub(r'[^a-zA-Z0-9_]', '_', str(pivot_value))
        return f"{safe_measure}_{safe_value}"
