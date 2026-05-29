"""Per-Measure Execution Planner — Phase 3 of the PBI-parity filter migration.

DECISION-ONLY MODULE — does not emit SQL or execute anything.

Given a chart_config and the current extra_filters, decide whether the chart's
measures can be split into PARALLEL per-fact queries (PBI/Tableau style) and
merged in Python. This eliminates fan-out across DIFFERENT facts that share
conformed dimensions — each fact's measure is computed in its own scoped
query, then results are outer-joined on the shared dimension key(s) at
application layer.

Activated behind ``FEATURE_PER_MEASURE_ISOLATION`` (default OFF).

When isolation does NOT apply (single-fact chart, calculated field that
spans multiple fact views, single-measure chart, pivot chart for Phase 3.0),
the planner returns ``PerMeasurePlan(enabled=False, reason=...)`` and the
caller continues with the legacy single-query path.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class MeasureRef:
    """One metric entry in roleConfig.metrics, parsed for routing."""
    field_ref: str          # 'view.measure_name'
    view: str               # parsed view portion
    raw_config: dict        # original entry from roleConfig.metrics


@dataclass(frozen=True)
class MeasureGroup:
    """All measures from a single fact view → one query per group."""
    fact_view: str          # the common view across measures in this group
    measures: tuple[MeasureRef, ...]


@dataclass(frozen=True)
class PerMeasurePlan:
    """Planner output. ``enabled=False`` → caller falls back to legacy path."""
    enabled: bool
    reason: str = ""                              # populated when enabled=False
    groups: tuple[MeasureGroup, ...] = ()         # one entry per fact view
    # Echoed from input so executor doesn't have to re-parse
    shared_dimensions: tuple[str, ...] = ()
    pivots: tuple[str, ...] = ()
    sorts: tuple[dict, ...] = ()
    limit: int | None = None


# Calc-field placeholder regex used by the engine for `${view.field}` refs.
_CALC_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\}")


def plan_per_measure_execution(
    chart_config: dict,
    *,
    feature_enabled: bool,
) -> PerMeasurePlan:
    """Decide whether to split a chart's measures into parallel per-fact queries.

    Disables itself (returns ``enabled=False``) for any of:
      - ``feature_enabled=False`` (the FEATURE_PER_MEASURE_ISOLATION flag is OFF).
      - Chart has fewer than 2 metrics.
      - All metrics come from a single fact view.
      - A metric is unqualified (no ``view.col``).
      - A calculated field references metrics across MORE THAN ONE fact view
        (then the calc can't be evaluated in any per-fact subquery — bail to
        the legacy path so the calc still works).
      - Chart has a pivot (Phase-3.0 limitation; pivots need consistent
        value sets across groups which requires extra merge logic deferred
        to Phase-3.1).
    """
    if not feature_enabled:
        return PerMeasurePlan(enabled=False, reason="feature_flag_off")

    role_config = (chart_config or {}).get("roleConfig") or {}
    metrics = role_config.get("metrics") or []
    if len(metrics) < 2:
        return PerMeasurePlan(enabled=False, reason="single_metric")

    # Pivot charts are not supported in Phase 3.0 — pivot-value reconciliation
    # across per-fact groups requires consistent distinct value sets which is a
    # deeper merge problem. Defer to Phase 3.1.
    pivots = role_config.get("pivots") or []
    if not pivots and chart_config.get("pivot"):
        pivots = [chart_config["pivot"]]
    if pivots:
        return PerMeasurePlan(enabled=False, reason="pivot_chart_unsupported")

    # Parse each metric → MeasureRef; bail on unqualified refs.
    refs: list[MeasureRef] = []
    for m in metrics:
        if not isinstance(m, dict):
            return PerMeasurePlan(enabled=False, reason="invalid_metric_shape")
        f = str(m.get("field") or "").strip()
        if "." not in f:
            return PerMeasurePlan(enabled=False, reason=f"unqualified_metric:{f!r}")
        view, _ = f.split(".", 1)
        refs.append(MeasureRef(field_ref=f, view=view.strip(), raw_config=m))

    # Group metrics by fact view.
    by_view: dict[str, list[MeasureRef]] = {}
    for mr in refs:
        by_view.setdefault(mr.view, []).append(mr)

    if len(by_view) < 2:
        return PerMeasurePlan(enabled=False, reason="single_fact")

    # Calculated-field cross-fact check — a calc that references metrics from
    # multiple fact views can't be evaluated inside any single per-fact query.
    # Bail to legacy path so the calc still works.
    calc_fields = role_config.get("calculatedFields") or []
    cross_dep = _detect_cross_fact_calc_dependency(calc_fields, set(by_view.keys()))
    if cross_dep:
        return PerMeasurePlan(
            enabled=False,
            reason=f"calculated_field_cross_fact_dependency:{cross_dep!r}",
        )

    # Build groups + extract shared dim/sort/limit (echo-only — executor uses these).
    dimension = role_config.get("dimension")
    shared_dims: tuple[str, ...] = (dimension,) if dimension else ()
    sorts_in = role_config.get("sorts") or []
    sorts: tuple[dict, ...] = tuple(s for s in sorts_in if isinstance(s, dict))
    limit = role_config.get("limit")
    if isinstance(limit, str) and limit.isdigit():
        limit = int(limit)
    if not isinstance(limit, int):
        limit = None

    groups = tuple(
        MeasureGroup(fact_view=v, measures=tuple(meas_list))
        for v, meas_list in by_view.items()
    )
    return PerMeasurePlan(
        enabled=True,
        groups=groups,
        shared_dimensions=shared_dims,
        pivots=(),
        sorts=sorts,
        limit=limit,
    )


def _detect_cross_fact_calc_dependency(
    calc_fields: list[dict],
    fact_view_set: set[str],
) -> str | None:
    """If any calculated field references columns from >1 fact view in fact_view_set,
    return that calc field's name. Else None.

    Only counts refs whose VIEW PORTION is in ``fact_view_set`` (i.e., refs to
    shared dims are ignored — those can be JOINed into any group's query).
    """
    for cf in calc_fields or []:
        if not isinstance(cf, dict):
            continue
        sql = str(cf.get("sql") or "")
        if not sql:
            continue
        refs = _CALC_REF_RE.findall(sql)
        views_in_calc = {r.split(".", 1)[0] for r in refs}
        cross_facts = views_in_calc & fact_view_set
        if len(cross_facts) > 1:
            return str(cf.get("name") or "<unnamed>")
    return None


__all__ = [
    "MeasureGroup",
    "MeasureRef",
    "PerMeasurePlan",
    "plan_per_measure_execution",
]
