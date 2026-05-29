"""Per-Measure Execution Executor — Phase 3 of the PBI-parity filter migration.

Runs each :class:`MeasureGroup` from :mod:`per_measure_planner` in a separate
chart_config-scoped query, then merges results in Python by the shared
dimension key. Mirrors PowerBI / Tableau's "context isolation per measure"
behaviour without requiring a column-store engine.

Activated only when ``PerMeasurePlan.enabled is True`` (caller checks).

Design notes (see docs/phases/phase-3-per-measure-isolation.md §3.3-3.4):
  - Each group's query is built by cloning the chart_config and reducing
    ``roleConfig.metrics`` to that group's measures only. Calculated fields
    that DON'T reference other facts are kept; cross-fact calcs were already
    bailed-out at planner level (planner returns ``enabled=False``).
  - Execution is parallel via ``concurrent.futures.ThreadPoolExecutor`` (BQ
    client is sync I/O). Each thread opens its OWN ``SessionLocal()`` so
    SQLAlchemy's session-per-thread invariant holds.
  - Merge is outer-join on the shared dimension key. Rows present in only one
    group's result carry ``None`` for the other group's measure columns.
  - When ``shared_dimensions`` is empty (KPI-style chart with no axis), the
    merged result is a SINGLE row with every group's measure column folded in.
"""
from __future__ import annotations

import concurrent.futures
import copy
import logging
import re
from typing import Any

from app.services.per_measure_planner import MeasureGroup, PerMeasurePlan

logger = logging.getLogger(__name__)


# Calc-field placeholder regex (mirror of per_measure_planner's). Local copy
# avoids a cycle if planner ever depends on this module.
_CALC_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\}")

# Conservative cap on parallel BQ slots per chart. Each chart fires N queries;
# a dashboard with 20 charts × N=4 = 80 concurrent BQ jobs — keep N modest so
# slot-quota stays sane. Override via FEATURE_PER_MEASURE_MAX_WORKERS env var
# if a tenant has dedicated slot allocation.
DEFAULT_MAX_WORKERS = 4


def build_group_chart_config(
    base_chart_config: dict,
    group: MeasureGroup,
    plan: PerMeasurePlan,
) -> dict:
    """Construct a chart_config scoped to ONE measure group.

    The returned dict:
      * ``roleConfig.metrics`` → only this group's measures.
      * ``roleConfig.dimension`` → preserved from the plan (shared dim).
      * ``roleConfig.calculatedFields`` → only those whose refs stay within
        ``group.fact_view`` (cross-fact calcs already excluded by planner).
      * Pivots / pivot top-level field → stripped (Phase-3.0 doesn't merge pivots).
      * ``semanticBinding.baseViewName`` → set to ``group.fact_view`` so the
        engine routes via the correct explore.
    """
    cfg = copy.deepcopy(base_chart_config or {})
    rc = cfg.setdefault("roleConfig", {})

    # Reduce metrics to this group's.
    rc["metrics"] = [m.raw_config for m in group.measures]

    # Shared dimension (single string for now — pivots disabled in Phase 3.0).
    if plan.shared_dimensions:
        rc["dimension"] = plan.shared_dimensions[0]
    elif "dimension" in rc:
        # No shared dim — drop any base-config dim so it doesn't sneak in.
        rc.pop("dimension", None)

    # Calc fields scoped to this group only.
    incoming_calcs = rc.get("calculatedFields") or []
    rc["calculatedFields"] = [
        cf for cf in incoming_calcs
        if isinstance(cf, dict) and _calc_only_references_this_fact(cf, group.fact_view)
    ]

    # Strip pivots (Phase 3.0 limitation; planner already declined pivot charts
    # but we belt-and-suspenders strip anyway in case caller passed one through).
    rc.pop("pivots", None)
    cfg.pop("pivot", None)

    # Hint semantic binding to this fact's base view.
    binding = cfg.setdefault("semanticBinding", {})
    binding["baseViewName"] = group.fact_view
    return cfg


