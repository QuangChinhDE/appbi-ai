"""Regression tests locking the PowerBI-parity semantic contract.

These pin the invariants hardened in the 2026-06-02 contract-lock pass so they
cannot silently regress:

  • Metric identity — a metric with NO explicit aggregation defers to the
    field's DECLARED type (percent_of_total / count_distinct / …), it is NOT
    clobbered to SUM (the bug that made a "% of total" measure render raw sums).
  • Dropped-filter policy — a complete filter the engine can't apply fails
    LOUD (hard reasons); incomplete-input / public-link-policy drops are
    tolerated (soft reasons).
  • Single resolver — bare-ref resolution lives ONLY in the engine and fails
    loud on ambiguous / unknown; AmbiguousFieldError is a ValueError so the
    chart-data endpoints map it to HTTP 400.
  • Cross-table measure grain — a dataset-scope measure that aggregates a
    column from another view is evaluated at THAT view's grain, not its
    declared (base) view.

Unit-level: hand-built views, no DB / no BigQuery — runnable anywhere.
"""
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ.setdefault("DATABASE_URL", "sqlite:///./test_locked_contract.db")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.chart_contracts import (  # noqa: E402
    HARD_FILTER_DROP_REASONS,
    FILTER_DROP_BINDING_UNSUPPORTED,
    FILTER_DROP_DATASET_MISMATCH,
    FILTER_DROP_EMPTY_VALUE,
    FILTER_DROP_LINK_HIDDEN,
    FILTER_DROP_NO_FIELD,
    FILTER_DROP_NOT_IN_PUBLIC_WHITELIST,
    FILTER_DROP_UNKNOWN_FIELD,
    FILTER_DROP_UNREACHABLE_VIEW,
    FILTER_DROP_UNSUPPORTED_OPERATOR,
    enforce_no_hard_dropped_filters,
    normalize_metric_config,
)
from app.services.semantic_query_engine import (  # noqa: E402
    AmbiguousFieldError,
    SemanticQueryEngine,
)
from app.services.semantic_query_compiler import (  # noqa: E402
    SemanticQuerySpec,
    classify_semantic_roles,
    compile_from_semantic_request,
    is_declared_measure_ref,
)
from app.services.chart_service import _apply_bubble_label_aggregation  # noqa: E402
from app.services.live_query_service import build_live_agg_query  # noqa: E402


# ── Metric identity: a no-agg metric defers to the declared type ──────────
def test_metric_no_agg_defaults_to_auto_not_sum():
    # dict + string forms both default to "auto" (engine then uses the
    # measure's stored type, or SUM only for a bare numeric column).
    assert normalize_metric_config({"field": "orders.pct_total"})["agg"] == "auto"
    assert normalize_metric_config("orders.pct_total")["agg"] == "auto"


def test_metric_explicit_agg_is_preserved():
    assert normalize_metric_config({"field": "x", "agg": "count_distinct"})["agg"] == "count_distinct"
    assert normalize_metric_config({"field": "x", "agg": "percent_of_total"})["agg"] == "percent_of_total"


def test_metric_unknown_agg_falls_back_to_auto():
    # An unrecognised agg must NOT silently become SUM; it falls back to the
    # default ("auto") so the declared type still wins downstream.
    assert normalize_metric_config({"field": "x", "agg": "bogus"})["agg"] == "auto"


def test_fe_seed_aggs_survive_normalization():
    # The Explore editor's metricAggFor() (frontend ExploreEditor.tsx) seeds a
    # new metric's agg from the field KIND: a declared MEASURE -> "auto" (defer
    # to its declared type, NEVER hardcode SUM), a numeric column -> "sum",
    # otherwise -> "count_distinct". The frontend has no JS test runner, so we
    # lock the BE half of that contract here: each seed outcome must survive
    # normalize_metric_config unchanged. (The bug this guards: the FE once
    # hardcoded agg:'sum' for the auto-seed, so a %/count/window MEASURE charted
    # as raw SUM — see test_metric_no_agg_defaults_to_auto_not_sum.)
    assert normalize_metric_config({"field": "rev.total_revenue", "agg": "auto"})["agg"] == "auto"
    assert normalize_metric_config({"field": "rev.amount", "agg": "sum"})["agg"] == "sum"
    assert normalize_metric_config({"field": "rev.region", "agg": "count_distinct"})["agg"] == "count_distinct"
    # A measure seeded WITHOUT an explicit agg must still default to "auto".
    assert normalize_metric_config({"field": "rev.total_revenue"})["agg"] == "auto"


