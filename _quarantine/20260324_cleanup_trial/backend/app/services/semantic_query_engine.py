"""
Semantic Query Engine
Generates SQL queries from semantic definitions (LookML-style)
"""
import re
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session
from app.models.semantic import SemanticView, SemanticExplore
from app.schemas.semantic import FilterCondition, DimensionDefinition, MeasureDefinition


class SemanticQueryEngine:
    """
    Core engine for generating SQL from semantic layer definitions
    Similar to how Looker compiles LookML to SQL
    """

    def __init__(self, db: Session):
        self.db = db

    def generate_sql(
        self,
        explore_name: str,
        dimensions: List[str],
        measures: List[str],
        filters: Dict[str, FilterCondition],
        sorts: Optional[List[Dict[str, str]]] = None,
        limit: int = 500
    ) -> Tuple[str, List[str]]:
        """
        Generate SQL query from semantic definitions
        
        Returns:
            (sql_query, column_names)
        """
        # Load explore
        explore = self.db.query(SemanticExplore).filter(
            SemanticExplore.name == explore_name
        ).first()
        
        if not explore:
            raise ValueError(f"Explore '{explore_name}' not found")

        # Load base view
        base_view = self.db.query(SemanticView).filter(
            SemanticView.id == explore.base_view_id
        ).first()
        
        if not base_view:
            raise ValueError(f"Base view not found for explore '{explore_name}'")

        # Parse field references and load views
        view_map = self._load_views(explore, base_view, dimensions, measures, filters)
        
        # Build SELECT clause
        select_parts = []
        column_names = []
        
        # Add dimensions
        for dim_ref in dimensions:
            sql_expr, col_name = self._render_dimension(dim_ref, view_map)
            select_parts.append(f"{sql_expr} AS {col_name}")
            column_names.append(col_name)
        
        # Add measures
        for measure_ref in measures:
            sql_expr, col_name = self._render_measure(measure_ref, view_map)
            select_parts.append(f"{sql_expr} AS {col_name}")
            column_names.append(col_name)
        
        if not select_parts:
            raise ValueError("Must select at least one dimension or measure")
        
        select_clause = "SELECT\n  " + ",\n  ".join(select_parts)
        
        # Build FROM clause
        from_clause = self._build_from_clause(base_view, explore)
        
        # Build WHERE clause
        where_clause = self._build_where_clause(filters, view_map)
        
        # Build GROUP BY clause (if measures are present)
        group_by_clause = ""
        if measures:
            group_by_clause = self._build_group_by_clause(len(dimensions))
        
        # Build ORDER BY clause
        order_by_clause = self._build_order_by_clause(sorts, dimensions, measures)
        
        # Build LIMIT clause
        limit_clause = f"LIMIT {limit}"
        
        # Assemble final query
        sql_parts = [select_clause, from_clause]
        if where_clause:
            sql_parts.append(where_clause)
        if group_by_clause:
            sql_parts.append(group_by_clause)
        if order_by_clause:
            sql_parts.append(order_by_clause)
        sql_parts.append(limit_clause)
        
        final_sql = "\n".join(sql_parts)
        
        return final_sql, column_names

    def _load_views(
        self,
        explore: SemanticExplore,
        base_view: SemanticView,
        dimensions: List[str],
        measures: List[str],
        filters: Dict[str, FilterCondition]
    ) -> Dict[str, SemanticView]:
        """Load all views referenced in query"""
        view_map = {base_view.name: base_view}
        
        # Extract view names from field references
        all_fields = dimensions + measures + list(filters.keys())
        referenced_views = set()
        
        for field in all_fields:
            if "." in field:
                view_name = field.split(".")[0]
                referenced_views.add(view_name)
        
        # Load additional views
        for view_name in referenced_views:
            if view_name not in view_map:
                view = self.db.query(SemanticView).filter(
                    SemanticView.name == view_name
                ).first()
                if view:
                    view_map[view_name] = view
        
        return view_map

    def _render_dimension(self, dim_ref: str, view_map: Dict[str, SemanticView]) -> Tuple[str, str]:
        """Render dimension SQL expression"""
        view_name, field_name = self._parse_field_ref(dim_ref)
        
        view = view_map.get(view_name)
        if not view:
            raise ValueError(f"View '{view_name}' not found")
        
        # Find dimension definition
        dim_def = None
        for dim in view.dimensions:
            if isinstance(dim, dict) and dim.get("name") == field_name:
                dim_def = dim
                break
        
        if not dim_def:
            raise ValueError(f"Dimension '{field_name}' not found in view '{view_name}'")
        
        # Render SQL
        if dim_def.get("sql"):
            sql_expr = self._render_sql_template(dim_def["sql"], view_name, view)
        else:
            sql_expr = f"{view_name}.{field_name}"
        
        col_name = f"{view_name}_{field_name}"
        
        return sql_expr, col_name

    def _render_measure(self, measure_ref: str, view_map: Dict[str, SemanticView]) -> Tuple[str, str]:
        """Render measure SQL expression"""
        view_name, field_name = self._parse_field_ref(measure_ref)
        
        view = view_map.get(view_name)
        if not view:
            raise ValueError(f"View '{view_name}' not found")
        
        # Find measure definition
        measure_def = None
        for measure in view.measures:
            if isinstance(measure, dict) and measure.get("name") == field_name:
                measure_def = measure
                break
        
        if not measure_def:
            raise ValueError(f"Measure '{field_name}' not found in view '{view_name}'")
        
        measure_type = measure_def.get("type", "count")
        
        # Render SQL based on measure type
        if measure_def.get("sql"):
            inner_sql = self._render_sql_template(measure_def["sql"], view_name, view)
        else:
            inner_sql = f"{view_name}.{field_name}"
        
        if measure_type == "count":
            sql_expr = "COUNT(*)"
        elif measure_type == "count_distinct":
            sql_expr = f"COUNT(DISTINCT {inner_sql})"
        elif measure_type == "sum":
            sql_expr = f"SUM({inner_sql})"
        elif measure_type == "avg":
            sql_expr = f"AVG({inner_sql})"
        elif measure_type == "min":
            sql_expr = f"MIN({inner_sql})"
        elif measure_type == "max":
            sql_expr = f"MAX({inner_sql})"
        else:
            sql_expr = f"COUNT(*)"
        
        col_name = f"{view_name}_{field_name}_{measure_type}"
        
        return sql_expr, col_name

    def _build_from_clause(self, base_view: SemanticView, explore: SemanticExplore) -> str:
        """Build FROM clause with joins"""
        # Base table
        if base_view.sql_table_name:
            from_clause = f"FROM {base_view.sql_table_name} AS {base_view.name}"
        elif base_view.dataset_id:
            # Use dataset as subquery (simplified - in production, execute dataset query)
            from_clause = f"FROM dataset_{base_view.dataset_id} AS {base_view.name}"
        else:
            raise ValueError(f"View '{base_view.name}' has no sql_table_name or dataset_id")
        
        # Add joins
        if explore.joins:
            for join in explore.joins:
                if isinstance(join, dict):
                    join_name = join.get("name")
                    join_view = join.get("view")
                    join_type = join.get("type", "left").upper()
                    sql_on = join.get("sql_on")
                    
                    # Load joined view to get table name
                    joined_view = self.db.query(SemanticView).filter(
                        SemanticView.name == join_view
                    ).first()
                    
                    if joined_view:
                        if joined_view.sql_table_name:
                            table_ref = joined_view.sql_table_name
                        else:
                            table_ref = f"dataset_{joined_view.dataset_id}"
                        
                        from_clause += f"\n{join_type} JOIN {table_ref} AS {join_view} ON {sql_on}"
        
        return from_clause

    def _build_where_clause(self, filters: Dict[str, FilterCondition], view_map: Dict[str, SemanticView]) -> str:
        """Build WHERE clause from filters"""
        if not filters:
            return ""
        
        conditions = []
        for field_ref, filter_cond in filters.items():
            view_name, field_name = self._parse_field_ref(field_ref)
            field_sql = f"{view_name}.{field_name}"
            
            operator = filter_cond.operator
            value = filter_cond.value
            
            if operator == "eq":
                if isinstance(value, str):
                    conditions.append(f"{field_sql} = '{value}'")
                else:
                    conditions.append(f"{field_sql} = {value}")
            elif operator == "ne":
                if isinstance(value, str):
                    conditions.append(f"{field_sql} != '{value}'")
                else:
                    conditions.append(f"{field_sql} != {value}")
            elif operator == "gt":
                conditions.append(f"{field_sql} > {value}")
            elif operator == "gte":
                conditions.append(f"{field_sql} >= {value}")
            elif operator == "lt":
                conditions.append(f"{field_sql} < {value}")
            elif operator == "lte":
                conditions.append(f"{field_sql} <= {value}")
            elif operator == "in":
                if isinstance(value, list):
                    values_str = ", ".join([f"'{v}'" if isinstance(v, str) else str(v) for v in value])
                    conditions.append(f"{field_sql} IN ({values_str})")
            elif operator == "contains":
                conditions.append(f"{field_sql} LIKE '%{value}%'")
            elif operator == "starts_with":
                conditions.append(f"{field_sql} LIKE '{value}%'")
            elif operator == "ends_with":
                conditions.append(f"{field_sql} LIKE '%{value}'")
        
        if conditions:
            return "WHERE\n  " + " AND\n  ".join(conditions)
        return ""

    def _build_group_by_clause(self, num_dimensions: int) -> str:
        """Build GROUP BY clause"""
        if num_dimensions == 0:
            return ""
        group_by_positions = ", ".join(str(i + 1) for i in range(num_dimensions))
        return f"GROUP BY {group_by_positions}"

    def _build_order_by_clause(self, sorts: Optional[List[Dict[str, str]]], dimensions: List[str], measures: List[str]) -> str:
        """Build ORDER BY clause"""
        if not sorts:
            # Default: order by first measure desc if present
            if measures:
                return f"ORDER BY {len(dimensions) + 1} DESC"
            return ""
        
        order_parts = []
        all_fields = dimensions + measures
        
        for sort in sorts:
            field = sort.get("field")
            direction = sort.get("direction", "asc").upper()
            
            if field in all_fields:
                position = all_fields.index(field) + 1
                order_parts.append(f"{position} {direction}")
        
        if order_parts:
            return "ORDER BY " + ", ".join(order_parts)
        return ""

    def _parse_field_ref(self, field_ref: str) -> Tuple[str, str]:
        """Parse field reference like 'orders.order_date' into (view_name, field_name)"""
        if "." not in field_ref:
            raise ValueError(f"Invalid field reference: '{field_ref}'. Must be in format 'view.field'")
        parts = field_ref.split(".", 1)
        return parts[0], parts[1]

    def _render_sql_template(self, sql_template: str, view_name: str, view: SemanticView) -> str:
        """Render SQL template, replacing ${TABLE} with actual table alias"""
        sql = sql_template.replace("${TABLE}", view_name)
        # Could add more template variable support here
        return sql