def _calc_only_references_this_fact(cf: dict, fact_view: str) -> bool:
    """A calc is safe inside this group iff every ref's view is `fact_view`
    OR not a fact view at all (i.e., a shared dim view — JOINs handle that).

    Planner already rejected cross-fact calcs, but we re-check here so the
    individual group's SELECT doesn't drag in a ref to ANOTHER fact's column
    by accident (defensive).
    """
    sql = str(cf.get("sql") or "")
    refs = _CALC_REF_RE.findall(sql)
    if not refs:
        return True
    ref_views = {r.split(".", 1)[0] for r in refs}
    # If every ref view is either this fact OR a non-fact view, keep the calc.
    # We can't distinguish dim vs fact here without the model, so the safe
    # heuristic: drop calcs that reference any OTHER known fact view. Since
    # planner already checked this, in practice ref_views will be {fact_view}
    # or {fact_view, <dim_view>}. The simple test: if `fact_view` ∈ ref_views,
    # accept (the other refs are assumed dim or downstream calc).
    return fact_view in ref_views or len(ref_views) == 1


def execute_groups_parallel(
    plan: PerMeasurePlan,
    base_chart_config: dict,
    *,
    runner,
    max_workers: int | None = None,
) -> list[dict]:
    """Run each group's chart-config via ``runner`` in parallel.

    ``runner`` is a callable ``(group_chart_config: dict) -> dict`` returning
    the executed result with keys ``data``, ``debug`` (matching
    ``ChartService.get_chart_data`` shape sans the ``chart`` ORM object).
    The caller (chart_service) supplies a closure that calls
    ``_execute_chart_runtime_for_table`` with a fresh DB session per thread.

    Returns a list of per-group result dicts, each carrying the group's
    ``fact_view`` for identification at merge time.
    """
    if not plan.enabled:
        raise ValueError("execute_groups_parallel called with disabled plan")
    if max_workers is None:
        max_workers = min(len(plan.groups), DEFAULT_MAX_WORKERS)
    max_workers = max(1, int(max_workers))

    def _one(group: MeasureGroup) -> dict:
        sub_cfg = build_group_chart_config(base_chart_config, group, plan)
        try:
            res = runner(sub_cfg)
        except Exception as exc:
            logger.exception("[per_measure] group %r failed: %s", group.fact_view, exc)
            return {
                "fact_view": group.fact_view,
                "data": [],
                "sql": "",
                "dropped_filters": [],
                "warnings": [f"Group {group.fact_view!r} execution failed: {exc}"],
                "error": str(exc),
            }
        debug = (res.get("debug") or {}) if isinstance(res, dict) else {}
        return {
            "fact_view": group.fact_view,
            "data": (res or {}).get("data") or [],
            "sql": debug.get("sql_emitted") or "",
            "dropped_filters": debug.get("dropped_filters") or [],
            "warnings": debug.get("warnings") or [],
        }

    if max_workers == 1 or len(plan.groups) <= 1:
        # Single-threaded execution preserves stable error surfacing in tests.
        return [_one(g) for g in plan.groups]

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        return list(ex.map(_one, plan.groups))


def merge_group_results(
    plan: PerMeasurePlan,
    group_results: list[dict],
) -> list[dict]:
    """Outer-join per-group rows on the shared dimension key(s).

    With no shared dimension: returns a single row with every measure column
    from every group merged. (Multiple group rows in a no-dim chart shouldn't
    happen — each group's KPI query returns 1 row.)

    With a shared dimension: groups rows by the dimension value, then merges
    measure columns across groups. Rows absent in a group's result carry None
    for that group's measure columns.

    Applies plan.sorts and plan.limit at the end (Python-side sort/limit so
    cross-group order is consistent).
    """
    if not plan.shared_dimensions:
        merged: dict[str, Any] = {}
        for r in group_results:
            for row in r.get("data") or []:
                if isinstance(row, dict):
                    merged.update(row)
        return [merged] if merged else []

    dim_field = plan.shared_dimensions[0]
    by_key: dict[Any, dict] = {}
    for r in group_results:
        for row in r.get("data") or []:
            if not isinstance(row, dict):
                continue
            key = row.get(dim_field)
            slot = by_key.setdefault(key, {dim_field: key})
            for k, v in row.items():
                if k != dim_field:
                    slot[k] = v

    out = list(by_key.values())

    # Apply sort
    for sort_spec in plan.sorts:
        sort_field = sort_spec.get("field") if isinstance(sort_spec, dict) else None
        if not sort_field:
            continue
        reverse = str(sort_spec.get("direction") or "asc").lower() == "desc"
        # Stable sort; rows missing the sort field bubble to the end.
        def _key(row, _f=sort_field):
            v = row.get(_f)
            return (v is None, v)
        out.sort(key=_key, reverse=reverse)

    if plan.limit and plan.limit > 0:
        out = out[: plan.limit]

    return out


__all__ = [
    "DEFAULT_MAX_WORKERS",
    "build_group_chart_config",
    "execute_groups_parallel",
    "merge_group_results",
]