# ── Dropped-filter policy (strict fail-loud) ──────────────────────────────
def test_hard_filter_drop_reason_set_is_exact():
    # PBI parity (2026-06): UNREACHABLE_VIEW is intentionally NOT hard — a
    # filter on a table unrelated to the visual is IGNORED (and surfaced as a
    # structured drop), never a 400. See test_unreachable_view_is_tolerated.
    assert HARD_FILTER_DROP_REASONS == frozenset({
        FILTER_DROP_UNKNOWN_FIELD,
        FILTER_DROP_DATASET_MISMATCH,
        FILTER_DROP_BINDING_UNSUPPORTED,
        FILTER_DROP_UNSUPPORTED_OPERATOR,
    })
    assert FILTER_DROP_UNREACHABLE_VIEW not in HARD_FILTER_DROP_REASONS


@pytest.mark.parametrize("reason", sorted(HARD_FILTER_DROP_REASONS))
def test_hard_dropped_filter_fails_loud(reason):
    with pytest.raises(ValueError):
        enforce_no_hard_dropped_filters([{"field": "f", "reason": reason}])


@pytest.mark.parametrize("reason", [
    FILTER_DROP_NO_FIELD,
    FILTER_DROP_EMPTY_VALUE,
    FILTER_DROP_NOT_IN_PUBLIC_WHITELIST,
    FILTER_DROP_LINK_HIDDEN,
])
def test_soft_dropped_filter_is_tolerated(reason):
    # Must NOT raise — incomplete input / by-design public-link policy.
    enforce_no_hard_dropped_filters([{"field": "f", "reason": reason}])


def test_unreachable_view_is_tolerated():
    # PBI parity (2026-06): a filter whose table has no relationship path to
    # the visual's base must NOT raise — PowerBI ignores it. The engine still
    # records it in `_debug.dropped_filters` (visible skip-badge), so it is
    # ignored, never silent. This locks the demotion from HARD → soft.
    enforce_no_hard_dropped_filters([{"field": "dim_x.col", "reason": FILTER_DROP_UNREACHABLE_VIEW}])


def test_no_dropped_filters_is_tolerated():
    enforce_no_hard_dropped_filters([])
    enforce_no_hard_dropped_filters(None)


def test_mixed_drops_fail_loud_if_any_hard():
    with pytest.raises(ValueError):
        enforce_no_hard_dropped_filters([
            {"field": "ok", "reason": FILTER_DROP_EMPTY_VALUE},
            {"field": "bad", "reason": FILTER_DROP_UNKNOWN_FIELD},
        ])


# ── Single resolver: bare-ref resolution + fail-loud ──────────────────────
def test_ambiguous_field_error_is_value_error():
    # The chart-data endpoints catch ValueError -> HTTP 400; AmbiguousFieldError
    # must inherit from it so an ambiguous bare ref surfaces as 400 (not 500).
    assert issubclass(AmbiguousFieldError, ValueError)


def _engine(views):
    eng = SemanticQueryEngine(db=None)  # type: ignore[arg-type]
    eng.views_cache = views
    return eng


def test_parse_field_ref_qualified_passes_through():
    assert _engine({})._parse_field_ref("orders.amount") == ("orders", "amount")


def test_parse_field_ref_bare_unique_resolves_deterministically():
    eng = _engine({"orders": SimpleNamespace(dimensions=[{"name": "amount"}], measures=[])})
    assert eng._parse_field_ref("amount") == ("orders", "amount")


