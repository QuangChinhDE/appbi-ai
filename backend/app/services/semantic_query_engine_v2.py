"""
Semantic Query Engine v2
Advanced SQL generation with pivots, window functions, calculated fields, and more
"""
from typing import List, Tuple, Dict, Any, Optional, Set
from sqlalchemy.orm import Session
from app.models.semantic import SemanticView, SemanticExplore, SemanticModel
from app.services.semantic_join_resolver import SemanticJoinResolver
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
        self._resolver: Optional[SemanticJoinResolver] = None
        self._model: Optional[SemanticModel] = None
        self._model_dataset_table_ids: Set[int] = set()
    
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
        top_n: Optional[Dict[str, Any]] = None,
        measure_agg_overrides: Optional[Dict[str, str]] = None,
        model_id: Optional[int] = None,
        explore_id: Optional[int] = None,
    ) -> Tuple[str, List[str], List[PivotedColumn]]:
        """
        Generate SQL from semantic query definition (v2)
        
        Returns:
            Tuple of (sql, columns, pivoted_columns)
        """
        self.warnings = []
        self.views_cache = {}
        self._resolver = None
        self._model = None
        self._model_dataset_table_ids = set()
        pivots = pivots or []
        sorts = sorts or []
        window_functions = window_functions or []
        calculated_fields = calculated_fields or []
        time_grains = time_grains or {}
        
        # Validate pivot limitation (only 1 pivot supported in v2)
        if len(pivots) > 1:
            raise ValueError("Only one pivot dimension is supported in v2")
        
        # Load explore definition
        explore_query = self.db.query(SemanticExplore)
        if explore_id is not None:
            explore_query = explore_query.filter(SemanticExplore.id == explore_id)
        else:
            explore_query = explore_query.filter(SemanticExplore.name == explore_name)
        if model_id is not None:
            explore_query = explore_query.filter(SemanticExplore.model_id == model_id)
        explore = explore_query.first()
        
        if not explore:
            raise ValueError(f"Explore '{explore_name}' not found")

        model = self.db.query(SemanticModel).filter(
            SemanticModel.id == explore.model_id
        ).first()
        self._set_model_scope(model)
        self._resolver = SemanticJoinResolver(
            self.db,
            model,
            explore.base_view_name,
            bidirectional=True,
        )

        base_view = self.db.query(SemanticView).filter(
            SemanticView.id == explore.base_view_id
        ).first()
        if not base_view:
            base_view = self._find_view_by_name(explore.base_view_name)
        if not base_view:
            raise ValueError(f"Base view '{explore.base_view_name}' not found")
        self.views_cache[explore.base_view_name] = base_view

        # Load every semantic view referenced by field roles, filters, sorts,
        # windows, and calculated-field placeholders before rendering SQL.
        field_refs = list(dimensions) + list(measures) + list(pivots) + list((filters or {}).keys())
        field_refs.extend(
            str(sort.get("field") or "")
            for sort in sorts
            if sort.get("field")
        )
        for wf in window_functions:
            base_measure = str(wf.get("base_measure") or "").strip()
            if base_measure:
                field_refs.append(base_measure)
            field_refs.extend(str(item or "").strip() for item in (wf.get("partition_by") or []) if str(item or "").strip())
            field_refs.extend(str(item or "").strip() for item in (wf.get("order_by") or []) if str(item or "").strip())
        for cf in calculated_fields:
            sql_template = str(cf.get("sql") or "")
            field_refs.extend(
                re.findall(
                    r"\$\{([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\}",
                    sql_template,
                )
            )
        self._load_views(field_refs)
        
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
            window_functions, calculated_fields, time_grains,
            measure_agg_overrides=measure_agg_overrides or {},
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

    def _set_model_scope(self, model: Optional[SemanticModel]) -> None:
        self._model = model
        self._model_dataset_table_ids = set()
        dataset_id = getattr(model, "dataset_id", None)
        if dataset_id is None:
            return
        try:
            from app.models.dataset import DatasetTable

            self._model_dataset_table_ids = {
                int(row.id)
                for row in self.db.query(DatasetTable.id)
                .filter(DatasetTable.dataset_id == dataset_id)
                .all()
            }
        except Exception:
            self._model_dataset_table_ids = set()

    def _find_view_by_name(self, view_name: str) -> Optional[SemanticView]:
        name = str(view_name or "").strip()
        if not name:
            return None
        if self._model is None:
            return self.db.query(SemanticView).filter(SemanticView.name == name).first()
        if self._model_dataset_table_ids:
            view = (
                self.db.query(SemanticView)
                .filter(
                    SemanticView.name == name,
                    SemanticView.dataset_table_id.in_(self._model_dataset_table_ids),
                )
                .first()
            )
            if view is not None:
                return view
        return (
            self.db.query(SemanticView)
            .filter(
                SemanticView.name == name,
                SemanticView.dataset_table_id.is_(None),
            )
            .first()
        )
    
    def _load_views(self, field_refs: List[str]):
        """Load all views referenced in field names"""
        node_ids = set()
        for field_ref in field_refs:
            if '.' in field_ref:
                node_id, _ = self._parse_field_ref(field_ref)
                node_ids.add(node_id)

        for node_id in node_ids:
            self._get_view_for_node(node_id)

    def _get_view_for_node(self, node_id: str) -> SemanticView:
        """Return the SemanticView for a field node id.

        Node ids normally equal view names, but role-playing joins may expose
        an alias. The resolver maps alias node -> actual SemanticView.name.
        """
        if node_id in self.views_cache:
            return self.views_cache[node_id]

        view_name = self._resolver.view_for_node(node_id) if self._resolver else None
        view_name = view_name or node_id
        view = self._find_view_by_name(view_name)
        if not view:
            raise ValueError(f"View '{node_id}' not found")
        self.views_cache[node_id] = view
        return view
    
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
        time_grains: Dict[str, str],
        measure_agg_overrides: Optional[Dict[str, str]] = None,
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
                agg_over = (measure_agg_overrides or {}).get(measure_field)
                for pval in pivot_values:
                    pivot_sql = self._render_pivoted_measure(
                        measure_field, pivots[0], pval,
                        agg_override=agg_over,
                    )
                    alias = self._pivot_column_alias(measure_field, pval)
                    select_parts.append(f"{pivot_sql} AS {alias}")
                    column_names.append(alias)
        else:
            # Regular measures
            for measure_field in measures:
                agg_over = (measure_agg_overrides or {}).get(measure_field)
                measure_sql = self._render_measure(measure_field, agg_override=agg_over)
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
        view = self.views_cache.get(view_name) or self._get_view_for_node(view_name)
        
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
    
    def _render_measure(
        self,
        field_ref: str,
        *,
        agg_override: Optional[str] = None,
        _stack: Optional[Set[str]] = None,
    ) -> str:
        """Render measure SQL with aggregation.

        When *agg_override* is provided (e.g. ``"max"``, ``"count_distinct"``),
        it takes precedence over the aggregation type stored in the view
        definition.  This allows callers (chart rendering, Explore API) to
        request a specific aggregation without mutating the semantic model.

        Phase-1 extensions handled here:
          * ``expression``: when set, takes precedence over ``sql`` as the
            value being aggregated (advanced power-user mode).
          * ``filters`` / ``where_sql``: produce a ``CASE WHEN <cond> THEN
            <value> ELSE NULL END`` wrapper so the aggregation only sees
            qualifying rows (Looker-style filtered measures).
        """
        stack = set(_stack or set())
        if field_ref in stack:
            cycle = " -> ".join([*stack, field_ref])
            raise ValueError(f"Circular measure dependency detected: {cycle}")
        stack.add(field_ref)

        view_name, field_name = self._parse_field_ref(field_ref)
        view = self.views_cache.get(view_name) or self._get_view_for_node(view_name)

        measure_def = next((m for m in view.measures if m['name'] == field_name), None)
        if not measure_def:
            raise ValueError(f"Measure '{field_name}' not found in view '{view_name}'")

        stored_measure_type = str(measure_def.get('type', 'count') or 'count').lower().strip()
        override_type = str(agg_override or "").lower().strip()
        measure_type = override_type or stored_measure_type
        expression_template = (measure_def.get('expression') or "").strip()
        depends_on = [
            str(item).strip()
            for item in (measure_def.get('depends_on') or [])
            if str(item).strip()
        ]

        # Ratio / aggregate-level measures. When a measure declares
        # `depends_on`, treat `expression` as a formula over already-aggregated
        # measures instead of aggregating the expression again.
        if expression_template and depends_on and (not override_type or override_type == stored_measure_type):
            return self._render_measure_formula(
                expression_template,
                view_name,
                depends_on,
                stack,
            )

        # `expression` (advanced) wins over `sql` (form). Both are SQL templates.
        sql_template = expression_template or measure_def.get('sql') or '*'
        base_sql = self._render_sql_template(sql_template, view_name)

        # Filtered measure: wrap `base_sql` in CASE WHEN so the aggregate only
        # sees qualifying rows. COUNT(*) needs special-casing because there is
        # no per-row value to gate.
        filter_sql = self._render_measure_filter_clause(measure_def, view_name)
        if filter_sql:
            if measure_type == "count" and base_sql.strip() == "*":
                # COUNT(CASE WHEN cond THEN 1 END) counts only matching rows
                gated = f"CASE WHEN {filter_sql} THEN 1 END"
            else:
                gated = f"CASE WHEN {filter_sql} THEN {base_sql} END"
            base_sql = gated

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

    def _render_measure_filter_clause(
        self, measure_def: Dict[str, Any], view_name: str
    ) -> Optional[str]:
        """Compose AND-joined filter expression for a measure, or None.

        Combines the structured ``filters`` list (UI builder) with the raw
        ``where_sql`` fragment (advanced); both render against ``view_name``
        and are joined with AND.
        """
        parts: List[str] = []
        for f in measure_def.get('filters') or []:
            rendered = self._render_one_measure_filter(f, view_name)
            if rendered:
                parts.append(rendered)
        where_sql = (measure_def.get('where_sql') or "").strip()
        if where_sql:
            # Allow ${TABLE} / ${view.field} placeholders in raw SQL too
            parts.append(f"({self._render_sql_template(where_sql, view_name)})")
        if not parts:
            return None
        return " AND ".join(parts)

    def _render_measure_formula(
        self,
        template: str,
        view_name: str,
        depends_on: List[str],
        stack: Set[str],
    ) -> str:
        """Render an aggregate-level formula over dependent measures.

        Supported placeholders:
          - ${TABLE}: current SQL alias
          - ${measure_name}: measure in the same view listed in depends_on
          - ${view.measure_name}: qualified measure listed in depends_on
          - ${view.dimension_name}: qualified dimension reference
        """
        allowed_refs = set()
        for dep in depends_on:
            allowed_refs.add(dep)
            allowed_refs.add(dep if "." in dep else f"{view_name}.{dep}")

        rendered = template.replace("${TABLE}", view_name)
        placeholder_pattern = r"\$\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}"

        def replace_placeholder(match):
            ref = match.group(1)
            qualified = ref if "." in ref else f"{view_name}.{ref}"
            ref_view_name, ref_field_name = self._parse_field_ref(qualified)
            ref_view = self.views_cache.get(ref_view_name) or self._get_view_for_node(ref_view_name)

            is_measure = any(
                m.get("name") == ref_field_name
                for m in (ref_view.measures or [])
                if isinstance(m, dict)
            )
            if is_measure:
                if ref not in allowed_refs and qualified not in allowed_refs:
                    raise ValueError(
                        f"Measure formula references '{ref}' but it is not listed in depends_on"
                    )
                return f"({self._render_measure(qualified, _stack=stack)})"

            is_dimension = any(
                d.get("name") == ref_field_name
                for d in (ref_view.dimensions or [])
                if isinstance(d, dict)
            )
            if is_dimension:
                return self._render_dimension(qualified, ref_view_name)

            raise ValueError(f"Unknown semantic field in measure formula: {ref}")

        return re.sub(placeholder_pattern, replace_placeholder, rendered)

    def _render_one_measure_filter(
        self, f: Dict[str, Any], view_name: str
    ) -> Optional[str]:
        """Render a single MeasureFilter dict into a SQL boolean expression."""
        field = (f.get('field') or "").strip()
        operator = (f.get('operator') or "eq").lower().strip()
        value = f.get('value')
        if not field:
            return None

        # `field` may be a bare column ("status") or qualified ("orders.status")
        if "." in field:
            field_sql = self._render_dimension(field, self._parse_field_ref(field)[0])
        else:
            field_sql = f"{view_name}.{field}"

        def _q(v: Any) -> str:
            if v is None:
                return "NULL"
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return str(v)
            return "'" + str(v).replace("'", "''") + "'"

        if operator == "eq":
            return f"{field_sql} = {_q(value)}"
        if operator == "ne":
            return f"{field_sql} <> {_q(value)}"
        if operator == "gt":
            return f"{field_sql} > {_q(value)}"
        if operator == "gte":
            return f"{field_sql} >= {_q(value)}"
        if operator == "lt":
            return f"{field_sql} < {_q(value)}"
        if operator == "lte":
            return f"{field_sql} <= {_q(value)}"
        if operator == "in":
            vals = value if isinstance(value, list) else [value]
            return f"{field_sql} IN ({', '.join(_q(v) for v in vals)})"
        if operator == "not_in":
            vals = value if isinstance(value, list) else [value]
            return f"{field_sql} NOT IN ({', '.join(_q(v) for v in vals)})"
        if operator == "between":
            lo, hi = (value or [None, None])[:2]
            return f"{field_sql} BETWEEN {_q(lo)} AND {_q(hi)}"
        if operator == "contains":
            return f"{field_sql} LIKE '%' || {_q(value)} || '%'"
        if operator == "starts_with":
            return f"{field_sql} LIKE {_q(value)} || '%'"
        if operator == "ends_with":
            return f"{field_sql} LIKE '%' || {_q(value)}"
        if operator == "is_null":
            return f"{field_sql} IS NULL"
        if operator == "is_not_null":
            return f"{field_sql} IS NOT NULL"
        return None
    
    def _render_pivoted_measure(
        self, 
        measure_field: str, 
        pivot_field: str, 
        pivot_value: str,
        *,
        agg_override: Optional[str] = None,
    ) -> str:
        """Render measure with CASE for pivot"""
        view_name, field_name = self._parse_field_ref(measure_field)
        view = self.views_cache.get(view_name) or self._get_view_for_node(view_name)
        
        measure_def = next((m for m in view.measures if m['name'] == field_name), None)
        if not measure_def:
            raise ValueError(f"Measure '{field_name}' not found")
        
        measure_type = (agg_override or measure_def.get('type', 'sum')).lower().strip()
        sql_template = measure_def.get('expression') or measure_def.get('sql') or '*'
        base_sql = self._render_sql_template(sql_template, view_name)

        # Filtered measure inside a pivot: AND the measure's own filter into
        # the pivot CASE branch so each pivoted column also respects the filter.
        measure_filter_sql = self._render_measure_filter_clause(measure_def, view_name)

        # Get pivot dimension SQL
        pivot_view_name, pivot_field_name = self._parse_field_ref(pivot_field)
        pivot_sql = self._render_dimension(pivot_field, pivot_view_name)
        
        # Build CASE expression. When the measure carries its own filter, AND
        # it into the pivot predicate so each pivoted column is correctly gated.
        pivot_pred = f"{pivot_sql} = '{pivot_value}'"
        if measure_filter_sql:
            pivot_pred = f"({pivot_pred}) AND ({measure_filter_sql})"

        if measure_type in ["sum", "avg"]:
            agg_func = measure_type.upper()
            case_expr = f"CASE WHEN {pivot_pred} THEN {base_sql} ELSE 0 END"
            return f"{agg_func}({case_expr})"
        elif measure_type == "count":
            case_expr = f"CASE WHEN {pivot_pred} THEN 1 ELSE 0 END"
            return f"SUM({case_expr})"
        elif measure_type == "count_distinct":
            case_expr = f"CASE WHEN {pivot_pred} THEN {base_sql} ELSE NULL END"
            return f"COUNT(DISTINCT {case_expr})"
        else:
            case_expr = f"CASE WHEN {pivot_pred} THEN {base_sql} ELSE 0 END"
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
        
        resolver = self._resolver
        if resolver is None:
            return from_clause

        joined_nodes: set[str] = {explore.base_view_name}
        target_nodes = sorted(set(self.views_cache.keys()) - joined_nodes)
        for target_node in target_nodes:
            path = resolver.resolve_path(target_node)
            if path is None:
                raise ValueError(
                    f"View '{target_node}' is not reachable from base view '{explore.base_view_name}'"
                )

            for step in path.steps:
                edge = step.edge
                if edge.to_node in joined_nodes:
                    continue
                join_view = self._get_view_for_node(edge.to_node)
                join_table = join_view.sql_table_name or edge.to_view
                join_condition_rendered = self._render_edge_join_condition(edge)
                if not join_condition_rendered:
                    raise ValueError(
                        f"Join from '{edge.from_node}' to '{edge.to_node}' is missing a SQL condition"
                    )
                join_type = (edge.type or "left").upper()
                from_clause += (
                    f"\n{join_type} JOIN {join_table} AS {edge.to_node} "
                    f"ON {join_condition_rendered}"
                )
                joined_nodes.add(edge.to_node)

        return from_clause

    def _render_edge_join_condition(self, edge) -> str:
        """Render a JOIN ON condition for a resolved join edge."""
        condition = str(edge.sql_on or "").strip()
        if not condition:
            if edge.from_column and edge.to_column:
                return f"{edge.from_node}.{edge.from_column} = {edge.to_node}.{edge.to_column}"
            return ""

        rendered = condition.replace("${TABLE}", edge.from_node)
        if edge.to_node and edge.to_node != edge.to_view:
            rendered = rendered.replace(f"${{{edge.to_node}}}", edge.to_node)
        rendered = rendered.replace(f"${{{edge.to_view}}}", edge.to_node)

        dotted_pattern = r'\$\{([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\}'

        def replace_field(match):
            field_ref = match.group(1)
            node_name, field_name = self._parse_field_ref(field_ref)
            if node_name in {edge.to_node, edge.to_view}:
                return f"{edge.to_node}.{field_name}"
            if node_name == edge.from_node:
                return f"{edge.from_node}.{field_name}"
            return f"{node_name}.{field_name}"

        rendered = re.sub(dotted_pattern, replace_field, rendered)

        bare_pattern = r'\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}'
        rendered = re.sub(bare_pattern, lambda m: m.group(1), rendered)

        return rendered
    
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
        
        return ""
    
    def _parse_field_ref(self, field_ref: str) -> Tuple[str, str]:
        """Parse 'view.field' into (view_name, field_name)"""
        if '.' not in field_ref:
            raise ValueError(f"Invalid field reference: {field_ref} (must be view.field)")
        
        parts = field_ref.split('.', 1)
        return parts[0], parts[1]
    
    def _render_sql_template(self, template: str, view_alias: str) -> str:
        """Render a SQL template with semantic placeholders.

        `${TABLE}` resolves to the current SQL alias. `${view.field}` resolves
        to `view.field`; bare column names are left untouched for backwards
        compatibility with existing generated model fields.
        """
        rendered = template.replace("${TABLE}", view_alias)

        dotted_pattern = r"\$\{([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\}"

        def replace_field(match):
            field_ref = match.group(1)
            ref_view_name, ref_field_name = self._parse_field_ref(field_ref)
            return f"{ref_view_name}.{ref_field_name}"

        return re.sub(dotted_pattern, replace_field, rendered)
    
    def _safe_alias(self, field_ref: str) -> str:
        """Generate safe SQL alias from field reference"""
        return field_ref.replace('.', '_')
    
    def _pivot_column_alias(self, measure_field: str, pivot_value: str) -> str:
        """Generate alias for pivoted column"""
        safe_measure = self._safe_alias(measure_field)
        safe_value = re.sub(r'[^a-zA-Z0-9_]', '_', str(pivot_value))
        return f"{safe_measure}_{safe_value}"
