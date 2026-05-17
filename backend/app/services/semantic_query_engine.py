"""
Semantic Query Engine

Advanced SQL generation with pivots, window functions, calculated fields,
time grains, top N, dialect-aware time macros (Phase-5), measure rename
auto-rewrite (Phase-6), and ambiguous join path detection (Phase-3b).

History: this module used to be ``semantic_query_engine_v2.py`` (a v1
engine existed briefly during the early semantic refactor). Phase-7
canonicalised the filename + class name; the legacy module path keeps
a re-export shim so old imports stay working.
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


class SemanticQueryEngine:
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

        # Build LIMIT clause. When the caller asks for "top N", that N takes
        # precedence over the generic chart limit: it's the user's explicit
        # request for the leading N rows, ordered by the top_n field.
        effective_limit = limit
        if top_n and isinstance(top_n, dict):
            try:
                n_value = int(top_n.get("n", 0))
                if n_value > 0:
                    effective_limit = n_value
            except (TypeError, ValueError):
                pass
        limit_clause = f"LIMIT {effective_limit}" if effective_limit else ""
        
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
        """Load all views referenced in field names.

        Phase-12: when a referenced measure has ``scope='dataset'`` and
        declares ``source_columns``, the views named in source_columns are
        also loaded so the join-graph builder includes them. Without this
        step a dataset-scope measure like
        ``${deals.amount} / COUNT(${leads.id})`` would only join the parent
        view's table; the engine would then fail to resolve ${deals.amount}
        because the ``deals`` view was never registered in views_cache.
        """
        node_ids: set[str] = set()
        for field_ref in field_refs:
            if '.' in field_ref:
                node_id, _ = self._parse_field_ref(field_ref)
                node_ids.add(node_id)

        # First pass: load every directly-referenced view.
        for node_id in node_ids:
            self._get_view_for_node(node_id)

        # Second pass: for each measure ref, if it's a dataset-scope measure,
        # add its source_columns views into the load set.
        extra_node_ids: set[str] = set()
        for field_ref in field_refs:
            if '.' not in field_ref:
                continue
            view_name, field_name = self._parse_field_ref(field_ref)
            view = self.views_cache.get(view_name)
            if not view:
                continue
            measure_def = next(
                (m for m in (view.measures or []) if str(m.get('name') or '') == field_name),
                None,
            )
            if not measure_def:
                continue
            if str(measure_def.get('scope') or 'view') != 'dataset':
                continue
            for entry in measure_def.get('source_columns') or []:
                src_view = str(entry.get('view') or '').strip() if isinstance(entry, dict) else ''
                if src_view and src_view not in node_ids:
                    extra_node_ids.add(src_view)
        for node_id in extra_node_ids:
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
            # Regular measures. Phase-14: pass active_dimensions so any
            # context_modifiers on the measure can compile to a window
            # aggregate against the right partition set.
            for measure_field in measures:
                agg_over = (measure_agg_overrides or {}).get(measure_field)
                measure_sql = self._render_measure(
                    measure_field,
                    agg_override=agg_over,
                    active_dimensions=non_pivot_dims,
                )
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
        """Render dimension with time grain applied.

        Phase-15.12 — added a MySQL branch. MySQL does NOT support the
        SQL-standard ``DATE_TRUNC`` function; the prior code fell into the
        PostgreSQL/DuckDB branch and produced a syntax error at run time.
        We emit equivalent ``DATE_FORMAT``/``MAKEDATE`` expressions that
        round to the start of the bucket (so subsequent GROUP BY 1 buckets
        correctly). Week uses ``WEEKDAY`` so Monday becomes the bucket
        start, matching ISO-8601 (which is what DATE_TRUNC('week', ...)
        does on PG/DuckDB).
        """
        base_sql = self._render_dimension(field_ref, view_alias)
        dialect = (self.database_type or "").lower()

        if dialect == "bigquery":
            grain_map = {
                "day": "DAY",
                "week": "WEEK",
                "month": "MONTH",
                "quarter": "QUARTER",
                "year": "YEAR",
            }
            return f"TIMESTAMP_TRUNC({base_sql}, {grain_map.get(grain, 'DAY')})"

        if dialect == "mysql":
            g = (grain or "day").lower()
            if g == "day":
                return f"DATE({base_sql})"
            if g == "week":
                # ISO Monday start: subtract WEEKDAY(...) days from the date.
                return f"DATE_SUB(DATE({base_sql}), INTERVAL WEEKDAY({base_sql}) DAY)"
            if g == "month":
                return f"DATE_FORMAT({base_sql}, '%Y-%m-01')"
            if g == "quarter":
                return f"MAKEDATE(YEAR({base_sql}), 1) + INTERVAL (QUARTER({base_sql}) - 1) QUARTER"
            if g == "year":
                return f"MAKEDATE(YEAR({base_sql}), 1)"
            return f"DATE({base_sql})"

        # PostgreSQL + DuckDB both support DATE_TRUNC with text-literal grain.
        return f"DATE_TRUNC('{grain}', {base_sql})"
    
    def _render_measure(
        self,
        field_ref: str,
        *,
        agg_override: Optional[str] = None,
        _stack: Optional[Set[str]] = None,
        active_dimensions: Optional[List[str]] = None,
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

        Phase-14: when ``context_modifiers`` is non-empty AND a list of
        ``active_dimensions`` (qualified `view.field`) is provided by the
        caller, the measure is rendered as a window aggregate
        (``agg(expr) OVER (PARTITION BY ...)``) so the modifier can mask
        the chart's filter context. The function still returns a single
        SQL fragment — the GROUP-BY emitter excludes window-aggregated
        measures via a sibling helper (``measure_is_windowed``). When
        ``active_dimensions`` is None, modifiers are silently ignored
        and the measure renders as a plain aggregate (legacy behaviour
        for callers like ratio formulas that don't know the query dims).
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
            # ── Implicit measure fallback (Phase-15.7) ──
            #
            # Mirrors PowerBI's "drag any numeric column → it sums". When
            # `_classify_columns` runs with auto_generate_measures=False
            # (the default since Phase-2), numeric columns become
            # dimensions with type='number' and NO matching measure entry
            # gets emitted. Without this fallback, every Explore drag of
            # a raw numeric column fails with:
            #   "Measure 'X' not found in view 'Y'"
            # which is what DA hit (see "Measure 'deal_value' not found"
            # report).
            #
            # Logic: when the field IS a declared dimension of type 'number'
            # on the view (i.e. user dragged a real numeric column, not a
            # typo'd name), synthesise an ad-hoc measure def that the rest
            # of this function can render the same way as a real one:
            #
            #   { name: <field>, type: <agg_override or 'sum'>, sql: <field> }
            #
            # The synthesised measure has NO `filters`, `where_sql`,
            # `expression`, or `depends_on` — it's the simplest possible
            # `AGG(view.field)` aggregation. If the user later wants a
            # filtered / formula variant, they declare a real measure in
            # the Data Model and the lookup above will find it instead.
            #
            # KHÔNG vi phạm Nguyên tắc 1 ("2 cơ chế"). Implicit measure
            # vẫn là Measure — chỉ là chưa được persist vào SemanticView
            # tại thời điểm này. The synthesised dict has the exact shape
            # `view.measures[]` entries use, so all downstream code paths
            # (filter wrap, window aggregate for Phase-14 modifiers, etc.)
            # work unchanged. Validator / persistence is unaffected: this
            # never gets written back to the DB.
            dim_def = next(
                (d for d in (view.dimensions or []) if d.get('name') == field_name),
                None,
            )
            if dim_def is None:
                raise ValueError(
                    f"Measure '{field_name}' không tồn tại trong view '{view_name}'. "
                    f"Cột này cũng không phải dimension trên view. Pick một field "
                    "đã khai báo trong tab Data Model, hoặc bật \"Show JOIN keys\" "
                    "nếu đang cần count một FK."
                )

            # Phase-15.17: aggregation-validity matrix mirroring the FE
            # (Phase-15.16). FE allows DA to drop ANY column type into the
            # Values slot and pick a sensible agg; BE must accept the same
            # combos or DA hits "Measure X không tồn tại" on COUNT_DISTINCT
            # of a FK (the previous fallback only fired for numeric dims).
            #
            #   SUM / AVG          → numeric only (string AVG = SQL error)
            #   MIN / MAX          → any orderable type (numeric, date, string)
            #   COUNT / COUNT_DISTINCT → any column (counts rows / distinct values)
            #
            # Defaults match FE `defaultMetricAggForCol`:
            #   numeric → SUM,   anything else → COUNT_DISTINCT.
            dim_type = str(dim_def.get('type') or '').lower()
            is_numeric_dim = dim_type == 'number'

            requested_agg = str(agg_override or '').lower().strip()
            if requested_agg not in {"count", "sum", "avg", "min", "max", "count_distinct"}:
                requested_agg = ""  # treat as no override
            if not requested_agg:
                requested_agg = "sum" if is_numeric_dim else "count_distinct"

            NUMERIC_ONLY_AGGS = {"sum", "avg"}
            if requested_agg in NUMERIC_ONLY_AGGS and not is_numeric_dim:
                raise ValueError(
                    f"Aggregation '{requested_agg.upper()}' không dùng được trên "
                    f"cột '{field_name}' (type={dim_type or 'unknown'}). "
                    f"Đổi sang COUNT / COUNT_DISTINCT / MIN / MAX, "
                    f"hoặc tạo một measure '{field_name}' trên view "
                    f"'{view_name}' với expression rõ ràng (vd `SUM(CAST({field_name} AS NUMERIC))`)."
                )

            # Phase-15.15: must be `${TABLE}.field`, NOT bare `field`.
            # `_render_sql_template` only substitutes `${TABLE}` placeholders
            # — a bare column name passes through unchanged. In a single-
            # table query BigQuery resolves the bare name against the lone
            # FROM table; in a cross-table JOIN the same column existing
            # on multiple joined views makes BigQuery raise "Column name
            # X is ambiguous" (DA's `deal_value` error). Qualifying via
            # the template ensures the engine emits `Deals.deal_value`,
            # matching the SQL alias from `_build_from_clause`.
            measure_def = {
                'name': field_name,
                'type': requested_agg,
                'sql': '${TABLE}.' + field_name,
            }

        stored_measure_type = str(measure_def.get('type', 'count') or 'count').lower().strip()
        override_type = str(agg_override or "").lower().strip()
        # "auto" (and unknown values) means "use the measure's stored type" —
        # not "fallback to SUM". The previous behaviour silently converted any
        # unrecognised agg into a SUM, which broke COUNT_DISTINCT measures
        # consumed by chart roleConfigs that ship `agg: "auto"`.
        _KNOWN_AGGS = {"count", "sum", "avg", "min", "max", "count_distinct", "percent_of_total"}
        if override_type and override_type not in _KNOWN_AGGS:
            override_type = ""
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

        # Build the aggregate function call (no OVER yet).
        if measure_type == "count":
            agg_sql = f"COUNT({base_sql})"
        elif measure_type == "sum":
            agg_sql = f"SUM({base_sql})"
        elif measure_type == "avg":
            agg_sql = f"AVG({base_sql})"
        elif measure_type == "min":
            agg_sql = f"MIN({base_sql})"
        elif measure_type == "max":
            agg_sql = f"MAX({base_sql})"
        elif measure_type == "count_distinct":
            agg_sql = f"COUNT(DISTINCT {base_sql})"
        elif measure_type == "percent_of_total":
            # Phase-1: built-in % of grand total via window aggregate over
            # the inner aggregate. Already self-contained; context_modifiers
            # are skipped to avoid double-wrapping.
            return f"SUM({base_sql}) / SUM(SUM({base_sql})) OVER () * 100"
        else:
            agg_sql = f"SUM({base_sql})"  # Default fallback

        # Phase-14: context_modifiers turn the aggregate into a window
        # aggregate. Only applies when the caller passed active_dimensions
        # (i.e. we know the query shape). Modifiers that don't change the
        # window (currently only `use_relationship`, which affects JOIN
        # path resolution rather than the OVER clause) are ignored here.
        modifiers = list(measure_def.get('context_modifiers') or [])
        if modifiers and active_dimensions is not None:
            partition_clause = self._compute_context_partition(
                modifiers, active_dimensions, view_name,
            )
            if partition_clause is not None:
                # `None` partition_clause means "no window override needed".
                # An empty string means OVER () — grand total.
                over_body = f"PARTITION BY {partition_clause}" if partition_clause else ""
                return f"{agg_sql} OVER ({over_body})"

        return agg_sql

    def _compute_context_partition(
        self,
        modifiers: List[Dict[str, Any]],
        active_dimensions: List[str],
        host_view_name: str,
    ) -> Optional[str]:
        """Phase-14: derive the PARTITION BY expression list for a measure
        with context_modifiers. Returns:

          * a comma-separated SQL string of dim references — partition by
            exactly those dims;
          * ``""`` (empty string) — render as ``OVER ()`` (grand total);
          * ``None`` — no window override needed (no all / all_except in
            the modifier set).

        ``use_relationship`` is handled elsewhere (join path resolver) and
        does not influence the partition clause.
        """
        has_all = any(m.get("type") == "all" for m in modifiers)
        all_except_keep: Optional[set] = None
        for m in modifiers:
            if m.get("type") == "all_except":
                all_except_keep = {
                    str(f or "").strip()
                    for f in (m.get("keep_fields") or [])
                    if str(f or "").strip()
                }
                break

        if has_all:
            return ""  # OVER () — grand total

        if all_except_keep is not None:
            # Resolve each kept field to qualified ref (default to host_view
            # when bare) and render via the same path SELECT uses.
            keep_qualified: List[str] = []
            for raw in all_except_keep:
                ref = raw if "." in raw else f"{host_view_name}.{raw}"
                if ref not in active_dimensions:
                    # Defensive: kept field isn't in the query — skip
                    # silently rather than emit invalid SQL.
                    continue
                view_alias, _ = self._parse_field_ref(ref)
                keep_qualified.append(self._render_dimension(ref, view_alias))
            # If none of the keep_fields are active, fall through to grand
            # total — semantically equivalent for the user's intent.
            return ", ".join(keep_qualified) if keep_qualified else ""

        return None

    def _measure_is_windowed(
        self,
        field_ref: str,
        active_dimensions: List[str],
    ) -> bool:
        """Phase-14: tell the GROUP BY emitter whether this measure renders
        as a window aggregate (and thus should NOT block the query from
        being a non-grouped SELECT when it's the only "aggregate").

        Returns True only when context_modifiers actually produce a window —
        i.e. there's an 'all' or 'all_except' entry. 'use_relationship'
        alone does not windowize.
        """
        try:
            view_name, field_name = self._parse_field_ref(field_ref)
        except ValueError:
            return False
        view = self.views_cache.get(view_name)
        if not view:
            return False
        measure_def = next((m for m in view.measures if m.get('name') == field_name), None)
        if not measure_def:
            return False
        for m in measure_def.get('context_modifiers') or []:
            t = m.get('type')
            if t in ("all", "all_except"):
                return True
        return False

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
            # Phase-15.7: same implicit measure fallback as `_render_measure`
            # (see longer comment there). Pivot tables also let DA drag any
            # numeric column into the pivoted-measure slot; without this the
            # pivot fails with the same "measure not found" error.
            dim_def = next(
                (d for d in (view.dimensions or []) if d.get('name') == field_name),
                None,
            )
            if dim_def is None:
                raise ValueError(
                    f"Measure '{field_name}' không tồn tại trong view '{view_name}' (pivot)."
                )

            # Phase-15.17: same validity matrix as `_render_measure`. SUM/AVG
            # require numeric; COUNT/COUNT_DISTINCT/MIN/MAX work on any type.
            dim_type = str(dim_def.get('type') or '').lower()
            is_numeric_dim = dim_type == 'number'

            requested_agg = str(agg_override or '').lower().strip()
            if requested_agg not in {"count", "sum", "avg", "min", "max", "count_distinct"}:
                requested_agg = ""
            if not requested_agg:
                requested_agg = "sum" if is_numeric_dim else "count_distinct"

            if requested_agg in {"sum", "avg"} and not is_numeric_dim:
                raise ValueError(
                    f"Aggregation '{requested_agg.upper()}' không dùng được trên "
                    f"cột '{field_name}' (type={dim_type or 'unknown'}) trong pivot. "
                    f"Đổi sang COUNT / COUNT_DISTINCT / MIN / MAX."
                )

            # Phase-15.15: qualify via `${TABLE}` — same fix as `_render_measure`
            # (see comment there). Bare column refs blow up in cross-table
            # JOINs because BigQuery / Postgres / MySQL all reject ambiguous
            # columns when the same name exists on multiple joined tables.
            measure_def = {
                'name': field_name,
                'type': requested_agg,
                'sql': '${TABLE}.' + field_name,
            }

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
                # Phase-11: friendly Vietnamese message so DA hiểu cần thêm
                # relationship. Tránh raw English engine identifier.
                raise ValueError(
                    f"Bảng \"{target_node}\" chưa có relationship tới base view "
                    f"\"{explore.base_view_name}\". "
                    f"Mở tab Data Model để định nghĩa join trước khi dùng field từ bảng này."
                )
            # Phase-3b: surface ambiguous path so the front-end can banner it.
            # The path itself is deterministic (first-found in BFS), but the
            # user deserves to know multiple routes exist so they can pick
            # one explicitly via inactive relationships.
            if path.ambiguous:
                self.warnings.append(
                    f"Có nhiều đường join đến '{target_node}' — đang dùng đường ngắn nhất. "
                    "Nếu kết quả không như mong muốn, hãy mark một quan hệ là Inactive để chọn đường khác."
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
        """Build WHERE clause from filters.

        Phase-15.19: the operator set was lagging FilterBuilder for months.
        FE generates `between`, `is_null`, `is_not_null`, and `not_contains`
        (defaults for date / number columns), but the engine's `if/elif`
        chain only matched eq/ne/gt/gte/lt/lte/in/not_in/contains/
        starts_with/ends_with — anything else fell through silently, the
        WHERE clause came back empty, and DA saw the chart return ALL
        rows when they'd dialled in a "between Jan and Dec" filter.

        Live_query's `_build_where_clause` (live_query_service.py:558)
        already handled these; the semantic path was the regression. We
        intentionally mirror that contract — same operator names, same
        BETWEEN-with-single-side-fallback, same escaping shape — so
        switching between live_query and semantic routing produces
        identical results for a given filter list.
        """
        if not filters:
            return ""

        def _lit(raw: Any) -> str:
            """Quote a Python value as a SQL literal. Matches
            live_query_service._sql_literal so the same value formats
            consistently across both paths."""
            if raw is None:
                return "NULL"
            if isinstance(raw, bool):
                return "TRUE" if raw else "FALSE"
            if isinstance(raw, (int, float)):
                return str(raw)
            return "'" + str(raw).replace("'", "''") + "'"

        def _value_present(raw: Any) -> bool:
            if raw is None:
                return False
            if isinstance(raw, str) and not raw.strip():
                return False
            return True

        conditions = []
        for field_ref, filter_def in filters.items():
            operator = str(filter_def.get('operator') or 'eq').strip().lower()
            value = filter_def.get('value')

            view_name, _ = self._parse_field_ref(field_ref)

            # Apply time grain if specified
            if field_ref in time_grains:
                field_sql = self._render_dimension_with_time_grain(
                    field_ref, view_name, time_grains[field_ref]
                )
            else:
                field_sql = self._render_dimension(field_ref, view_name)

            # Null-state operators don't take a value.
            if operator == "is_null":
                conditions.append(f"{field_sql} IS NULL")
                continue
            if operator == "is_not_null":
                conditions.append(f"{field_sql} IS NOT NULL")
                continue

            # Phase-15.19: BETWEEN with single-side fallback. FE pickers
            # often leave one bound blank ("from X with no upper bound"
            # or vice-versa); rather than silently dropping the filter
            # we degrade to >= / <= so the user's intent still lands.
            if operator == "between" and isinstance(value, list) and len(value) >= 2:
                lo, hi = value[0], value[1]
                if _value_present(lo) and _value_present(hi):
                    conditions.append(f"{field_sql} BETWEEN {_lit(lo)} AND {_lit(hi)}")
                elif _value_present(lo):
                    conditions.append(f"{field_sql} >= {_lit(lo)}")
                elif _value_present(hi):
                    conditions.append(f"{field_sql} <= {_lit(hi)}")
                # if both blank → user hasn't filled the picker yet, skip
                continue

            # IN / NOT IN accept list or comma-separated string.
            if operator == "in":
                if isinstance(value, list):
                    vals = ", ".join(_lit(v) for v in value if _value_present(v))
                elif isinstance(value, str) and value.strip():
                    vals = ", ".join(_lit(v.strip()) for v in value.split(",") if v.strip())
                else:
                    vals = ""
                if vals:
                    conditions.append(f"{field_sql} IN ({vals})")
                continue
            if operator == "not_in":
                if isinstance(value, list):
                    vals = ", ".join(_lit(v) for v in value if _value_present(v))
                elif isinstance(value, str) and value.strip():
                    vals = ", ".join(_lit(v.strip()) for v in value.split(",") if v.strip())
                else:
                    vals = ""
                if vals:
                    conditions.append(f"{field_sql} NOT IN ({vals})")
                continue

            # Pattern operators need LIKE-escaping for % and _ so DA-typed
            # literals don't accidentally turn into wildcards.
            if operator in {"contains", "not_contains", "starts_with", "ends_with"}:
                if value is None:
                    continue
                esc = str(value).replace("'", "''").replace("%", "\\%").replace("_", "\\_")
                if operator == "contains":
                    conditions.append(f"{field_sql} LIKE '%{esc}%' ESCAPE '\\'")
                elif operator == "not_contains":
                    conditions.append(f"{field_sql} NOT LIKE '%{esc}%' ESCAPE '\\'")
                elif operator == "starts_with":
                    conditions.append(f"{field_sql} LIKE '{esc}%' ESCAPE '\\'")
                else:  # ends_with
                    conditions.append(f"{field_sql} LIKE '%{esc}' ESCAPE '\\'")
                continue

            # Scalar comparison operators.
            if operator == "eq":
                conditions.append(f"{field_sql} = {_lit(value)}")
            elif operator == "ne":
                conditions.append(f"{field_sql} != {_lit(value)}")
            elif operator == "gt":
                conditions.append(f"{field_sql} > {_lit(value)}")
            elif operator == "gte":
                conditions.append(f"{field_sql} >= {_lit(value)}")
            elif operator == "lt":
                conditions.append(f"{field_sql} < {_lit(value)}")
            elif operator == "lte":
                conditions.append(f"{field_sql} <= {_lit(value)}")
            # Unknown operator → skip silently rather than emit broken SQL.
            # (Filter validators upstream should catch these earlier.)

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
        """Build GROUP BY clause.

        Phase-14: when EVERY measure compiles to a window aggregate (i.e.
        the measure has context_modifiers all/all_except), there are no
        plain aggregates to group — emit no GROUP BY. Mixed mode (some
        plain measures + some windowed) still needs GROUP BY because the
        plain ones force grouping; windowed aggregates ignore GROUP BY by
        SQL definition. Pure-window queries without dimensions would
        produce N rows of the same window value otherwise, but in
        practice pure-window queries always carry at least one dim too.
        """
        if not measures:
            return ""

        # Non-pivoted dimensions
        non_pivot_dims = [d for d in dimensions if d not in pivots]

        if not non_pivot_dims:
            return ""

        # Phase-14: if all measures are windowed (no plain aggregate left),
        # we don't need GROUP BY at all.
        non_pivot_active = non_pivot_dims  # alias for clarity in window check
        all_windowed = all(
            self._measure_is_windowed(m, non_pivot_active) for m in measures
        )
        if all_windowed:
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

        Supported placeholders:
          * ``${TABLE}``            — current view's SQL alias
          * ``${view.field}``       — qualified field reference
          * ``${TODAY}``            — today's date in the active dialect
          * ``${MONTH_START}``      — first day of the current month
          * ``${YEAR_START}``       — first day of the current year
          * ``${PREV_MONTH_START}`` — first day of the previous month
          * ``${PREV_YEAR_START}``  — first day of the previous year
          * ``${DAYS_AGO:N}``       — date N days before today (literal int)

        Phase-5: time macros let the SAME measure expression work across
        DuckDB / PostgreSQL / BigQuery / MySQL — instead of forcing the
        user to rewrite `date_trunc('month', CURRENT_DATE)` per dialect.
        """
        rendered = template.replace("${TABLE}", view_alias)
        rendered = self._render_time_macros(rendered)

        dotted_pattern = r"\$\{([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\}"

        def replace_field(match):
            field_ref = match.group(1)
            ref_view_name, ref_field_name = self._parse_field_ref(field_ref)
            return f"{ref_view_name}.{ref_field_name}"

        return re.sub(dotted_pattern, replace_field, rendered)

    def _render_time_macros(self, template: str) -> str:
        """Substitute dialect-aware time macros in a SQL template."""
        if "${" not in template:
            return template
        dialect = (self.database_type or "").lower()
        today = self._dialect_today(dialect)
        macros: dict[str, str] = {
            "${TODAY}": today,
            "${MONTH_START}": self._dialect_date_trunc(dialect, today, "month"),
            "${YEAR_START}": self._dialect_date_trunc(dialect, today, "year"),
            "${PREV_MONTH_START}": self._dialect_date_add(
                dialect,
                self._dialect_date_trunc(dialect, today, "month"),
                -1,
                "month",
            ),
            "${PREV_YEAR_START}": self._dialect_date_add(
                dialect,
                self._dialect_date_trunc(dialect, today, "year"),
                -1,
                "year",
            ),
        }
        for token, sql in macros.items():
            template = template.replace(token, sql)
        # ${DAYS_AGO:N}
        import re as _re
        def _days_ago(match: "_re.Match[str]") -> str:
            try:
                n = int(match.group(1))
            except (TypeError, ValueError):
                return match.group(0)
            return self._dialect_date_add(dialect, today, -n, "day")
        return _re.sub(r"\$\{DAYS_AGO:(\d+)\}", _days_ago, template)

    @staticmethod
    def _dialect_today(dialect: str) -> str:
        if dialect == "bigquery":
            return "CURRENT_DATE()"
        if dialect == "mysql":
            return "CURDATE()"
        # postgresql / duckdb / default
        return "CURRENT_DATE"

    @staticmethod
    def _dialect_date_trunc(dialect: str, date_expr: str, unit: str) -> str:
        u = unit.lower()
        if dialect == "bigquery":
            return f"DATE_TRUNC({date_expr}, {u.upper()})"
        if dialect == "mysql":
            if u == "month":
                return f"DATE_FORMAT({date_expr}, '%Y-%m-01')"
            if u == "year":
                return f"DATE_FORMAT({date_expr}, '%Y-01-01')"
            if u == "day":
                return f"DATE({date_expr})"
            return date_expr
        # postgresql / duckdb
        return f"date_trunc('{u}', {date_expr})"

    @staticmethod
    def _dialect_date_add(dialect: str, date_expr: str, amount: int, unit: str) -> str:
        u = unit.lower()
        if dialect == "bigquery":
            verb = "DATE_ADD" if amount >= 0 else "DATE_SUB"
            return f"{verb}({date_expr}, INTERVAL {abs(amount)} {u.upper()})"
        if dialect == "mysql":
            verb = "DATE_ADD" if amount >= 0 else "DATE_SUB"
            return f"{verb}({date_expr}, INTERVAL {abs(amount)} {u.upper()})"
        # postgresql / duckdb: use INTERVAL arithmetic
        sign = "+" if amount >= 0 else "-"
        return f"({date_expr} {sign} INTERVAL '{abs(amount)} {u}')"
    
    def _safe_alias(self, field_ref: str) -> str:
        """Generate safe SQL alias from field reference"""
        return field_ref.replace('.', '_')
    
    def _pivot_column_alias(self, measure_field: str, pivot_value: str) -> str:
        """Generate alias for pivoted column"""
        safe_measure = self._safe_alias(measure_field)
        safe_value = re.sub(r'[^a-zA-Z0-9_]', '_', str(pivot_value))
        return f"{safe_measure}_{safe_value}"