def test_parse_field_ref_bare_ambiguous_fails_loud():
    eng = _engine({
        "a": SimpleNamespace(dimensions=[{"name": "src"}], measures=[]),
        "b": SimpleNamespace(dimensions=[{"name": "src"}], measures=[]),
    })
    with pytest.raises(AmbiguousFieldError):
        eng._parse_field_ref("src")


def test_parse_field_ref_bare_unknown_fails_loud():
    eng = _engine({"orders": SimpleNamespace(dimensions=[], measures=[])})
    with pytest.raises(ValueError):
        eng._parse_field_ref("nope")


# ── Cross-table measure grain = its source-column view ────────────────────
def test_measure_fact_view_cross_table_uses_source_view():
    eng = _engine({
        "deal": SimpleNamespace(
            measures=[{
                "name": "tot_rev", "type": "sum", "scope": "dataset",
                "source_columns": [{"view": "revenue", "field": "amount"}],
            }],
            dimensions=[],
        ),
    })
    # Aggregates revenue.amount although declared on `deal` → grain is `revenue`.
    assert eng._measure_fact_view("deal.tot_rev") == "revenue"


def test_measure_fact_view_same_view_measure_unchanged():
    eng = _engine({
        "deal": SimpleNamespace(
            measures=[{"name": "cnt", "type": "count", "scope": "view"}],
            dimensions=[],
        ),
    })
    assert eng._measure_fact_view("deal.cnt") == "deal"


# ── Pivot agg semantics: 'auto' defers to the stored type; avg/min/max use
#    ELSE NULL (not 0); a window measure fails loud (not a silent SUM) ─────────
def _pivot_engine():
    return _engine({
        "rev": SimpleNamespace(
            name="rev", sql_table_name="rev",
            measures=[
                {"name": "cnt", "type": "count", "sql": "*"},
                {"name": "avg_amt", "type": "avg", "sql": "${TABLE}.amount"},
                {"name": "min_amt", "type": "min", "sql": "${TABLE}.amount"},
                {"name": "max_amt", "type": "max", "sql": "${TABLE}.amount"},
                {"name": "pct", "type": "percent_of_total", "sql": "${TABLE}.amount"},
            ],
            dimensions=[{"name": "amount"}],
        ),
        "cal": SimpleNamespace(
            name="cal", sql_table_name="cal",
            measures=[], dimensions=[{"name": "yr"}],
        ),
    })


def _pivot(field, agg):
    return _pivot_engine()._render_pivoted_measure("rev." + field, "cal.yr", "2025", agg_override=agg)


def test_pivoted_count_measure_auto_is_count_not_sum():
    # COUNT-via-pivot = SUM of 1s; pre-fix 'auto' summed the column expression.
    out = _pivot("cnt", "auto")
    assert out.strip().startswith("SUM(") and "THEN 1 ELSE 0 END" in out


def test_pivoted_avg_measure_auto_is_avg_with_else_null():
    # AVG must ignore non-matching rows (ELSE NULL); ELSE 0 drags the mean down.
    out = _pivot("avg_amt", "auto")
    assert out.strip().startswith("AVG(") and "ELSE NULL END" in out
    assert "ELSE 0 END" not in out


def test_pivoted_min_max_measure_auto_uses_else_null():
    # ELSE 0 would inject a spurious 0 into MIN(positives) / MAX(negatives).
    for field, fn in (("min_amt", "MIN"), ("max_amt", "MAX")):
        out = _pivot(field, "auto")
        assert out.strip().startswith(f"{fn}(") and "ELSE NULL END" in out
        assert "ELSE 0 END" not in out


def test_pivoted_percent_of_total_fails_loud_not_silent_sum():
    # A window measure has no per-cell pivot CASE — must raise, not silently SUM.
    with pytest.raises(ValueError):
        _pivot("pct", "auto")


def test_pivoted_measure_explicit_agg_still_honoured():
    # An explicit, recognised override still wins (parity with _render_measure).
    assert _pivot("avg_amt", "sum").strip().startswith("SUM(")


