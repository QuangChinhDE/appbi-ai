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
from app.services import physical_type_map as _ptm
from app.services.sql_literal import quote_string as _quote_string
from app.services.sql_pattern import pattern_predicate, regex_predicate
from app.services.semantic_arithmetic import normalize_division, true_division_sql
from app.services.semantic_join_resolver import (
    AmbiguousJoinPathError, RouteEnumerationIncomplete, SemanticJoinResolver, SemanticRefusal,
    canonical_cardinality, edge_propagates, hop_is_to_one, raise_for_invalid_relationships,
    read_join_contract,
)
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
        # BUG-018 redux — per-table {column: physical_type} maps, lazily built
        # from DatasetTable.columns_cache so the type-aware filter/aggregate
        # paths can recover a column's real type even when it was never
        # modeled as a declared dimension. Keyed by dataset_table_id.
        self._phys_coltype_cache: Dict[Any, Dict[str, str]] = {}
        # Dashboard perf #5 — snapshot redirect map (see generate_sql). Default
        # empty = live behaviour; set per-request by the caller.
        self._snapshot_overrides: Dict[int, str] = {}
        # Phase 3 — per-request compile-time relation cache + drop diagnostics.
        self._relation_sql_cache: Dict[int, Optional[str]] = {}
        self._relation_source_cache: Dict[int, tuple] = {}
        self.live_source_ids: Set[int] = set()
        self.live_source_kinds: Dict[int, Set[str]] = {}
        self._propagation_drops: list = []
        # Calendar materialization — per-request memo of "the generated-calendar
        # table's snapshot ref among _snapshot_overrides" so role-played date-dim
        # views (dataset_table_id is None) can read the flat snapshot too. False =
        # not yet computed; None = no materialized calendar; str = the physical ref.
        self._calendar_ref_cache: Any = False
        # Audit #3 — per-request memo of the inline calendar SQL re-rendered for
        # THIS engine's dialect (role-dim fallback when no snapshot override).
        self._cal_live_sql_cache: Any = False

    def run(self, spec) -> Tuple[str, List[str], List[PivotedColumn]]:
        """Single engine entry: execute a ``SemanticQuerySpec`` (the one input
        every path compiles to via ``semantic_query_compiler``). Unpacks to
        ``generate_sql`` (which stays the internal implementation). ``spec``'s
        ``response_aliases`` / ``diagnostics`` are caller-side extras the engine
        ignores.

        Refactor Phase 3 — per-entry state hygiene: ``run`` is the ONE public
        entry, so per-request diagnostics reset HERE (not in generate_sql, which
        recurses internally for re-anchor/multi-fact and must ACCUMULATE across
        those recursions). ``snapshot_overrides`` is likewise always passed as a
        concrete dict so a reused engine instance can never leak a previous
        request's snapshot redirects into this one."""
        self._propagation_drops = []
        # Datasource ids whose tables this statement reads LIVE (not from a
        # snapshot ref) — the executor checks they share its connection
        # (execution_plan.refuse_foreign_live_sources).
        self.live_source_ids = set()
        self.live_source_kinds = {}
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
            snapshot_overrides=dict(getattr(spec, "snapshot_overrides", None) or {}),
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
        snapshot_overrides: Optional[Dict[int, str]] = None,
    ) -> Tuple[str, List[str], List[PivotedColumn]]:
        """
        Generate SQL from semantic query definition (v2)
        
        Returns:
            Tuple of (sql, columns, pivoted_columns)
        """
        self.warnings = []
        if not _reanchored:
            self._stitch_decline_reason = None
            # Key probes of every to-one JOIN this query (and its re-anchored /
            # stitched sub-queries) trusts — see relationship_key_guard.
            self._key_probes = {}
            # Snapshot-dependent memos are per QUERY: the previous-generation
            # fallback re-runs this same instance on another generation, and a
            # kept calendar ref would read (and probe) the failed generation.
            self._calendar_ref_cache = False
            self._cal_live_sql_cache = False
            self._snap_rename_cache = None
            # The observable plan of THIS query and its route memos.
            self.query_plan = {}
            self._filter_resolver_cache = {}
            self._filter_root = None
            self._calendar_candidates_memo = {}
            self._from_fact_views = set()
        self.views_cache = {}
        self._resolver = None
        self._model = None
        self._model_dataset_table_ids = set()
        self._symmetric_aggregate_views = set()
        self._phys_coltype_cache = {}
        # Canonical non-fanning reachability graph, memoised per model for THIS
        # request (rebuilt fresh each top-level call; a re-anchored re-entry on
        # the same model reuses it). See _non_fanning_adjacency.
        self._nf_adj_cache = {}
        # Refactor Phase 3 — compile-time relation cache: physical relation SQL is
        # rendered per-request from the CURRENT DatasetTable definition in THIS
        # engine's dialect (see _relation_sql_for_view), memoised per table id.
        self._relation_sql_cache = {}
        self._relation_source_cache = {}
        # Dashboard perf #5 — snapshot redirect. {dataset_table_id -> physical_ref}.
        # When a view's table has a fresh materialized snapshot, the FROM clause
        # reads the flat snapshot instead of re-running its heavy source SQL.
        # Empty map → no change. Read-only; never mutates the ORM SemanticView.
        # Top-level entry (run()) ALWAYS passes a concrete dict; the internal
        # recursive generate_sql calls (measure-isolation re-anchor + per-fact
        # multifact) pass the current map explicitly so it survives recursion
        # without relying on instance-state persistence (Phase 3 hygiene).
        if snapshot_overrides is not None:
            self._snapshot_overrides = dict(snapshot_overrides)
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
        if explore_id is None and model_id is None:
            # A bare name is not unique across models; `.first()` would pick one
            # by storage order — another model's views, joins and source.
            _candidates = explore_query.limit(2).all()
            if len(_candidates) > 1:
                raise ValueError(
                    f"Explore '{explore_name}' tồn tại ở nhiều model — truyền model_id để chỉ định."
                )
            explore = _candidates[0] if _candidates else None
        else:
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
        raise_for_invalid_relationships(self._resolver)

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
        # `_disable_isolation` reverts to the pre-isolation legacy path entirely —
        # no collapse, no isolation/re-anchor/stitch. NO production caller sets
        # it: the chart runtime has no isolation-disabling retry (a refused or
        # failing query is never re-run through a weaker path — Pair #3).
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
                self._plan_note(strategy="isolate")

        # ── Dimensioned chart with cross-fact measure(s) — base-invariance ──
        # Two cases (both keep the measure at its OWN grain, PowerBI/Tableau):
        #   • SINGLE measure-fact M (≠ base): RE-ANCHOR the whole query at M
        #     (reuses the full verified engine incl pivot/window/calc). Group
        #     dims/pivots unrelated to M → REFUSED (UNRELATED_GRAIN).
        #   • MULTIPLE measure-facts (mixed base+cross, or several cross-facts):
        #     sub-generate each fact independently (re-anchored) and STITCH on
        #     the shared group dims (skeleton ∪ + NULL-safe LEFT JOINs). A stitch
        #     that declines, and pivot/window/calc with multi-fact, are REFUSED
        #     (FANOUT_RISK, the fail-loud guard below) — never the single-FROM
        #     build, which would JOIN the facts and fan out.
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
                        # "Preserve the base's members" only means something when
                        # the base IS a row dimension. Grouped by something else
                        # (a calendar reached through the fact), the base would
                        # only drop the fact rows that have no base member — a
                        # base-dependent number, the same defect the KPI guard
                        # below fixes. Such a chart re-anchors like a KPI.
                        and explore.base_view_name in _grp_views
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
                        _rebound = self._rebind_calendar_filters(
                            dict(filters or {}), _cal_view, measure_view=_m_view,
                            tied=self._calendar_tie(_m_resolver, _m_view),
                        )
                        self._plan_note(strategy="reanchor", calendar={_m_view: _cal_view})
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
                            snapshot_overrides=self._snapshot_overrides,
                        )
                else:
                    # (A cross-table measure grouped ONLY by dims unrelated to its
                    # source fact used to be isolated here — its grand total
                    # repeated per group — while the same aggregate declared on its
                    # own view is refused: one quantity, two answers. The kernel
                    # contract is the refusal, for both — foundation freeze.)
                    # MIXED (some related + some unrelated dims), or a non-scalar
                    # measure with an unrelated dim, or a non-cross-table measure
                    # that can't re-anchor onto an unrelated dim. The legacy
                    # single-FROM build would JOIN through a chasm and FAN OUT →
                    # FAIL LOUD (wrong number must never render).
                    raise SemanticRefusal(
                        f"Measure trên bảng '{_m_view}' không thể nhóm/cắt theo dimension "
                        f"{sorted(_grp_unrelated)} một cách an toàn (không có đường M:1 — "
                        f"JOIN sẽ fan-out, ra số sai). Thêm/sửa quan hệ trong Data Model, "
                        f"đổi dimension, hoặc qualify field.",
                        SemanticRefusal.UNRELATED_GRAIN,
                    )
            elif (
                _cross and len(_facts) >= 2
                and dimensions
                and not pivots and not window_functions and not calculated_fields
            ):
                _stitched = self._build_dimensioned_multifact_sql(
                    explore, dimensions, measures, filters, time_grains,
                    limit, measure_agg_overrides,
                    sorts=sorts, top_n=top_n,
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
                _reason = getattr(self, "_stitch_decline_reason", None)
                raise SemanticRefusal(
                    "Không thể tính các measure từ nhiều bảng fact "
                    f"({', '.join(sorted(_fact_grains))}) theo cấu hình chart này "
                    "một cách an toàn — thiếu relationship / ambiguous path, hoặc "
                    "chart dùng pivot/window/calc cùng measure đa-fact. JOIN các "
                    "fact sẽ fan-out và nhân SUM lên, nên engine từ chối render số "
                    "sai. Hãy thêm/sửa quan hệ trong Data Model, đổi dimension, "
                    "hoặc tách thành nhiều chart."
                    + (f" Lý do cụ thể: {_reason}" if _reason else ""),
                    SemanticRefusal.FANOUT_RISK,
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
            # ── DIMS-ONLY multi-fact fan-out guard (PowerBI parity) ──────────
            # Every measure guard above gates on `measures`, so a chart with NO
            # measure (a Table / list that just SELECTs columns) slips through:
            # the normal build below flat-LEFT-JOINs every dim view, and if two
            # of them are DIFFERENT facts joined only through a shared dim
            # (chasm), the join fans the base rows into their cartesian product
            # (n×m rows) — the "n-n" a DA sees when pulling raw columns from two
            # fact tables into one table. With no measure the BASE view IS the
            # grain, so every dim/pivot view must be M:1-reachable from it
            # (itself, or a star/snowflake spoke); a view reachable only via a
            # 1:N hop is another fact → fail loud (same policy as the measure
            # paths) rather than render duplicated rows. Single-fact tables and
            # single-table selects stay safe (all views M:1-reachable).
            if not measures and (dimensions or pivots):
                self._validate_dims_only_grain(explore.base_view_name, dimensions, pivots)

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
        # BUG (2026-06-12): also pull in the views of a formula measure's
        # cross-view `depends_on` measures. A ratio like
        # `${products.prod_value}/${employees.emp_value}` declared on base
        # `sales` lists those qualified measures in depends_on; the formula
        # renderer inlines each as its OWN aggregate (SUM(products.price) etc.),
        # so products/employees must be in the FROM/JOIN chain or BigQuery
        # raises "Unrecognized name". (source_columns covers the column-ratio
        # case; this covers the measure-ratio case.)
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
            if not mdef:
                continue
            if str(mdef.get("scope") or "view") == "dataset":
                _grain = self._measure_fact_view(m)
                _grain_m1 = None
                for entry in mdef.get("source_columns") or []:
                    sv = str(entry.get("view") or "").strip() if isinstance(entry, dict) else ""
                    if sv:
                        if sv != _grain:
                            # A row-level column of ANOTHER view is safe only when
                            # every row the measure aggregates (its grain) has at
                            # most ONE row of that view: many-to-one reachable.
                            # A one-to-many child joined in would multiply the
                            # grain's rows — THIS measure's and every other
                            # measure's of the statement (SUM(fee) × items).
                            if _grain_m1 is None:
                                _grain_m1 = self._m1_reachable_views(_grain)
                            if sv not in _grain_m1:
                                raise SemanticRefusal(
                                    f"Measure '{m}' đọc cột của '{sv}', bảng không đi được theo quan hệ "
                                    f"nhiều-một từ '{_grain}' (grain của measure): JOIN bảng đó sẽ nhân "
                                    "dòng — measure này và mọi measure khác trong truy vấn ra số sai. "
                                    "Đặt measure trên bảng chi tiết (nhiều) hoặc tổng hợp riêng rồi "
                                    "dùng measure công thức trên cùng một view.",
                                    SemanticRefusal.FANOUT_RISK,
                                )
                        measure_source_views.add(sv)
            # cross-view depends_on measures → JOIN their views
            for dep in mdef.get("depends_on") or []:
                dep_s = str(dep or "").strip()
                if "." in dep_s:
                    dep_view = dep_s.split(".", 1)[0].strip()
                    if dep_view and dep_view != decl_view:
                        measure_source_views.add(dep_view)

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
        # The probes THIS statement's FROM chain trusts (a nested generation —
        # another fact's CTE — keeps its own list).
        _outer_chain_probes = getattr(self, "_chain_probe_keys", None)
        self._chain_probe_keys = []
        try:
            if _omit_from:
                from_clause = ""
                joined_nodes = {explore.base_view_name}
            else:
                # The facts whose rows the measures sum (not the isolated ones):
                # under a dimension base, their own dimensions are meanings too.
                self._from_fact_views = {
                    self._measure_fact_view(m) for m in (measures or [])
                } - set(getattr(self, "_isolated_measure_views", None) or ())
                from_clause, joined_nodes = self._build_from_clause(
                    explore, target_views=select_side_views,
                )
            _statement_probe_keys = list(self._chain_probe_keys)
        finally:
            self._chain_probe_keys = _outer_chain_probes
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
            # Concept-1 (model-structure) filter anchor: the set of views that are
            # forward-M:1 reachable from each MEASURE'S FACT (+ the facts). A filter
            # on any of these is a standard dim→fact filter that must apply
            # irrespective of the chart's base view or cross-filter direction —
            # see the drop gate in _build_where_clause. Empty for pure-dim charts
            # with no fact measure (keeps the direction gate authoritative there).
            _measure_fact_views: set[str] = set()
            for _m in (measures or []):
                try:
                    _mf = self._measure_fact_view(_m)
                except Exception:  # noqa: BLE001 — never block on measure parse
                    _mf = None
                if _mf:
                    _measure_fact_views |= self._m1_reachable_views(_mf) | {_mf}
            # Filter routes are walked from the query's FACT grain: the measure's
            # fact when it is joined under another base (a chart grouped by a
            # dimension table), else the base. The same filter then means the same
            # thing whichever table the chart is based on.
            _facts_here = {self._measure_fact_view(m) for m in (measures or [])}
            _outer_filter_root = getattr(self, "_filter_root", None)
            self._filter_root = (
                next(iter(_facts_here))
                if len(_facts_here) == 1 and next(iter(_facts_here)) in joined_nodes
                else explore.base_view_name
            )
            self._plan_note(fact_grains=sorted(_facts_here) or [explore.base_view_name],
                            filter_root=self._filter_root)
            try:
                where_clause = self._build_where_clause(
                    where_filters, time_grains,
                    exists_views=exists_views,
                    explore=explore,
                    select_side_views=select_side_views,
                    joined_nodes=joined_nodes,
                    measure_fact_views=_measure_fact_views,
                )
            finally:
                self._filter_root = _outer_filter_root
            having_clause = self._build_having_clause(
                having_filters, time_grains,
                measure_agg_overrides=measure_agg_overrides or {},
            )
            # The one-side keys this statement's JOINs trust are re-checked IN
            # the statement (same snapshot as the JOIN) for every live relation:
            # the probe that ran before the query cannot see a writer in between.
            from app.services.relationship_key_guard import statement_key_guard

            _recorded = getattr(self, "_key_probes", None) or {}
            _key_guard = statement_key_guard([_recorded[k] for k in _statement_probe_keys if k in _recorded])
            if _key_guard and from_clause:
                where_clause = (f"{where_clause} AND\n  {_key_guard}" if where_clause
                                else f"WHERE\n  {_key_guard}")

        # Build GROUP BY clause
        group_by_clause = self._build_group_by_clause(dimensions, measures, pivots, time_grains)

        # Build ORDER BY clause
        order_by_clause = self._build_order_by_clause(
            sorts, measures, top_n, group_dims=[d for d in dimensions if d not in (pivots or [])],
        )

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

        self._plan_note(strategy="single")
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
            # A view with no table (a role-played calendar) is global by name,
            # so it is only this model's when one of the model's explores names
            # it — otherwise a same-named view of another dataset would be used.
            if name not in self._model_view_names():
                return None
        return (
            self.db.query(SemanticView)
            .filter(
                SemanticView.name == name,
                SemanticView.dataset_table_id.is_(None),
            )
            .first()
        )

    def _model_view_names(self) -> Set[str]:
        """Every view name the current model's explores reference."""
        cached = getattr(self, "_model_view_names_cache", None)
        if cached is not None and cached[0] == getattr(self._model, "id", None):
            return cached[1]
        names: Set[str] = set()
        if self._model is not None:
            for e in self.db.query(SemanticExplore).filter(
                SemanticExplore.model_id == self._model.id
            ).all():
                names.add(str(e.base_view_name or ""))
                for j in e.joins or []:
                    if isinstance(j, dict) and j.get("view"):
                        names.add(str(j["view"]))
        self._model_view_names_cache = (getattr(self._model, "id", None), names)
        return names
    
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
    
    def _dimension_is_text_typed(self, field_ref: str) -> bool:
        """True when this dimension's column is stored as TEXT.

        Same recorded metadata + same shared vocabulary the SUM gate uses
        (``physical_type_map.loads_as_text``), so "needs a cast" means one thing
        across aggregation, joins and time grains. Unresolvable field → False
        (render exactly as before)."""
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
        if dim is not None:
            return _ptm.loads_as_text(dim.get("source_type"), dim.get("type"))
        phys = self._physical_source_type(view, col)
        return bool(phys) and _ptm.loads_as_text(phys)

    def _calendar_timezone(self) -> Optional[str]:
        """The model's dataset calendar timezone when it shifts dates, else None."""
        cached = getattr(self, "_calendar_tz_cache", None)
        model_id = getattr(self._model, "id", None)
        if cached is not None and cached[0] == model_id:
            return cached[1]
        tz = None
        dataset_id = getattr(self._model, "dataset_id", None)
        if dataset_id is not None:
            from app.models.dataset import Dataset
            from app.services.dataset_calendar_service import effective_calendar_timezone

            dataset = self.db.query(Dataset).filter(Dataset.id == dataset_id).first()
            tz = effective_calendar_timezone(dataset) if dataset is not None else None
        self._calendar_tz_cache = (model_id, tz)
        return tz

    def _dimension_is_instant(self, field_ref: str) -> bool:
        """True when the dimension's column is a TIMESTAMP-like instant."""
        from app.services.dataset_calendar_service import is_instant_column

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
        phys = (dim or {}).get("source_type") or self._physical_source_type(view, col)
        return is_instant_column(phys, (dim or {}).get("type"))

    @staticmethod
    def _truncate_date_sql(date_sql: str, grain: str, dialect: str) -> str:
        """Start of the `grain` bucket of a DATE expression (ISO Monday weeks)."""
        g = (grain or "day").lower()
        if dialect == "bigquery":
            if g == "day":
                return date_sql
            unit = {"week": "WEEK(MONDAY)", "month": "MONTH", "quarter": "QUARTER", "year": "YEAR"}.get(g)
            return f"DATE_TRUNC({date_sql}, {unit})" if unit else date_sql
        if dialect == "mysql":
            if g == "week":
                return f"DATE_SUB({date_sql}, INTERVAL WEEKDAY({date_sql}) DAY)"
            if g == "month":
                return f"DATE_FORMAT({date_sql}, '%Y-%m-01')"
            if g == "quarter":
                return f"MAKEDATE(YEAR({date_sql}), 1) + INTERVAL (QUARTER({date_sql}) - 1) QUARTER"
            if g == "year":
                return f"MAKEDATE(YEAR({date_sql}), 1)"
            return date_sql
        if g not in {"day", "week", "month", "quarter", "year"}:
            g = "day"
        return f"DATE_TRUNC('{g}', {date_sql})"

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
        # A time grain over a column that is PHYSICALLY TEXT is invalid SQL, not a
        # rounding problem: BigQuery rejects `TIMESTAMP_TRUNC(STRING, MONTH)` and
        # the whole chart 400s. Text dates are normal here — a CSV/Sheets cell is
        # always text, and Airbyte lands dates as STRING — so coerce first. The
        # cast is a value-preserving no-op on a genuine DATE/TIMESTAMP column, so
        # the common case is unchanged, and unparseable text becomes NULL (an
        # empty bucket) instead of killing the query.
        if self._dimension_is_text_typed(field_ref):
            from app.services.type_override_service import build_safe_cast_sql

            base_sql = build_safe_cast_sql(base_sql, "datetime", dialect)
        elif dialect == "duckdb":
            # Manual and Google Sheets sources run on DuckDB, where a cell is
            # materialized as VARCHAR while the model records its SAMPLED type
            # ('date') — so the text gate above cannot see it, and
            # DATE_TRUNC('month', VARCHAR) is a Binder error: every viewer drill
            # / time grain on such a report failed. TRY_CAST is value-preserving
            # on a genuine DATE/TIMESTAMP and parses ISO text.
            base_sql = f"TRY_CAST({base_sql} AS TIMESTAMP)"

        # SEM-P2-007 — with a non-UTC calendar timezone, the calendar join puts
        # an INSTANT on its LOCAL date. Bucketing the raw instant (UTC on
        # BigQuery, the session zone on Postgres) put a near-midnight event in
        # another day/week/month than the calendar's own columns did. Bucket
        # the same local date instead (sql: dataset_calendar_service.local_date_sql).
        _tz = self._calendar_timezone()
        if _tz and self._dimension_is_instant(field_ref):
            from app.services.dataset_calendar_service import local_date_sql

            return self._truncate_date_sql(local_date_sql(base_sql, _tz, dialect), grain, dialect)

        if dialect == "bigquery":
            # WEEK alone is WEEK(SUNDAY) on BigQuery; every other dialect here and
            # the generated calendar (ISO week columns) start weeks on MONDAY, so
            # the same event landed in a different week on live vs snapshot.
            grain_map = {
                "day": "DAY",
                "week": "WEEK(MONDAY)",
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
        # THE decision is delegated to `physical_type_map.loads_as_text`, which is
        # the SAME map the snapshot loader uses to choose each column's physical
        # BigQuery type. Keeping a private token set here is what broke: the loader
        # stopped recognising `number` (CSV/manual) and stored STRING while this
        # gate still read `number` as numeric and skipped the cast → SUM(STRING)
        # 400. Sharing the map makes "stored as text" and "cast before SUM" one
        # decision that cannot drift.
        dim = next(
            (d for d in (getattr(view, "dimensions", None) or []) if d.get("name") == col),
            None,
        )
        if not dim:
            # Not a declared dimension (deleted dim, column added after model-gen,
            # or picked from the measure-column combobox) — recover the physical
            # type from columns_cache so an unmodeled text column still casts.
            phys = self._physical_source_type(view, col)
            return bool(phys) and _ptm.loads_as_text(phys)
        return _ptm.loads_as_text(dim.get("source_type"), dim.get("type"))

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

    def _physical_source_type(self, view, col: str) -> Optional[str]:
        """Resolve a column's PHYSICAL warehouse type from the view's underlying
        ``DatasetTable.columns_cache`` — for columns that are NOT declared
        dimensions.

        Model generation turns most columns into dimensions (carrying
        ``source_type``), but a DA can (a) delete a dimension, (b) reference a
        column added to the source AFTER generation, or (c) pick — via the
        measure-filter / aggregation column combobox, which lists EVERY physical
        column — a numeric column that was never modeled as a dimension. The
        dimension-only type lookups then saw nothing and the caller fell back to
        "quote as a string", which slipped ``INT64_col = '1'`` to BigQuery → 400
        "No matching signature for operator = INT64, STRING" (BUG-018 only fixed
        the declared-dimension case). This recovers the real type so the value
        renders with a matching SQL literal.

        Returns a lowercased type string (physical ``source_type`` preferred,
        value-sampled ``type`` as fallback) or None when unresolvable (→ caller
        keeps the legacy quote, byte-identical to before).
        """
        table_id = getattr(view, "dataset_table_id", None)
        cache_key = table_id if table_id is not None else id(view)
        cached = self._phys_coltype_cache.get(cache_key)
        if cached is None:
            cached = {}
            try:
                table = getattr(view, "dataset_table", None)
                cc = getattr(table, "columns_cache", None) if table is not None else None
                if isinstance(cc, dict):
                    cols = cc.get("columns", []) or []
                elif isinstance(cc, list):
                    cols = cc
                else:
                    cols = []
                for c in cols:
                    if not isinstance(c, dict):
                        continue
                    name = str(c.get("name") or "").strip()
                    if not name:
                        continue
                    t = str(c.get("source_type") or c.get("type") or "").strip().lower()
                    if t:
                        cached[name] = t
            except Exception:  # noqa: BLE001 — best-effort; never block SQL-gen
                cached = {}
            self._phys_coltype_cache[cache_key] = cached
        return cached.get(col)

    def _filter_type_family(self, field: str, default_view: str) -> Optional[str]:
        """Resolve a filter column's INTENT type → 'number'|'bool'|'date'|
        'datetime'|'string'|None. Drives type-aware literal rendering so a
        measure/dashboard filter value (which arrives as a STRING from the FE)
        is compared against the column with a matching SQL literal — BigQuery
        and other strict dialects reject ``INT64 = STRING`` etc. (BUG-018).

        Uses the column's declared semantic ``type`` as the primary intent
        signal (``number`` means the analyst wants a numeric comparison even if
        the column is physically STRING — Airbyte/Sheets — in which case the
        caller SAFE_CASTs), with physical ``source_type`` confirming bool/date.
        For columns that are NOT declared dimensions, falls back to the physical
        type from ``columns_cache`` (``_physical_source_type``) so a filter on a
        never-modeled numeric column still coerces instead of emitting
        ``INT64 = STRING``. Returns None only when the column is wholly
        unresolvable → caller keeps the legacy quote.
        """
        if "." in field:
            try:
                vname, col = self._parse_field_ref(field)
            except ValueError:
                return None
        else:
            vname, col = default_view, field
        view = self.views_cache.get(vname) or self._get_view_for_node(vname)
        if view is None:
            return None
        dim = next(
            (d for d in (getattr(view, "dimensions", None) or []) if d.get("name") == col),
            None,
        )
        if dim:
            st = str(dim.get("source_type") or "").strip().lower()
            sem = str(dim.get("type") or "").strip().lower()
        else:
            # Not a declared dimension — recover the column's physical type so
            # the value still renders with a matching literal (else a numeric
            # column the DA never modeled slips ``INT64_col = '1'`` to BigQuery).
            st = (self._physical_source_type(view, col) or "").strip().lower()
            sem = ""
            if not st:
                return None
        # Physical families come from the shared vocabulary (physical_type_map) so
        # every driver token — int8/float8/timestamptz/money/numeric(10,2) … — is
        # classified the same way here, in the loader, and in the cast gates.
        # The SEMANTIC type still wins for intent (a `number` label means the DA
        # wants a numeric comparison even on a physically-text column).
        st_fam = _ptm.family(st)
        _BOOL_SEM = {"bool", "boolean", "yesno"}
        if st_fam == "bool" or sem in _BOOL_SEM:
            return "bool"
        if st_fam == "date" or sem == "date":
            return "date"
        if st_fam in ("timestamp", "time") or sem == "datetime":
            return "datetime"
        if sem == "number" or st_fam in _ptm.NUMERIC_FAMILIES:
            return "number"
        return "string"

    @staticmethod
    def _coerce_typed_filter_value(value: Any, family: Optional[str]) -> Any:
        """Coerce a filter value (which arrives as a STRING from the FE) to the
        Python type implied by its column's declared ``family`` so the literal
        renders with a matching SQL type (BUG-018). Numeric-looking strings on a
        ``number`` column → int/float; truthy/falsy strings on a ``bool`` column
        → bool. Everything else (genuine strings, dates, un-coercible text) is
        left untouched → rendered quoted exactly as before. Shared by the
        measure-filter and dashboard-filter paths so they never drift again.
        """
        def _one(v: Any) -> Any:
            if v is None:
                return v
            if family == "number" and not (isinstance(v, (int, float)) and not isinstance(v, bool)):
                s = str(v).strip()
                if not s:
                    return v
                try:
                    fv = float(s)
                    return int(fv) if (fv.is_integer() and "." not in s and "e" not in s.lower()) else fv
                except ValueError:
                    return v
            if family == "bool" and not isinstance(v, bool):
                s = str(v).strip().lower()
                if s in ("true", "t", "1", "yes", "y"):
                    return True
                if s in ("false", "f", "0", "no", "n"):
                    return False
            return v

        if isinstance(value, list):
            return [_one(v) for v in value]
        return _one(value)

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

        Phase-14 (NOT REACHED on any path today): a measure with
        ``context_modifiers`` is refused above (UNSUPPORTED_CONTEXT) before this
        point. The window-aggregate rendering below (``agg(expr) OVER
        (PARTITION BY ...)``) is kept unreachable on purpose: it computed over
        the already-FILTERED rows and did not remove the filter context, so it
        must not be re-enabled without the context-removal engine. The function still returns a single
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
                # Quote the column so names with spaces / special chars (e.g. a
                # Google-Sheets header "ID KH") emit `alias."ID KH"` instead of
                # the unquoted `alias.ID KH` that DuckDB/BigQuery reject. Plain
                # identifiers stay unquoted (byte-identical) via _quote_ident.
                'sql': '${TABLE}.' + self._quote_ident(field_name),
            }

        # Context modifiers (all / all_except / use_relationship) are NOT
        # supported by this engine and are refused rather than half-applied:
        # all/all_except compiled to a window over the already-FILTERED rows
        # (the filter was never removed, and GROUP BY vanished so every fact row
        # came back), and use_relationship was never read at all (the active
        # relationship was used). Removing filter context correctly also needs
        # the engine to tell security filters (link locks, row-level scope) from
        # ordinary ones, so an ALL cannot widen what a viewer may see.
        _unsupported_mods = sorted({
            str((m or {}).get("type") or "").strip()
            for m in (measure_def.get("context_modifiers") or [])
            if isinstance(m, dict) and str((m or {}).get("type") or "").strip()
        })
        if _unsupported_mods:
            raise SemanticRefusal(
                f"Measure '{view_name}.{field_name}' dùng context modifier {_unsupported_mods} — "
                "tính năng này chưa được hỗ trợ đúng ngữ nghĩa nên bị từ chối thay vì trả số sai. "
                "Xoá context modifier khỏi measure trong Data Model (dùng measure kiểu "
                "percent_of_total cho % trên tổng, hoặc join có alias cho role-playing).",
                SemanticRefusal.UNSUPPORTED_CONTEXT,
            )

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
        if expression_template and depends_on:
            # A formula is a value over ALREADY-aggregated measures: another
            # aggregation of it would aggregate the formula TEXT as a row
            # expression (its `${measure}` refs read as columns) — never the
            # formula's number. Refused, not reinterpreted.
            raise SemanticRefusal(
                f"Measure '{measure_def.get('name', '?')}' là measure công thức (trên các measure "
                f"đã tổng hợp) — không thể tổng hợp lại bằng '{override_type}'. Dùng tổng hợp mặc "
                "định (auto) của measure.",
                SemanticRefusal.UNSUPPORTED_CONTEXT,
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
            # Allow spaces in the bare column name ([\w ]) so a Sheets header
            # like "ID KH" qualifies too — mirrors the dimension path (1092).
            and re.fullmatch(r"[A-Za-z_][\w ]*", sql_template.strip())
        ):
            # _quote_ident leaves plain names unquoted (byte-identical) and
            # quotes names with spaces/special chars → `${TABLE}."ID KH"`.
            sql_template = f"${{TABLE}}.{self._quote_ident(sql_template.strip())}"

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
        # we fall through to the plain aggregate below. (Context modifiers
        # never reach here — they are refused above, UNSUPPORTED_CONTEXT.)
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
            agg_sql = self._avg_sql(base_sql)
        elif measure_type == "min":
            agg_sql = f"MIN({base_sql})"
        elif measure_type == "max":
            agg_sql = f"MAX({base_sql})"
        elif measure_type == "count_distinct":
            agg_sql = f"COUNT(DISTINCT {base_sql})"
        elif measure_type == "percent_of_total":
            # Phase-1: built-in % of grand total via window aggregate over
            # the inner aggregate. Already self-contained; context_modifiers
            # are skipped to avoid double-wrapping. True division, NULL on a
            # zero total, on every engine (semantic_arithmetic).
            return true_division_sql(
                f"SUM({base_sql})", f"SUM(SUM({base_sql})) OVER ()", self.database_type,
            ) + " * 100"
        else:
            agg_sql = f"SUM({base_sql})"  # Default fallback

        # Phase-14 window aggregates for context_modifiers — UNREACHABLE: a
        # measure with any modifier was refused above (UNSUPPORTED_CONTEXT;
        # the window over already-filtered rows gave wrong numbers and
        # `use_relationship` was never applied). Do not route modifiers here.
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
        m_table = self._snapshot_ref_for_view(view) or self._relation_sql_for_view(view) or view_name

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
            filters = self._rebind_calendar_filters(
                filters, cal_view, measure_view=view_name, tied=self._calendar_tie(m_resolver, view_name),
            )
            if cal_view:
                reachable = m_resolver.reachable_nodes()

            bound_filters: Dict[str, Any] = {}
            for f_ref, f_def in filters.items():
                f_view, _ = self._parse_field_ref(f_ref)
                if f_view == view_name or f_view in reachable:
                    bound_filters[f_ref] = f_def
                else:
                    for _d in (f_def if isinstance(f_def, list) else [f_def]):
                        self._refuse_unapplied_authoritative(_d, "unreachable_view")
                    # the declared soft drop (PowerBI parity: a filter on a view this
                    # measure's fact has no relationship to does not filter it) — a
                    # structured record, as every other engine drop, never free text only
                    self._propagation_drops = list(getattr(self, "_propagation_drops", None) or []) + [{
                        "field": f_ref,
                        "reason": "unreachable_view",
                        "detail": (f"Filter view {f_view!r} has no relationship path to the measure "
                                   f"{field_ref!r} (evaluated at its own grain, {view_name!r}); "
                                   "ignored for that measure."),
                    }]
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
                _saved_root = getattr(self, "_filter_root", None)
                self._resolver = m_resolver
                self._filter_root = view_name
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
                    self._filter_root = _saved_root

        body = f"SELECT {plain_agg} FROM {m_table} AS {view_name}"
        if where_sql:
            body += f"\n{where_sql}"
        return f"({body})"

    def _find_calendar_dim_for_measure(self, m_resolver, m_view: str) -> Optional[str]:
        """Return the node-id of the MAIN calendar dimension reachable from the
        measure view, or None. The calendar spine is a ``GENERATE_DATE_ARRAY``
        source; the standalone "Date" dim (no role-played ``__…_date_dim``
        suffix) is preferred over per-column role-played date dims, and a
        calendar related to the measure's view directly over one reached
        through a dimension (never "the shortest chain").

        Only a UNIQUE best candidate is returned: when two date roles tie (two
        role-played dims, two aliases of one calendar, no main calendar), which
        one the measure's "Date" means is not decided by the model — the
        caller refuses (see ``_calendar_tie``); the node-set order (which a
        process restart changes) used to decide."""
        best = self._best_calendar_dim_candidates(m_resolver, m_view)
        return best[0] if len(best) == 1 else None

    def _calendar_tie(self, m_resolver, m_view: str) -> List[str]:
        """The tied date roles of ``m_view`` (empty when one role is main, or
        none is reachable)."""
        best = self._best_calendar_dim_candidates(m_resolver, m_view)
        return best if len(best) > 1 else []

    def _best_calendar_dim_candidates(self, m_resolver, m_view: str) -> List[str]:
        """Every calendar node tied for the best (main-first, own-date-first) score,
        sorted. More than one means the choice is not determined by the model —
        only by the order the relationships were created. Memoised per query
        (the main-calendar pick and the tie check ask the same question)."""
        memo = getattr(self, "_calendar_candidates_memo", None)
        if memo is None:
            memo = self._calendar_candidates_memo = {}
        key = (getattr(self._model, "id", None), getattr(m_resolver, "base_node", None), m_view)
        if key not in memo:
            memo[key] = self._compute_calendar_dim_candidates(m_resolver, m_view)
        return list(memo[key])

    def _compute_calendar_dim_candidates(self, m_resolver, m_view: str) -> List[str]:
        scored: List[Tuple[Tuple[int, int], str]] = []
        # A calendar is the measure's only when it is one of ITS dimensions
        # (many-to-one reachable): a main calendar reached through ANOTHER fact
        # outranked the measure's own tied date roles and the Date filter was
        # dropped (no route to it) instead of refused.
        own = self._m1_reachable_views(m_view)
        for node in m_resolver.reachable_nodes():
            if node == m_view:
                continue
            if node not in own and (m_resolver.view_for_node(node) or node) not in own:
                continue
            vname = m_resolver.view_for_node(node) or node
            view = self.views_cache.get(node) or self._find_view_by_name(vname)
            if view is None:
                continue
            if not self._view_is_generated_calendar(view):
                continue
            is_role_played = self._is_role_played_calendar_name(vname) or self._is_role_played_calendar_name(node)
            # The measure's OWN date relationship (a calendar related to its
            # view directly) outranks a date of one of its dimensions; two
            # dimension dates are a tie however long their chains — a shorter
            # chain is not a reason for one date role to be "the" Date.
            chains = m_resolver.forward_routes(node)
            if chains is None:
                raise RouteEnumerationIncomplete(node)
            direct = any(len(c.steps) == 1 for c in chains)
            scored.append(((1 if is_role_played else 0, 0 if direct else 1), node))
        if not scored:
            return []
        best_score = min(sc for sc, _ in scored)
        return sorted(n for sc, n in scored if sc == best_score)

    def _is_calendar_dim_view(self, view_name: Optional[str]) -> bool:
        """True if ``view_name`` is a calendar/date dimension — either a
        per-column role-played date-dim (``…__<col>__date_dim``) or a standalone
        generated calendar (``GENERATE_DATE_ARRAY`` source). Used to treat a date
        group dimension as a CONFORMED dimension across facts in the multi-fact
        stitch (every date-dim view carries the identical calendar grain
        columns — year_month, month, day_name… — with identical values)."""
        if not view_name:
            return False
        if self._is_role_played_calendar_name(view_name):
            return True
        v = self.views_cache.get(view_name) or self._find_view_by_name(view_name)
        if v is None:
            return False
        return self._view_is_generated_calendar(v)

    @staticmethod
    def _is_role_played_calendar_name(name: Optional[str]) -> bool:
        """The generated per-column role-played date-dim (``…__<col>__date_dim``)."""
        n = str(name or "")
        return "__" in n and n.endswith("_date_dim")

    # Markers every dialect's generated calendar SQL carries
    # (dataset_calendar_service.build_calendar_live_sql): BigQuery
    # GENERATE_DATE_ARRAY, Postgres generate_series, MySQL/DuckDB the
    # recursive `calendar_series` CTE. Only a LEGACY fallback — see below.
    _CALENDAR_SQL_MARKERS = ("GENERATE_DATE_ARRAY", "GENERATE_SERIES", "CALENDAR_SERIES")

    def _view_is_generated_calendar(self, view) -> bool:
        """Is this SemanticView the dataset's GENERATED calendar?

        Decided from METADATA, never from one warehouse's SQL spelling: a view
        backed by a DatasetTable whose ``source_kind`` is the generated calendar,
        or a role-played ``…__date_dim`` view. Recognition used to look for the
        BigQuery-only ``GENERATE_DATE_ARRAY`` in the stored SQL, so on Postgres,
        MySQL and DuckDB datasets the calendar was never found: a date slicer fanned
        across every date column of a fact stayed AND-ed and returned ~0 rows.
        Views with no backing table (legacy/external) fall back to the per-dialect
        calendar markers."""
        if view is None:
            return False
        if self._is_role_played_calendar_name(getattr(view, "name", None)):
            return True
        tid = getattr(view, "dataset_table_id", None)
        if tid is not None:
            try:
                from app.models.dataset import DatasetTable
                from app.services.dataset_calendar_service import is_generated_calendar_table

                table = self.db.query(DatasetTable).filter(DatasetTable.id == tid).first()
                return is_generated_calendar_table(table)
            except Exception:  # noqa: BLE001 — fall through to the legacy check
                logger.debug("[calendar] metadata lookup failed for view %s", getattr(view, "name", "?"), exc_info=True)
        src = str(getattr(view, "sql_table_name", "") or "").upper()
        return any(marker in src for marker in self._CALENDAR_SQL_MARKERS)

    def _fact_own_calendar_view(self, fact: str, m_resolver) -> Optional[str]:
        """The calendar/date-dim view this fact OWNS (M:1-reachable, one hop).
        A fact with a single date column has exactly one date-dim (unambiguous);
        if it exposes several, the main calendar (``_find_calendar_dim_for_measure``).
        Several with no single main → which date role a conformed "by month"
        groups this fact by is not determined: refused (it used to take the
        first of a set — a role chosen by hash order). Returns None when no
        calendar is reachable — then a calendar group dim is left unchanged and
        the unrelated-check declines the stitch, as before."""
        cals = sorted(v for v in self._m1_reachable_views(fact) if self._is_calendar_dim_view(v))
        if not cals:
            return None
        if len(cals) == 1:
            return cals[0]
        main = self._find_calendar_dim_for_measure(m_resolver, fact)
        if main in cals:
            return main
        raise SemanticRefusal(
            f"Không ghép được measure của bảng '{fact}' theo Calendar chung: bảng có nhiều vai trò ngày "
            f"({', '.join(cals)}) và không có Calendar chính — không xác định được nhóm theo ngày nào. "
            "Nối bảng với Calendar chính trong Data Model, hoặc nhóm theo một vai trò ngày cụ thể.",
            SemanticRefusal.AMBIGUOUS_ROUTE,
        )

    def _build_dimensioned_multifact_sql(
        self,
        explore: SemanticExplore,
        dimensions: List[str],
        measures: List[str],
        filters: Dict[str, Any],
        time_grains: Dict[str, str],
        limit: int,
        measure_agg_overrides: Optional[Dict[str, str]],
        sorts: Optional[List[Dict[str, str]]] = None,
        top_n: Optional[Dict[str, Any]] = None,
    ) -> Optional[Tuple[str, List[str], List[PivotedColumn]]]:
        """Stitch a dimensioned chart whose measures span ≥2 facts (mixed
        base+cross-fact or several cross-facts). Each fact is sub-generated
        INDEPENDENTLY at its own grain (re-anchored, so base-invariant), then
        joined on the shared group dims:

            WITH _mf0 AS (<dims, fact0 measures>), _mf1 AS (<dims, fact1 …>),
                 _skel AS (SELECT dims FROM _mf0 UNION DISTINCT SELECT dims FROM _mf1)
            SELECT _skel.dims, _mf0.m…, _mf1.m…
            FROM _skel LEFT JOIN _mf0 ON <null-safe dims> LEFT JOIN _mf1 ON …

        Returns None if any fact can't relate to a group dim (the reason in
        ``_stitch_decline_reason``); the caller then REFUSES (FANOUT_RISK) —
        there is no fallback that could emit a wrong cross-product.
        """
        from collections import OrderedDict
        from app.services.semantic_join_resolver import SemanticJoinResolver as _R

        self._plan_note(strategy="stitch")

        # Group measures by their TRUE fact grain (the source-column view for a
        # cross-table measure; declared view otherwise) — NOT the declared view.
        # This MUST match the dispatch in generate_sql (which now keys
        # `_facts` on `_measure_fact_view`); otherwise a cross-table measure
        # would be grouped+re-anchored at its declared base and reference its
        # source column against a table not in FROM ("Unrecognized name").
        groups: "OrderedDict[str, List[str]]" = OrderedDict()
        for m in measures:
            groups.setdefault(self._measure_fact_view(m), []).append(m)

        # A filter on a MEASURE is a condition on the stitched row (PowerBI's
        # visual-level measure filter): "revenue > 100" removes the whole row,
        # target included. Passed down, it became a WHERE on the other fact's
        # rows (or an error), and a group missing from the filtered fact still
        # came back through the skeleton with the other fact's number.
        row_filters: Dict[str, Any] = {}
        measure_filters: Dict[str, Any] = {}
        for f_ref, f_def in (filters or {}).items():
            if self._filter_targets_measure(f_ref, measures):
                measure_filters[f_ref] = f_def
            else:
                row_filters[f_ref] = f_def
        _measure_aliases = {self._safe_alias(m): m for m in measures}
        for f_ref in measure_filters:
            if self._safe_alias(f_ref) not in _measure_aliases:
                raise ValueError(
                    f"Filter trên measure '{f_ref}' cần measure đó có trong chart đa-fact "
                    "(filter được áp lên từng dòng kết quả sau khi ghép các fact)."
                )

        dim_aliases = [self._safe_alias(d) for d in dimensions]
        # Each per-fact sub-generation starts by resetting `self.warnings`, so
        # without this only the LAST fact's warnings would reach the response.
        _outer_warnings = list(self.warnings)
        _fact_warnings: List[str] = []
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
            fact_cal = (
                self._fact_own_calendar_view(fact, m_resolver)
                if any(self._is_calendar_dim_view(self._parse_field_ref(d)[0]) for d in dimensions)
                else None
            )
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
                self._stitch_decline_reason = (
                    f"measure của '{fact}' không nối được theo {sorted(unrelated)} (chasm/fan-out)"
                )
                return None
            cal_view = self._find_calendar_dim_for_measure(m_resolver, fact)
            rebound = self._rebind_calendar_filters(
                dict(row_filters), cal_view, measure_view=fact, tied=self._calendar_tie(m_resolver, fact),
            )
            # Time grains are keyed by field ref. A calendar dim rebound onto
            # this fact's own calendar keeps its ORIGINAL grain — otherwise this
            # fact groups by raw day while the others group by month and the
            # skeleton splits one bucket into several rows (a mid-month target
            # became its own row and left the month short).
            fact_time_grains = dict(time_grains or {})
            for orig_d, rebound_d in cal_realias:
                if orig_d in fact_time_grains:
                    fact_time_grains[rebound_d] = fact_time_grains[orig_d]
            try:
                sub_sql, _sub_cols, _ = self.generate_sql(
                    explore_name=fact,
                    dimensions=fact_dims,
                    measures=fact_measures,
                    filters=rebound,
                    sorts=[],
                    # Per-fact CTEs must cover EVERY dimension group, so the row
                    # limit must NOT be pushed down here: each `_mf` is aggregated
                    # independently and stitched onto `_skel` by the conformed
                    # dims, and the limit is re-applied to the FINAL stitched
                    # result below. Propagating the outer limit truncated each
                    # fact to an arbitrary (un-ordered, possibly mismatched) N
                    # rows BEFORE the stitch → a dim value kept in one fact but
                    # dropped in another surfaced as a spurious NULL measure (and
                    # nondeterministic rows). No-op for the common sentinel limit
                    # (every fact already covered all groups); fixes explicit
                    # small-limit cross-fact charts. The outer `LIMIT {limit}`
                    # (below) still bounds the returned rows.
                    limit=10_000_000,
                    time_grains=fact_time_grains,
                    measure_agg_overrides=measure_agg_overrides,
                    model_id=model_id,
                    _reanchored=True,
                    snapshot_overrides=self._snapshot_overrides,
                )
            except ValueError as exc:
                # Kept so the caller's fail-loud names the real cause (an
                # ambiguous route, an unsupported modifier…) instead of a
                # generic multi-fact refusal.
                self._stitch_decline_reason = f"[{fact}] {exc}"
                self.warnings = _outer_warnings + _fact_warnings
                return None
            _fact_warnings.extend(w for w in self.warnings if w not in _fact_warnings)
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
        select_cols = [f"_skel.{a} AS {a}" for a in dim_aliases]
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
        if measure_filters:
            stitched_preds = [
                self._aggregate_predicate(
                    f"{alias_to_cte[self._safe_alias(f_ref)]}.{self._safe_alias(f_ref)}",
                    f_ref, f_def,
                )
                for f_ref, fds in measure_filters.items()
                for f_def in (fds if isinstance(fds, list) else [fds])
            ]
            stitched_preds = [p for p in stitched_preds if p]
            if stitched_preds:
                sql += "\nWHERE " + " AND ".join(stitched_preds)
        # Sort / Top-N apply to the STITCHED result — the only place every
        # fact's measure is present (pushing them into a per-fact CTE would rank
        # one fact and drop groups the others need). The dimension columns are
        # always appended as a tie-break so a LIMIT never keeps an arbitrary,
        # unstably ordered subset.
        order_parts: list[str] = []
        effective_limit = limit
        output_aliases = set(dim_aliases) | {self._safe_alias(m) for m in measures}

        def _src(alias: str) -> str:
            # Qualified by the relation that provides it: `_skel` and every fact
            # CTE carry the same dimension column names, and MySQL resolves a
            # name inside an ORDER BY EXPRESSION (`(x IS NULL), x`) against
            # those columns — the bare alias was "ambiguous" there, so every
            # multi-fact chart failed on MySQL.
            return f"_skel.{alias}" if alias in dim_aliases else f"{alias_to_cte[alias]}.{alias}"

        if top_n and isinstance(top_n, dict) and top_n.get("field"):
            t_alias = self._safe_alias(str(top_n["field"]))
            if t_alias not in output_aliases:
                raise ValueError(
                    f"Top-N theo '{top_n['field']}' không có trong kết quả của chart đa-fact này."
                )
            order_parts.append(self._order_term(_src(t_alias), "DESC", nulls_last=True))
            try:
                n_value = int(top_n.get("n", 0))
            except (TypeError, ValueError):
                n_value = 0
            if n_value > 0:
                effective_limit = n_value
        for s in (sorts or []):
            s_field = str(s.get("field") or "").strip()
            if not s_field:
                continue
            s_alias = self._safe_alias(s_field)
            if s_alias not in output_aliases:
                raise ValueError(
                    f"Sắp xếp theo '{s_field}' không có trong kết quả của chart đa-fact này."
                )
            direction = "DESC" if str(s.get("direction") or "asc").lower() == "desc" else "ASC"
            order_parts.append(self._order_term(_src(s_alias), direction, nulls_last=True))
        order_parts.extend(self._order_term(_src(a), "ASC", nulls_last=True) for a in dim_aliases)
        sql += "\nORDER BY " + ", ".join(order_parts)
        if effective_limit:
            sql += f"\nLIMIT {effective_limit}"
        column_names = dim_aliases + [self._safe_alias(m) for m in measures]
        self.warnings = _outer_warnings + [w for w in _fact_warnings if w not in _outer_warnings]
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

        # Which filters are COPIES OF ONE fanned filter. chart_service stamps the
        # copies it creates with one fan id; an unstamped (legacy / direct engine)
        # set is a fan when its copies share calendarField + operator + value —
        # but an AUTHORITATIVE filter without a stamp is never merged into one:
        # a 🔒 lock on ship-date year and a viewer's order-date pick with the
        # same value are TWO filters, and collapsing them onto the main calendar
        # moved the lock to another date column (wider data, silently).
        def _group_key(cf: str, d: Any):
            if not isinstance(d, dict):
                return None
            if d.get("_calendar_fan"):
                return ("fan", cf, str(d.get("_calendar_fan")))
            if d.get("_authoritative"):
                return None
            return ("sig", cf) + _sig(d)

        groups: Dict[tuple, set] = {}
        ref_group: Dict[str, tuple] = {}
        for f_ref, f_def in filters.items():
            defs = f_def if isinstance(f_def, list) else [f_def]
            cf = _cal_field(defs)
            if not cf:
                continue
            keys = {_group_key(cf, d) for d in defs
                    if isinstance(d, dict) and (d.get("calendarField") or d.get("calendar_field"))}
            if len(keys) != 1 or None in keys:
                continue
            (key,) = keys
            groups.setdefault(key, set()).add(f_ref)
            ref_group[f_ref] = key
        fanned_groups = {k for k, refs in groups.items() if len(refs) >= 2}
        fanned = {k[1] for k in fanned_groups}
        per_field_refs: Dict[str, set] = {}
        for k in fanned_groups:
            per_field_refs.setdefault(k[1], set()).update(groups[k])
        if not fanned:
            return filters

        _cal_candidates = self._best_calendar_dim_candidates(self._resolver, base_view)
        if len(_cal_candidates) > 1:
            # No main calendar and several date roles equally close: which role
            # "the Date filter" means would be decided by creation order.
            raise SemanticRefusal(
                "Filter ngày áp lên nhiều cột ngày nhưng không có Calendar chính để chọn: "
                f"các vai trò {sorted(_cal_candidates)} ngang nhau. Nối bảng với Calendar "
                "chính trong Data Model, hoặc lọc trên một vai trò ngày cụ thể.",
                SemanticRefusal.AMBIGUOUS_ROUTE,
            )
        cal_view = _cal_candidates[0] if _cal_candidates else None
        if not cal_view:
            # The fan means "one date filter, replicated onto every date role of
            # this fact". AND-ing those roles is an intersection nobody asked for
            # (NULL-prone roles annihilate the result), so without a calendar
            # relationship to bind it to, refuse rather than return that number.
            raise SemanticRefusal(
                "Filter ngày áp lên nhiều cột ngày của cùng một bảng "
                f"({', '.join(sorted({r for refs in per_field_refs.values() for r in refs}))}) "
                "nhưng không tìm thấy quan hệ tới bảng Calendar để chọn một cột ngày. "
                "Nối bảng này với Calendar trong Data Model, hoặc lọc trực tiếp trên một cột ngày.",
                SemanticRefusal.UNREACHABLE_VIEW,
            )

        out: Dict[str, Any] = {}
        added: set[str] = set()
        for f_ref, f_def in filters.items():
            defs = f_def if isinstance(f_def, list) else [f_def]
            cf = _cal_field(defs)
            if ref_group.get(f_ref) in fanned_groups:
                new_ref = f"{cal_view}.{cf}"
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
                # The replicated copies of ONE fanned filter collapse (identical
                # predicates); a DIFFERENT filter landing on the same calendar
                # key is ANDed — it used to be skipped (dropped).
                self._accumulate_filter(out, new_ref, cleaned)
            else:
                self._accumulate_filter(out, f_ref, defs if isinstance(f_def, list) else [f_def])
        return out

    @staticmethod
    def _accumulate_filter(out: Dict[str, Any], ref: str, defs: list) -> None:
        """Add predicates under ``ref`` (AND); identical predicates once."""
        existing = out.get(ref)
        merged = list(existing) if isinstance(existing, list) else ([existing] if existing else [])
        for d in defs:
            if d not in merged:
                merged.append(d)
        out[ref] = merged

    @staticmethod
    def _refuse_unapplied_authoritative(filter_def, reason: str) -> None:
        from app.services.chart_contracts import refuse_unapplied_authoritative

        refuse_unapplied_authoritative(filter_def, reason)

    def _rebind_calendar_filters(
        self,
        filters: Dict[str, Any],
        cal_view: Optional[str],
        *,
        measure_view: Optional[str] = None,
        tied: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Re-point calendar-metadata filters at ``cal_view.<calendarField>`` so
        the generic WHERE/EXISTS builder binds them via the measure→Date edge
        (one event-date column) rather than the chart base's fanned columns.
        Filters without calendar metadata pass through untouched.

        Only a filter written onto ANOTHER table's date column (the chart base's,
        when the measure is evaluated at its own fact) moves. A filter already on
        the measure's own date column (``measure_view``) names that role — a
        Ship-date year stays the ship date; it used to move to the main (order)
        calendar. A foreign filter with no single calendar to move to — the
        measure's date roles tie (``tied``) — has no single meaning: refused."""
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
            # An authoritative filter on a SPECIFIC date role (not a fanned
            # "Date") keeps its column: re-pointing it at the measure's main
            # calendar would apply the lock to another date (wider data). It is
            # bound — or refused — on its own column below.
            _role_lock = any(isinstance(d, dict) and d.get("_authoritative") and not d.get("_calendar_fan")
                             for d in defs)
            _own_role = bool(measure_view) and str(f_ref).split(".", 1)[0] == measure_view
            if cal_field and not _role_lock and not _own_role and not cal_view and tied:
                raise SemanticRefusal(
                    f"Filter ngày '{f_ref}' cần gắn vào ngày của bảng '{measure_view}', nhưng bảng này có "
                    f"nhiều vai trò ngày ngang nhau ({', '.join(sorted(tied))}) và không có Calendar chính "
                    "— không xác định được filter áp lên ngày nào. Nối bảng với Calendar chính trong Data "
                    "Model, hoặc lọc trên một vai trò ngày cụ thể.",
                    SemanticRefusal.AMBIGUOUS_ROUTE,
                )
            if cal_view and cal_field and not _role_lock and not _own_role:
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
                # two date filters re-pointed at ONE calendar key both apply
                self._accumulate_filter(out, new_ref, cleaned)
            else:
                self._accumulate_filter(out, f_ref, defs)
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

        # `${a} / ${b}` is true division on every engine (semantic_arithmetic):
        # rewritten on the formula text, before the measures are substituted.
        rendered = normalize_division(template, self.database_type).replace("${TABLE}", view_name)
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
                if ref_view_name != view_name:
                    # Inlined here, a measure of ANOTHER view aggregates over this
                    # view's joined rows — a dimension's rows repeated per fact row,
                    # another fact's rows multiplied — never the number the same
                    # measure has on its own (each measure is evaluated at its own
                    # grain). Refused rather than answered at the wrong grain.
                    raise SemanticRefusal(
                        f"Measure công thức trên '{view_name}' dùng measure '{qualified}' của view khác. "
                        "Trong một công thức, measure đó sẽ bị tính trên các dòng của "
                        f"'{view_name}' (lặp hoặc thiếu dòng) chứ không ở grain của chính nó, nên "
                        "kết quả sai. Đặt các measure cùng một view trong công thức, hoặc đưa hai "
                        "measure vào biểu đồ riêng rẽ.",
                        SemanticRefusal.UNSUPPORTED_CONTEXT,
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
        # Same spellings the WHERE builder accepts for the same meaning.
        operator = {"neq": "ne", "!=": "ne", "date_eq": "eq", "date_between": "between"}.get(operator, operator)
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

        # ── Type-aware literal rendering (BUG-018) ──────────────────────────
        # The measure filter value arrives as a STRING from the FE text input
        # (e.g. "1"). Quoting it blindly produced ``INT64_col >= '1'`` →
        # BigQuery 400 "No matching signature for operator >= ... INT64, STRING".
        # Mirror the dashboard path (``_build_where_clause``): resolve the
        # column's declared type, coerce the value to that type's Python form,
        # render numbers/bools unquoted, and SAFE_CAST the column when comparing
        # against a number (no-op on genuine numerics, parses STRING-stored
        # numerics — Airbyte/Sheets). Genuine string/date columns stay quoted
        # (byte-identical to before).
        from app.services.type_override_service import build_safe_cast_sql
        _dialect = (self.database_type or "").lower()
        family = self._filter_type_family(field, target_view)

        def _present(v: Any) -> bool:
            return not (v is None or (isinstance(v, str) and not v.strip()))

        def _coerce(v: Any) -> Any:
            return self._coerce_typed_filter_value(v, family)

        def _lit(v: Any) -> str:
            if v is None:
                return "NULL"
            if isinstance(v, bool):
                return "TRUE" if v else "FALSE"
            if isinstance(v, (int, float)):
                return str(v)
            return _quote_string(v, self.database_type)

        def _numcast(col_sql: str, *vals: Any) -> str:
            present = [v for v in vals if _present(v)]
            if present and all(
                isinstance(v, (int, float)) and not isinstance(v, bool) for v in present
            ):
                return build_safe_cast_sql(col_sql, "float", _dialect)
            return col_sql

        def _pred() -> Optional[str]:
            if operator == "eq":
                v = _coerce(value); return f"{_numcast(field_sql, v)} = {_lit(v)}"
            if operator == "ne":
                v = _coerce(value); return f"{_numcast(field_sql, v)} <> {_lit(v)}"
            if operator == "gt":
                v = _coerce(value); return f"{_numcast(field_sql, v)} > {_lit(v)}"
            if operator == "gte":
                v = _coerce(value); return f"{_numcast(field_sql, v)} >= {_lit(v)}"
            if operator == "lt":
                v = _coerce(value); return f"{_numcast(field_sql, v)} < {_lit(v)}"
            if operator == "lte":
                v = _coerce(value); return f"{_numcast(field_sql, v)} <= {_lit(v)}"
            if operator in ("in", "not_in"):
                raw = value if isinstance(value, list) else [value]
                vals = [_coerce(v) for v in raw if _present(v)]
                if not vals:
                    return None
                kw = "IN" if operator == "in" else "NOT IN"
                return f"{_numcast(field_sql, *vals)} {kw} ({', '.join(_lit(v) for v in vals)})"
            if operator == "between":
                # Phase-15.79 — degrade to >= / <= when only one bound is
                # supplied, mirroring _build_where_clause Phase-15.19 behaviour.
                lo, hi = (value or [None, None])[:2]
                lo, hi = _coerce(lo), _coerce(hi)
                if _present(lo) and _present(hi):
                    return f"{_numcast(field_sql, lo, hi)} BETWEEN {_lit(lo)} AND {_lit(hi)}"
                if _present(lo):
                    return f"{_numcast(field_sql, lo)} >= {_lit(lo)}"
                if _present(hi):
                    return f"{_numcast(field_sql, hi)} <= {_lit(hi)}"
                return None
            # Pattern operators share the WHERE path's one helper, so a value is
            # matched LITERALLY (a "%" or "_" in it is not a wildcard) and
            # not_contains is honoured — both used to diverge here: wildcards
            # leaked through and not_contains silently dropped the filter, so
            # the measure summed every row.
            if operator in {"contains", "not_contains", "starts_with", "ends_with"}:
                if not _present(value):
                    return None
                return pattern_predicate(
                    field_sql, operator, value, self.database_type,
                    lambda s: _quote_string(s, self.database_type),
                )
            if operator == "is_null":
                return f"{field_sql} IS NULL"
            if operator == "is_not_null":
                return f"{field_sql} IS NOT NULL"
            # An operator this renderer does not know would otherwise leave the
            # measure UNFILTERED — a plausible number that means something else.
            raise ValueError(
                f"Measure filter trên '{field}' dùng toán tử '{operator}' không được hỗ trợ — "
                "sửa filter của measure trong Data Model."
            )

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
            # Correlated to the MEASURE's own rows: routes are walked from the
            # measure's view, whatever the chart is based on.
            _saved_root = getattr(self, "_filter_root", None)
            self._filter_root = view_name
            try:
                exists_sql = self._build_filter_exists_clause(
                    None, target_view, [pred], joined_nodes={view_name},
                )
            finally:
                self._filter_root = _saved_root
            if exists_sql:
                return exists_sql
            # No route the filter may travel from the measure's view. The old
            # fallback emitted the predicate INLINE: it referenced the related
            # view's alias in the outer query — a raw "missing FROM-clause"
            # error, or, when the chart happened to join that view by another
            # route, a filter meaning something else. Refused instead.
            raise SemanticRefusal(
                f"Measure filter trên '{field}' không áp được: bảng '{target_view}' không có quan hệ "
                f"(lọc được) tới bảng của measure '{view_name}'. Thêm quan hệ trong Data Model hoặc sửa "
                "filter của measure.",
                SemanticRefusal.UNREACHABLE_VIEW,
            )
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
                # Quote the column so names with spaces / special chars (e.g. a
                # Google-Sheets header "ID KH") emit `alias."ID KH"` instead of
                # the unquoted `alias.ID KH` that DuckDB/BigQuery reject. Plain
                # identifiers stay unquoted (byte-identical) via _quote_ident.
                'sql': '${TABLE}.' + self._quote_ident(field_name),
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
        if measure_def.get('depends_on') and (measure_def.get('expression') or "").strip():
            # A formula over aggregated measures has no per-cell CASE form: its
            # text would be aggregated as a row expression — refused, never a
            # different number (the same rule as an explicit agg on a formula).
            raise SemanticRefusal(
                f"Measure '{field_name}' là measure công thức — không thể đặt vào cột pivot. "
                "Bỏ pivot hoặc dùng các measure gốc.",
                SemanticRefusal.UNSUPPORTED_CONTEXT,
            )
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
        pivot_literal = _quote_string(pivot_value, self.database_type)
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
            return self._avg_sql(case_expr)
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
            return f"{self._avg_sql(measure_sql)} OVER ({over_clause} {frame})"
        
        elif wf_type == "rank":
            return f"RANK() OVER ({over_clause})"
        
        elif wf_type == "dense_rank":
            return f"DENSE_RANK() OVER ({over_clause})"
        
        elif wf_type == "row_number":
            return f"ROW_NUMBER() OVER ({over_clause})"
        
        else:
            raise ValueError(f"Unsupported window function type: {wf_type}")
    
    def _avg_sql(self, expr: str) -> str:
        """AVG with the same precision on every engine: MySQL's AVG of an
        integer is a DECIMAL with 4 extra digits (an average of 0/1 flags of
        1 in 30000 is 0.0000), so it averages a DOUBLE there."""
        if (self.database_type or "").lower() == "mysql":
            return f"AVG(({expr}) * 1e0)"
        return f"AVG({expr})"

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
        sql_template = normalize_division(sql_template, self.database_type)

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
    
    def _snapshot_renamed_columns(self, tid) -> Dict[str, str]:
        """``{original_name: safe_name}`` for columns of dataset_table ``tid``
        whose physical snapshot name was sanitized at build time
        (``bq_safe_field``). Empty for clean names — the common case, so the
        snapshot FROM operand stays byte-identical. Derived from the SAME
        per-name function the build uses, so no shared state is needed."""
        cache = getattr(self, "_snap_rename_cache", None)
        if cache is None:
            cache = {}
            self._snap_rename_cache = cache
        if tid in cache:
            return cache[tid]
        out: Dict[str, str] = {}
        try:
            from app.models.dataset import DatasetTable
            from app.services.datasource_service import bq_safe_field

            t = self.db.query(DatasetTable).filter(DatasetTable.id == tid).first()
            cc = getattr(t, "columns_cache", None) if t is not None else None
            cols = cc.get("columns") if isinstance(cc, dict) else cc
            for c in cols or []:
                name = c.get("name") if isinstance(c, dict) else None
                if not name:
                    continue
                safe = bq_safe_field(name)
                if safe != name:
                    out[name] = safe
        except Exception:  # noqa: BLE001 — never break rendering over a rename map
            out = {}
        cache[tid] = out
        return out

    def _snapshot_ref_for_view(self, view) -> Optional[str]:
        """Dashboard perf #5 — if this view's dataset table has a fresh
        materialized snapshot, return a drop-in FROM operand that reads the flat
        snapshot instead of re-running the view's heavy source SQL. Returns None
        (→ use the normal sql_table_name) when there is no override. The snapshot
        was materialized FROM the view's fully-resolved SQL, so `SELECT *` over it
        is column-identical."""
        if not self._snapshot_overrides:
            return None
        tid = getattr(view, "dataset_table_id", None)
        ref = self._snapshot_overrides.get(tid) if tid is not None else None
        if not ref and tid is None:
            # Role-played date-dim views (``dataset_table_587__sale_date__date_dim``)
            # carry NO dataset_table_id — they render the calendar inline via
            # ``sql_table_name``. When the dataset's generated-calendar table IS
            # materialized in the snapshot, point these role views at that same
            # physical table. It is column- AND row-identical to the inline calendar
            # (both are produced by ``build_calendar_live_sql`` on the same calendar
            # settings), so the M:1 date join, grain, and every measure are unchanged
            # — only the FROM operand swaps recursive-CTE generation for a flat read.
            # This is what makes date-intelligence charts "query entirely on the BQ
            # snapshot" rather than regenerating the calendar per request.
            name = str(getattr(view, "name", "") or "")
            if name.endswith("_date_dim"):
                ref = self._calendar_snapshot_ref()
        if not ref:
            return None
        # Refactor Phase 3 — quote the physical ref for THIS engine's dialect
        # instead of hardcoding BigQuery backticks. Snapshots are hosted in
        # BigQuery today (the planner forces dialect="bigquery" in snapshot
        # mode, so this stays backticks in practice) — but the renderer itself
        # no longer bakes in that assumption.
        d = (self.database_type or "").lower()
        # Re-alias any physically-renamed columns back to their ORIGINAL names.
        # The snapshot BUILD sanitizes BigQuery-invalid Sheet headers (e.g.
        # "BC/CD phụ trách") via bq_safe_field; here we map them back so the chart
        # SQL that references the original names still resolves. `SELECT * EXCEPT`
        # renames ONLY the affected columns (robust to columns_cache staleness);
        # empty for every clean dataset → the FROM operand is byte-identical.
        renamed = self._snapshot_renamed_columns(tid) if tid is not None else {}
        if d in ("bigquery", "mysql"):
            if renamed:
                _except = ", ".join(f"`{safe}`" for safe in renamed.values())
                _alias = ", ".join(f"`{safe}` AS `{orig}`" for orig, safe in renamed.items())
                return f"(SELECT * EXCEPT ({_except}), {_alias} FROM `{ref}`)"
            return f"(SELECT * FROM `{ref}`)"
        quoted = ".".join('"' + p.replace('"', "") + '"' for p in str(ref).split("."))
        if renamed:
            _except = ", ".join('"' + safe + '"' for safe in renamed.values())
            _alias = ", ".join(f'"{safe}" AS "{orig}"' for orig, safe in renamed.items())
            return f"(SELECT * EXCEPT ({_except}), {_alias} FROM {quoted})"
        return f"(SELECT * FROM {quoted})"

    def _calendar_live_sql_for_dialect(self) -> Optional[str]:
        """Inline calendar SQL for THIS engine's dialect, parenthesized as a
        FROM operand — the dialect-correct fallback for role-played date-dims
        when no materialized calendar snapshot exists (audit #3). Memoised per
        request; None on any failure (→ caller keeps the stored SQL)."""
        if self._cal_live_sql_cache is not False:
            return self._cal_live_sql_cache
        out: Optional[str] = None
        try:
            ds_id = getattr(getattr(self, "_model", None), "dataset_id", None)
            if ds_id:
                from app.models.dataset import Dataset
                from app.services.dataset_calendar_service import (
                    build_calendar_live_sql, get_calendar_settings,
                )

                d = self.db.query(Dataset).filter(Dataset.id == ds_id).first()
                if d is not None:
                    settings = get_calendar_settings(d, enabled_default=False)
                    dialect = (self.database_type or "postgresql").lower()
                    out = f"({build_calendar_live_sql(settings, dialect)})"
        except Exception:  # noqa: BLE001 — fallback must never break rendering
            out = None
        self._cal_live_sql_cache = out
        return out

    def _calendar_snapshot_ref(self) -> Optional[str]:
        """The physical snapshot ref of the dataset's generated-calendar table,
        if it is present among ``_snapshot_overrides``. Role-played date-dim views
        reuse it (see ``_snapshot_ref_for_view``). Memoised per request; there is
        at most one generated-calendar table per dataset."""
        if self._calendar_ref_cache is not False:
            return self._calendar_ref_cache
        out: Optional[str] = None
        try:
            from app.models.dataset import DatasetTable
            from app.services.dataset_calendar_service import is_generated_calendar_table

            for tid, ref in (self._snapshot_overrides or {}).items():
                if not ref:
                    continue
                t = self.db.query(DatasetTable).filter(DatasetTable.id == tid).first()
                if t is not None and is_generated_calendar_table(t):
                    out = ref
                    break
        except Exception:  # noqa: BLE001 — no calendar redirect on any lookup error
            out = None
        self._calendar_ref_cache = out
        return out

    def _relation_sql_for_view(self, view) -> Optional[str]:
        """Refactor Phase 3 — the PHYSICAL relation a view reads from, rendered
        at COMPILE TIME from the current DatasetTable definition in THIS
        engine's dialect. This replaces trusting the sync-time
        ``view.sql_table_name`` for FROM operands, which had two failure modes:
          * staleness — the stored SQL drifts from the table definition until
            someone re-opens/syncs the Dataset ("phải vào Dataset trước");
          * wrong dialect — the stored SQL was rendered with the DATASET's
            sync dialect (first datasource wins), which can differ from the
            dialect this request actually executes on (mixed-source datasets,
            snapshot mode forcing BigQuery).
        Falls back to the stored ``sql_table_name`` for role views
        (dataset_table_id is None) and on any load/render failure — i.e. the
        pre-Phase-3 behaviour. Memoised per table id for the request."""
        tid = getattr(view, "dataset_table_id", None)
        if tid is None:
            # Semantic-audit 2026-07 (#3) — role-played date-dims
            # (``…__date_dim``) store the inline calendar SQL rendered at SYNC
            # time in the dataset's sync dialect (duckdb for Sheets, postgres
            # for PG). Executed on a DIFFERENT engine (snapshot mode forces
            # BigQuery) that SQL 400s. Re-render the calendar for THIS engine's
            # dialect — mirroring what `_sql_table_for_table` already does for
            # the standalone Date view at compile time. Any gap → the stored
            # SQL, exactly the pre-fix behaviour. (When the calendar IS
            # materialized, `_snapshot_ref_for_view` wins before this runs.)
            name = str(getattr(view, "name", "") or "")
            if name.endswith("_date_dim"):
                rendered_cal = self._calendar_live_sql_for_dialect()
                if rendered_cal:
                    return rendered_cal
            return getattr(view, "sql_table_name", None)
        if tid in self._relation_sql_cache:
            self._record_live_source(*(self._relation_source_cache.get(tid) or (None, None)))
            return self._relation_sql_cache[tid]
        rendered = None
        source_id, source_kind = None, None
        try:
            from app.models.dataset import Dataset, DatasetTable
            from app.models.models import DataSource
            from app.services.dataset_model_service import _sql_table_for_table

            t = self.db.query(DatasetTable).filter(DatasetTable.id == tid).first()
            if t is not None:
                ds_obj = self.db.query(Dataset).filter(Dataset.id == t.dataset_id).first()
                src = (
                    self.db.query(DataSource).filter(DataSource.id == t.datasource_id).first()
                    if t.datasource_id else None
                )
                source_id = self._live_source_of_table(ds_obj, t)
                source_kind = str(getattr(t, "source_kind", "") or "").lower() or None
                if ds_obj is not None:
                    rendered = _sql_table_for_table(
                        ds_obj, t,
                        calendar_dialect=(self.database_type or "postgresql").lower(),
                        datasource=src, db=self.db,
                    )
        except ValueError:
            # A DELIBERATE refusal of the table's current relation (an invalid
            # transformation order, a composed table with its own shaping, a
            # calculated table whose sources cannot be resolved): never answered
            # from the STORED relation — that is the last model sync's, i.e. a
            # stale definition of the data. The request is refused.
            raise
        except Exception:  # noqa: BLE001 — fall back to the stored relation
            logger.debug("[relation] compile-time render failed for view %s",
                         getattr(view, "name", "?"), exc_info=True)
        out = rendered or getattr(view, "sql_table_name", None)
        self._relation_sql_cache[tid] = out
        self._relation_source_cache[tid] = (source_id, source_kind)
        self._record_live_source(source_id, source_kind)
        return out

    def _record_live_source(self, source_id, source_kind) -> None:
        """This statement reads a table of datasource ``source_id`` LIVE."""
        if source_id:
            self.live_source_ids.add(source_id)
            self.live_source_kinds.setdefault(source_id, set()).add(source_kind or "unknown")

    def _live_source_of_table(self, ds_obj, t) -> Optional[int]:
        """The datasource whose connection a LIVE read of table ``t`` needs: its
        own; a calculated (derived) table's dependencies' (one datasource — the
        derived resolver enforces it); none for the generated calendar (inline
        SQL, no source table)."""
        from app.services.dataset_calendar_service import is_generated_calendar_table
        from app.services.dataset_table_sql_service import (
            build_dataset_table_live_query,
            is_derived_table,
        )

        if is_generated_calendar_table(t):
            return None
        if is_derived_table(t) and ds_obj is not None:
            try:
                resolved, _sql = build_dataset_table_live_query(self.db, ds_obj, t)
                return getattr(resolved, "id", None)
            except Exception:  # noqa: BLE001 — unresolvable: the render fails loud on its own
                return None
        return getattr(t, "datasource_id", None)

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

        # Determine base table name (snapshot redirect wins when present — #5)
        base_table = self._snapshot_ref_for_view(base_view) or self._relation_sql_for_view(base_view) or explore.base_view_name
        from_clause = f"FROM {base_table} AS {explore.base_view_name}"

        joined_nodes: set[str] = {explore.base_view_name}
        resolver = self._resolver
        if resolver is None:
            return from_clause, joined_nodes

        if target_views is None:
            candidate_nodes = set(self.views_cache.keys())
        else:
            candidate_nodes = set(target_views)
        from app.services.semantic_join_resolver import _edge_signature, _route_label

        def _nodes(path) -> set:
            out = set()
            for st in path.steps:
                out.add(st.edge.from_node)
                out.add(st.edge.to_node)
            return out

        def _tail_sig(steps) -> tuple:
            return tuple(_edge_signature(st.edge) for st in steps)

        routes_memo: dict = {}
        base_name = explore.base_view_name
        # The measures' facts under a DIMENSION base (the base is one of their
        # dimensions): the rows the measure sums are theirs, so their own
        # dimension chains are meanings of a view too.
        fact_views = sorted(
            f for f in (getattr(self, "_from_fact_views", None) or ())
            if f and f != base_name and f in candidate_nodes and base_name in self._m1_reachable_views(f)
        )

        def _fact_rooted(target_node: str) -> list:
            """Every forward chain from a fact of the query to the target,
            reached through EVERY route of that fact from the base (the
            choice among them is made with the rest, by `_pick_route`)."""
            out = []
            for fact in fact_views:
                if fact == target_node:
                    continue
                tails = self._resolver_rooted(fact).forward_routes(target_node)
                if tails is None:
                    raise RouteEnumerationIncomplete(target_node)
                for prefix in _base_routes_for(fact):
                    prefix_nodes = _nodes(prefix) | {base_name}
                    for tail in tails:
                        if not tail.steps or (_nodes(tail) - {fact}) & prefix_nodes:
                            continue    # not a simple route (it comes back through the prefix)
                        steps = list(prefix.steps) + list(tail.steps)
                        out.append(type(tail)(
                            target_node=target_node,
                            steps=[type(st)(edge=st.edge, alias_sql=f"_appbi_sem_join_{i}")
                                   for i, st in enumerate(steps)],
                        ))
            return out

        base_memo: dict = {}

        def _base_routes_for(target_node: str):
            """The target's routes from the base alone (no fact-rooted chains)."""
            if target_node not in base_memo:
                found_routes: list = []
                for enumerate_routes in (resolver.forward_routes, resolver.descend_ascend_routes,
                                         resolver.any_routes):
                    found = enumerate_routes(target_node)
                    if found is None:
                        raise RouteEnumerationIncomplete(target_node)
                    found_routes = [r for r in found if r.steps]
                    if found_routes:
                        break
                base_memo[target_node] = found_routes
            return base_memo[target_node]

        def _routes_for(target_node: str):
            """The target's meanings — every route, of any length, of the
            first kind that exists: FORWARD chains — of the base, and of the
            measures' facts under a dimension base (a customers-based chart's
            "region" is the customer's, and the summed SALE's own region is a
            second meaning); else DESCEND-then-ASCEND routes (a fact under a
            dimension base, and that fact's dimensions — "the region's sales"
            through two chains is two meanings, as "sales by region" is from the
            fact); else any route. Never a shortest pick; a set that cannot be
            seen completely is refused (RouteEnumerationIncomplete)."""
            if target_node in routes_memo:
                return routes_memo[target_node]
            out = list(_base_routes_for(target_node))
            if out and all(hop_is_to_one(st.edge) for r in out for st in r.steps):
                # a dimension of the base: the facts' own chains are meanings too
                seen = {tuple(_edge_signature(st.edge) for st in r.steps) for r in out}
                for r in _fact_rooted(target_node):
                    sig = tuple(_edge_signature(st.edge) for st in r.steps)
                    if sig not in seen:
                        seen.add(sig)
                        out.append(r)
            routes_memo[target_node] = out
            return out

        def _decide(routes, required: set):
            return self._pick_route(routes, required)

        # Decided against EVERY node the query certainly joins — the base plus the
        # route of each target that has only one — never against "whatever the
        # names sorted before this one happened to join" (the order of view
        # names decided a role diamond: customer + store + region took the
        # customer's region because `customers` sorts before `stores`).
        targets = sorted(candidate_nodes - joined_nodes)
        chosen: dict = {}
        tied: dict = {}
        for target_node in targets:
            routes = _routes_for(target_node)
            if not routes:
                # Phase-11: friendly Vietnamese message so DA hiểu cần thêm
                # relationship. Tránh raw English engine identifier.
                raise SemanticRefusal(
                    f"Bảng \"{target_node}\" chưa có relationship tới base view "
                    f"\"{explore.base_view_name}\". "
                    f"Mở tab Data Model để định nghĩa join trước khi dùng field từ bảng này.",
                    SemanticRefusal.UNREACHABLE_VIEW,
                )
            if len(routes) == 1:
                chosen[target_node] = routes[0]
            else:
                tied[target_node] = routes
        required = set(joined_nodes)
        for path in chosen.values():
            required |= _nodes(path)
        # A tie decided by another target's route widens `required` for the next
        # pass; decisions of one pass use the same `required` (order-free).
        decided_ties: list = []
        while tied:
            decided = {}
            for target_node in sorted(tied):
                path, _alt = _decide(tied[target_node], required)
                if path is not None:
                    decided[target_node] = path
            if not decided:
                break
            for target_node, path in decided.items():
                chosen[target_node] = path
                decided_ties.append(target_node)
                tied.pop(target_node)
                required |= _nodes(path)
        if tied:
            first = sorted(tied)[0]
            _p, alternatives = _decide(tied[first], required)
            raise AmbiguousJoinPathError(first, [_route_label(r) for r in (alternatives or tied[first])])
        # Every decision must still hold for the FINAL FROM chain: a route chosen
        # before a later target joined its alternative's anchor is a tie.
        for target_node in decided_ties:
            path, alternatives = _decide(_routes_for(target_node), required)
            if path is None or self._route_meaning(path, required) != self._route_meaning(chosen[target_node], required):
                raise AmbiguousJoinPathError(
                    target_node, [_route_label(r) for r in (alternatives or [path or chosen[target_node]])])
        # One relationship per joined node: two chosen routes entering the same
        # node through DIFFERENT relationships would give that alias two meanings
        # (the FROM chain can join it only once) — refused, never first-wins.
        entered_by: dict = {}
        for target_node in sorted(chosen):
            for st in chosen[target_node].steps:
                sig = _edge_signature(st.edge)
                prev = entered_by.setdefault(st.edge.to_node, (sig, chosen[target_node]))
                if prev[0] != sig:
                    raise AmbiguousJoinPathError(
                        st.edge.to_node, [_route_label(prev[1]), _route_label(chosen[target_node])])
        for target_node in sorted(chosen):
            from_clause = self._append_route_joins(from_clause, chosen[target_node], joined_nodes)
        plan = getattr(self, "query_plan", None)
        if isinstance(plan, dict):
            plan.setdefault("select_routes", {})[explore.base_view_name] = {
                t: _route_label(chosen[t]) for t in sorted(chosen)}

        return from_clause, joined_nodes

    @property
    def key_probes(self) -> list:
        """The key probes the last generated query needs verified before it runs."""
        return list((getattr(self, "_key_probes", None) or {}).values())

    def _record_key_probe(self, edge, condition: str) -> None:
        """Record the probe of every ONE-side key this JOIN trusts.

        The walked cardinality names the one side: the to side of a
        many-to-one, the FROM side of a one-to-many (a relationship walked from
        its dimension, e.g. a chart based on the dim summing the fact), both
        sides of a one-to-one. A duplicate on that side repeats the other
        side's rows whichever way the JOIN is written. The probe groups the one
        side by the very expressions the ON condition compares (casts and
        expressions included), on the relation the FROM chain reads; a
        condition that is not a key equality yields an unverifiable probe,
        which refuses the query."""
        from app.services.relationship_key_guard import one_side_probe

        card = canonical_cardinality(getattr(edge, "cardinality", None))
        sides = []
        if card in ("many_to_one", "one_to_one"):
            sides.append((edge.to_node, edge.from_node))
        if card in ("one_to_many", "one_to_one"):
            sides.append((edge.from_node, edge.to_node))
        probes = getattr(self, "_key_probes", None)
        if probes is None:
            probes = self._key_probes = {}
        for one, other in sides:
            view = self._get_view_for_node(one)
            snapshot_ref = self._snapshot_ref_for_view(view)
            relation = snapshot_ref or self._relation_sql_for_view(view) or getattr(view, "name", None) or one
            probe = one_side_probe(
                condition, one_alias=one, other_alias=other, relation=relation,
                label=f"{edge.from_node} → {edge.to_node}", view=str(getattr(view, "name", None) or one),
                # a snapshot table is immutable (one physical table per build);
                # anything else is read live and may change between queries
                immutable=bool(snapshot_ref),
            )
            probes.setdefault(probe["key"], probe)
            chain = getattr(self, "_chain_probe_keys", None)
            if isinstance(chain, list) and probe["key"] not in chain:
                chain.append(probe["key"])

    def _append_route_joins(self, from_clause: str, path, joined_nodes: set) -> str:
        """Append the JOINs of `path` that are not in the FROM chain yet."""
        for step in path.steps:
            edge = step.edge
            if edge.to_node in joined_nodes:
                continue
            join_view = self._get_view_for_node(edge.to_node)
            join_table = self._snapshot_ref_for_view(join_view) or self._relation_sql_for_view(join_view) or edge.to_view
            join_condition_rendered = self._render_edge_join_condition(edge)
            if not join_condition_rendered:
                raise ValueError(
                    f"Join from '{edge.from_node}' to '{edge.to_node}' is missing a SQL condition"
                )
            self._record_key_probe(edge, join_condition_rendered)
            join_type = (edge.type or "left").upper()
            from_clause += (
                f"\n{join_type} JOIN {join_table} AS {edge.to_node} "
                f"ON {join_condition_rendered}"
            )
            joined_nodes.add(edge.to_node)
        return from_clause

    # Semantic-audit 2026-07 (#1) — canonical equality template our join
    # builders emit (`${TABLE}.a = ${target}.b`, AND-joined for composite
    # keys). ONLY conditions that fullmatch this shape are eligible for
    # type-aware key coercion; anything else (calendar CAST joins, custom
    # user SQL) renders through the legacy path byte-identical.
    _CANON_JOIN_EQ_RE = re.compile(
        r"^\s*\$\{TABLE\}\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"
        r"\$\{([^}]+)\}\.([A-Za-z_][A-Za-z0-9_]*)\s*$"
    )
    def _joinkey_family(self, view, col: str) -> Optional[str]:
        """'number' | 'string' | None for a join-key column's PHYSICAL type.

        Resolved through the shared ``physical_type_map`` so a key MATERIALIZED as
        text is treated as text even when the model labelled it numeric — the
        mismatch that produced ``STRING = INT64`` on federated joins."""
        t = self._physical_source_type(view, col)
        if not t:
            return None
        return _ptm.compare_family(t)

    def _typed_join_condition(self, edge, condition: str) -> Optional[str]:
        """Type-aware rebuild of a CANONICAL key-equality join condition.

        Sheets/Airbyte/CSV sources store numeric keys as physical STRING while
        the other side is INT64/NUMERIC — a raw `a = b` ON clause then 400s on
        BigQuery/Postgres ("No matching signature for operator = STRING,
        INT64") or silently no-matches on MySQL ('007' vs 7). The WHERE and
        measure paths already SAFE_CAST for exactly this; joins were the gap.

        Returns the rebuilt condition ONLY when (a) the sql_on is exactly the
        canonical builder template and (b) at least one key pair mixes a
        physical string with a physical number — the string side is coerced
        via build_safe_cast_sql(..., "float") (the filter-path convention; a
        no-op on genuine numerics, NULL → no-match on real text, never a type
        error). Every other case returns None → legacy render, byte-identical.
        """
        try:
            parts = [p.strip() for p in condition.split(" AND ")]
            pairs: list[tuple[str, str]] = []
            for p in parts:
                m = self._CANON_JOIN_EQ_RE.fullmatch(p)
                if not m:
                    return None
                target_ph = m.group(2).strip()
                if target_ph not in {edge.to_view, edge.to_node}:
                    return None
                pairs.append((m.group(1), m.group(3)))
            if not pairs:
                return None
            from_view = self._get_view_for_node(edge.from_node)
            # to_node (not to_view) — resolves role-play aliases through the
            # cache first, exactly like every other field lookup.
            to_view_obj = self._get_view_for_node(edge.to_node)
            if from_view is None or to_view_obj is None:
                return None

            from app.services.type_override_service import build_safe_cast_sql

            rebuilt: list[str] = []
            any_cast = False
            for fc, tc in pairs:
                ff = self._joinkey_family(from_view, fc)
                tf = self._joinkey_family(to_view_obj, tc)
                lhs = f"{edge.from_node}.{fc}"
                rhs = f"{edge.to_node}.{tc}"
                if {ff, tf} == {"number", "string"}:
                    # Cast BOTH sides, not just the text one. Casting a single
                    # side trusts the OTHER side's recorded type to be exact, and
                    # a materialized column can disagree with the model that
                    # describes it (a Postgres key whose physical type was never
                    # resolved landed in the snapshot as STRING while the model
                    # called it an integer) — the join then emitted
                    # `FLOAT64 = STRING` and BigQuery rejected the whole query.
                    # SAFE_CAST over a genuine number is a value-preserving no-op,
                    # so casting both makes the comparison type-check whatever the
                    # physical types turn out to be. Only reached when one side is
                    # KNOWN numeric and the other KNOWN text: two text keys are
                    # left alone (casting them could NULL a legitimate match).
                    lhs = build_safe_cast_sql(lhs, "float", self.database_type)
                    rhs = build_safe_cast_sql(rhs, "float", self.database_type)
                    any_cast = True
                rebuilt.append(f"{lhs} = {rhs}")
            if not any_cast:
                return None  # same-family keys → legacy path, byte-identical
            return " AND ".join(rebuilt)
        except Exception:  # noqa: BLE001 — never let coercion break rendering
            return None

    def _render_edge_join_condition(self, edge) -> str:
        """Render a JOIN ON condition for a resolved join edge."""
        condition = str(edge.sql_on or "").strip()
        if not condition:
            if edge.from_column and edge.to_column:
                return f"{edge.from_node}.{edge.from_column} = {edge.to_node}.{edge.to_column}"
            return ""

        # Audit #1 — type-aware key coercion for canonical equality joins
        # (physical STRING key vs numeric key). None → legacy render below.
        typed = self._typed_join_condition(edge, condition)
        if typed is not None:
            return typed

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

        # Audit #4 — expand the dialect-portable local-date macro (calendar
        # timezone joins) for THIS engine's dialect. No-op when absent.
        if "APPBI_LOCAL_DATE" in rendered:
            from app.services.dataset_calendar_service import expand_local_date_macros

            rendered = expand_local_date_macros(rendered, self.database_type)

        return rendered
    
    def _build_where_clause(
        self,
        filters: Dict[str, Any],
        time_grains: Dict[str, str],
        exists_views: set[str] | None = None,
        explore: SemanticExplore | None = None,
        select_side_views: set[str] | None = None,
        joined_nodes: set[str] | None = None,
        measure_fact_views: set[str] | None = None,
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
            return _quote_string(raw, self.database_type)

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

        def _numeric_text(v: Any) -> Optional[int]:
            """An integer-like STRING, e.g. the "2017" a slicer hands back.

            The mirror image of the guard above. Distinct values reach the
            client as text, so choosing a year sends `["2017"]` at an INT64
            column and BigQuery refuses outright: *No matching signature for
            operator IN for argument types INT64 and {STRING}*. Measured on
            dash 67 — selecting a year 400'd every chart on the page, through
            the dropdown exactly as much as through the segmented control.

            Only plain integer text converts. Floats keep their text form
            (it round-trips badly) and anything zero-padded stays text, because
            in a code like "007" the padding is part of the identity.
            """
            if not isinstance(v, str):
                return None
            t = v.strip()
            body = t[1:] if t[:1] in {"+", "-"} else t
            if not body.isdigit():
                return None
            if len(body) > 1 and body[0] == "0":
                return None
            try:
                return int(t)
            except ValueError:
                return None

        def _coerce_numeric_text(values: list) -> list:
            """Convert a value list when EVERY present entry is integer text.

            All-or-nothing: a mixed list means the column really is textual and
            the numbers in it are incidental. Once converted, `_num` above sees
            numbers and SAFE_CASTs the column, so the comparison lands whether
            the column is physically INT64 or STRING.
            """
            present = [v for v in values if _value_present(v)]
            if not present:
                return values
            converted = [_numeric_text(v) for v in present]
            if any(c is None for c in converted):
                return values
            return converted

        where_conditions: list[str] = []      # base / select-side predicates
        exists_groups: dict[str, list[str]] = {}  # filter-only view -> predicates
        # views whose EXISTS group carries an authoritative predicate
        exists_authoritative: set[str] = set()
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
        _gate_root = getattr(self, "_filter_root", None) or (explore.base_view_name if explore is not None else None)
        if self._model is not None and explore is not None:
            try:
                from app.services.semantic_join_resolver import SemanticJoinResolver as _R2
                _drop_gate_resolver = _R2(
                    self.db, self._model, _gate_root, bidirectional=False,
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

            # BUG-018 convergence: coerce the value to its column's declared type
            # (number/bool) so `_lit`/`_num` below render a type-matched literal.
            # No-op when the value is already typed (dashboard's usual case →
            # byte-identical) or for string/date columns; fixes a string value
            # like "1" arriving on a numeric column (→ INT64 = STRING 400).
            value = self._coerce_typed_filter_value(
                value, self._filter_type_family(field_ref, view_name)
            )

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
                    self._refuse_unapplied_authoritative(filter_def, "propagation_drop")
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
                        if isinstance(filter_def, dict) and filter_def.get("_authoritative"):
                            exists_authoritative.add(view_name)
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
                            self._refuse_unapplied_authoritative(filter_def, "no_primary_key")
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
                    if isinstance(filter_def, dict) and filter_def.get("_authoritative"):
                        exists_authoritative.add(view_name)
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
                        and view_name != _gate_root
                    ):
                        try:
                            _strict_unreachable = not _drop_gate_resolver.resolve_paths(view_name)
                        except Exception:  # noqa: BLE001 — fall back to legacy on resolver error
                            _strict_unreachable = False
                    # ── Separate the TWO filter concepts (root-cause of the ds84
                    # "slicer wrong" report) ─────────────────────────────────
                    # 1) HOW data is filtered = the MODEL structure. A filter on a
                    #    dimension that is forward-M:1 reachable from a MEASURE'S
                    #    FACT is the standard star-schema dim→fact filter and MUST
                    #    apply — regardless of the chart's arbitrary base view and
                    #    regardless of cross-filter direction.
                    # 2) Cross-filter DIRECTION (single/both) is an add-on that
                    #    only governs the genuinely direction-dependent cases
                    #    (fact→dim reverse, dim→dim / fact→fact bridging).
                    # The base-anchored strict resolver above conflates the two:
                    # it drops a dim that IS related to the measure's fact merely
                    # because the chart base is a *different* table needing a
                    # reverse hop. Un-drop when the view is structurally related
                    # to a measure's fact; the cross-fact/bridge protection (the
                    # real Concept-2 case, unreachable from every measure fact)
                    # is untouched.
                    if _strict_unreachable and measure_fact_views and view_name in measure_fact_views:
                        _strict_unreachable = False
                    if _strict_unreachable:
                        self._refuse_unapplied_authoritative(filter_def, "unreachable_view")
                        propagation_drops.append({
                            "field": field_ref,
                            "reason": "unreachable_view",
                            "detail": (
                                f"Filter view {view_name!r} has no single-direction "
                                f"relationship path to base {_gate_root!r}; "
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
                    if isinstance(filter_def, dict) and filter_def.get("_authoritative"):
                        exists_authoritative.add(view_name)
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
                    # so we only add the calendar math on top. An INSTANT under
                    # a non-UTC calendar is first put on its LOCAL date — the
                    # rule the calendar join and the time grains use — or a
                    # near-midnight event is filtered into another day/year
                    # than the one it is grouped into.
                    _cal_tz = self._calendar_timezone()
                    if _cal_tz and self._dimension_is_instant(field_ref):
                        from app.services.dataset_calendar_service import local_date_sql

                        field_sql = local_date_sql(field_sql, _cal_tz, (self.database_type or "").lower())
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
                # a server-owned constraint refuses with the fixed message (it
                # names no field: the ref of a 🚫 hidden filter is not public)
                self._refuse_unapplied_authoritative(filter_def, "field_not_renderable")
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
            if calendar_field_ref and not calendar_field_sql:
                # A calendar field with no expression here (week_start_date,
                # month_end_date, date_key, …) is compared with the raw date
                # column — another predicate. An ordinary filter keeps that
                # legacy fallback; a server-owned one refuses.
                self._refuse_unapplied_authoritative(filter_def, "calendar_field_unsupported")

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
                else:
                    # both blank → user hasn't filled the picker yet, skip
                    self._refuse_unapplied_authoritative(filter_def, "empty_value")
                continue

            # IN / NOT IN accept list or comma-separated string.
            if operator == "in":
                present: list[Any] = []
                if isinstance(value, list):
                    present = _coerce_numeric_text([v for v in value if _value_present(v)])
                elif isinstance(value, str) and value.strip():
                    present = _coerce_numeric_text([v.strip() for v in value.split(",") if v.strip()])
                vals = ", ".join(_lit(v) for v in present)
                if vals:
                    conditions.append(f"{_num(field_sql, *present)} IN ({vals})")
                else:
                    self._refuse_unapplied_authoritative(filter_def, "empty_value")
                continue
            if operator == "not_in":
                present = []
                if isinstance(value, list):
                    present = _coerce_numeric_text([v for v in value if _value_present(v)])
                elif isinstance(value, str) and value.strip():
                    present = _coerce_numeric_text([v.strip() for v in value.split(",") if v.strip()])
                vals = ", ".join(_lit(v) for v in present)
                if vals:
                    conditions.append(f"{_num(field_sql, *present)} NOT IN ({vals})")
                else:
                    self._refuse_unapplied_authoritative(filter_def, "empty_value")
                continue

            # Pattern operators need LIKE-escaping for % and _ so DA-typed
            # literals don't accidentally turn into wildcards.
            if operator in {"contains", "not_contains", "starts_with", "ends_with"}:
                if value is None:
                    self._refuse_unapplied_authoritative(filter_def, "empty_value")
                    continue
                # PBI parity (2026-06) — a LIKE operator on a DATE/numeric column
                # is invalid SQL (Postgres: `operator does not exist: date ~~
                # text`) and previously 500'd the chart. The FE gates operators
                # by type; this only trips on a legacy saved filter or an API
                # caller. An unsupported operator is a HARD reason (chart_contracts):
                # refused (400), never answered without the filter — the same as an
                # operator any other builder cannot render.
                if self._field_rejects_pattern_operator(field_ref):
                    self._refuse_unapplied_authoritative(filter_def, "unsupported_operator")
                    raise ValueError(
                        f"Toán tử {operator!r} (dạng văn bản) không dùng được trên cột "
                        f"{field_ref!r} kiểu ngày/số — sửa filter (đổi toán tử hoặc cột)."
                    )
                # One shape per dialect (app/services/sql_pattern): BigQuery has
                # no LIKE … ESCAPE, so it gets STRPOS / STARTS_WITH / ENDS_WITH.
                conditions.append(pattern_predicate(
                    field_sql, operator, value, self.database_type,
                    lambda s: _quote_string(s, self.database_type),
                ))
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
                else:
                    self._refuse_unapplied_authoritative(filter_def, "empty_value")
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
                    self._refuse_unapplied_authoritative(filter_def, "empty_value")
                    continue
                # One spelling per engine (sql_pattern.regex_predicate). This
                # used to emit `SIMILAR TO`, an anchored SQL pattern in which
                # `.` is literal: wrong rows on Postgres, a 400 on BigQuery.
                conditions.append(regex_predicate(
                    field_sql, value, self.database_type, lambda v: _lit(v),
                ))
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
                else:
                    self._refuse_unapplied_authoritative(filter_def, "empty_value")
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
                if view_node in exists_authoritative:
                    from app.services.chart_contracts import AuthoritativeFilterNotApplied

                    raise AuthoritativeFilterNotApplied("no_join_path")
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
        resolver = self._filter_route_resolver()
        if resolver is None or not predicates:
            return None

        jn = joined_nodes or set()

        def _anchor_idx(p) -> int:
            """Deepest index on ``p.steps`` whose hop SOURCE is already joined.

            ``p.steps`` runs root→…→target; ``step.edge.from_node`` is the
            closer-to-root side of each hop. The highest such index is the most
            specific (closest-to-target) correlation anchor available on ``p``.
            """
            idx = 0
            for i, step in enumerate(p.steps):
                if getattr(step.edge, "from_node", None) in jn:
                    idx = i
            return idx

        from app.services.semantic_join_resolver import _edge_signature, _route_label

        # FORWARD — the filter is on a dimension that describes a row the query
        # already has: walked from the BASE first (the same chain the SELECT
        # would use, so a filtered view means what a grouped one shows), then
        # from the measure's fact when it is joined under another base. The
        # picking rule is the FROM builder's (_pick_route): the meaning anchored
        # closest to the target wins; a competing meaning is refused.
        base_resolver = self._resolver
        routes = None
        fwd: list = []
        # A measure-level filter (no explore: its own grain) routes from the
        # measure's view only — the chart's base is not part of its meaning.
        roots = [resolver] if explore is None else (
            [base_resolver] + ([resolver] if resolver is not base_resolver else []))
        for r in roots:
            found = r.forward_routes(target_node)
            if found is None:
                raise RouteEnumerationIncomplete(target_node)
            fwd += [p for p in found if p.steps]
        if fwd:
            # ONE candidate set: a dimension of the chart's base AND a dimension
            # of the fact the measure sums (when the fact is joined under
            # another base) are both meanings — a customers-based chart filtered
            # by "region": the customer's region and the summed sale's own
            # region; the closest one to the query's views wins, a tie refused.
            path, tied = self._pick_route(fwd, jn)
            if path is None:
                raise AmbiguousJoinPathError(target_node, [_route_label(c) for c in tied])
            routes = [path]
        if routes is None:
            # PROPAGATION — the view is another table reached through a 1:N hop
            # (revenue → date ← deals and revenue → owner ← deals, filtered on
            # deals): the routes from the query's FACT grain that relate it to
            # that table most DIRECTLY (every shortest one — a longer route
            # relates the two tables through further relationships, typically
            # another role of a dimension: an order's items vs "the customer's
            # geo = a seller's geo"), only over hops a filter may travel (toward a
            # many side only when the relationship filters both ways; the
            # bidirectional walk is never a filter path). The other table's
            # filter restricts EACH such route and the fact is filtered by all
            # of them: one EXISTS per valid route, AND-ed, whatever the chart
            # groups by. The set is enumerated completely — past its cap the
            # query is refused (distinct_routes raises), never AND-ed partially.
            candidate_paths = [p for p in (resolver.distinct_routes(target_node) or []) if p and p.steps]
            valid = [c for c in candidate_paths
                     if all(edge_propagates(s.edge) for s in c.steps[_anchor_idx(c):])]
            if not valid:
                # every shortest route crosses a hop a filter may not travel —
                # the most direct routes it MAY travel are the filter's (a
                # single-direction relationship never hides a valid one)
                valid = resolver.shortest_propagation_routes(target_node, set(jn))
                if valid is None:
                    raise RouteEnumerationIncomplete(target_node)
            if not valid:
                return None
            routes, _seen = [], set()
            for c in valid:
                tail = tuple(_edge_signature(s.edge) for s in c.steps[_anchor_idx(c):])
                if tail not in _seen:
                    _seen.add(tail)
                    routes.append(c)

        def _emit(steps) -> str | None:
            """Build one ``EXISTS (...)`` for a root→target sub-path; None if a
            hop's view is unknown or has no join condition. (Nested-CTE sources
            are embedded like any relation: BigQuery, Postgres, MySQL and DuckDB
            all accept them inside a correlated EXISTS — verified on BigQuery.)"""
            pieces: list[str] = []
            correlation: str | None = None
            for idx, step in enumerate(steps):
                edge = step.edge
                try:
                    join_view = self._get_view_for_node(edge.to_node)
                except ValueError:
                    return None
                relation = self._snapshot_ref_for_view(join_view) or self._relation_sql_for_view(join_view) or edge.to_view
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

        self._record_filter_routes(target_node, routes)
        clauses = [_emit(c.steps[_anchor_idx(c):]) for c in routes]
        if any(c is None for c in clauses):
            if len(clauses) > 1:
                # Dropping one route would filter through the others only — a
                # narrower answer than the model means. Refuse instead.
                raise AmbiguousJoinPathError(target_node, [_route_label(c) for c in routes])
            return None
        if len(clauses) == 1:
            return clauses[0]
        return "(" + " AND ".join(clauses) + ")"
    
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
    @staticmethod
    def _route_anchor(route, joined: set) -> int:
        """Index of the deepest step whose SOURCE the query already joins."""
        idx = 0
        for i, st in enumerate(route.steps):
            if st.edge.from_node in joined:
                idx = i
        return idx

    @classmethod
    def _route_meaning(cls, route, joined: set) -> tuple:
        """What a route means FROM the nearest node the query joins (the part
        before is the query's own FROM chain): its key-composition segments —
        so ``sales → dim_product → products`` on ``product_id`` all the way IS
        ``sales → products`` on ``product_id``, one meaning; a chain through
        another column (``customers.region_id``) is a meaning of its own."""
        from app.services.semantic_join_resolver import route_meaning_segments

        return route_meaning_segments(route.steps[cls._route_anchor(route, joined):])

    @classmethod
    def _pick_route(cls, routes, joined: set):
        """(route, None) when the query's context determines ONE meaning, else
        (None, the competing routes). The one rule of the FROM builder and the
        filter EXISTS builder:

        * a route's meaning is its relationships from the NEAREST node the query
          joins (the anchor) — grouped by customer, "region" is the customer's;
        * the meaning anchored closest to the target wins; an equally close one
          through other relationships, or a longer chain from the SAME anchor
          (the sale's own region vs the customer's region, both from the sale),
          is a second meaning → refused, never shortest-wins or first-wins;
        * routes with one meaning (identical relationships, or chains that
          compose to the same key equalities): the one whose prefix the query
          already joins, then the one with the fewest joins (deterministic
          otherwise)."""
        from app.services.semantic_join_resolver import _route_label

        routes = [r for r in routes if r is not None]
        if not routes:
            return None, None
        if any(not r.steps for r in routes):
            return next(r for r in routes if not r.steps), None
        info = []
        for r in routes:
            a = cls._route_anchor(r, joined)
            info.append((r, a, len(r.steps) - a, r.steps[a].edge.from_node))
        best_len = min(t for _r, _a, t, _n in info)
        best_nodes = {n for _r, _a, t, n in info if t == best_len}
        competing = [r for r, _a, t, n in info if t == best_len or n in best_nodes]
        meanings: dict = {}
        for r in competing:
            meanings.setdefault(cls._route_meaning(r, joined), []).append(r)
        if len(meanings) == 1:
            group = next(iter(meanings.values()))
            # One KEY meaning can still keep different ROWS: a chain through an
            # intermediate view finds no target row where that intermediate has
            # none (a LEFT JOIN NULL), so two equally short chains through
            # DIFFERENT intermediates may disagree on which rows reach the target.
            # Only a strictly shortest route represents the meaning; a tie
            # between different relationships is refused (Pair #3 H3-13).
            from app.services.semantic_join_resolver import _edge_signature

            tails: dict = {}
            for r in group:
                tails.setdefault(tuple(_edge_signature(st.edge) for st in r.steps[cls._route_anchor(r, joined):]), r)
            if len(tails) > 1:
                shortest = min(len(t) for t in tails)
                tied_tails = [t for t in tails if len(t) == shortest]
                if len(tied_tails) > 1:
                    return None, sorted((tails[t] for t in tied_tails), key=_route_label)
            group.sort(key=lambda r: (
                not all(st.edge.to_node in joined for st in r.steps[:cls._route_anchor(r, joined)]),
                len(r.steps), _route_label(r)))
            return group[0], None
        return None, [sorted(g, key=_route_label)[0] for g in meanings.values()]

    def _filter_route_resolver(self):
        """The resolver filter routes are walked with: rooted at the query's
        fact grain (``_filter_root``), the base resolver when that IS the base."""
        base = self._resolver
        root = getattr(self, "_filter_root", None)
        if base is None or not root or root == base.base_node:
            return base
        return self._resolver_rooted(root)

    def _resolver_rooted(self, root: str):
        """A (bidirectional) resolver of this query's model rooted at ``root``,
        memoised per query."""
        base = self._resolver
        if base is not None and root == base.base_node:
            return base
        cache = getattr(self, "_filter_resolver_cache", None)
        if cache is None:
            cache = self._filter_resolver_cache = {}
        key = (getattr(self._model, "id", None), root)
        if key not in cache:
            cache[key] = SemanticJoinResolver(self.db, self._model, root, bidirectional=True)
        return cache[key]

    def _plan_note(self, **items) -> None:
        """Record a planning decision on the query plan (observable before any
        SQL runs: fact grains, strategy, routes, calendar role). The first note
        of a key wins — the top-level query's, not a nested sub-query's."""
        plan = getattr(self, "query_plan", None)
        if not isinstance(plan, dict):
            plan = self.query_plan = {}
        for key, value in items.items():
            plan.setdefault(key, value)

    def _record_filter_routes(self, target_node: str, routes) -> None:
        from app.services.semantic_join_resolver import _route_label

        plan = getattr(self, "query_plan", None)
        if not isinstance(plan, dict):
            plan = self.query_plan = {}
        plan.setdefault("filter_routes", {})[target_node] = sorted(_route_label(r) for r in routes)

    def _split_filters_by_role(
        self,
        filters: Dict[str, Any],
        measures: List[str],
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        if not filters:
            return {}, {}
        where_filters: Dict[str, Any] = {}
        having_filters: Dict[str, Any] = {}
        for field_ref, fdef in filters.items():
            if self._filter_targets_measure(field_ref, measures):
                having_filters[field_ref] = fdef
            else:
                where_filters[field_ref] = fdef
        return where_filters, having_filters

    def _filter_targets_measure(self, field_ref: str, measures: List[str]) -> bool:
        """Is this filter a condition on an AGGREGATE (HAVING), not on rows?

        Yes when the field is one of the query's measures, and also when the
        model says it is a measure of its view (and not a dimension of the same
        name) — a measure filter used to count as a row filter unless the chart
        also displayed that measure, and a measure named like a column then
        silently filtered rows instead of groups."""
        key = str(field_ref or "").strip()
        if key.lower() in {str(m or "").strip().lower() for m in (measures or []) if m}:
            return True
        if "." not in key:
            return False
        view_name, field_name = key.split(".", 1)
        view = self.views_cache.get(view_name) or self._find_view_by_name(view_name)
        if view is None:
            return False
        measure_names = {str(m.get("name")) for m in (view.measures or []) if isinstance(m, dict)}
        dim_names = {str(d.get("name")) for d in (view.dimensions or []) if isinstance(d, dict)}
        return field_name in measure_names and field_name not in dim_names

    def _aggregate_predicate(self, value_sql: str, field_ref: str, filter_def: Dict[str, Any]) -> str:
        """`value_sql <op> literal` for a filter on an aggregated value.

        Same operators and literals as the HAVING builder; used on the stitched
        multi-fact row, where each measure is a column of its fact's CTE."""
        operator = str(filter_def.get("operator") or "eq").strip().lower()
        value = filter_def.get("value")

        def _lit(raw: Any) -> str:
            if raw is None:
                return "NULL"
            if isinstance(raw, bool):
                return "TRUE" if raw else "FALSE"
            if isinstance(raw, (int, float)):
                return str(raw)
            return _quote_string(raw, self.database_type)

        def _present(raw: Any) -> bool:
            return not (raw is None or (isinstance(raw, str) and not raw.strip()))

        if operator == "is_null":
            return f"{value_sql} IS NULL"
        if operator == "is_not_null":
            return f"{value_sql} IS NOT NULL"
        if operator == "between" and isinstance(value, list) and len(value) >= 2:
            lo, hi = value[0], value[1]
            if _present(lo) and _present(hi):
                return f"{value_sql} BETWEEN {_lit(lo)} AND {_lit(hi)}"
            if _present(lo):
                return f"{value_sql} >= {_lit(lo)}"
            if _present(hi):
                return f"{value_sql} <= {_lit(hi)}"
            return ""
        if operator in {"in", "not_in"}:
            raw = value if isinstance(value, list) else str(value or "").split(",")
            vals = ", ".join(_lit(v.strip() if isinstance(v, str) else v) for v in raw if _present(v))
            if not vals:
                return ""
            return f"{value_sql} {'IN' if operator == 'in' else 'NOT IN'} ({vals})"
        scalar_ops = {"eq": "=", "neq": "!=", "ne": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
        if operator in scalar_ops:
            return f"{value_sql} {scalar_ops[operator]} {_lit(value)}"
        raise ValueError(
            f"Filter trên measure '{field_ref}' dùng toán tử '{operator}' không áp được "
            "lên giá trị tổng hợp — dùng =, ≠, >, ≥, <, ≤, between, in, not_in hoặc null."
        )

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
            return _quote_string(raw, self.database_type)

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
                # Dropping it returned every group — the filter silently gone.
                raise ValueError(
                    f"Filter trên measure '{field_ref}' không dựng được: {exc}"
                ) from exc

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

            raise ValueError(
                f"Filter trên measure '{field_ref}' dùng toán tử '{operator}' không áp được "
                "lên giá trị tổng hợp — dùng =, ≠, >, ≥, <, ≤, between, in, not_in hoặc null."
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
    
    def _order_term(self, alias: str, direction: str, *, nulls_last: bool = False) -> str:
        """One ORDER BY term. ``nulls_last`` pins NULLs after every value on
        every dialect: Postgres puts NULLs FIRST under DESC and BigQuery under
        ASC, so without it a Top-N could keep a group with no value at all.
        MySQL has no NULLS LAST, so it orders by the IS NULL flag first."""
        direction = "DESC" if str(direction).upper() == "DESC" else "ASC"
        if not nulls_last:
            return f"{alias} {direction}"
        if (self.database_type or "").lower() == "mysql":
            return f"({alias} IS NULL), {alias} {direction}"
        return f"{alias} {direction} NULLS LAST"

    def _build_order_by_clause(
        self,
        sorts: List[Dict[str, str]],
        measures: List[str],
        top_n: Optional[Dict[str, Any]],
        group_dims: Optional[List[str]] = None,
    ) -> str:
        """Build ORDER BY clause — the same rule as the multi-fact stitch, so a
        Top-N / sort + LIMIT keeps the same rows whichever strategy answers:

        * NULLs never rank first (NULLS LAST on every dialect — Postgres puts
          them FIRST under DESC and BigQuery under ASC, so "the top 2" used to
          start with the group that has no value on one dialect only);
        * the group dimensions follow as a tie-break, so equal values never
          leave WHICH row survives the LIMIT to the physical row order."""
        tie_breaks = [self._safe_alias(d) for d in (group_dims or [])]
        if top_n:
            alias = self._safe_alias(top_n['field'])
            parts = [self._order_term(alias, 'DESC', nulls_last=True)]
            parts += [self._order_term(a, 'ASC', nulls_last=True) for a in tie_breaks if a != alias]
            return "ORDER BY " + ", ".join(parts)

        # Use explicit sorts
        if sorts:
            order_parts = []
            used: set = set()
            for sort in sorts:
                field = sort.get('field')
                direction = "DESC" if str(sort.get('direction') or 'asc').upper() == "DESC" else "ASC"
                alias = self._safe_alias(field)
                order_parts.append(self._order_term(alias, direction, nulls_last=True))
                used.add(alias)
            order_parts += [self._order_term(a, 'ASC', nulls_last=True) for a in tie_breaks if a not in used]
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
            # The relationship contract decides (same reading as the resolver):
            # an inactive or invalid join is absent here too, so relatedness
            # checks stay consistent with the path the query builder renders.
            c = read_join_contract(base_view_name, j)
            if c.valid and c.is_active and c.view:
                out.add(c.view)
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
                raise SemanticRefusal(
                    f"Measure trên bảng '{fact}' không thể nhóm/pivot theo "
                    f"dimension {unsafe} (không có đường M:1 — JOIN sẽ fan-out, "
                    f"ra số sai). Các chiều này thuộc bảng fact khác / chỉ nối "
                    f"qua shared dim (chasm). Đổi chiều, thêm quan hệ M:1 trong "
                    f"Data Model, hoặc bỏ measure khỏi chart.",
                    SemanticRefusal.UNRELATED_GRAIN,
                )

    def _validate_dims_only_grain(self, base_view_name, dimensions, pivots) -> None:
        """STRICT grain guard for a MEASURE-LESS chart (Table / list). With no
        measure the base view defines the row grain; every dim/pivot view must
        be M:1-reachable from it. A dim on ANOTHER fact (reachable only via a
        1:N hop through a shared dim) would force a fan-out JOIN that multiplies
        the rows into a cartesian product. Fail loud rather than render the
        duplicated ("n-n") rows. Single-fact / single-table selects → every view
        is M:1-reachable → no-op. See the call site in ``generate_sql``."""
        if not base_view_name:
            return
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
        safe = self._m1_reachable_views(base_view_name) | {base_view_name}
        unsafe = sorted(v for v in group_views if v not in safe)
        if unsafe:
            raise SemanticRefusal(
                f"Các cột {unsafe} thuộc bảng fact khác — không có đường M:1 từ "
                f"bảng gốc '{base_view_name}'. Ghép cột từ nhiều bảng fact vào MỘT "
                f"bảng/list (không có measure) sẽ JOIN chéo qua shared dim (chasm) "
                f"→ nhân dòng (fan-out), ra số/hàng sai. Hãy: thêm measure để engine "
                f"tách theo từng fact, tách thành nhiều chart, hoặc chỉ chọn cột từ "
                f"MỘT bảng fact + các bảng dim của nó.",
                SemanticRefusal.FANOUT_RISK,
            )

    def _non_fanning_adjacency(self) -> dict[str, set[str]]:
        """The model's CANONICAL non-fanning reachability graph, built ONCE.

        A directed edge ``X -> Y`` means: joining from ``X`` to ``Y`` maps each
        ``X`` row to AT MOST ONE ``Y`` row (no fan-out). So a measure at ``X``'s
        grain may be grouped / sliced by a dimension on ``Y``, a filter on ``Y``
        structurally reaches ``X``'s grain, and a multi-fact stitch may relate
        the two — all consumed via :meth:`_m1_reachable_views`.

        Direction is decided by CARDINALITY ALONE — the single source of truth —
        and is INDEPENDENT of which side the modeller drew the relationship /
        which explore physically stores the join:

          * ``many_to_one`` (from=N -> to=1): ``from -> to``
          * ``one_to_one``:                   ``from -> to`` AND ``to -> from``
            — 1:1 is non-fanning in BOTH directions. (BUGFIX 2026-07-23: the old
            forward-only walk read only the join's authored explore, so a 1:1
            was reachable one way and "unrelated" the other → Measure/grain/
            filter results depended on the draw direction. See regression
            ``test_one_to_one_direction_agnostic``.)
          * ``one_to_many`` (from=1 -> to=N): ``to -> from`` (the MANY side
            reaches the ONE side; the authored from->to would fan out).
          * ``many_to_many``: NO edge (not non-fanning-safe either way).
          * empty / unknown cardinality: NO edge (STRICT PowerBI parity — never
            guessed M:1; the caller fails loud so the modeller declares it).

        Inactive joins are skipped (invisible to ``SemanticJoinResolver`` too).
        This is a STRUCTURAL graph only — it is deliberately SEPARATE from
        cross-filter propagation direction (``cross_filter`` single/both), which
        must never change structural measure/grain safety.
        """
        model = self._model
        model_id = getattr(model, "id", None)
        cache = getattr(self, "_nf_adj_cache", None)
        if cache is None:
            cache = self._nf_adj_cache = {}
        if model_id in cache:
            return cache[model_id]

        adj: dict[str, set[str]] = {}

        def _link(a: str, b: str) -> None:
            if a and b and a != b:
                adj.setdefault(a, set()).add(b)

        for explore in (getattr(model, "explores", None) or []):
            base = str(getattr(explore, "base_view_name", "") or "").strip()
            for j in (getattr(explore, "joins", None) or []):
                # The relationship contract (the resolver's reading): an invalid
                # row gives NO edge — never a guessed many-to-one — and "false"
                # is inactive. (The engine refuses a model with invalid rows
                # before it gets here; this keeps the graph honest regardless.)
                contract = read_join_contract(base, j)
                if not contract.valid or not contract.is_active:
                    continue
                frm = contract.from_view
                to = contract.view
                if not frm or not to:
                    continue
                # The resolver addresses a role-played join by its ALIAS (the
                # node id field refs use, e.g. `ship_cal.year`). Link the alias
                # node too, or a grouping on an aliased dimension is refused as
                # "no M:1 path" while the resolver happily joins it.
                alias = str(j.get("alias") or "").strip()
                targets = [to] + ([alias] if alias and alias != to else [])
                # CARDINALITY first (canonical Phase-1 field the resolver reads);
                # legacy `relationship` only as fallback. Same vocabulary as the
                # resolver's canonical alias table, but an UNKNOWN value gives no
                # edge here (strict: never guessed M:1 — the caller fails loud).
                card = contract.cardinality
                for tgt in targets:
                    if card == "many_to_one":
                        _link(frm, tgt)
                    elif card == "one_to_one":
                        _link(frm, tgt)
                        _link(tgt, frm)
                    elif card == "one_to_many":
                        _link(tgt, frm)
                # many_to_many / unknown → no non-fanning edge (fail-loud upstream)

        cache[model_id] = adj
        return adj

    def _m1_reachable_views(self, fact: str) -> set[str]:
        """Views NON-FANNING-reachable from ``fact`` (transitively) over the
        canonical :meth:`_non_fanning_adjacency` graph — every hop maps a
        ``fact`` row to a SINGLE target row.

        A group dimension on such a view is safe to aggregate ``fact``'s
        measures by, including SNOWFLAKE dims (sales → product → category, all
        many-to-one) and a 1:1 partner in EITHER draw direction. A dimension on
        ANOTHER FACT (reachable only via a 1:N / chasm hop) is NOT reached, so
        the caller fails loud instead of fanning out.

        Name kept for back-compat (all consumers call it); the semantics are now
        cardinality-symmetric for 1:1 rather than authored-direction-only.
        """
        adj = self._non_fanning_adjacency()
        seen: set[str] = {fact}
        frontier: list[str] = [fact]
        while frontier:
            cur = frontier.pop()
            for nxt in adj.get(cur, ()):  # non-fanning neighbours only
                if nxt not in seen:
                    seen.add(nxt)
                    frontier.append(nxt)
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

        Division in the author's text is TRUE division with a NULL zero
        denominator on every engine (semantic_arithmetic) — rewritten here,
        before any placeholder is substituted.
        """
        rendered = normalize_division(template, self.database_type).replace("${TABLE}", view_alias)
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
