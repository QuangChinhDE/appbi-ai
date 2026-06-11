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
import logging
import re

logger = logging.getLogger(__name__)


class AmbiguousFieldError(ValueError):
    """Raised when a bare field reference (no view prefix) matches multiple
    views in the dataset. The chart layer catches this to surface a
    user-friendly error instead of the cryptic BigQuery "Column X is
    ambiguous" message.
    """
    pass


def _build_calendar_expr_from_base(base_sql: str, calendar_field: str, dialect: str) -> str | None:
    """Wrap a resolved base-column SQL ref in the calendar math for ``calendar_field``.

    Mirrors the column generators in ``dataset_calendar_service.build_calendar_live_sql``
    so a role-played calendar filter rewritten onto its base fact column
    emits the SAME predicate the JOIN-to-calendar path would have used —
    just without the JOIN itself. Used by ``_build_where_clause`` when
    ``filter_def`` carries the ``calendarField`` metadata stamped by
    ``chart_service._rewrite_calendar_filter_to_all_roles``.

    Returns ``None`` for unrecognised calendar fields (caller falls back
    to plain column comparison, which is the safe legacy behaviour).
    """
    if not calendar_field or not base_sql:
        return None
    field = calendar_field.strip().lower()
    d = (dialect or "").strip().lower()

    if d == "bigquery":
        date_expr = f"DATE({base_sql})"
        year_expr = f"EXTRACT(YEAR FROM {date_expr})"
        quarter_expr = f"EXTRACT(QUARTER FROM {date_expr})"
        month_expr = f"EXTRACT(MONTH FROM {date_expr})"
        iso_week_expr = f"EXTRACT(ISOWEEK FROM {date_expr})"
        # BigQuery has no ISODOW — derive ISO day-of-week (Mon=1..Sun=7)
        # from DAYOFWEEK (Sun=1..Sat=7) via the modular trick used by
        # dataset_calendar_service.build_calendar_live_sql so the
        # rewritten predicate matches the calendar column exactly.
        iso_dow_expr = f"MOD(EXTRACT(DAYOFWEEK FROM {date_expr}) + 5, 7) + 1"
        day_expr = f"EXTRACT(DAY FROM {date_expr})"
        month_name_expr = f"FORMAT_DATE('%B', {date_expr})"
        month_short_expr = f"FORMAT_DATE('%b', {date_expr})"
        day_name_expr = f"FORMAT_DATE('%A', {date_expr})"
        year_month_expr = f"FORMAT_DATE('%Y-%m', {date_expr})"
    elif d == "mysql":
        date_expr = f"DATE({base_sql})"
        year_expr = f"EXTRACT(YEAR FROM {date_expr})"
        quarter_expr = f"QUARTER({date_expr})"
        month_expr = f"EXTRACT(MONTH FROM {date_expr})"
        iso_week_expr = f"WEEK({date_expr}, 3)"
        iso_dow_expr = f"(WEEKDAY({date_expr}) + 1)"
        day_expr = f"EXTRACT(DAY FROM {date_expr})"
        month_name_expr = f"MONTHNAME({date_expr})"
        month_short_expr = f"DATE_FORMAT({date_expr}, '%b')"
        day_name_expr = f"DAYNAME({date_expr})"
        year_month_expr = f"DATE_FORMAT({date_expr}, '%Y-%m')"
    elif d == "duckdb":
        date_expr = f"CAST({base_sql} AS DATE)"
        year_expr = f"CAST(EXTRACT(YEAR FROM {date_expr}) AS INTEGER)"
        quarter_expr = f"CAST(EXTRACT(QUARTER FROM {date_expr}) AS INTEGER)"
        month_expr = f"CAST(EXTRACT(MONTH FROM {date_expr}) AS INTEGER)"
        iso_week_expr = f"CAST(strftime({date_expr}, '%V') AS INTEGER)"
        iso_dow_expr = f"CAST(strftime({date_expr}, '%u') AS INTEGER)"
        day_expr = f"CAST(EXTRACT(DAY FROM {date_expr}) AS INTEGER)"
        month_name_expr = f"monthname({date_expr})"
        month_short_expr = f"substr(monthname({date_expr}), 1, 3)"
        day_name_expr = f"dayname({date_expr})"
        year_month_expr = f"strftime({date_expr}, '%Y-%m')"
    else:  # postgresql + fallback
        date_expr = f"CAST({base_sql} AS DATE)"
        year_expr = f"EXTRACT(YEAR FROM {date_expr})"
        quarter_expr = f"EXTRACT(QUARTER FROM {date_expr})"
        month_expr = f"EXTRACT(MONTH FROM {date_expr})"
        iso_week_expr = f"EXTRACT(WEEK FROM {date_expr})"
        iso_dow_expr = f"EXTRACT(ISODOW FROM {date_expr})"
        day_expr = f"EXTRACT(DAY FROM {date_expr})"
        month_name_expr = f"TO_CHAR({date_expr}, 'FMMonth')"
        month_short_expr = f"TO_CHAR({date_expr}, 'Mon')"
        day_name_expr = f"TO_CHAR({date_expr}, 'FMDay')"
        year_month_expr = f"TO_CHAR({date_expr}, 'YYYY-MM')"

    expr_map = {
        "date": date_expr,
        "year": year_expr,
        "quarter": quarter_expr,
        "year_quarter": f"CONCAT(CAST({year_expr} AS STRING), '-Q', CAST({quarter_expr} AS STRING))"
            if d == "bigquery"
            else (f"CONCAT(CAST({year_expr} AS CHAR), '-Q', CAST({quarter_expr} AS CHAR))"
                  if d == "mysql"
                  else f"CAST({year_expr} AS VARCHAR) || '-Q' || CAST({quarter_expr} AS VARCHAR)"),
        "month": month_expr,
        "month_name": month_name_expr,
        "month_short": month_short_expr,
        "year_month": year_month_expr,
        "week_of_year_iso": iso_week_expr,
        "day_of_month": day_expr,
        "day_of_week_iso": iso_dow_expr,
        "day_name": day_name_expr,
        "is_weekend": f"CASE WHEN {iso_dow_expr} IN (6, 7) THEN TRUE ELSE FALSE END",
    }
    return expr_map.get(field)


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
        # Phase 4 — views whose measures must use the symmetric aggregate form
        # (Looker MD5 trick) because a SYMMETRIC-mode filter introduced a 1:N
        # join fan-out at SELECT time. Populated by _build_where_clause.
        self._symmetric_aggregate_views: Set[str] = set()
    
    def run(self, spec) -> Tuple[str, List[str], List[PivotedColumn]]:
        """Single engine entry: execute a ``SemanticQuerySpec`` (the one input
        every path compiles to via ``semantic_query_compiler``). Unpacks to
        ``generate_sql`` (which stays the internal implementation). ``spec``'s
        ``response_aliases`` / ``diagnostics`` are caller-side extras the engine
        ignores."""
        return self.generate_sql(
            explore_name=spec.explore_name,
            dimensions=list(spec.dimensions or []),
            measures=list(spec.measures or []),
            filters=dict(spec.filters or {}),
            pivots=list(spec.pivots or []),
            sorts=list(spec.sorts or []),
            limit=spec.limit if spec.limit is not None else 10_000_000,
            window_functions=list(spec.window_functions or []),
            calculated_fields=list(spec.calculated_fields or []),
            time_grains=(dict(spec.time_grains) if spec.time_grains else None),
            top_n=spec.top_n,
            measure_agg_overrides=(dict(spec.measure_agg_overrides) or None) if spec.measure_agg_overrides else None,
            model_id=spec.model_id,
            explore_id=spec.explore_id,
        )

    def generate_sql(
        self,
        explore_name: str,
        dimensions: List[str],
        measures: List[str],
        filters: Dict[str, Any],
        pivots: List[str] = None,
        sorts: List[Dict[str, str]] = None,
        # Phase-15.83 — DA dropped per-chart row caps. Default raised from
        # 500 to a 10M sentinel; `top_n` still overrides for explicit
        # "leading N" queries.
        limit: int = 10_000_000,
        window_functions: List[Dict[str, Any]] = None,
        calculated_fields: List[Dict[str, Any]] = None,
        time_grains: Dict[str, str] = None,
        top_n: Optional[Dict[str, Any]] = None,
        measure_agg_overrides: Optional[Dict[str, str]] = None,
        model_id: Optional[int] = None,
        explore_id: Optional[int] = None,
        _reanchored: bool = False,
        _disable_isolation: bool = False,
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
        self._symmetric_aggregate_views = set()
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
        # Phase 2 — stash model early so _build_where_clause can build a strict
        # (cross_filter-respecting) resolver for the propagation engine.
        # NOTE: there's another `self._model = model` later in this function
        # (kept for legacy code that may run with a different model object) —
        # this early assignment is purely for the Phase 2 propagation path.
        self._model = model
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

        # ── Diet bug #3: collapse a fanned synthetic-calendar filter to the
        # fact's PRIMARY calendar relationship (no-op unless a multi-date fact
        # was fanned). Runs before isolation/where so every path sees the
        # collapsed form; idempotent on already-clean filters.
        # `_disable_isolation` (set by the chart-runtime auto-fallback when the
        # isolated SQL errored on the datasource) reverts to the pre-isolation
        # legacy path entirely — no collapse, no isolation/re-anchor/stitch.
        if not _disable_isolation:
            filters = self._collapse_fanned_calendar_filters(filters, explore.base_view_name)

        # ── Measure isolation (base-invariance — PowerBI/Tableau standard) ──
        # A measure whose view is NOT the chart's base fact must be evaluated
        # at ITS OWN grain (an independent aggregate over its own table), not
        # LEFT-JOINed off the base — otherwise the base fact's key domain
        # scopes the measure (Tableau's "measures forget their source and adopt
        # the post-join grain"; our bug #2). We mark cross-fact measure views
        # here; `_render_measure` emits them as isolated correlated subqueries
        # and `_build_from_clause` leaves them OUT of the base JOIN chain.
        #
        # Stage-1 scope: scalar/KPI charts (no dimensions/pivots/window-fns/
        # calc-fields). This covers the reported cross-base matrix. Charts with
        # dimensions keep the legacy path for now (byte-identical) — the
        # group-by correlation lands in Stage-2.
        self._chart_filters = dict(filters or {})
        self._chart_time_grains = dict(time_grains or {})
        self._isolated_measure_views: set[str] = set()
        self._isolation_active = False
        self._isolation_explore = explore
        _stage1_scalar = (not _disable_isolation) and not (dimensions or pivots or window_functions or calculated_fields)
        if _stage1_scalar and measures:
            # Group cross-fact measures by view; isolate a view ONLY when EVERY
            # cross-fact measure on it renders as a scalar aggregate. A view with
            # any non-scalar measure (formula/percent_of_total/window) is left on
            # the legacy join path so the scalar-subquery wrap can't emit invalid
            # multi-row SQL ("Scalar subquery produced more than one element").
            _facts_all = {self._measure_fact_view(m) for m in measures}
            _cross_by_view: Dict[str, list] = {}
            for m in measures:
                mv = self._measure_fact_view(m)
                if mv != explore.base_view_name:
                    _cross_by_view.setdefault(mv, []).append(m)
            _iso = {
                mv for mv, ms in _cross_by_view.items()
                if all(self._is_scalar_isolatable_measure(m) for m in ms)
            }
            # A SINGLE cross-fact measure fact is handled by re-anchor below
            # (`SELECT agg FROM <fact>` — the FROM-base form, which BigQuery
            # accepts even when the fact's source_query has a nested WITH; the
            # scalar-subquery wrap `(SELECT agg FROM (WITH a AS (WITH b …)))`
            # is what BQ rejected — "Expected … BY but got AS"). Scalar-subquery
            # isolation is reserved for the multi-fact KPI case (≥2 measure
            # facts) where the query can't be anchored at one fact.
            if _iso and len(_facts_all) >= 2:
                self._isolated_measure_views = _iso
                self._isolation_active = True

        # ── Dimensioned chart with cross-fact measure(s) — base-invariance ──
        # Two cases (both keep the measure at its OWN grain, PowerBI/Tableau):
        #   • SINGLE measure-fact M (≠ base): RE-ANCHOR the whole query at M
        #     (reuses the full verified engine incl pivot/window/calc). Group
        #     dims/pivots unrelated to M → legacy path + warn.
        #   • MULTIPLE measure-facts (mixed base+cross, or several cross-facts):
        #     sub-generate each fact independently (re-anchored) and STITCH on
        #     the shared group dims (skeleton ∪ + NULL-safe LEFT JOINs). Pivot/
        #     window/calc with multi-fact → legacy path (deferred).
        if (
            not _disable_isolation
            and not _reanchored
            and not self._isolation_active
            and measures
        ):
            _facts = {self._measure_fact_view(m) for m in measures}
            _cross = _facts - {explore.base_view_name}
            if _cross and len(_facts) == 1:
                _m_view = next(iter(_facts))
                from app.services.semantic_join_resolver import SemanticJoinResolver as _R
                _m_resolver = _R(self.db, self._model, _m_view, bidirectional=True)  # calendar only
                _grp_views = {
                    self._parse_field_ref(g)[0]
                    for g in (list(dimensions) + list(pivots or []))
                }
                _is_cross_table = any(
                    self._parse_field_ref(mm)[0] != self._measure_fact_view(mm)
                    for mm in measures
                )
                # Relatedness via FORWARD M:1 multi-hop reach (snowflake-safe;
                # excludes another fact reached only through a 1:N chasm). NOT
                # `_direct_join_views` (1-hop wrongly marks a 2-hop snowflake dim
                # like fact→product→category as unrelated) and NOT bidirectional
                # reach (walks 1:N edges, so a chasm-reachable fact looks related).
                _m1_safe = self._m1_reachable_views(_m_view)
                _grp_unrelated = {v for v in _grp_views if v not in _m1_safe}
                if not _grp_unrelated:
                    # Every group dim is M:1-reachable from the measure's fact
                    # (incl. snowflake multi-hop).
                    if (
                        (dimensions or pivots)
                        and not _is_cross_table
                        and explore.base_view_name in _m1_safe
                        and _grp_views.issubset(_m1_safe | {explore.base_view_name})
                    ):
                        # The chart's BASE is itself on that M:1 spine (a
                        # dimension-table on the 1-side of the measure fact) and
                        # the measure is a PLAIN measure on its own view (not a
                        # cross-SOURCE measure). The NORMAL build from the base
                        # LEFT-JOINs the measure fact and GROUPs by the base dim,
                        # preserving EVERY base member (PowerBI: the dimension
                        # defines the row grain; the measure is blank for members
                        # with no fact rows — e.g. an owner with no revenue).
                        # Re-anchoring onto the measure fact would DROP those
                        # members, so fall through to the normal build (no re-
                        # anchor, no isolation; single fact joined → no fan-out).
                        #
                        # GUARD: this "preserve base members" rationale only holds
                        # when a GROUP-BY dimension actually defines the row grain.
                        # A scalar/KPI (no dimensions/pivots) has no members to
                        # preserve — leaving it on the base path makes the measure
                        # base-DEPENDENT (the base→fact join silently constrains it:
                        # e.g. a deal-grain CR shows 0.89 on a deal-based KPI but
                        # 0.86 on an owner-based KPI because the owner join drops
                        # ownerless deals). PowerBI measures are model-wide and
                        # base-invariant, so a no-dim cross-fact measure must
                        # RE-ANCHOR at its own fact grain (the else branch).
                        pass
                    else:
                        # RE-ANCHOR onto the measure fact and correlate per group
                        # (measure at its own grain, sliced by the related dim;
                        # no fan-out). Needed for a cross-SOURCE measure (its own
                        # grain / nested-WITH source) or when the base is not a
                        # dim-preserving anchor. KPI (no dims) also lands here.
                        _cal_view = self._find_calendar_dim_for_measure(_m_resolver, _m_view)
                        _rebound = self._rebind_calendar_filters(dict(filters or {}), _cal_view)
                        return self.generate_sql(
                            explore_name=_m_view,
                            dimensions=dimensions,
                            measures=measures,
                            filters=_rebound,
                            pivots=pivots,
                            sorts=sorts,
                            limit=limit,
                            window_functions=window_functions,
                            calculated_fields=calculated_fields,
                            time_grains=time_grains,
                            top_n=top_n,
                            measure_agg_overrides=measure_agg_overrides,
                            model_id=getattr(self._model, "id", None),
                            _reanchored=True,
                        )
                elif (
                    _is_cross_table
                    and _grp_unrelated == _grp_views
                    and all(self._is_scalar_isolatable_measure(mm) for mm in measures)
                ):
                    # EVERY group dim is UNRELATED to the measure's source fact
                    # (chasm). PowerBI leaves the measure UNFILTERED by an
                    # unrelated dim → its total repeats per group. Reproduce that
                    # by ISOLATING the measure (uncorrelated aggregate over its
                    # own table) while the base supplies the dim — NO legacy
                    # fan-out. Falls through to the normal build below.
                    self._isolated_measure_views = {_m_view}
                    self._isolation_active = True
                else:
                    # MIXED (some related + some unrelated dims), or a non-scalar
                    # measure with an unrelated dim, or a non-cross-table measure
                    # that can't re-anchor onto an unrelated dim. The legacy
                    # single-FROM build would JOIN through a chasm and FAN OUT →
                    # FAIL LOUD (wrong number must never render).
                    raise ValueError(
                        f"Measure trên bảng '{_m_view}' không thể nhóm/cắt theo dimension "
                        f"{sorted(_grp_unrelated)} một cách an toàn (không có đường M:1 — "
                        f"JOIN sẽ fan-out, ra số sai). Thêm/sửa quan hệ trong Data Model, "
                        f"đổi dimension, hoặc qualify field."
                    )
            elif (
                _cross and len(_facts) >= 2
                and dimensions
                and not pivots and not window_functions and not calculated_fields
            ):
                _stitched = self._build_dimensioned_multifact_sql(
                    explore, dimensions, measures, filters, time_grains,
                    limit, measure_agg_overrides,
                )
                if _stitched is not None:
                    return _stitched
                # else fall through to the fail-loud guard below (NOT legacy)

        # ── FAIL-LOUD: an unhandled multi-fact chart must NOT reach the legacy
        # single-FROM build. If the measures span ≥2 distinct FACT grains and
        # none of the safe paths above took it (scalar isolation for KPIs,
        # re-anchor for a single cross-fact, or the dimensioned stitch — which
        # returns None when a fact can't relate to a group dim), the legacy
        # build below would JOIN those facts and FAN OUT (deals × revenue rows)
        # → a silently inflated SUM. There is no correct number, so RAISE rather
        # than render a wrong one. (Re-anchored sub-calls carry a single fact, so
        # len<2 never trips them; single-fact charts are unaffected.)
        if not _reanchored and not self._isolation_active and measures:
            _fact_grains = {self._measure_fact_view(m) for m in measures}
            if len(_fact_grains) >= 2:
                raise ValueError(
                    "Không thể tính các measure từ nhiều bảng fact "
                    f"({', '.join(sorted(_fact_grains))}) theo cấu hình chart này "
                    "một cách an toàn — thiếu relationship / ambiguous path, hoặc "
                    "chart dùng pivot/window/calc cùng measure đa-fact. JOIN các "
                    "fact sẽ fan-out và nhân SUM lên, nên engine từ chối render số "
                    "sai. Hãy thêm/sửa quan hệ trong Data Model, đổi dimension, "
                    "hoặc tách thành nhiều chart."
                )

        # ── STRICT GRAIN (PowerBI): a measure may only be grouped/pivoted by a
        # dimension on its OWN fact or one M:1-reachable from it. A dim on
        # ANOTHER fact (reachable only via a shared dim = chasm) forces a
        # fan-out JOIN that double-counts the measure — e.g. revenue grouped by
        # deal.title via the owner/date chasm gave 4000/3600 (NON-deterministic)
        # vs the true 2400. Fail loud rather than render a silently-wrong number.
        # Skipped under isolation (a cross-table scalar measure grouped by an
        # UNRELATED dim is intentionally a repeated total — PBI semantics, not a
        # fan-out). The multi-fact STITCH (≥2 measure facts) and re-anchor/
        # isolate paths handle their own grain above, so this guards exactly the
        # single-fact-grain normal build that the dispatch left untouched. KPIs
        # (no group dims) + filters (EXISTS, not a grouping JOIN) are unaffected.
        if not self._isolation_active:
            self._validate_group_grain(dimensions, pivots, measures)

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
        
        # Phase-B' (PBI-parity rework) — separate SELECT-side views (those
        # projected via dimensions / measures / pivots / sorts / windows /
        # calc) from views referenced ONLY by filters. Only SELECT-side
        # views (+ base + the hops needed to reach them) enter the FROM
        # JOIN chain. Filter-only views are applied as EXISTS subqueries so
        # filtering a fact through a shared dimension to another fact's
        # column doesn't fan out and double-count the measure.
        def _views_of(refs) -> set[str]:
            out: set[str] = set()
            for ref in refs:
                if ref and isinstance(ref, str) and "." in ref:
                    try:
                        out.add(self._parse_field_ref(ref)[0])
                    except ValueError:
                        pass
            return out

        # NOTE: measures are intentionally NOT folded into `select_side_refs`
        # (whose `_views_of` would key them by their DECLARED view). Measure
        # views are added below via `_measure_fact_view`, which returns the
        # source-column view for a cross-table measure — so a cross-table
        # ``SUM(${B.col})`` declared on base view A contributes B (not A) and
        # we don't spuriously JOIN A, which would fan-out B and inflate the SUM.
        select_side_refs: List[str] = list(dimensions) + list(pivots)
        select_side_refs.extend(
            str(sort.get("field") or "") for sort in sorts if sort.get("field")
        )
        for wf in window_functions:
            base_measure = str(wf.get("base_measure") or "").strip()
            if base_measure:
                select_side_refs.append(base_measure)
            select_side_refs.extend(str(i or "").strip() for i in (wf.get("partition_by") or []) if str(i or "").strip())
            select_side_refs.extend(str(i or "").strip() for i in (wf.get("order_by") or []) if str(i or "").strip())
        for cf in calculated_fields:
            select_side_refs.extend(
                re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\}", str(cf.get("sql") or ""))
            )
        # Isolated (cross-fact) measure views are evaluated as their own
        # subqueries — keep them OUT of the base FROM/JOIN chain so the base
        # can't scope them.
        # Include each measure's TRUE fact view (the `source_columns` view for
        # a cross-table measure declared on the base) so the FROM/JOIN chain
        # actually contains the table the measure aggregates — otherwise a
        # cross-table ``SUM(${B.col})`` references B against a table not in
        # FROM → "Unrecognized name: B". (Re-anchor handles the clean cases
        # above; this covers the legacy fall-through where re-anchor declined.)
        # BUG-007 (2026-06-11): also pull in each dataset-scope measure's
        # declared source_columns views. _measure_fact_view re-anchors a
        # SINGLE-foreign-view measure to that view, but a MIXED-grain measure
        # (references base col + foreign col, e.g. `${quantity}/${B.price}`)
        # stays on the declared view — and then the foreign view B was never
        # added to the FROM/JOIN chain → "Unrecognized name: B". Adding the
        # source_columns views here guarantees the JOIN reaches them in BOTH
        # cases. (Isolated views are subtracted right after, as before.)
        measure_source_views: set[str] = set()
        for m in measures:
            try:
                decl_view, fld = self._parse_field_ref(m)
            except ValueError:
                continue
            mv = self.views_cache.get(decl_view) or self._get_view_for_node(decl_view)
            mdef = next(
                (md for md in (mv.measures or [])
                 if md.get("name") == fld or md.get("sql_name") == fld),
                None,
            )
            if not mdef or str(mdef.get("scope") or "view") != "dataset":
                continue
            for entry in mdef.get("source_columns") or []:
                sv = str(entry.get("view") or "").strip() if isinstance(entry, dict) else ""
                if sv:
                    measure_source_views.add(sv)

        select_side_views = (
            _views_of(select_side_refs)
            | {explore.base_view_name}
            | {self._measure_fact_view(m) for m in measures}
            | measure_source_views
        ) - self._isolated_measure_views
        filter_views = _views_of(list((filters or {}).keys()))

        # When EVERY measure is isolated and there are no base-side projections,
        # the outer query needs no base table at all — `SELECT (sq1), (sq2)`
        # returns exactly one row and is maximally base-invariant. Otherwise the
        # base aggregate (single-fact measures) collapses the base to one row and
        # the isolated subqueries ride alongside as scalars.
        _all_measures_isolated = bool(measures) and all(
            self._measure_fact_view(m) in self._isolated_measure_views
            for m in measures
        )
        _omit_from = (
            self._isolation_active
            and _all_measures_isolated
            and not dimensions and not pivots
        )

        # Build FROM/JOIN clause (only SELECT-side views + base + hops).
        if _omit_from:
            from_clause = ""
            joined_nodes = {explore.base_view_name}
        else:
            from_clause, joined_nodes = self._build_from_clause(
                explore, target_views=select_side_views,
            )
        # Filter views that never made it into the FROM chain → EXISTS.
        exists_views = filter_views - joined_nodes

        # Phase-B' (PBI-parity rework) — split filters into WHERE (on
        # dimension fields, applied pre-aggregation) and HAVING (on
        # measure fields, applied post-aggregation). The split is
        # purely additive: a filter is classified as HAVING ONLY if its
        # field_ref is in the measures list. Anything else stays in
        # WHERE, preserving prior behavior for the common case.
        # See docs/filter-semantics.md §4.
        if _omit_from:
            # No base table → no outer predicates; every filter is bound to the
            # measure's grain inside its isolated subquery (see _render_measure).
            where_clause = ""
            having_clause = ""
        else:
            where_filters, having_filters = self._split_filters_by_role(
                filters, measures,
            )
            where_clause = self._build_where_clause(
                where_filters, time_grains,
                exists_views=exists_views,
                explore=explore,
                select_side_views=select_side_views,
                joined_nodes=joined_nodes,
            )
            having_clause = self._build_having_clause(
                having_filters, time_grains,
                measure_agg_overrides=measure_agg_overrides or {},
            )

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
        ]
        if from_clause:
            sql_parts.append(from_clause)

        if where_clause:
            sql_parts.append(where_clause)

        if group_by_clause:
            sql_parts.append(group_by_clause)

        # Phase-B' — HAVING must follow GROUP BY (SQL grammar requires it).
        # Inserted only when there are measure-side filters; otherwise the
        # query is identical to the pre-Phase-B' shape.
        if having_clause:
            sql_parts.append(having_clause)

        if order_by_clause:
            sql_parts.append(order_by_clause)
        
        if limit_clause:
            sql_parts.append(limit_clause)
        
        sql = "\n".join(sql_parts)

        # Phase-15.58 — log compiled SQL + input role refs so DA can
        # grep `semantic_emit` in backend logs to verify whether a
        # "Column X is ambiguous" came from un-aliased SQL emission
        # vs upstream chart config drift.
        logger.info(
            "semantic_emit explore=%s dims=%s measures=%s pivots=%s sql=%s",
            explore_name,
            list(dimensions),
            list(measures),
            list(pivots),
            sql.replace("\n", " ")[:1500],
        )

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

        Phase-15.53: if any field_ref is BARE (no view prefix), we can't
        know which view owns it without loading every candidate first.
        Load the explore's full view set so `_parse_field_ref` (which
        scans views_cache) can resolve or report a clean ambiguity.
        """
        has_bare = any('.' not in ref for ref in field_refs if ref)
        node_ids: set[str] = set()
        for field_ref in field_refs:
            if '.' in field_ref:
                node_id, _ = self._parse_field_ref(field_ref)
                node_ids.add(node_id)

        if has_bare and self._resolver is not None:
            # Pull every view the resolver can reach from the base view —
            # that is, every view the explore could possibly JOIN. Loading
            # them all means `_parse_field_ref` sees the full candidate
            # set when resolving a bare `name` reference.
            try:
                for v in self._resolver.reachable_nodes():
                    node_ids.add(v)
            except Exception:  # noqa: BLE001 — best effort, fall through
                pass

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
        from_clause, _ = self._build_from_clause(explore)
        where_clause = self._build_where_clause(filters, {})
        
        query = f"SELECT DISTINCT {dim_sql} AS pval {from_clause}"
        if where_clause:
            query += f" {where_clause}"
        # Phase-15.83 — was LIMIT 100 (pivot/breakdown distinct values).
        # FE pivotByBreakdown still caps at 12 visible series, but here we
        # lift the SQL cap to 10000 so very wide pivots (regional codes,
        # product SKUs) reach the FE intact for the user to filter down.
        query += " ORDER BY pval LIMIT 10000"
        
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

        # Phase-15.61 — auto-qualify bare-identifier custom SQL with
        # ${TABLE}. Old dim definitions may have `sql = "name"` (bare
        # column name) instead of `sql = "${TABLE}.name"`. In multi-
        # view queries (JOINs) BigQuery rejects the unqualified column
        # as ambiguous when 2+ joined views share a column name. Detect
        # the bare-identifier case and prepend the placeholder so the
        # template still routes through view_alias substitution.
        raw_sql = dim_def.get('sql')
        stripped = (raw_sql or "").strip()
        # Bare column reference (no SQL expression / placeholder) → qualify with
        # the view alias and QUOTE the column if its name has spaces/special
        # chars. Plain names ('subject') render byte-identically to before;
        # names like 'Activity Group' were previously emitted raw + unquoted
        # ("Activity Group AS …"), which BigQuery rejects ("Expected … BY but
        # got AS"). When sql is empty, the column is the dimension's own name.
        if not stripped:
            return f"{view_alias}.{self._quote_ident(field_name)}"
        if "${" not in stripped and re.fullmatch(r"[A-Za-z_][\w ]*", stripped):
            return f"{view_alias}.{self._quote_ident(stripped)}"
        return self._render_sql_template(raw_sql, view_alias)
    
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
    
    def _render_symmetric_aggregate(
        self,
        view_name: str,
        base_sql: str,
        measure_type: str,
    ) -> Optional[str]:
        """Render the Looker-style symmetric aggregate form for SUM/COUNT/AVG.

        Phase 4 — defends against fan-out double-counting when a SYMMETRIC
        propagation mode (filter target is SELECT-side across a 1:N hop) was
        decided by the Phase-2 engine. The Looker trick:

          symmetric_sum(value)  = SUM(DISTINCT hash(pk) + value) - SUM(DISTINCT hash(pk))
          symmetric_count(*)    = COUNT(DISTINCT pk)
          symmetric_avg(value)  = symmetric_sum(value) / symmetric_count(value)

        Each row's PK is hashed into a wide enough integer that adding the
        measured value can't collide with another row's hash. DISTINCT then
        deduplicates the fan-out introduced by the JOIN before the aggregate
        sees it.

        Returns ``None`` to signal the caller should fall back to the legacy
        aggregate when any of these are true:
          * ``FEATURE_SYMMETRIC_AGGREGATES`` flag is OFF.
          * The view is not in ``self._symmetric_aggregate_views``.
          * The view has no declared ``primary_key``.
          * ``measure_type`` is not ``sum`` / ``count`` / ``avg``.
          * The active dialect is not one we have a hash recipe for.
        """
        from app.core.config import settings as _settings
        if not bool(getattr(_settings, "FEATURE_SYMMETRIC_AGGREGATES", False)):
            return None
        # Phase 4.3 — dialect allow-list. The Looker form is empirically 53×
        # SLOWER than EXISTS on Postgres (see memory). Default allow-list is
        # bigquery-only; admins opt-in to other dialects via env var.
        _allowed = {
            d.strip().lower()
            for d in str(
                getattr(_settings, "FEATURE_SYMMETRIC_AGGREGATES_DIALECTS", "") or ""
            ).split(",")
            if d.strip()
        }
        if _allowed and (self.database_type or "").lower() not in _allowed:
            return None
        sym_views = getattr(self, "_symmetric_aggregate_views", None) or set()
        if view_name not in sym_views:
            return None
        if measure_type not in {"sum", "count", "avg"}:
            return None
        view = self.views_cache.get(view_name)
        if view is None:
            return None
        pk_cols = list(getattr(view, "primary_key", None) or [])
        if not pk_cols:
            # Phase-2 should have DROPped with NO_PRIMARY_KEY before reaching
            # us; defensive fallback if the model changed mid-request.
            return None

        # Build the PK reference. Single column → CAST(view.col AS VARCHAR);
        # composite → '|'-separated CAST concat. The hash function below
        # treats the result as a text key.
        pk_refs = [f"{view_name}.{col}" for col in pk_cols]
        if len(pk_refs) == 1:
            pk_text = f"CAST({pk_refs[0]} AS VARCHAR)"
        else:
            joined = " || '|' || ".join(f"CAST({r} AS VARCHAR)" for r in pk_refs)
            pk_text = f"({joined})"

        # Hash + multiplier choice per dialect. The multiplier keeps the
        # row's value and the per-row hash in DISJOINT decimal positions in
        # the encoded NUMERIC, so two rows with different (pk, value) pairs
        # can never collapse to the same encoded number under DISTINCT.
        # See R-P4-2 in docs/phases/phase-4-symmetric-aggregates.md.
        dialect = (self.database_type or "").lower()
        if dialect == "bigquery":
            # FARM_FINGERPRINT → INT64 (~±9.2e18). Multiplier 1e18 keeps the
            # value (assumed |v| < 1e18 for any realistic metric) in lower
            # decimal positions. Final encoded value fits NUMERIC (38 digits).
            hash_expr = f"FARM_FINGERPRINT({pk_text})"
            hash_mult = "1e18"
        elif dialect in ("postgresql", "postgres"):
            # MD5 first 60 bits → bigint (~±1.15e18). Multiplier 1e15 is
            # conservative enough for any realistic metric (|v| < 1e15) and
            # the product fits Postgres NUMERIC (arbitrary precision).
            hash_expr = (
                f"(('x' || SUBSTRING(MD5({pk_text}) FROM 1 FOR 15))::bit(60)::bigint)"
            )
            hash_mult = "1e15"
        elif dialect == "mysql":
            hash_expr = f"CONV(SUBSTRING(MD5({pk_text}), 1, 15), 16, 10)"
            hash_mult = "1e15"
        elif dialect == "duckdb":
            hash_expr = f"hash({pk_text})"
            hash_mult = "1e15"
        else:
            return None

        # COUNT is the cheap case — counting distinct PKs equals counting
        # distinct rows pre-fan-out. Filtered COUNT gates on the prebuilt
        # CASE expression so only filter-passing rows participate.
        if measure_type == "count":
            if base_sql.strip() == "*":
                return f"COUNT(DISTINCT {pk_text})"
            return f"COUNT(DISTINCT CASE WHEN {base_sql} IS NOT NULL THEN {pk_text} END)"

        # SUM — Looker symmetric form:
        #   encoded   = CAST(value AS NUMERIC) + CAST(hash AS NUMERIC) * MULT
        #   sym_sum   = SUM(DISTINCT encoded) - SUM(DISTINCT hash*MULT)
        # COALESCE(value, 0) avoids NULL → NULL encoded values (DISTINCT would
        # lump all NULL rows into one bucket and lose the hash signal).
        hash_part = f"(CAST({hash_expr} AS NUMERIC) * {hash_mult})"
        encoded = f"(COALESCE(CAST({base_sql} AS NUMERIC), 0) + {hash_part})"
        sym_sum = f"(SUM(DISTINCT {encoded}) - SUM(DISTINCT {hash_part}))"
        if measure_type == "sum":
            return sym_sum

        # AVG = symmetric SUM / symmetric COUNT (only counting rows where the
        # measured value is non-null — matches plain AVG semantics).
        sym_count = (
            f"COUNT(DISTINCT CASE WHEN {base_sql} IS NOT NULL THEN {pk_text} END)"
        )
        return f"({sym_sum}) / NULLIF({sym_count}, 0)"

    def _measure_value_is_string_typed(
        self,
        sql_template: str,
        view,
        measure_type: str,
        *,
        has_expression: bool,
        has_depends_on: bool,
    ) -> bool:
        """True when a SUM/AVG measure aggregates a single column that is
        PHYSICALLY stored as text.

        Airbyte / Google-Sheets / CSV sources land numeric data as physical
        STRING. A declared SUM measure (or an ad-hoc SUM of a numeric-looking
        text column) then emits ``SUM(<string col>)`` and BigQuery / most
        engines reject it with "No matching signature for aggregate function
        SUM Argument types: STRING". The caller SAFE_CASTs the value so the
        analyst's modeled numeric intent works — mirroring the filter-path
        coercion in ``live_query_service._build_where_clause`` (SAFE_CAST is a
        no-op on genuine numerics and yields NULL on real text, never a type
        error).

        Keys on the dimension's recorded PHYSICAL type (``source_type``), not
        its value-sampled semantic ``type``: the cache's ``type`` is inferred
        from sample VALUES, so a physically-STRING column whose values look
        numeric (e.g. Airbyte's ``quantity``) is mislabelled ``number`` and
        would otherwise emit ``SUM(STRING)`` → 400. Genuinely numeric columns
        (physical INT64/NUMERIC/FLOAT) are never cast, so their SQL stays
        byte-identical. Falls back to the semantic ``type`` only when no
        physical type was recorded (legacy caches built before this field),
        preserving the prior behaviour there.

        Only simple single-column measures are eligible: ``expression`` /
        ``depends_on`` / ``*`` / cross-view ``${view.field}`` refs are left
        byte-identical.
        """
        if measure_type not in ("sum", "avg"):
            return False
        if has_expression or has_depends_on:
            return False
        col = (sql_template or "").strip()
        if not col or col == "*":
            return False
        if col.startswith("${TABLE}."):
            col = col[len("${TABLE}."):].strip()
        # Only a bare column identifier — anything else is an expression or a
        # cross-view reference we must not blindly cast.
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", col):
            return False
        dim = next(
            (d for d in (getattr(view, "dimensions", None) or []) if d.get("name") == col),
            None,
        )
        if not dim:
            return False
        # Physical string-family storage types across supported warehouses
        # (BigQuery STRING, Postgres text/varchar/char, MySQL char/varchar/…).
        _STRING_PHYSICAL = {
            "string", "text", "varchar", "char", "nvarchar", "nchar",
            "character varying", "character", "bpchar", "clob", "str", "utf8",
        }
        source_type = str(dim.get("source_type") or "").strip().lower()
        if source_type:
            return source_type in _STRING_PHYSICAL
        # Legacy cache without a recorded physical type: fall back to the
        # value-sampled semantic type (only catches columns modeled `string`).
        return str(dim.get("type") or "").lower() == "string"

    def _field_rejects_pattern_operator(self, field_ref: str) -> bool:
        """True when a LIKE/pattern operator can't apply to ``field_ref``'s column.

        PowerBI parity (2026-06): a ``contains`` / ``starts_with`` / ``ends_with``
        filter on a DATE or numeric column is meaningless — Postgres rejects
        ``date LIKE '%x%'`` outright (``operator does not exist: date ~~ text``),
        so emitting it 500s the whole chart with a misleading "cardinality
        relationship sai" hint (the DA's date-``contains`` crash). The FE filter
        UIs already gate operators by type, so this only fires on a legacy saved
        filter or a programmatic/API caller. We detect it on the column's recorded
        PHYSICAL type (``source_type``) and let the caller soft-drop the filter
        (reason ``unsupported_operator``) instead of building invalid SQL.

        Returns False (allow) whenever the type is unknown / text-like, so the
        common case stays byte-identical and we never reject a legitimate LIKE.
        """
        try:
            view_name, col = self._parse_field_ref(field_ref)
        except ValueError:
            return False
        view = self.views_cache.get(view_name) or self._get_view_for_node(view_name)
        if view is None:
            return False
        dim = next(
            (d for d in (getattr(view, "dimensions", None) or []) if d.get("name") == col),
            None,
        )
        if not dim:
            return False
        # Type families where LIKE is invalid SQL. Text-like and unknown types
        # are intentionally NOT listed (allow the operator).
        _NON_TEXT_TYPES = {
            "date", "datetime", "timestamp", "timestamptz", "time",
            "int", "integer", "int64", "bigint", "smallint", "tinyint",
            "float", "float64", "double", "double precision", "real",
            "numeric", "decimal", "number", "bool", "boolean",
        }
        source_type = str(dim.get("source_type") or "").strip().lower()
        if source_type:
            return source_type in _NON_TEXT_TYPES
        # Legacy cache without a physical type — fall back to the value-sampled
        # semantic `type`, but ONLY for DATE/TIME families. A sampled `number`
        # is unreliable: Airbyte/Sheets store numeric-looking text as physical
        # STRING but the sampler labels it `number`; blocking `contains` there
        # would wrongly reject a legitimate text LIKE (see the Airbyte STRING
        # numeric-filter case). Date detection (ISO match) is reliable, and LIKE
        # on a date is ALWAYS invalid SQL, so only dates are safe to block here.
        _DATE_TYPES = {"date", "datetime", "timestamp", "timestamptz", "time"}
        return str(dim.get("type") or "").strip().lower() in _DATE_TYPES

    def _render_measure(
        self,
        field_ref: str,
        *,
        agg_override: Optional[str] = None,
        _stack: Optional[Set[str]] = None,
        active_dimensions: Optional[List[str]] = None,
        _isolate: bool = True,
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

        # ── Measure isolation (base-invariance) ──
        # When this measure's view is cross-fact (≠ base) and isolation is
        # active, emit it as an independent aggregate over its OWN table rather
        # than `AGG(base_join_alias.col)`. `_isolate=False` (set when the
        # subquery builder re-enters to render the inner plain aggregate, and
        # by ratio-measure recursion) keeps the legacy path. Single-fact and
        # non-scalar charts never set `_isolation_active` → byte-identical.
        if (
            _isolate
            and getattr(self, "_isolation_active", False)
            and self._measure_fact_view(field_ref) in getattr(self, "_isolated_measure_views", set())
        ):
            return self._build_isolated_measure_subquery(
                field_ref, agg_override=agg_override,
            )

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

            # SUM/AVG need numeric input. A `string` column is allowed through
            # here: Airbyte/Sheets/CSV store numbers as text, and the aggregate
            # emitter SAFE_CASTs string values to numbers (see
            # `_measure_value_is_string_typed`). Genuinely non-numeric types
            # (date / boolean / etc.) still fail loud — casting them to a number
            # would silently produce NULLs, which is more confusing than a clear
            # "pick a different aggregation" message.
            NUMERIC_ONLY_AGGS = {"sum", "avg"}
            if (
                requested_agg in NUMERIC_ONLY_AGGS
                and not is_numeric_dim
                and dim_type != "string"
            ):
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
        # Phase-15.29: for non-count measures, both empty is now caught at
        # schema-validation time. We keep the count→'*' default here (legacy
        # measures that pre-date the validator still need to render); any
        # non-count measure that slipped through historically will fail loudly
        # at SQL execution rather than silently aggregating the wrong column.
        raw_template = expression_template or measure_def.get('sql')
        if not raw_template:
            if measure_type == "count":
                sql_template = '*'
            else:
                raise ValueError(
                    f"Measure '{measure_def.get('name','?')}' type='{measure_type}' "
                    "has no `sql` or `expression`. Cannot compile aggregate without "
                    "a column reference. Fix the measure definition (set "
                    "sql='${TABLE}.<column>') or change type to 'count'."
                )
        else:
            sql_template = raw_template

        # Phase-15.81 v9 — auto-qualify bare-identifier measure templates
        # with ${TABLE}, mirroring the Phase-15.61 fix on the dimension
        # path. Legacy measures stored as `sql = "user_id"` rendered as
        # the bare column name; when a dashboard filter triggered an
        # extra JOIN (linkedFields fan-out across tables that share a
        # column name like `user_id`), BigQuery raised
        # "Column name X is ambiguous". Explore worked because no extra
        # JOIN happened. Detect the bare-identifier case and prepend the
        # placeholder so view_alias substitution kicks in.
        if (
            sql_template
            and sql_template != '*'
            and "${TABLE}" not in sql_template
            and "${" not in sql_template  # skip ${view.field} cross-refs
            and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", sql_template.strip())
        ):
            sql_template = f"${{TABLE}}.{sql_template.strip()}"

        # Phase-15.30: Path-C guard. An expression with an aggregate call
        # but no depends_on would get wrapped in this method's outer
        # aggregate (e.g. AVG(SUM(...)/COUNT(...))) and yield wrong numbers.
        # Catch it here and fail loud — the schema/MCP layers also reject
        # this, but the engine is the last line of defence for legacy rows.
        if expression_template and not depends_on:
            expr_upper = expression_template.upper()
            if any(
                f"{fn}(" in expr_upper
                for fn in ("SUM", "AVG", "COUNT", "MIN", "MAX")
            ):
                raise ValueError(
                    f"Measure '{measure_def.get('name','?')}' expression "
                    "contains an aggregate function but depends_on is empty. "
                    "The engine would wrap this in an outer aggregate "
                    f"({measure_type.upper()}(...)) producing double-aggregation. "
                    "Fix by (a) removing the inner aggregate so `type` "
                    "applies it once, or (b) splitting into named measures "
                    "and listing them in depends_on (ratio-measure pattern)."
                )

        base_sql = self._render_sql_template(sql_template, view_name)

        # Numeric aggregate over a STRING-typed column. Airbyte / Google-Sheets
        # / CSV sources store numbers as text; SUM/AVG of that column otherwise
        # emits SUM(STRING) → BigQuery 400 ("No matching signature for SUM
        # Argument types: STRING"). SAFE_CAST the value to a number — no-op on
        # genuine numerics (SQL byte-identical), NULL on real text, never a
        # type error. Same coercion the filter path uses (live_query_service).
        if self._measure_value_is_string_typed(
            sql_template,
            view,
            measure_type,
            has_expression=bool(expression_template),
            has_depends_on=bool(depends_on),
        ):
            from app.services.type_override_service import build_safe_cast_sql
            base_sql = build_safe_cast_sql(
                base_sql, "float", (self.database_type or "").lower(),
            )

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
            # [pbi-filter] confirm declared-measure where_sql/filters got
            # applied for this query. Charts that route to the legacy live
            # builder will NOT log this line — that asymmetry was the source
            # of the "chart preview vs dashboard differ" reports for
            # measures like ``Lead nhận Marketing`` with internal predicates.
            # ``chart_id`` read from the contextvar set by
            # ``chart_service.get_chart_data`` so DA can grep one tile.
            # Temporary instrumentation.
            try:
                from app.services.chart_service import _pbi_current_chart_id
                _pbi_cid = _pbi_current_chart_id()
            except Exception:
                _pbi_cid = None
            logger.info(
                "[pbi-filter] measure-filter applied chart_id=%s view=%s measure=%s type=%s where=%s",
                _pbi_cid,
                view_name,
                measure_def.get("name"),
                measure_type,
                filter_sql,
            )

        # Phase 4 — when a SYMMETRIC propagation result for this base view was
        # recorded by _build_where_clause AND the feature flag is on AND the
        # view has a declared primary_key, dedupe fan-out via the Looker MD5
        # trick before aggregating. The helper returns None for any reason
        # ("not symmetric", "no PK", "flag off", "unknown dialect", ...) and
        # we fall through to the legacy aggregate path. Context modifiers
        # (Phase-14 window aggregates) are NOT compatible with the symmetric
        # form — when both are present, symmetric wins (correctness over the
        # OVER clause, which can't preserve PK identity).
        _symmetric_sql = self._render_symmetric_aggregate(
            view_name, base_sql, measure_type,
        )
        if _symmetric_sql is not None:
            return _symmetric_sql

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

    def _is_scalar_isolatable_measure(self, field_ref: str) -> bool:
        """A measure can be wrapped as a scalar isolation subquery ONLY if it
        renders to a SINGLE-ROW scalar aggregate. The non-AGG-wrapped renders in
        `_render_measure` are: formula/ratio measures (``depends_on`` — may emit
        a bare dimension column), ``percent_of_total`` (emits ``… OVER ()``), and
        ``context_modifiers`` (emit a window ``AGG(…) OVER (…)``). Each yields
        MULTIPLE rows inside ``(SELECT … FROM t)`` → BigQuery "Scalar subquery
        produced more than one element". Those measures are NOT isolated (they
        keep the legacy join path); only plain aggregates (sum/count/avg/min/
        max/count_distinct, incl. filtered CASE-WHEN measures) are isolatable.
        """
        try:
            view_name, field_name = self._parse_field_ref(field_ref)
            view = self.views_cache.get(view_name) or self._get_view_for_node(view_name)
        except Exception:
            return False
        measures = getattr(view, "measures", None) or []
        mdef = next(
            (m for m in measures if isinstance(m, dict) and m.get("name") == field_name),
            None,
        )
        if mdef is None:
            # Implicit measure (a numeric dimension dragged into Values) →
            # synthesised as a plain AGG(column) → always scalar.
            return True
        if str(mdef.get("type") or "").lower() == "percent_of_total":
            return False
        if mdef.get("depends_on"):
            return False
        if mdef.get("context_modifiers"):
            return False
        return True

    def _build_isolated_measure_subquery(
        self,
        field_ref: str,
        *,
        agg_override: Optional[str] = None,
    ) -> str:
        """Render a cross-fact measure as an isolated aggregate over its OWN
        table (base-invariance). The chart's filters are bound to the measure's
        grain:

          * filter on the measure's own view  → direct predicate on its alias;
          * filter on a RELATED view           → EXISTS / key-equality via a
            resolver re-rooted at the measure view (so e.g. a calendar filter
            binds to the measure's single event-date column — diet bug #3 — and
            an owner.Team filter binds to ``deal.sdr_key = owner.sdr_key``);
          * filter on an UNRELATED view         → dropped with a warning (per
            product decision: never emit a silently-wrong number).

        The inner aggregate is produced by re-entering ``_render_measure`` with
        ``_isolate=False`` so all existing logic (filtered measures, symmetric
        aggregates, formula measures) is reused verbatim.
        """
        # Aggregate over the measure's GRAIN view: for a CROSS-TABLE measure
        # (declared on view A, expression sums ${B.col}) that is B, not A —
        # otherwise the body would be `SELECT AGG(B.col) FROM A` and reference
        # B against a table not in its own FROM. For a normal cross-fact
        # measure `_measure_fact_view` returns the declared view (unchanged).
        view_name = self._measure_fact_view(field_ref)
        view = self.views_cache.get(view_name) or self._get_view_for_node(view_name)
        m_table = view.sql_table_name or view_name

        plain_agg = self._render_measure(
            field_ref, agg_override=agg_override, _isolate=False,
        )

        where_sql = ""
        filters = self._chart_filters or {}
        if filters:
            from app.services.semantic_join_resolver import SemanticJoinResolver as _R
            m_resolver = _R(self.db, self._model, view_name, bidirectional=True)
            reachable = m_resolver.reachable_nodes()

            # ── Calendar re-binding (diet bug #3 + perf) ──
            # chart_service rewrites a calendar/Date filter onto the CHART
            # BASE fact's date column(s) (base-centric). For an isolated
            # measure the base ≠ measure fact, so that base column is the
            # wrong grain and, worse, binding it into this subquery forces an
            # expensive multi-hop EXISTS (the activity/meeting/revenue timeout).
            # We undo that premature base-fan: any filter carrying calendar
            # metadata is re-pointed at the MAIN calendar dim, so the generic
            # EXISTS builder binds it via the measure→Date edge on ONE event-
            # date column (the cheap path that already makes base=Date correct).
            cal_view = self._find_calendar_dim_for_measure(m_resolver, view_name)
            filters = self._rebind_calendar_filters(filters, cal_view)
            if cal_view:
                reachable = m_resolver.reachable_nodes()

            bound_filters: Dict[str, Any] = {}
            for f_ref, f_def in filters.items():
                f_view, _ = self._parse_field_ref(f_ref)
                if f_view == view_name or f_view in reachable:
                    bound_filters[f_ref] = f_def
                else:
                    self.warnings.append(
                        f"Filter '{f_ref}' không liên quan tới measure '{field_ref}' "
                        f"(bảng '{view_name}') — bỏ qua để tránh số sai âm thầm."
                    )

            if bound_filters:
                # Related (non-own) views → EXISTS; own-view filters → direct
                # predicates. Re-root the resolver at the measure view so the
                # EXISTS correlation anchors to THIS measure's grain.
                exists_views = {
                    self._parse_field_ref(fr)[0]
                    for fr in bound_filters
                    if self._parse_field_ref(fr)[0] != view_name
                }
                _saved_resolver = self._resolver
                self._resolver = m_resolver
                try:
                    where_sql = self._build_where_clause(
                        bound_filters,
                        self._chart_time_grains or {},
                        exists_views=exists_views,
                        explore=self._isolation_explore,
                        select_side_views={view_name},
                        joined_nodes={view_name},
                    )
                finally:
                    self._resolver = _saved_resolver

        body = f"SELECT {plain_agg} FROM {m_table} AS {view_name}"
        if where_sql:
            body += f"\n{where_sql}"
        return f"({body})"

    def _find_calendar_dim_for_measure(self, m_resolver, m_view: str) -> Optional[str]:
        """Return the node-id of the MAIN calendar dimension reachable from the
        measure view, or None. The calendar spine is a ``GENERATE_DATE_ARRAY``
        source; the standalone "Date" dim (no role-played ``__…_date_dim``
        suffix) is preferred over per-column role-played date dims, and the
        shortest path wins ties."""
        best_node = None
        best_score = None
        for node in m_resolver.reachable_nodes():
            if node == m_view:
                continue
            vname = m_resolver.view_for_node(node) or node
            view = self.views_cache.get(node) or self._find_view_by_name(vname)
            if view is None:
                continue
            src = (
                (getattr(view, "sql_table_name", "") or "")
                + " "
                + (getattr(view, "source_query", "") or "")
            ).upper()
            if "GENERATE_DATE_ARRAY" not in src:
                continue
            is_role_played = "__" in node and node.endswith("_date_dim")
            path = m_resolver.resolve_path(node)
            depth = len(path.steps) if path else 99
            score = (1 if is_role_played else 0, depth)
            if best_score is None or score < best_score:
                best_score, best_node = score, node
        return best_node

    def _is_calendar_dim_view(self, view_name: Optional[str]) -> bool:
        """True if ``view_name`` is a calendar/date dimension — either a
        per-column role-played date-dim (``…__<col>__date_dim``) or a standalone
        generated calendar (``GENERATE_DATE_ARRAY`` source). Used to treat a date
        group dimension as a CONFORMED dimension across facts in the multi-fact
        stitch (every date-dim view carries the identical calendar grain
        columns — year_month, month, day_name… — with identical values)."""
        if not view_name:
            return False
        if "__" in view_name and view_name.endswith("_date_dim"):
            return True
        v = self.views_cache.get(view_name) or self._find_view_by_name(view_name)
        if v is None:
            return False
        src = (
            (getattr(v, "sql_table_name", "") or "")
            + " "
            + (getattr(v, "source_query", "") or "")
        ).upper()
        return "GENERATE_DATE_ARRAY" in src

    def _fact_own_calendar_view(self, fact: str, m_resolver) -> Optional[str]:
        """The calendar/date-dim view this fact OWNS (M:1-reachable, one hop).
        A fact with a single date column has exactly one date-dim (unambiguous);
        if it exposes several, prefer the main calendar
        (``_find_calendar_dim_for_measure``) else the first. Returns None when no
        calendar is reachable — then a calendar group dim is left unchanged and
        the unrelated-check declines the stitch, as before."""
        cals = [v for v in self._m1_reachable_views(fact) if self._is_calendar_dim_view(v)]
        if not cals:
            return None
        if len(cals) == 1:
            return cals[0]
        main = self._find_calendar_dim_for_measure(m_resolver, fact)
        return main if main in cals else cals[0]

    def _build_dimensioned_multifact_sql(
        self,
        explore: SemanticExplore,
        dimensions: List[str],
        measures: List[str],
        filters: Dict[str, Any],
        time_grains: Dict[str, str],
        limit: int,
        measure_agg_overrides: Optional[Dict[str, str]],
    ) -> Optional[Tuple[str, List[str], List[PivotedColumn]]]:
        """Stitch a dimensioned chart whose measures span ≥2 facts (mixed
        base+cross-fact or several cross-facts). Each fact is sub-generated
        INDEPENDENTLY at its own grain (re-anchored, so base-invariant), then
        joined on the shared group dims:

            WITH _mf0 AS (<dims, fact0 measures>), _mf1 AS (<dims, fact1 …>),
                 _skel AS (SELECT dims FROM _mf0 UNION DISTINCT SELECT dims FROM _mf1)
            SELECT _skel.dims, _mf0.m…, _mf1.m…
            FROM _skel LEFT JOIN _mf0 ON <null-safe dims> LEFT JOIN _mf1 ON …

        Returns None (→ caller falls back to the legacy path) if any fact can't
        relate to a group dim, so we never emit a wrong cross-product.
        """
        from collections import OrderedDict
        from app.services.semantic_join_resolver import SemanticJoinResolver as _R

        # Group measures by their TRUE fact grain (the source-column view for a
        # cross-table measure; declared view otherwise) — NOT the declared view.
        # This MUST match the dispatch in generate_sql (which now keys
        # `_facts` on `_measure_fact_view`); otherwise a cross-table measure
        # would be grouped+re-anchored at its declared base and reference its
        # source column against a table not in FROM ("Unrecognized name").
        groups: "OrderedDict[str, List[str]]" = OrderedDict()
        for m in measures:
            groups.setdefault(self._measure_fact_view(m), []).append(m)

        dim_aliases = [self._safe_alias(d) for d in dimensions]
        parts: list[tuple[str, str, list[str]]] = []  # (cte_name, sql, measure_aliases)
        alias_to_cte: Dict[str, str] = {}
        model_id = getattr(self._model, "id", None)

        for idx, (fact, fact_measures) in enumerate(groups.items()):
            m_resolver = _R(self.db, self._model, fact, bidirectional=True)  # for calendar below
            # A group dim is safe to stitch on this fact ONLY if it is the fact's
            # OWN view or a view DIRECTLY joined from the fact (a one-hop M:1
            # edge — Owner, Date, Org, role-played calendars — which never fans).
            # A dim that lives on ANOTHER FACT is reachable only via a CHASM
            # (fact → shared dim ← other fact, a 1:N hop) which WOULD fan this
            # fact's rows when grouped → UNRELATED → decline → caller fails loud.
            # (Bidirectional reach is unsafe here: it walks dim→fact 1:N edges
            # and treats a chasm-reachable other fact as "related".)
            # ── Conformed-calendar group-dim rebind (galaxy / shared Date). ──
            # A calendar/date group dimension is a CONFORMED dimension across
            # facts: each fact joins its OWN role-played date-dim
            # (fct_sales→…__order_date__date_dim, fct_target→…__month_start_date__
            # date_dim) but the grain fields (year_month, month, day_name…) are
            # identical calendar columns with identical values. Re-point a
            # calendar group dim at THIS fact's own calendar at the same grain so
            # the fact can be grouped via a clean one-hop M:1 edge (no chasm), and
            # the wrap below re-aligns it under the ORIGINAL uniform alias so the
            # skeleton stitches the facts on the (identical) calendar value.
            # Without this, "revenue vs target by month" across two facts fails
            # loud even though PowerBI renders it (conformed Date dimension).
            # Non-calendar dims are NOT rebound — a non-conformed dim on another
            # fact still trips the unrelated-check below (correct chasm refusal).
            fact_cal = self._fact_own_calendar_view(fact, m_resolver)
            fact_dims: List[str] = []
            cal_realias: List[Tuple[str, str]] = []   # (original_dim, rebound_dim)
            for d in dimensions:
                dv, df = self._parse_field_ref(d)
                if df and fact_cal and dv != fact_cal and self._is_calendar_dim_view(dv):
                    rebound_d = f"{fact_cal}.{df}"
                    fact_dims.append(rebound_d)
                    cal_realias.append((d, rebound_d))
                else:
                    fact_dims.append(d)

            # A group dim is safe to stitch on this fact ONLY if it is the fact's
            # OWN view or one DIRECTLY joined from it (one-hop M:1 — never fans).
            # A dim reachable only via a chasm WOULD fan when grouped → UNRELATED
            # → decline → caller fails loud. Checked on the REBOUND dims so a
            # conformed calendar (now this fact's own date-dim) passes.
            safe_views = self._m1_reachable_views(fact)
            unrelated = {
                self._parse_field_ref(d)[0]
                for d in fact_dims
                if self._parse_field_ref(d)[0] not in safe_views
            }
            if unrelated:
                self.warnings.append(
                    f"Không tách được measure của bảng '{fact}' theo dimension "
                    f"{sorted(unrelated)} (multi-fact, chỉ nối được qua chasm/fan-out) — fail-loud."
                )
                return None
            cal_view = self._find_calendar_dim_for_measure(m_resolver, fact)
            rebound = self._rebind_calendar_filters(dict(filters or {}), cal_view)
            try:
                sub_sql, _sub_cols, _ = self.generate_sql(
                    explore_name=fact,
                    dimensions=fact_dims,
                    measures=fact_measures,
                    filters=rebound,
                    sorts=[],
                    limit=limit,
                    time_grains=time_grains,
                    measure_agg_overrides=measure_agg_overrides,
                    model_id=model_id,
                    _reanchored=True,
                )
            except ValueError:
                return None
            cte = f"_mf{idx}"
            m_aliases = [self._safe_alias(m) for m in fact_measures]
            if cal_realias:
                # Re-alias each rebound calendar dim's column back to the ORIGINAL
                # dim alias so every fact CTE exposes the SAME dim aliases — the
                # skeleton + LEFT JOINs below then align them on the conformed
                # calendar value. Non-calendar dims already carry their original
                # alias; measures pass through unchanged.
                rebound_by_orig = {orig: rb for orig, rb in cal_realias}
                out_cols: List[str] = []
                for d in dimensions:
                    orig_a = self._safe_alias(d)
                    if d in rebound_by_orig:
                        out_cols.append(f"{self._safe_alias(rebound_by_orig[d])} AS {orig_a}")
                    else:
                        out_cols.append(orig_a)
                out_cols.extend(m_aliases)
                sub_sql = (
                    "SELECT " + ", ".join(out_cols) + f"\nFROM (\n{sub_sql}\n) AS _mfsrc{idx}"
                )
            for a in m_aliases:
                alias_to_cte[a] = cte
            parts.append((cte, sub_sql, m_aliases))

        if not dim_aliases or not parts:
            return None

        cte_defs = ",\n".join(f"{name} AS (\n{sql}\n)" for name, sql, _ in parts)
        skel_body = "\n  UNION DISTINCT\n  ".join(
            f"SELECT {', '.join(dim_aliases)} FROM {name}" for name, _, _ in parts
        )
        select_cols = [f"_skel.{a}" for a in dim_aliases]
        # preserve the ORIGINAL measure order (chart maps columns by alias, but
        # keep it tidy + deterministic)
        for m in measures:
            a = self._safe_alias(m)
            select_cols.append(f"{alias_to_cte[a]}.{a} AS {a}")
        join_sql = "FROM _skel"
        for name, _, _ in parts:
            on = " AND ".join(
                f"(_skel.{a} = {name}.{a} OR (_skel.{a} IS NULL AND {name}.{a} IS NULL))"
                for a in dim_aliases
            )
            join_sql += f"\nLEFT JOIN {name} ON {on}"
        sql = (
            f"WITH {cte_defs},\n_skel AS (\n  {skel_body}\n)\n"
            "SELECT\n  " + ",\n  ".join(select_cols) + f"\n{join_sql}"
        )
        if limit:
            sql += f"\nLIMIT {limit}"
        column_names = dim_aliases + [self._safe_alias(m) for m in measures]
        logger.info(
            "semantic_emit[multifact] explore=%s facts=%s dims=%s measures=%s",
            explore.base_view_name, list(groups.keys()), list(dimensions), list(measures),
        )
        return sql, column_names, []

    def _collapse_fanned_calendar_filters(
        self,
        filters: Dict[str, Any],
        base_view: str,
    ) -> Dict[str, Any]:
        """Diet bug #3 on the SINGLE-FACT path. chart_service fans a synthetic
        "Date" filter across EVERY role-played date column of a multi-date fact
        (transfer_date AND won_time AND lost_time …), AND-ing them — NULL-prone
        roles annihilate the result (base=deal → 2 instead of 7,597).

        We collapse a fan (≥2 calendar filters sharing the same calendarField)
        down to a SINGLE filter on the dataset's MAIN calendar dim, then let the
        generic EXISTS builder bind it via the fact→main-calendar edge (the
        fact's PRIMARY event date — the exact relationship that makes base=Date
        correct). A fact with a SINGLE date column produces no fan (1 filter) →
        untouched → byte-identical. Non-calendar filters pass through."""
        if not filters:
            return filters

        def _cal_field(defs: list) -> str:
            for d in defs:
                if isinstance(d, dict) and (d.get("calendarField") or d.get("calendar_field")):
                    return str(d.get("calendarField") or d.get("calendar_field") or "").strip()
            return ""

        # A genuine fan is the SAME synthetic predicate REPLICATED across ≥2
        # role columns (identical operator+value). We require that identity so
        # we never merge a power-user's two DIFFERENT date-role filters (which
        # legitimately intersect). Per calendarField: collect distinct refs and
        # the set of (operator, value) signatures.
        def _sig(d: Any) -> tuple:
            if not isinstance(d, dict):
                return ("eq", "")
            return (str(d.get("operator") or "eq").strip().lower(), str(d.get("value")))

        per_field_refs: Dict[str, set] = {}
        per_field_sigs: Dict[str, set] = {}
        for f_ref, f_def in filters.items():
            defs = f_def if isinstance(f_def, list) else [f_def]
            cf = _cal_field(defs)
            if not cf:
                continue
            per_field_refs.setdefault(cf, set()).add(f_ref)
            for d in defs:
                per_field_sigs.setdefault(cf, set()).add(_sig(d))
        fanned = {
            cf for cf, refs in per_field_refs.items()
            if len(refs) >= 2 and len(per_field_sigs.get(cf, set())) == 1
        }
        if not fanned:
            return filters

        cal_view = self._find_calendar_dim_for_measure(self._resolver, base_view)
        if not cal_view:
            return filters

        out: Dict[str, Any] = {}
        added: set[str] = set()
        for f_ref, f_def in filters.items():
            defs = f_def if isinstance(f_def, list) else [f_def]
            cf = _cal_field(defs)
            if cf in fanned:
                new_ref = f"{cal_view}.{cf}"
                if new_ref in added:
                    continue  # fan already collapsed to this one canonical filter
                added.add(new_ref)
                cleaned = [
                    {k: v for k, v in d.items()
                     if k not in ("calendarField", "calendar_field",
                                  "calendarSourceField", "calendar_source_field")}
                    for d in defs
                ]
                if cal_view not in self.views_cache:
                    v = self._find_view_by_name(cal_view)
                    if v is not None:
                        self.views_cache[cal_view] = v
                out[new_ref] = cleaned if isinstance(f_def, list) else cleaned[0]
            else:
                out[f_ref] = f_def
        return out

    def _rebind_calendar_filters(
        self,
        filters: Dict[str, Any],
        cal_view: Optional[str],
    ) -> Dict[str, Any]:
        """Re-point calendar-metadata filters at ``cal_view.<calendarField>`` so
        the generic WHERE/EXISTS builder binds them via the measure→Date edge
        (one event-date column) rather than the chart base's fanned columns.
        Filters without calendar metadata pass through untouched."""
        if not filters:
            return filters
        out: Dict[str, Any] = {}
        for f_ref, f_def in filters.items():
            defs = f_def if isinstance(f_def, list) else [f_def]
            cal_field = next(
                (
                    str(d.get("calendarField") or d.get("calendar_field") or "").strip()
                    for d in defs
                    if isinstance(d, dict) and (d.get("calendarField") or d.get("calendar_field"))
                ),
                "",
            )
            if cal_view and cal_field:
                new_ref = f"{cal_view}.{cal_field}"
                cleaned = []
                for d in defs:
                    d2 = {k: v for k, v in d.items()
                          if k not in ("calendarField", "calendar_field",
                                       "calendarSourceField", "calendar_source_field")}
                    cleaned.append(d2)
                # ensure the calendar view is loaded for rendering
                if new_ref.split(".", 1)[0] not in self.views_cache:
                    v = self._find_view_by_name(cal_view)
                    if v is not None:
                        self.views_cache[cal_view] = v
                out[new_ref] = cleaned if isinstance(f_def, list) else cleaned[0]
            else:
                out[f_ref] = f_def
        return out

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

        # `field` may be a bare column ("status") or qualified ("orders.status").
        # Track the target view so a filter on a RELATED view (joined dim) can be
        # rewritten as a correlated EXISTS instead of an invalid inline predicate.
        if "." in field:
            target_view = self._parse_field_ref(field)[0]
            field_sql = self._render_dimension(field, target_view)
        else:
            target_view = view_name
            field_sql = f"{view_name}.{field}"

        def _q(v: Any) -> str:
            if v is None:
                return "NULL"
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return str(v)
            return "'" + str(v).replace("'", "''") + "'"

        def _pred() -> Optional[str]:
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
                # Phase-15.79 — degrade to >= / <= when only one bound is
                # supplied, mirroring _build_where_clause Phase-15.19 behaviour.
                # Old code emitted `BETWEEN NULL AND NULL` for single-side
                # bounds which never matches anything; with the new range-
                # slider UI users routinely leave one thumb un-set so we now
                # render the user's intent properly here too.
                lo, hi = (value or [None, None])[:2]
                lo_present = lo is not None and (not isinstance(lo, str) or lo.strip() != "")
                hi_present = hi is not None and (not isinstance(hi, str) or hi.strip() != "")
                if lo_present and hi_present:
                    return f"{field_sql} BETWEEN {_q(lo)} AND {_q(hi)}"
                if lo_present:
                    return f"{field_sql} >= {_q(lo)}"
                if hi_present:
                    return f"{field_sql} <= {_q(hi)}"
                return None
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

        pred = _pred()
        if pred is None:
            return None

        # PowerBI CALCULATE parity: a measure filter targeting a RELATED view
        # (a joined dimension — e.g. CALCULATE(SUM(Sales[amount]),
        # Product[category]="Electronics")) must NOT be a bare inline predicate.
        # The aggregate runs over the measure's own table, where the related
        # dim is not in scope — emitting ``dim.col = ...`` inside the CASE WHEN
        # yields "missing FROM-clause entry" / "column does not exist". Rewrite
        # it as a correlated EXISTS tied to the measure's own grain
        # (``base.fk = dim.key AND <pred>``), so the CASE WHEN tests set
        # membership through the relationship. Own-view filters stay a plain
        # predicate (byte-identical to before).
        if target_view and target_view != view_name:
            try:
                exists_sql = self._build_filter_exists_clause(
                    None, target_view, [pred], joined_nodes={view_name},
                )
            except Exception:  # noqa: BLE001 — fall back to inline on any resolver error
                exists_sql = None
            if exists_sql:
                return exists_sql
            # EXISTS unavailable (unreachable view / nested CTE) → keep the
            # legacy inline predicate so existing same-table cases are unchanged.
        return pred
    
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

        # Mirror `_render_measure`: an "auto" (or unknown) agg_override means
        # "use the measure's STORED type", NOT "fallback to SUM". Without this a
        # declared percent_of_total / count_distinct / avg measure rendered in a
        # PIVOT cell via agg_override='auto' (what chart roleConfigs ship) was
        # silently summed.
        stored_pivot_type = str(measure_def.get('type', 'sum') or 'sum').lower().strip()
        _pivot_override = str(agg_override or "").lower().strip()
        _KNOWN_AGGS = {"count", "sum", "avg", "min", "max", "count_distinct", "percent_of_total"}
        if _pivot_override and _pivot_override not in _KNOWN_AGGS:
            _pivot_override = ""
        measure_type = _pivot_override or stored_pivot_type
        sql_template = measure_def.get('expression') or measure_def.get('sql') or '*'
        # Phase-15.81 v9 — same bare-identifier guard as `_render_measure`.
        if (
            sql_template
            and sql_template != '*'
            and "${TABLE}" not in sql_template
            and "${" not in sql_template
            and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", sql_template.strip())
        ):
            sql_template = f"${{TABLE}}.{sql_template.strip()}"
        base_sql = self._render_sql_template(sql_template, view_name)

        # Filtered measure inside a pivot: AND the measure's own filter into
        # the pivot CASE branch so each pivoted column also respects the filter.
        measure_filter_sql = self._render_measure_filter_clause(measure_def, view_name)

        # Get pivot dimension SQL
        pivot_view_name, pivot_field_name = self._parse_field_ref(pivot_field)
        pivot_sql = self._render_dimension(pivot_field, pivot_view_name)
        
        # Build CASE expression. When the measure carries its own filter, AND
        # it into the pivot predicate so each pivoted column is correctly gated.
        # Escape single quotes in the pivot value (e.g. a category "O'Brien").
        # Raw interpolation here produced invalid/injectable SQL for ANY value
        # containing a quote — every other predicate uses `_q`/`esc` which double
        # single quotes; this one path was missed (DA9 white-box). Mirror that.
        pivot_literal = "'" + str(pivot_value).replace("'", "''") + "'"
        pivot_pred = f"{pivot_sql} = {pivot_literal}"
        if measure_filter_sql:
            pivot_pred = f"({pivot_pred}) AND ({measure_filter_sql})"

        if measure_type == "sum":
            # SUM: non-matching rows contribute 0 (correct).
            case_expr = f"CASE WHEN {pivot_pred} THEN {base_sql} ELSE 0 END"
            return f"SUM({case_expr})"
        elif measure_type == "avg":
            # AVG: non-matching rows MUST be NULL, not 0 — averaging in 0s drags
            # the mean toward zero (the column's avg for the pivot value, not
            # "avg including a 0 for every other row").
            case_expr = f"CASE WHEN {pivot_pred} THEN {base_sql} ELSE NULL END"
            return f"AVG({case_expr})"
        elif measure_type == "count":
            # COUNT = SUM of 1s for matching rows.
            case_expr = f"CASE WHEN {pivot_pred} THEN 1 ELSE 0 END"
            return f"SUM({case_expr})"
        elif measure_type == "count_distinct":
            case_expr = f"CASE WHEN {pivot_pred} THEN {base_sql} ELSE NULL END"
            return f"COUNT(DISTINCT {case_expr})"
        elif measure_type in ("min", "max"):
            # MIN/MAX: non-matching rows MUST be NULL (ELSE 0 would inject a
            # spurious 0 into a MIN over positive values / a MAX over negatives).
            case_expr = f"CASE WHEN {pivot_pred} THEN {base_sql} ELSE NULL END"
            return f"{measure_type.upper()}({case_expr})"
        elif measure_type == "percent_of_total":
            # A window measure (`… OVER ()`) has no per-cell pivot CASE form —
            # fail loud rather than silently summing (the old `else` SUM gave a
            # wrong number for every non-sum measure here).
            raise ValueError(
                f"Measure '{field_name}' (percent_of_total) là measure dạng "
                f"window — không thể đặt vào cột pivot. Bỏ pivot hoặc đổi measure."
            )
        else:
            raise ValueError(
                f"Aggregation '{measure_type}' chưa hỗ trợ trong pivot cho measure "
                f"'{field_name}'. Dùng sum / avg / count / count_distinct / min / max."
            )
    
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
    
    def _build_from_clause(
        self,
        explore: SemanticExplore,
        target_views: set[str] | None = None,
    ) -> tuple[str, set[str]]:
        """Build FROM and JOIN clauses.

        Phase-B' (PBI-parity rework) — `target_views`, when provided,
        restricts the FROM chain to the SELECT-side views (dimensions /
        measures / pivots / sorts) plus the base and any intermediate
        hops needed to reach them. Views referenced ONLY by filters are
        deliberately left OUT of the JOIN chain by the caller and applied
        as EXISTS subqueries instead (see `_build_where_clause`). This
        fixes the snowflake fan-out bug: filtering a fact through a
        shared dimension to ANOTHER fact's column (e.g.
        ``revenue -> owner -> deal`` where owner->deal is one-to-many)
        used to JOIN the far table and multiply the base rows, double-
        counting the measure. EXISTS filters as set-membership without
        fan-out, matching Power BI.

        When `target_views` is None (e.g. the pivot-value fetch) the old
        behavior is preserved: every view in `views_cache` is joined.

        Returns ``(from_clause, joined_nodes)`` so the caller knows which
        views actually entered the FROM chain (the complement of that set
        among the filter views is what must be rendered as EXISTS).
        """
        base_view = self.views_cache.get(explore.base_view_name)
        if not base_view:
            raise ValueError(f"Base view '{explore.base_view_name}' not found")

        # Determine base table name
        base_table = base_view.sql_table_name or explore.base_view_name
        from_clause = f"FROM {base_table} AS {explore.base_view_name}"

        joined_nodes: set[str] = {explore.base_view_name}
        resolver = self._resolver
        if resolver is None:
            return from_clause, joined_nodes

        if target_views is None:
            candidate_nodes = set(self.views_cache.keys())
        else:
            candidate_nodes = set(target_views)
        target_nodes = sorted(candidate_nodes - joined_nodes)
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

        return from_clause, joined_nodes

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
    
    def _build_where_clause(
        self,
        filters: Dict[str, Any],
        time_grains: Dict[str, str],
        exists_views: set[str] | None = None,
        explore: SemanticExplore | None = None,
        select_side_views: set[str] | None = None,
        joined_nodes: set[str] | None = None,
    ) -> str:
        """Build WHERE clause from filters.

        Phase-B' (PBI-parity rework) — `exists_views` names the views that
        are referenced ONLY by filters (not projected in SELECT) and were
        therefore left OUT of the FROM JOIN chain. Filters on those views
        are emitted as EXISTS subqueries (set-membership, no fan-out)
        instead of predicates on a joined alias. Everything else keeps the
        plain-predicate behavior. See `_build_from_clause`.

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

        _dialect = (self.database_type or "").lower()

        def _num(col_sql: str, *vals: Any) -> str:
            # Compare-as-number guard (mirrors live_query_service._build_where_clause).
            # When the filter value(s) are numeric, cast the column so the
            # comparison works even if the column is physically STRING
            # (Airbyte / Google Sheets / CSV store numbers as text, so a filter
            # `col >= 10` becomes STRING >= INT64 → BigQuery 400 "No matching
            # signature for operator >= ... STRING, INT64"). The model declared
            # the field numeric, so the analyst's intent IS numeric. SAFE_CAST
            # is a no-op on genuine numeric columns and yields NULL (no match)
            # on non-numeric text — never a type error.
            present = [v for v in vals if _value_present(v)]
            if present and all(
                isinstance(v, (int, float)) and not isinstance(v, bool) for v in present
            ):
                from app.services.type_override_service import build_safe_cast_sql
                return build_safe_cast_sql(col_sql, "float", _dialect)
            return col_sql

        where_conditions: list[str] = []      # base / select-side predicates
        exists_groups: dict[str, list[str]] = {}  # filter-only view -> predicates
        # Defensive default — pivot-value fetch (line ~445) calls this with only
        # filters + time_grains, so select_side_views may be None there.
        select_side_views = select_side_views if select_side_views is not None else set()
        # Phase 2 — collect explicit drop diagnostics (reason + detail) so the
        # debug payload surfaces propagation decisions to the user. List of
        # dicts: {field, reason, detail}.
        propagation_drops: list[dict[str, str]] = []
        # Phase 4 — accumulate views whose measures must use the symmetric
        # aggregate form (Looker MD5 trick). Populated when propagation engine
        # returns SYMMETRIC mode (filter target is a SELECT-side view across a
        # 1:N hop). _render_measure consults self._symmetric_aggregate_views.
        symmetric_aggregate_views: set[str] = set()
        # Phase 2 — feature-flag gate. When ON, route via propagation engine
        # instead of the binary `exists_views` set-diff. Build a strict
        # resolver (cross_filter-respecting) here — separate from self._resolver
        # which stays bidirectional=True for back-compat with the existing
        # EXISTS body builder + reachability check.
        from app.core.config import settings as _settings
        _use_propagation_v2 = bool(getattr(_settings, "FEATURE_PROPAGATION_ENGINE_V2", False))
        _strict_resolver = None
        if _use_propagation_v2 and self._model is not None and explore is not None:
            from app.services.semantic_join_resolver import SemanticJoinResolver as _R
            _strict_resolver = _R(
                self.db, self._model, explore.base_view_name, bidirectional=False,
            )

        # PBI-parity drop gate (always on, independent of the V2 flag). The
        # legacy `exists_views` set-diff routes ANY filter-only view to an
        # EXISTS subquery, and the bidirectional `self._resolver` happily finds
        # a correlation path even when it has to BORROW a second fact as a
        # bridge through a shared/conformed dimension (e.g. filter Product →
        # Targets via fact_sales + dim_region/date). PowerBI's default
        # single-direction relationships do NOT propagate that way: a filter on
        # a dim related to only ONE fact must NOT reach a sibling fact, so the
        # filter is simply ignored (visual stays unfiltered) — NOT forced to 0
        # by a bridge EXISTS. We build a STRICT resolver (cross_filter-honoring,
        # no synthetic reverse for 'single' joins) purely to decide *reachability*:
        # a filter-only view with no strict path to the base is dropped with a
        # diagnostic. cross_filter='both' joins still synthesise reverse edges,
        # so legitimate bidirectional cross-fact filtering is preserved.
        _drop_gate_resolver = None
        if self._model is not None and explore is not None:
            try:
                from app.services.semantic_join_resolver import SemanticJoinResolver as _R2
                _drop_gate_resolver = _R2(
                    self.db, self._model, explore.base_view_name, bidirectional=False,
                )
            except Exception:  # noqa: BLE001 — never block query build on resolver setup
                _drop_gate_resolver = None

        for field_ref, filter_def in (
            (fr, d)
            for fr, fd in filters.items()
            for d in (fd if isinstance(fd, list) else [fd])
        ):
            operator = str(filter_def.get('operator') or 'eq').strip().lower()
            value = filter_def.get('value')

            view_name, _ = self._parse_field_ref(field_ref)

            # ── Phase 2 routing (feature-flagged) ──────────────────────
            #
            # When FEATURE_PROPAGATION_ENGINE_V2 is on, the propagation engine
            # decides per-filter:
            #
            #   PLAIN / JOIN_CHAIN → predicate goes into where_conditions
            #                        (rendered against base or joined alias).
            #   EXISTS / SYMMETRIC → predicate goes into the per-view EXISTS
            #                        bucket (Phase-B' body builder handles it).
            #                        SYMMETRIC falls back to EXISTS here in
            #                        Phase 2; Phase 4 will switch it to use
            #                        the symmetric-aggregate measure emitter.
            #   DROP               → filter skipped, diagnostic recorded.
            #
            # When the flag is OFF, fall through to the Phase-B' binary check.
            propagated = None
            if _use_propagation_v2 and _strict_resolver is not None:
                from app.services.filter_propagation import (
                    resolve_filter_propagation as _resolve_prop,
                    PropagationMode as _Mode,
                )
                propagated = _resolve_prop(
                    _strict_resolver,
                    explore.base_view_name,
                    field_ref,
                    select_side_views=select_side_views,
                )
                if propagated.mode == _Mode.DROP:
                    propagation_drops.append({
                        "field": field_ref,
                        "reason": (propagated.reason.value if propagated.reason else "unknown"),
                        "detail": propagated.detail,
                    })
                    self.warnings.append(
                        f"Filter dropped — {field_ref}: {propagated.detail}"
                    )
                    continue
                # PLAIN — filter on base view itself; goes into top-level WHERE.
                if propagated.mode == _Mode.PLAIN:
                    conditions = where_conditions
                # JOIN_CHAIN — forward M:1 path with no fan-out. If the view is
                # ALSO select-side (joined into FROM for GROUP BY), a plain
                # predicate on the joined alias is fine. If the view is filter-
                # only (not projected), the engine WON'T have it in FROM, so
                # the safe emission is via EXISTS subquery (same result as JOIN
                # for M:1 forward, no fan-out). Phase-B' already handles this
                # uniformly via _build_filter_exists_clause.
                elif propagated.mode == _Mode.JOIN_CHAIN:
                    if view_name in select_side_views:
                        conditions = where_conditions
                    else:
                        conditions = exists_groups.setdefault(view_name, [])
                # EXISTS / SYMMETRIC — always EXISTS-bucket. SYMMETRIC also
                # accumulates the base view name so Phase-4 measure rendering
                # can dedupe fan-out via the Looker MD5 trick. The filter side
                # is identical to EXISTS (predicate inside the subquery).
                #
                # Phase 4.2 — SYMMETRIC requires a declared primary_key on each
                # symmetric_views entry; otherwise the Looker trick can't dedupe
                # and a plain JOIN would silently double-count. When PK is absent
                # AND the symmetric-aggregate feature flag is ON, we'd rather
                # DROP the filter with a clear message than emit silently-wrong
                # SUMs. When the flag is OFF, callers expect legacy behavior so
                # we let the EXISTS bucket carry it (matches pre-Phase-4 path).
                else:
                    if propagated.mode == _Mode.SYMMETRIC:
                        from app.core.config import settings as _sym_settings
                        from app.services.filter_propagation import DropReason as _DR
                        flag_on = bool(getattr(
                            _sym_settings, "FEATURE_SYMMETRIC_AGGREGATES", False,
                        ))
                        missing_pk_views = [
                            sv for sv in (propagated.symmetric_views or ())
                            if not (
                                (self.views_cache.get(sv) or
                                 self._get_view_for_node(sv)).primary_key or []
                            )
                        ]
                        if flag_on and missing_pk_views:
                            propagation_drops.append({
                                "field": field_ref,
                                "reason": _DR.NO_PRIMARY_KEY.value,
                                "detail": (
                                    f"Filter on {field_ref!r} requires symmetric "
                                    f"aggregation (1:N JOIN with projected target) "
                                    f"but view(s) {missing_pk_views!r} have no "
                                    f"primary_key declared. Declare PK in the Data "
                                    f"Model to enable safe filter propagation."
                                ),
                            })
                            self.warnings.append(
                                f"Filter dropped — {field_ref}: no primary_key on "
                                f"{missing_pk_views!r}; cannot dedupe fan-out."
                            )
                            continue
                        for sv in (propagated.symmetric_views or ()):
                            symmetric_aggregate_views.add(sv)
                    conditions = exists_groups.setdefault(view_name, [])
            else:
                # Phase-B' — route this filter's predicate(s) to the EXISTS
                # group for its view when the view is filter-only (not in the
                # FROM chain); otherwise to the top-level WHERE list. All the
                # `conditions.append(...)` below write to whichever bucket
                # `conditions` points at for this iteration.
                if exists_views and view_name in exists_views:
                    # PBI-parity drop gate: a filter-only view that the STRICT
                    # (single-direction) resolver cannot reach from the base is
                    # NOT related to this fact under PowerBI rules. The legacy
                    # bidirectional resolver would still build a bridge EXISTS
                    # (borrowing another fact through a shared dim) → wrong/zero
                    # result. PowerBI ignores such a filter. Drop it with a
                    # diagnostic instead of emitting the bridge EXISTS.
                    _strict_unreachable = False
                    if (
                        _drop_gate_resolver is not None
                        and explore is not None
                        and view_name != explore.base_view_name
                    ):
                        try:
                            _strict_unreachable = not _drop_gate_resolver.resolve_paths(view_name)
                        except Exception:  # noqa: BLE001 — fall back to legacy on resolver error
                            _strict_unreachable = False
                    if _strict_unreachable:
                        propagation_drops.append({
                            "field": field_ref,
                            "reason": "unreachable_view",
                            "detail": (
                                f"Filter view {view_name!r} has no single-direction "
                                f"relationship path to base {explore.base_view_name!r}; "
                                f"ignored (PowerBI parity). Set cross_filter='both' on "
                                f"the relationship to enable cross-fact propagation."
                            ),
                        })
                        self.warnings.append(
                            f"Filter ignored — {field_ref}: no relationship path to this "
                            f"chart's table (PowerBI parity)."
                        )
                        continue
                    conditions = exists_groups.setdefault(view_name, [])
                else:
                    conditions = where_conditions

            # Calendar-rewrite contract: when the chart_service-layer
            # rewrite collapses a role-played calendar filter onto its
            # source column, it stamps `calendarField` + `calendarSourceField`
            # onto the filter dict. We honour that here by emitting a
            # direct calendar expression (``EXTRACT(YEAR FROM …)``,
            # ``DATE(…)``, ``CASE WHEN ISODOW IN (6,7) …``) wrapped around
            # the base column's already-resolved SQL — the role-played
            # SemanticView is NOT loaded, which fixes the
            # ``View '…__date_dim' not found`` crash on datasets whose
            # calendar settings drifted (table removed but auto_calendar
            # joins persisted), AND makes Dashboard FilterPane (Path B)
            # emit the same SQL shape as Chart Explore's raw-column filter
            # (Path A) for time predicates.
            calendar_field_ref = str(
                filter_def.get("calendarField")
                or filter_def.get("calendar_field")
                or ""
            ).strip()
            calendar_field_sql: str | None = None

            # Phase-15.81 v20 — runtime filters can carry refs that the
            # current view no longer exposes (FE auto-fan-out picked a
            # column that doesn't exist on the chart's view, schema
            # drift after a dataset edit, etc.). Drop the offender with
            # a warning rather than raising — the alternative is a
            # 400 that brings down every chart on the dashboard for a
            # single mis-targeted ref. Same defensive contract as
            # live_query._build_where_clause: filters that can't be
            # rendered are skipped, not fatal.
            try:
                if field_ref in time_grains:
                    # Apply time grain if specified
                    field_sql = self._render_dimension_with_time_grain(
                        field_ref, view_name, time_grains[field_ref]
                    )
                else:
                    field_sql = self._render_dimension(field_ref, view_name)
                if calendar_field_ref:
                    # Wrap the resolved base-column SQL in the calendar
                    # expression for the requested calendar field. The
                    # base SQL already carries the right view alias + col
                    # name (matches Chart Explore's raw-column filter),
                    # so we only add the calendar math on top.
                    calendar_field_sql = _build_calendar_expr_from_base(
                        field_sql,
                        calendar_field_ref,
                        (self.database_type or "").lower(),
                    )
                    if calendar_field_sql:
                        # [pbi-filter] log expression wrap — DA can grep
                        # docker logs for this when verifying that a
                        # dashboard date slicer emitted EXTRACT()/etc
                        # instead of the legacy JOIN-on-CAST(DATE) path.
                        # Temporary instrumentation.
                        try:
                            from app.services.chart_service import _pbi_current_chart_id
                            _pbi_cid = _pbi_current_chart_id()
                        except Exception:
                            _pbi_cid = None
                        logger.info(
                            "[pbi-filter] where-calendar chart_id=%s field=%s calendarField=%s dialect=%s expr=%s",
                            _pbi_cid,
                            field_ref,
                            calendar_field_ref,
                            (self.database_type or "").lower(),
                            calendar_field_sql,
                        )
                        field_sql = calendar_field_sql
            except ValueError as exc:
                # STRICT (#4) — a filter whose field cannot be resolved
                # (unknown column / schema drift / view not reachable) is a
                # COMPLETE filter we cannot honour. The old contract skipped
                # it with a warning, which returns data computed WITHOUT the
                # filter — the "filter set but chart not filtered / wrong
                # total" bug class. Fail LOUD so the DA fixes the ref or the
                # model instead of trusting a silently-wrong number. Soft
                # skips (blank picker bounds, empty IN-list) are handled
                # per-operator below and never raise, so they don't reach here.
                raise ValueError(
                    f"Filter không áp được: field {field_ref!r} — {exc}"
                ) from exc

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
                bf = _num(field_sql, lo, hi)
                if _value_present(lo) and _value_present(hi):
                    conditions.append(f"{bf} BETWEEN {_lit(lo)} AND {_lit(hi)}")
                elif _value_present(lo):
                    conditions.append(f"{bf} >= {_lit(lo)}")
                elif _value_present(hi):
                    conditions.append(f"{bf} <= {_lit(hi)}")
                # if both blank → user hasn't filled the picker yet, skip
                continue

            # IN / NOT IN accept list or comma-separated string.
            if operator == "in":
                present: list[Any] = []
                if isinstance(value, list):
                    present = [v for v in value if _value_present(v)]
                elif isinstance(value, str) and value.strip():
                    present = [v.strip() for v in value.split(",") if v.strip()]
                vals = ", ".join(_lit(v) for v in present)
                if vals:
                    conditions.append(f"{_num(field_sql, *present)} IN ({vals})")
                continue
            if operator == "not_in":
                present = []
                if isinstance(value, list):
                    present = [v for v in value if _value_present(v)]
                elif isinstance(value, str) and value.strip():
                    present = [v.strip() for v in value.split(",") if v.strip()]
                vals = ", ".join(_lit(v) for v in present)
                if vals:
                    conditions.append(f"{_num(field_sql, *present)} NOT IN ({vals})")
                continue

            # Pattern operators need LIKE-escaping for % and _ so DA-typed
            # literals don't accidentally turn into wildcards.
            if operator in {"contains", "not_contains", "starts_with", "ends_with"}:
                if value is None:
                    continue
                # PBI parity (2026-06) — a LIKE operator on a DATE/numeric column
                # is invalid SQL (Postgres: `operator does not exist: date ~~
                # text`) and previously 500'd the chart. The FE gates operators
                # by type; this only trips on a legacy saved filter or an API
                # caller. Soft-drop it (visible in dropped_filters) rather than
                # emit SQL the warehouse rejects.
                if self._field_rejects_pattern_operator(field_ref):
                    propagation_drops.append({
                        "field": field_ref,
                        "reason": "unsupported_operator",
                        "detail": (
                            f"Toán tử {operator!r} (dạng văn bản) không dùng được "
                            f"trên cột {field_ref!r} kiểu ngày/số — filter bị bỏ qua."
                        ),
                    })
                    self.warnings.append(
                        f"Filter ignored — {field_ref}: operator {operator!r} is not "
                        f"valid on a date/numeric column."
                    )
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
            if operator == "eq" or operator == "date_eq":
                conditions.append(f"{_num(field_sql, value)} = {_lit(value)}")
                continue
            if operator in {"ne", "neq"}:
                conditions.append(f"{_num(field_sql, value)} != {_lit(value)}")
                continue
            if operator == "gt":
                conditions.append(f"{_num(field_sql, value)} > {_lit(value)}")
                continue
            if operator == "gte":
                conditions.append(f"{_num(field_sql, value)} >= {_lit(value)}")
                continue
            if operator == "lt":
                conditions.append(f"{_num(field_sql, value)} < {_lit(value)}")
                continue
            if operator == "lte":
                conditions.append(f"{_num(field_sql, value)} <= {_lit(value)}")
                continue

            # Phase-B (PBI-parity rework) — `date_between` is the typed
            # alias of `between` used by the FE date picker so authors
            # know the filter targets a date column. Same SQL emission.
            if operator == "date_between" and isinstance(value, list) and len(value) >= 2:
                lo, hi = value[0], value[1]
                if _value_present(lo) and _value_present(hi):
                    conditions.append(f"{field_sql} BETWEEN {_lit(lo)} AND {_lit(hi)}")
                elif _value_present(lo):
                    conditions.append(f"{field_sql} >= {_lit(lo)}")
                elif _value_present(hi):
                    conditions.append(f"{field_sql} <= {_lit(hi)}")
                continue

            # Phase-B (PBI-parity rework) — relative-date operators
            # `date_in_last`, `date_this`, `date_to_date` reach this
            # builder only if the upstream resolver did not pre-bake
            # them into absolute date ranges. For now we record a
            # diagnostic and skip; the resolver lives in the chart
            # engine layer (see filter-semantics.md §7 — server time is
            # the source of truth, so FE must NOT pre-resolve relative
            # dates) and will be wired in a follow-up step. Until then
            # treat these as "operator known but not implemented here".
            if operator in {"date_in_last", "date_this", "date_to_date"}:
                # STRICT (#4) — a relative-date operator that reaches the SQL
                # builder un-resolved means the upstream resolver did NOT bake
                # it into an absolute range; skipping it silently drops the
                # date filter (chart shows ALL dates). Fail LOUD.
                raise ValueError(
                    f"Filter không áp được: toán tử ngày tương đối "
                    f"{operator!r} cho {field_ref!r} chưa được resolve sang "
                    f"khoảng ngày tuyệt đối (FE phải pre-resolve trước khi gửi)."
                )

            # Phase-B (PBI-parity rework) — top_n / bottom_n are NOT
            # WHERE/HAVING predicates. They translate to ORDER BY +
            # LIMIT at the outer query level and are dispatched via the
            # `top_n` parameter of `_build_query_sql`, not through
            # filters. Silently skip here so they don't generate broken
            # SQL when an FE sends them mis-routed.
            if operator in {"top_n", "bottom_n"}:
                continue

            # Pattern — ends_with was already handled in the LIKE block
            # above. matches_regex falls here because dialects differ.
            if operator == "matches_regex":
                if value is None:
                    continue
                pattern_lit = _lit(value)
                # Postgres: `~`, MySQL: `REGEXP`, BigQuery: REGEXP_CONTAINS,
                # Snowflake: REGEXP_LIKE. The semantic engine target is
                # ANSI-ish; emit `field SIMILAR TO 'value'` as a safe
                # fallback that most engines either accept or reject
                # loudly. Callers that need dialect-specific output
                # should pre-rewrite to LIKE / contains.
                conditions.append(f"{field_sql} SIMILAR TO {pattern_lit}")
                continue

            # NOT BETWEEN — mirror of BETWEEN. Same single-side fallback.
            if operator == "not_between" and isinstance(value, list) and len(value) >= 2:
                lo, hi = value[0], value[1]
                if _value_present(lo) and _value_present(hi):
                    conditions.append(f"{field_sql} NOT BETWEEN {_lit(lo)} AND {_lit(hi)}")
                elif _value_present(lo):
                    conditions.append(f"{field_sql} < {_lit(lo)}")
                elif _value_present(hi):
                    conditions.append(f"{field_sql} > {_lit(hi)}")
                continue

            # Unknown operator. STRICT (#4) — appending no condition would
            # silently drop the filter (the exact silent-drop bug class that
            # broke the operator chain for months). Fail LOUD instead.
            raise ValueError(
                f"Filter không áp được: toán tử {operator!r} không được hỗ "
                f"trợ cho {field_ref!r}."
            )

        # Phase-B' — fold each filter-only view's predicates into one EXISTS
        # subquery that materialises the join path from the base view and
        # correlates back to it, so the filter constrains the base rows
        # without the FROM-chain fan-out that double-counts measures.
        for view_node, preds in exists_groups.items():
            clause = self._build_filter_exists_clause(explore, view_node, preds, joined_nodes=joined_nodes)
            if clause:
                where_conditions.append(clause)
            else:
                # PBI parity (2026-06) — the filter's view passed the
                # single-direction reachability gate but the EXISTS body could
                # not be rendered: the only join path runs through a malformed
                # edge (no sql_on and no from/to_column — the DA's TC-F66/F72)
                # or a nested-CTE source the dialect can't embed in a subquery.
                # PREVIOUSLY this raised → the whole chart 500'd and the DA saw
                # a cryptic "không có đường JOIN" error with no way to tell which
                # filter caused it. PowerBI never errors a visual over an
                # un-appliable filter; it ignores the filter. We do the same, but
                # record a STRUCTURED drop (reason `no_join_path`) so it surfaces
                # in `_debug.dropped_filters` + the skip-badge — ignored, never
                # silent. The root cause (broken relationship) is still
                # actionable from the badge tooltip + Data Model tab.
                propagation_drops.append({
                    "field": view_node,
                    "reason": "no_join_path",
                    "detail": (
                        f"Filter trên bảng {view_node!r} bị bỏ qua: không dựng "
                        f"được đường JOIN tới bảng gốc của chart (quan hệ thiếu "
                        f"cột khóa hoặc nguồn dùng CTE lồng nhau). Kiểm tra quan "
                        f"hệ trong Data Model."
                    ),
                })
                self.warnings.append(
                    f"Filter ignored — {view_node}: no renderable JOIN path to "
                    f"this chart's table (check the relationship in Data Model)."
                )
                continue

        # Phase 2 — stash propagation drops on self so the chart-runtime layer
        # can surface them in `debug.dropped_filters` (structured) alongside
        # the warnings already pushed onto self.warnings.
        if propagation_drops:
            existing = getattr(self, "_propagation_drops", [])
            self._propagation_drops = existing + propagation_drops

        # Phase 4 — merge any newly observed symmetric-aggregate views onto the
        # engine instance. _render_measure reads this set later; if the flag is
        # off the set stays empty and the helper returns None (legacy fallback).
        if symmetric_aggregate_views:
            existing_sym = getattr(self, "_symmetric_aggregate_views", set()) or set()
            self._symmetric_aggregate_views = existing_sym | symmetric_aggregate_views

        if where_conditions:
            return "WHERE\n  " + " AND\n  ".join(where_conditions)
        return ""

    def _build_filter_exists_clause(
        self,
        explore: SemanticExplore | None,
        target_node: str,
        predicates: List[str],
        joined_nodes: set[str] | None = None,
    ) -> str | None:
        """Build ``EXISTS (SELECT 1 FROM <path> WHERE <corr> AND <preds>)`` for a
        filter-only view, mirroring the distinct-values EXISTS builder.

        The resolver path's first hop becomes the EXISTS ``FROM`` relation and
        its join condition is pushed into the EXISTS ``WHERE`` as the
        correlation back to the outer alias (SQL forbids ``ON`` directly after
        ``FROM``); subsequent hops are ``INNER JOIN ... ON``. `predicates`
        already reference ``target_node.<col>`` which is aliased inside the body.

        Correlation anchor (2026-06 chasm-trap fix): the EXISTS must correlate
        to the DEEPEST node on the base→target path that is ALREADY in the
        FROM chain (``joined_nodes``) — NOT blindly to the base view. When a
        filter-only view attaches (via a shared key) to a non-base view that's
        already joined — e.g. a measure's fact joined on ``sdr_key`` while the
        chart is based on a calendar — anchoring to the base turns the intended
        per-fact-row predicate ("THIS deal is owned by Santiago") into a
        base-row existence check ("this MONTH has ANY Santiago deal"), which
        over-counts the measure. We therefore start the EXISTS sub-path at the
        last step whose source node is already joined, so the correlation ties
        to that FROM-chain alias and the filter constrains the right grain.
        Anchoring to base remains the behaviour for the common single-fact
        case (filter on a dim joined directly to the base) → no regression.

        PATH SELECTION (2026-06 deepening): a filter view (e.g. ``sdr_owner``)
        is typically reachable from the base via SEVERAL equal-length paths —
        one through each sibling fact that shares its key (``Date→deal→owner``,
        ``Date→revenue→owner``, ``Date→activity→owner`` …). ``resolve_path``
        returns whichever the BFS adjacency order discovers first, which is
        usually NOT the measure's fact — so the EXISTS correlates to a sibling
        fact's date back to the base ("this month had a *won deal / activity*
        by Santiago") instead of to the measure's own deal on ``sdr_key``. We
        therefore enumerate ALL shortest paths (``resolve_paths``) and pick the
        one whose correlation anchor lands on the DEEPEST already-joined node —
        i.e. the path that runs THROUGH the measure's (or a dim's) joined view —
        so the filter scopes the measure's grain. When only one shortest path
        exists, or none anchors deeper than the base, the choice is identical to
        the prior ``resolve_path`` behaviour → no regression.
        """
        resolver = self._resolver
        if resolver is None or not predicates:
            return None

        jn = joined_nodes or set()

        def _anchor_idx(p) -> int:
            """Deepest index on ``p.steps`` whose hop SOURCE is already joined.

            ``p.steps`` runs base→…→target; ``step.edge.from_node`` is the
            closer-to-base side of each hop. The highest such index is the most
            specific (closest-to-target) correlation anchor available on ``p``.
            """
            idx = 0
            for i, step in enumerate(p.steps):
                if getattr(step.edge, "from_node", None) in jn:
                    idx = i
            return idx

        # Enumerate every equal-length shortest path and prefer the one with the
        # deepest joined anchor. resolve_paths' first entry == resolve_path, so
        # the single-path / no-deeper-anchor cases stay byte-identical to before.
        candidate_paths = [p for p in (resolver.resolve_paths(target_node) or []) if p and p.steps]
        if not candidate_paths:
            single = resolver.resolve_path(target_node)
            candidate_paths = [single] if (single and single.steps) else []
        if not candidate_paths:
            return None
        path = candidate_paths[0]
        start_idx = _anchor_idx(path)
        for cand in candidate_paths[1:]:
            cand_idx = _anchor_idx(cand)
            if cand_idx > start_idx:
                path, start_idx = cand, cand_idx
        sub_steps = path.steps[start_idx:]
        if not sub_steps:
            return None

        # Lazy import to avoid a cross-module top-level cycle.
        from app.services.dataset_model_service import relation_has_nested_cte

        def _emit(steps) -> str | None:
            """Build one ``EXISTS (...)`` for a base→target sub-path; None if a
            hop's relation can't be safely embedded (unknown view / nested CTE)."""
            pieces: list[str] = []
            correlation: str | None = None
            for idx, step in enumerate(steps):
                edge = step.edge
                try:
                    join_view = self._get_view_for_node(edge.to_node)
                except ValueError:
                    return None
                relation = join_view.sql_table_name or edge.to_view
                # Phase-B' — bail ONLY when a hop's relation embeds a *nested* CTE
                # (the user's production case: `WITH a AS (WITH b AS (...))`
                # wrapped as `(SELECT * FROM (WITH a AS (WITH b AS (...))) AS _src)`.
                # BigQuery rejects THAT as `Syntax error: Unexpected keyword SELECT`.
                # Single-level CTE wraps are BQ-safe (see relation_has_nested_cte).
                if relation_has_nested_cte(relation):
                    self.warnings.append(
                        f"Filter on '{target_node}' dropped — view "
                        f"'{edge.to_node}' is backed by a nested-CTE source_query "
                        f"that cannot be safely embedded in an EXISTS subquery on "
                        f"BigQuery. Refactor the source_query to a single-level CTE."
                    )
                    return None
                condition = self._render_edge_join_condition(edge)
                if not condition:
                    return None
                if idx == 0:
                    pieces.append(f"FROM {relation} AS {edge.to_node}")
                    correlation = condition
                else:
                    pieces.append(f"INNER JOIN {relation} AS {edge.to_node} ON {condition}")
            body_where = [correlation, *predicates] if correlation else list(predicates)
            return "EXISTS (SELECT 1 " + " ".join(pieces) + " WHERE " + " AND ".join(body_where) + ")"

        single_sql = _emit(sub_steps)
        # PATH MULTIPLICITY (PowerBI parity). When the chosen anchor is the BASE
        # itself (start_idx == 0 — there's no deeper joined node to scope to,
        # i.e. a bare fact/KPI filtered by ANOTHER fact's attribute) AND the
        # target is reachable via SEVERAL equal-length paths through DIFFERENT
        # shared conformed dims, PowerBI propagates the filter through EVERY
        # active relationship and INTERSECTS (AND) the results — not one
        # arbitrary path (which made the number depend on BFS/model-build order:
        # revenue ← deal.org_id correlating via date → 2100 vs via owner → 1200).
        # Emit one EXISTS per distinct shared dim (first hop) and AND them.
        # When a path anchors DEEPER than the base (start_idx > 0 — the filter
        # scopes a JOINED measure's grain), keep the single deepest-anchor path
        # UNCHANGED (the chasm-trap fix above): ANDing sibling-fact paths there
        # would wrongly over-constrain the measure. Single-path targets are
        # unaffected (AND-of-one == the single clause; byte-identical SQL).
        if single_sql is not None and start_idx == 0:
            base_paths: dict = {}
            for cand in candidate_paths:
                if cand.steps and _anchor_idx(cand) == 0:
                    base_paths.setdefault(cand.steps[0].edge.to_node, cand)
            if len(base_paths) > 1:
                clauses: list[str] = []
                for cand in base_paths.values():
                    c = _emit(cand.steps)
                    if c is None:
                        clauses = []
                        break
                    clauses.append(c)
                if len(clauses) > 1:
                    return "(" + " AND ".join(clauses) + ")"
        return single_sql
    
    # ── Phase-B' (PBI-parity rework) — WHERE/HAVING split ─────────────
    #
    # `_split_filters_by_role` classifies each filter as dimension-side
    # (→ WHERE) or measure-side (→ HAVING) based on whether its
    # `field_ref` appears in the chart's measures list. The classification
    # is conservative: only filters whose field_ref matches a measure
    # exactly become HAVING; everything else stays in WHERE. This
    # preserves prior behavior for the common dimension-filter case
    # while enabling measure-filter usage that previously fell through
    # to WHERE (where it either no-op'd or returned wrong rows pre-agg).
    #
    # See docs/filter-semantics.md §4 for the spec.
    def _split_filters_by_role(
        self,
        filters: Dict[str, Any],
        measures: List[str],
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        if not filters:
            return {}, {}
        measures_set = {str(m or "").strip().lower() for m in (measures or []) if m}
        if not measures_set:
            return dict(filters), {}
        where_filters: Dict[str, Any] = {}
        having_filters: Dict[str, Any] = {}
        for field_ref, fdef in filters.items():
            key = str(field_ref or "").strip().lower()
            if key in measures_set:
                having_filters[field_ref] = fdef
            else:
                where_filters[field_ref] = fdef
        return where_filters, having_filters

    def _build_having_clause(
        self,
        filters: Dict[str, Any],
        time_grains: Dict[str, str],
        *,
        measure_agg_overrides: Optional[Dict[str, str]] = None,
    ) -> str:
        """Render HAVING clause for measure-side filters.

        Mirrors `_build_where_clause` semantics but resolves the field
        reference through `_render_measure` so the predicate operates
        on the aggregated expression (e.g. `SUM(orders.revenue) > 1B`)
        rather than the raw column.

        Supports the core operators most useful on aggregates:
        eq/neq/gt/gte/lt/lte/between/in/not_in. Other operators
        (contains/regex/etc.) are skipped with a warning — they make
        little sense on a numeric aggregate.
        """
        if not filters:
            return ""

        def _lit(raw: Any) -> str:
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

        conditions: List[str] = []
        overrides = measure_agg_overrides or {}
        for field_ref, filter_def in (
            (fr, d)
            for fr, fd in filters.items()
            for d in (fd if isinstance(fd, list) else [fd])
        ):
            operator = str(filter_def.get('operator') or 'eq').strip().lower()
            value = filter_def.get('value')
            try:
                measure_sql = self._render_measure(
                    field_ref,
                    agg_override=overrides.get(field_ref),
                )
            except Exception as exc:
                self.warnings.append(
                    f"HAVING filter dropped — measure {field_ref!r}: {exc}"
                )
                continue

            if operator == "is_null":
                conditions.append(f"{measure_sql} IS NULL")
                continue
            if operator == "is_not_null":
                conditions.append(f"{measure_sql} IS NOT NULL")
                continue

            if operator == "between" and isinstance(value, list) and len(value) >= 2:
                lo, hi = value[0], value[1]
                if _value_present(lo) and _value_present(hi):
                    conditions.append(f"{measure_sql} BETWEEN {_lit(lo)} AND {_lit(hi)}")
                elif _value_present(lo):
                    conditions.append(f"{measure_sql} >= {_lit(lo)}")
                elif _value_present(hi):
                    conditions.append(f"{measure_sql} <= {_lit(hi)}")
                continue

            if operator in {"in", "not_in"}:
                if isinstance(value, list):
                    vals = ", ".join(_lit(v) for v in value if _value_present(v))
                elif isinstance(value, str) and value.strip():
                    vals = ", ".join(_lit(v.strip()) for v in value.split(",") if v.strip())
                else:
                    vals = ""
                if vals:
                    op = "IN" if operator == "in" else "NOT IN"
                    conditions.append(f"{measure_sql} {op} ({vals})")
                continue

            scalar_ops = {
                "eq": "=", "neq": "!=", "ne": "!=",
                "gt": ">", "gte": ">=", "lt": "<", "lte": "<=",
            }
            if operator in scalar_ops:
                conditions.append(f"{measure_sql} {scalar_ops[operator]} {_lit(value)}")
                continue

            self.warnings.append(
                f"HAVING filter dropped — operator {operator!r} unsupported "
                f"for measure {field_ref!r}"
            )

        if conditions:
            return "HAVING\n  " + " AND\n  ".join(conditions)
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
        """Parse 'view.field' into (view_name, field_name).

        Phase-15.53: auto-qualify bare refs. When `field_ref` has no
        view prefix (e.g. `"name"` instead of `"sdr_owner.name"`), we
        scan the loaded views_cache and:
          • find ONE matching dim/measure → silently qualify
          • find MULTIPLE matches across joined views → raise
            AmbiguousFieldError with a hint listing all candidates so
            the caller (chart service) can surface a clean error to the
            UI (the BigQuery "Column name is ambiguous" message left
            DAs stuck — they didn't know it meant "qualify with a
            table prefix").
          • find ZERO matches → raise ValueError as before.

        Chart configs created by MCP or the FE picker still emit bare
        refs occasionally; this normalises them so query compilation
        no longer crashes downstream on multi-table datasets.
        """
        if '.' in field_ref:
            parts = field_ref.split('.', 1)
            return parts[0], parts[1]

        # Bare field — try to resolve against loaded views.
        candidates: List[str] = []
        for view_name, view in self.views_cache.items():
            in_dims = any((d or {}).get('name') == field_ref for d in (view.dimensions or []))
            in_measures = any((m or {}).get('name') == field_ref for m in (view.measures or []))
            if in_dims or in_measures:
                candidates.append(view_name)

        if len(candidates) == 1:
            return candidates[0], field_ref
        if len(candidates) > 1:
            qualified_hints = ", ".join(f"'{v}.{field_ref}'" for v in candidates)
            raise AmbiguousFieldError(
                f"Field '{field_ref}' xuất hiện ở nhiều bảng đã JOIN: "
                f"{', '.join(candidates)}. Mở chart và đổi reference "
                f"sang một trong: {qualified_hints} để engine biết "
                "lấy từ bảng nào."
            )
        raise ValueError(
            f"Invalid field reference: {field_ref} (must be view.field, "
            f"và không tìm thấy field '{field_ref}' trong bất kỳ view nào "
            f"của dataset)."
        )

    def _measure_fact_view(self, measure_ref: str) -> str:
        """The view at whose GRAIN a measure aggregates.

        Normally the measure's DECLARED view (the ``view.`` prefix of the
        ref). BUT a dataset-scope CROSS-TABLE measure — declared on view A
        yet whose expression aggregates a column from a single OTHER view B
        (via ``source_columns``, e.g. ``SUM(${B.deal_value})``) — actually
        aggregates at B's grain. Return B so the isolation / re-anchor
        machinery evaluates it there.

        Without this, ``_parse_field_ref`` reports A (which is often the
        chart's base), the measure is treated as same-fact, B is never added
        to the FROM/JOIN chain, and the emitted SQL references ``B.col``
        against a table not in FROM → BigQuery "Unrecognized name: B".
        """
        try:
            declared_view, field = self._parse_field_ref(measure_ref)
        except ValueError:
            return measure_ref
        try:
            view = self.views_cache.get(declared_view) or self._get_view_for_node(declared_view)
        except Exception:  # noqa: BLE001 — best effort; fall back to declared view
            return declared_view
        mdef = next(
            (m for m in (view.measures or [])
             if (m.get("name") == field or m.get("sql_name") == field)),
            None,
        )
        if not mdef or str(mdef.get("scope") or "view") != "dataset":
            return declared_view
        src_views = {
            str(s.get("view") or "").strip()
            for s in (mdef.get("source_columns") or [])
            if isinstance(s, dict) and str(s.get("view") or "").strip()
        }
        src_views.discard(declared_view)

        # BUG-007 (2026-06-11): only re-anchor to the foreign view when the
        # expression aggregates ONLY that foreign view's column(s). If the
        # expression ALSO references the declared (base) view's OWN columns —
        # e.g. `${quantity}/${products.price}` where `quantity` is a bare ref to
        # the base — the measure spans BOTH grains and MUST keep the base in the
        # FROM/JOIN chain (return declared_view). Re-anchoring to the foreign
        # view would isolate the base out → `base.col` references a table not in
        # FROM → "Unrecognized name". Detect base refs: a bare `${field}` (no
        # dot) or an explicit `${<declared_view>.field}` in the expression.
        expr = str(mdef.get("expression") or "")
        if expr:
            bare_refs = re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", expr)
            qualified_refs = re.findall(
                r"\$\{([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*\}", expr
            )
            references_base = bool(bare_refs) or (declared_view in qualified_refs)
            if references_base:
                return declared_view

        # A SINGLE foreign source view → that view IS the measure's grain.
        # (Multiple foreign views = a true multi-table formula; keep it on the
        # declared view so the formula renderer + join collector handle it.)
        if len(src_views) == 1:
            return next(iter(src_views))
        return declared_view

    def _direct_join_views(self, base_view_name: str) -> set[str]:
        """View names DIRECTLY joined from ``base_view_name``'s explore (one
        hop — NOT chasm-reachable through a shared dimension).

        Used to reject slicing a cross-table measure by a dimension on an
        UNRELATED fact: such a dim is only reachable via a chasm (fact →
        shared dim → other fact), which fans the measure's source rows and
        silently inflates the aggregate. There is no correct value without a
        direct relationship, so the caller fails loud instead.
        """
        exp = self.db.query(SemanticExplore).filter(
            SemanticExplore.base_view_name == base_view_name,
            SemanticExplore.model_id == getattr(self._model, "id", None),
        ).first()
        out: set[str] = set()
        for j in (getattr(exp, "joins", None) or []):
            if not isinstance(j, dict):
                continue
            tgt = j.get("view") or j.get("to_view") or j.get("target") or j.get("name")
            if tgt:
                out.add(str(tgt))
        return out

    def _validate_group_grain(self, dimensions, pivots, measures) -> None:
        """STRICT grain guard — raise if a group dimension/pivot lives on a fact
        that is NOT M:1-reachable from a measure's fact (a chasm). Grouping a
        measure by such a dim forces a fan-out JOIN that double-counts it. See
        the call site in ``generate_sql`` for the full rationale. No group
        dims/pivots → no-op (KPIs unaffected)."""
        group_views: set[str] = set()
        for ref in list(dimensions or []) + list(pivots or []):
            try:
                v = self._parse_field_ref(ref)[0]
            except Exception:
                continue
            if v:
                group_views.add(v)
        if not group_views:
            return
        for m in (measures or []):
            try:
                fact = self._measure_fact_view(m)
            except Exception:
                continue
            if not fact:
                continue
            safe = self._m1_reachable_views(fact) | {fact}
            unsafe = sorted(v for v in group_views if v not in safe)
            if unsafe:
                raise ValueError(
                    f"Measure trên bảng '{fact}' không thể nhóm/pivot theo "
                    f"dimension {unsafe} (không có đường M:1 — JOIN sẽ fan-out, "
                    f"ra số sai). Các chiều này thuộc bảng fact khác / chỉ nối "
                    f"qua shared dim (chasm). Đổi chiều, thêm quan hệ M:1 trong "
                    f"Data Model, hoặc bỏ measure khỏi chart."
                )

    def _m1_reachable_views(self, fact: str) -> set[str]:
        """Views reachable from ``fact`` by following the join graph FORWARD
        (transitively) along non-fanning edges — every hop maps a ``fact`` row
        to a SINGLE target row.

        A group dimension on such a view is safe to aggregate ``fact``'s
        measures by, including SNOWFLAKE dims (sales → product → category, all
        many-to-one). A dimension that lives on ANOTHER FACT is NOT reached:
        the forward graph only contains ``fact → dim → parent-dim`` edges; an
        other fact joins TO a shared dim (the reverse edge lives in that fact's
        own explore), so reaching it would require a one-to-many hop (a chasm)
        which we never traverse.

        Strictly better than ``_direct_join_views`` (one hop — too strict for
        snowflakes) and bidirectional ``reachable_nodes`` (walks 1:N edges, so
        it treats chasm-reachable facts as related → silent fan-out).
        """
        model_id = getattr(self._model, "id", None)
        _M1 = {"many_to_one", "one_to_one"}
        seen: set[str] = {fact}
        frontier: list[str] = [fact]
        while frontier:
            cur = frontier.pop()
            exp = self.db.query(SemanticExplore).filter(
                SemanticExplore.base_view_name == cur,
                SemanticExplore.model_id == model_id,
            ).first()
            for j in (getattr(exp, "joins", None) or []):
                if not isinstance(j, dict):
                    continue
                card = str(
                    j.get("relationship") or j.get("cardinality") or j.get("type") or ""
                ).strip().lower().replace("-", "_").replace(" ", "_")
                # STRICT (PowerBI parity): traverse ONLY an EXPLICITLY
                # many_to_one / one_to_one hop. An empty / unknown / garbage
                # cardinality is NOT assumed M:1-safe — on a galaxy schema a
                # missing-cardinality edge can fan out (or reach another fact),
                # so guessing M:1 risks a silently-wrong number. Unknown →
                # NOT reachable → the caller (re-anchor / stitch) fails loud,
                # prompting the modeller to DECLARE the relationship in the Data
                # Model rather than the engine guessing it. (generate-model
                # backfills cardinality, so real explores carry explicit values.)
                if card not in _M1:
                    continue
                tgt = str(
                    j.get("view") or j.get("to_view") or j.get("target") or j.get("name") or ""
                ).strip()
                if tgt and tgt not in seen:
                    seen.add(tgt)
                    frontier.append(tgt)
        return seen
    
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

        rendered = re.sub(dotted_pattern, replace_field, rendered)

        # BUG-007 (2026-06-11): resolve BARE ${field} refs (no dot) too. They
        # denote a column on the CURRENT view and must qualify to
        # `view_alias.field`, exactly like ${TABLE}.field. Previously only the
        # dotted form was substituted, so a cross-table ratio such as
        # `${lead_nhan}/${dataset_table_381.so_nhan_su_sdr}` left the bare
        # `${lead_nhan}` intact → the `$`/`{`/`}` chars reached BigQuery which
        # raised a syntax error. The auto-qualify step in `_render_measure`
        # also skips any template containing `${`, so this is the only place
        # that can resolve a bare ref inside a compound expression. Runs AFTER
        # the dotted pass so `${view.field}` is already consumed and the bare
        # pattern can't accidentally match the leftover field portion.
        bare_pattern = r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"

        def replace_bare(match):
            return f"{view_alias}.{match.group(1)}"

        return re.sub(bare_pattern, replace_bare, rendered)

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
    
    def _quote_ident(self, name: str) -> str:
        """Quote a SQL identifier ONLY when it needs it (contains chars outside
        [A-Za-z0-9_]). Plain identifiers return unquoted so existing SQL stays
        byte-identical; names with spaces/special chars (e.g. 'Activity Group')
        get the dialect quote char (backtick on BigQuery/MySQL, double-quote
        elsewhere)."""
        name = str(name)
        if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
            return name
        dialect = (self.database_type or '').lower()
        if dialect in ('bigquery', 'mysql'):
            return '`' + name.replace('`', '') + '`'
        return '"' + name.replace('"', '') + '"'

    def _safe_alias(self, field_ref: str) -> str:
        """Generate a safe SQL alias from a field reference. Sanitizes EVERY
        non-identifier char (not just '.') — a column like 'Activity Group'
        otherwise yields the alias 'view_Activity Group' with a space, which is
        invalid SQL. Must match chart_service._build_semantic_alias_map."""
        return re.sub(r'[^A-Za-z0-9_]', '_', field_ref)
    
    def _pivot_column_alias(self, measure_field: str, pivot_value: str) -> str:
        """Generate alias for pivoted column"""
        safe_measure = self._safe_alias(measure_field)
        safe_value = re.sub(r'[^a-zA-Z0-9_]', '_', str(pivot_value))
        return f"{safe_measure}_{safe_value}"