# ── FE metric-identity contract (structural guard) ──────────────────────────
# The 'auto' (defer-to-declared-type) contract also lives in the frontend, which
# has no JS test runner. We structurally assert the seed/normalize sites default
# to 'auto', not 'sum'. Runs on the CI runner (frontend/ is checked out — the
# workflow now triggers on frontend/src/components/explore/** too); SKIPS inside
# the backend container (frontend/ absent there).
def _fe_source(rel_path: str) -> str:
    p = Path(__file__).resolve().parents[2] / "frontend" / "src" / rel_path
    if not p.exists():
        pytest.skip(f"frontend/ not present ({p}) — FE structural guard runs on the CI runner")
    return p.read_text(encoding="utf-8")


def _fn_body(src: str, signature: str) -> str:
    i = src.find(signature)
    assert i != -1, f"{signature!r} not found — FE refactor? update this guard"
    rest = src[i + len(signature):]
    end = len(rest)
    for marker in ("\nexport function ", "\nexport const ", "\nexport default "):
        j = rest.find(marker)
        if j != -1:
            end = min(end, j)
    return rest[:end]


def test_fe_normalize_metric_config_defaults_to_auto_not_sum():
    body = _fn_body(
        _fe_source("components/explore/ExploreChartConfig.tsx"),
        "export function normalizeMetricConfig",
    )
    assert "'auto'" in body, "normalizeMetricConfig must default a missing/string agg to 'auto'"
    # The code patterns (not the explanatory comment, which mentions the word).
    assert "agg: 'sum'" not in body and "?? 'sum'" not in body, (
        "normalizeMetricConfig regressed to a 'sum' default — that clobbers a declared "
        "measure's type (percent_of_total/count_distinct) before the BE sees it"
    )


def test_fe_explore_editor_metric_agg_for_seeds_measure_auto():
    # metricAggFor seeds a declared measure as 'auto' (and still 'sum' for a raw
    # numeric col — so we assert only that the 'auto'/measure branch is present).
    body = _fn_body(_fe_source("components/explore/ExploreEditor.tsx"), "metricAggFor")
    assert "'auto'" in body and "measure" in body, (
        "ExploreEditor.metricAggFor must seed a declared measure as 'auto'"
    )


# ── Phase 1: SemanticQueryCompiler — single role classifier + spec/run ──────
# The compiler is built parity-first: classify_semantic_roles must reproduce
# the chart path (push_dim/_is_declared_measure/push_metric, post-audit-6) and
# the preview path (reclassify all dims) EXACTLY, so paths rewire with no
# behaviour change.
_MFIELDS = {"dataset_table_193.total_revenue", "dataset_table_188.avg_kpi"}
_MBARE = {"total_revenue", "avg_kpi"}


def test_classify_chart_scatter_reclassifies_only_measure_axis():
    # Chart: strict dims (crm_name) stay; scatter axes (reclassifiable) — a
    # declared measure → measure, a raw col (kpi) → dimension.
    dims, measures, aggs = classify_semantic_roles(
        strict_dims=["dataset_table_188.crm_name"],
        reclassifiable_dims=["dataset_table_193.total_revenue", "dataset_table_188.kpi"],
        metrics=[],
        measure_fields=_MFIELDS, measure_bare_names=_MBARE,
    )
    assert dims == ["dataset_table_188.crm_name", "dataset_table_188.kpi"]
    assert measures == ["dataset_table_193.total_revenue"]
    assert aggs == {}


def test_classify_strict_dim_measure_is_NOT_reclassified():
    # A declared measure wrongly placed in a STRICT dim slot stays a dimension
    # (engine fails loud later) — the audit-6 narrowing, locked.
    dims, measures, _ = classify_semantic_roles(
        strict_dims=["dataset_table_193.total_revenue"],
        reclassifiable_dims=[], metrics=[],
        measure_fields=_MFIELDS, measure_bare_names=_MBARE,
    )
    assert dims == ["dataset_table_193.total_revenue"] and measures == []


def test_classify_preview_reclassifies_all_dims_incl_bare():
    # Preview flattens everything into reclassifiable dims; declared measures
    # (qualified OR bare) move to measures.
    dims, measures, _ = classify_semantic_roles(
        strict_dims=[],
        reclassifiable_dims=["dataset_table_188.crm_name", "dataset_table_193.total_revenue", "total_revenue"],
        metrics=[],
        measure_fields=_MFIELDS, measure_bare_names=_MBARE,
    )
    assert dims == ["dataset_table_188.crm_name"]
    assert measures == ["dataset_table_193.total_revenue", "total_revenue"]


def test_classify_metrics_carry_agg_overrides():
    _, measures, aggs = classify_semantic_roles(
        strict_dims=[], reclassifiable_dims=[],
        metrics=[("dataset_table_193.amount", "SUM"), ("dataset_table_193.total_revenue", None)],
        measure_fields=_MFIELDS, measure_bare_names=_MBARE,
    )
    assert measures == ["dataset_table_193.amount", "dataset_table_193.total_revenue"]
    assert aggs == {"dataset_table_193.amount": "sum"}  # lowered; None → no override


def test_classify_metrics_precede_reclassified_measures():
    # Explicit metrics must come BEFORE a declared measure reclassified out of a
    # dim slot (chart: push_metric then legacy_selected; preview: explicit then
    # reclassified). measures[0] drives KPI / response shaping.
    _, measures, _ = classify_semantic_roles(
        strict_dims=[],
        reclassifiable_dims=["dataset_table_188.avg_kpi"],
        metrics=[("dataset_table_193.total_revenue", None)],
        measure_fields=_MFIELDS, measure_bare_names=_MBARE,
    )
    assert measures == ["dataset_table_193.total_revenue", "dataset_table_188.avg_kpi"]


def test_is_declared_measure_ref_qualified_and_bare():
    assert is_declared_measure_ref("dataset_table_193.total_revenue", _MFIELDS, _MBARE)
    assert is_declared_measure_ref("total_revenue", _MFIELDS, _MBARE)       # bare
    assert not is_declared_measure_ref("dataset_table_193.amount", _MFIELDS, _MBARE)
    assert not is_declared_measure_ref("dataset_table_193.title", _MFIELDS, _MBARE)


def _identity_ref(value):
    return str(value or "").strip()


def test_bubble_label_aggregation_removes_stale_timefield_from_group_grain():
    dims, measures, aggs = _apply_bubble_label_aggregation(
        chart_type="BUBBLE",
        role_config={
            "dimension": "sales.customer_name",
            "timeField": "sales.transaction_month",
            "scatterX": "sales.revenue",
            "scatterY": "sales.profit",
            "scatterXAgg": "sum",
            "scatterYAgg": "sum",
        },
        dimension_refs=[
            "sales.customer_name",
            "sales.transaction_month",
            "sales.revenue",
            "sales.profit",
        ],
        measure_refs=["sales.quantity"],
        agg_overrides={"sales.quantity": "sum"},
        qualify=_identity_ref,
    )

    assert dims == ["sales.customer_name"]
    assert measures == ["sales.quantity", "sales.revenue", "sales.profit"]
    assert aggs == {
        "sales.quantity": "sum",
        "sales.revenue": "sum",
        "sales.profit": "sum",
    }
    # This mirrors chart_service's active-dimension filter for time_grains:
    # stale timeField must not be forwarded, or SQL groups by Label + Month.
    raw_time_grains = {"sales.transaction_month": "month"}
    active_time_grains = {k: v for k, v in raw_time_grains.items() if k in set(dims)}
    assert active_time_grains == {}


def test_nine_box_keeps_categorical_axis_but_drops_stale_timefield():
    dims, measures, aggs = _apply_bubble_label_aggregation(
        chart_type="NINE_BOX",
        role_config={
            "dimension": "employee.name",
            "timeField": "employee.snapshot_month",
            "scatterX": "employee.performance_band",
            "scatterY": "employee.potential_score",
            "scatterYAgg": "avg",
        },
        dimension_refs=[
            "employee.name",
            "employee.snapshot_month",
            "employee.performance_band",
            "employee.potential_score",
        ],
        measure_refs=[],
        agg_overrides={},
        qualify=_identity_ref,
    )

    assert dims == ["employee.name", "employee.performance_band"]
    assert measures == ["employee.potential_score"]
    assert aggs == {"employee.potential_score": "avg"}


def test_bubble_keeps_date_label_when_label_is_timefield():
    dims, measures, aggs = _apply_bubble_label_aggregation(
        chart_type="BUBBLE",
        role_config={
            "dimension": "sales.month",
            "timeField": "sales.month",
            "scatterX": "sales.revenue",
            "scatterY": "sales.margin",
        },
        dimension_refs=["sales.month", "sales.revenue", "sales.margin"],
        measure_refs=[],
        agg_overrides={},
        qualify=_identity_ref,
    )

    assert dims == ["sales.month"]
    assert measures == ["sales.revenue", "sales.margin"]
    assert aggs == {"sales.revenue": "sum", "sales.margin": "sum"}


def test_live_bubble_query_aggregates_numeric_marks_at_label_grain():
    sql, pre_aggregated = build_live_agg_query(
        base_table="sales",
        chart_type="BUBBLE",
        role_config={
            "dimension": "customer_name",
            "timeField": "transaction_month",
            "scatterX": "revenue",
            "scatterY": "profit",
            "scatterXAgg": "sum",
            "scatterYAgg": "sum",
            "metrics": [{"field": "quantity", "agg": "sum"}],
        },
        filters=[],
        dialect="postgresql",
    )

    assert pre_aggregated is True
    assert 'SUM("revenue") AS "revenue"' in sql
    assert 'SUM("profit") AS "profit"' in sql
    assert 'SUM("quantity") AS "sum__quantity"' in sql
    assert 'GROUP BY "customer_name"' in sql
    assert '"transaction_month"' not in sql


def test_live_scatter_query_stays_raw_rows():
    sql, pre_aggregated = build_live_agg_query(
        base_table="sales",
        chart_type="SCATTER",
        role_config={
            "dimension": "customer_name",
            "scatterX": "revenue",
            "scatterY": "profit",
            "metrics": [{"field": "quantity", "agg": "sum"}],
        },
        filters=[],
        dialect="postgresql",
    )

    assert pre_aggregated is False
    assert 'GROUP BY' not in sql
    assert 'SUM("revenue")' not in sql
    assert sql.startswith('SELECT "revenue", "profit", "customer_name", "quantity" FROM sales')


def test_live_nine_box_keeps_categorical_axis_in_group_grain():
    sql, pre_aggregated = build_live_agg_query(
        base_table="employees",
        chart_type="NINE_BOX",
        role_config={
            "dimension": "employee_name",
            "timeField": "snapshot_month",
            "scatterX": "performance_band",
            "scatterY": "potential_score",
            "scatterYAgg": "avg",
        },
        filters=[],
        dialect="postgresql",
    )

    assert pre_aggregated is True
    assert 'AVG("potential_score") AS "potential_score"' in sql
    assert 'GROUP BY "employee_name", "performance_band"' in sql
    assert '"snapshot_month"' not in sql


def test_compile_from_semantic_request_passes_through():
    req = SimpleNamespace(
        explore="rev", dimensions=["dataset_table_193.bc_key"], measures=["dataset_table_193.total_revenue"],
        filters={}, sorts=[], window_functions=[], calculated_fields=[], time_grains={},
        pivots=[], top_n=None, limit=100, measure_agg_overrides={"dataset_table_193.total_revenue": "auto"},
        model_id=56,
    )
    spec = compile_from_semantic_request(req)
    assert spec.explore_name == "rev"
    assert spec.dimensions == ["dataset_table_193.bc_key"]
    assert spec.measures == ["dataset_table_193.total_revenue"]
    assert spec.measure_agg_overrides == {"dataset_table_193.total_revenue": "auto"}
    assert spec.limit == 100
    assert spec.model_id == 56  # M2: model binding flows through (PBI-style)


def test_engine_run_maps_spec_to_generate_sql():
    eng = _engine({})
    captured: dict = {}
    eng.generate_sql = lambda **kw: captured.update(kw) or ("SQL", [], [])  # type: ignore
    spec = SemanticQuerySpec(
        explore_name="rev",
        dimensions=["d"], measures=["m"], measure_agg_overrides={"m": "auto"},
        filters={"f": {"operator": "eq", "value": 1}}, time_grains={"d": "month"},
        pivots=["p"], limit=None, model_id=56, explore_id=7,
    )
    sql, _, _ = eng.run(spec)
    assert sql == "SQL"
    assert captured["explore_name"] == "rev"
    assert captured["dimensions"] == ["d"] and captured["measures"] == ["m"]
    assert captured["measure_agg_overrides"] == {"m": "auto"}
    assert captured["time_grains"] == {"d": "month"} and captured["pivots"] == ["p"]
    assert captured["model_id"] == 56 and captured["explore_id"] == 7
    assert captured["limit"] == 10_000_000  # None → engine's NO-LIMIT sentinel


def test_engine_run_empty_agg_overrides_is_none():
    eng = _engine({})
    captured: dict = {}
    eng.generate_sql = lambda **kw: captured.update(kw) or ("", [], [])  # type: ignore
    eng.run(SemanticQuerySpec(explore_name="x"))
    assert captured["measure_agg_overrides"] is None  # empty dict → None (matches callers)


# ── Phase 6: grain validator (fail-loud the chasm group-by) ─────────────────
def _grain_engine():
    eng = _engine({
        "rev": SimpleNamespace(
            measures=[{"name": "amt", "type": "sum", "sql": "amount"}],
            dimensions=[], name="rev",
        ),
        "deal": SimpleNamespace(measures=[], dimensions=[{"name": "title"}], name="deal"),
        "owner": SimpleNamespace(measures=[], dimensions=[{"name": "crm_name"}], name="owner"),
    })
    return eng


def test_grain_validator_raises_on_chasm_dim():
    # rev.amt grouped by deal.title where deal is NOT M:1-reachable from rev
    # (chasm) → fail loud (no fan-out number).
    eng = _grain_engine()
    eng._m1_reachable_views = lambda fact: set()  # nothing reachable from rev
    with pytest.raises(ValueError):
        eng._validate_group_grain(["deal.title"], [], ["rev.amt"])


def test_grain_validator_ok_when_dim_reachable():
    # rev.amt grouped by owner.crm_name where owner IS M:1-reachable → no raise.
    eng = _grain_engine()
    eng._m1_reachable_views = lambda fact: {"owner"}
    eng._validate_group_grain(["owner.crm_name"], [], ["rev.amt"])


def test_grain_validator_ok_for_dim_on_measure_own_fact():
    # A dim on the measure's OWN fact is always safe (no JOIN).
    eng = _grain_engine()
    eng._m1_reachable_views = lambda fact: set()
    eng._validate_group_grain(["rev.amt"], [], ["rev.amt"])  # V == fact → safe


def test_grain_validator_noop_without_group_dims():
    # KPI (no group dims/pivots) → no-op, never raises.
    _grain_engine()._validate_group_grain([], [], ["rev.amt"])


def test_measure_fact_view_multi_source_stays_declared():
    # A true multi-table formula (2+ foreign source views) is NOT a single
    # re-anchorable grain → keep the declared view (formula renderer handles it).
    eng = _engine({
        "deal": SimpleNamespace(
            measures=[{
                "name": "ratio", "type": "sum", "scope": "dataset",
                "source_columns": [
                    {"view": "revenue", "field": "amount"},
                    {"view": "lead", "field": "id"},
                ],
            }],
            dimensions=[],
        ),
    })
    assert eng._measure_fact_view("deal.ratio") == "deal"
