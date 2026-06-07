"""Single semantic-query compiler (PowerBI-style one-pipeline architecture).

The three callers of ``SemanticQueryEngine.generate_sql`` — the Dashboard /
saved-chart runtime (``chart_service``), the Explore dataset preview
(``api/datasets``), and the direct semantic API (``routers/semantic``) — used to
each classify roles (dimension vs measure) and assemble engine args
independently. That divergence was the structural root of the recurring
"Explore right / Dashboard wrong" class of bugs.

This module is the ONE place that turns any of those inputs into a
``SemanticQuerySpec``; every path then calls ``SemanticQueryEngine.run(spec)``.
Field RESOLUTION stays in the engine (``_parse_field_ref`` — the single
resolver); only ROLE classification (which ref is a dimension vs a measure) and
arg assembly live here.

Built parity-first: ``classify_semantic_roles`` reproduces, exactly, what the
chart path (``push_dim`` / ``_is_declared_measure`` / ``push_metric``, post the
2026-06 audit narrowing) and the preview path (``reclassified_refs``) already
do, so paths can be rewired onto it with ZERO behaviour change.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


# ── The single engine input ─────────────────────────────────────────────────
@dataclass
class SemanticQuerySpec:
    """Normalised, engine-ready query. Fields 1:1 with ``generate_sql`` params,
    plus ``response_aliases`` (output column → friendly key, computed by the
    chart path) and ``diagnostics`` (dropped-filter / warning records the caller
    surfaces). The datasource/dialect is NOT here — it is an execution concern
    resolved separately and set on the engine instance."""

    explore_name: str
    dimensions: list[str] = field(default_factory=list)
    measures: list[str] = field(default_factory=list)
    measure_agg_overrides: dict[str, str] = field(default_factory=dict)
    filters: dict[str, Any] = field(default_factory=dict)
    time_grains: dict[str, str] = field(default_factory=dict)
    pivots: list[str] = field(default_factory=list)
    sorts: list[dict] = field(default_factory=list)
    window_functions: list[dict] = field(default_factory=list)
    calculated_fields: list[dict] = field(default_factory=list)
    top_n: Optional[dict] = None
    limit: Optional[int] = None
    model_id: Optional[int] = None
    explore_id: Optional[int] = None
    # Caller-side extras (not engine args):
    response_aliases: dict[str, str] = field(default_factory=dict)
    diagnostics: list[dict] = field(default_factory=list)


# ── The single role classifier (dimension vs measure) ───────────────────────
def is_declared_measure_ref(
    ref: str,
    measure_fields: set[str],
    measure_bare_names: set[str],
) -> bool:
    """True if ``ref`` names a DECLARED semantic measure — qualified
    (``view.measure`` ∈ measure_fields) OR bare (``measure`` ∈ bare-names, no
    dot). Mirrors ``chart_service._is_declared_measure`` and the dataset-execute
    ``declared_measure_refs`` / ``declared_measure_bare_names`` membership test,
    so chart preview == dashboard for a bare measure axis too."""
    if not ref:
        return False
    return ref in measure_fields or ("." not in ref and ref in measure_bare_names)


def classify_semantic_roles(
    *,
    strict_dims: list[str],
    reclassifiable_dims: list[str],
    metrics: list[tuple[str, str | None]],
    measure_fields: set[str],
    measure_bare_names: set[str],
) -> tuple[list[str], list[str], dict[str, str]]:
    """Split refs into (dimensions, measures, agg_overrides) — the SINGLE rule
    every entry path shares.

    - ``strict_dims``: refs that MUST stay dimensions (a declared measure here is
      a role error the engine fails loud on — PowerBI enforces role; we never
      silently change its grain). Chart: dimension/breakdown/timeField/table
      dims. Preview/direct-API: dims the caller already treats as strict.
    - ``reclassifiable_dims``: slots that legitimately accept a measure — a
      declared measure here moves to the measure tier, else stays a dimension.
      Chart: scatterX/scatterY + selectedColumns. Preview: all its dims (the FE
      flattens scatter axes into ``dimensions``, so preview reclassifies them).
    - ``metrics``: explicit ``(ref, agg)`` from metric slots; ``agg`` (lowered)
      becomes a per-ref override when present.

    Order preserved within each bucket; duplicates dropped.
    """
    dimensions: list[str] = []
    measures: list[str] = []
    agg_overrides: dict[str, str] = {}

    def _add_dim(ref: str) -> None:
        if ref and ref not in dimensions:
            dimensions.append(ref)

    def _add_measure(ref: str, agg: str | None = None) -> None:
        if not ref:
            return
        if ref not in measures:
            measures.append(ref)
        if agg:
            agg_overrides[ref] = agg

    # Dimensions: strict slots first, then reclassifiable non-measure slots —
    # matches the chart path (push_dim strict → selectedColumns → scatter) and
    # the preview flat-dims order.
    for ref in strict_dims:
        _add_dim(str(ref or "").strip())
    # Measures: EXPLICIT metrics FIRST, then declared measures reclassified out
    # of dim slots — matches BOTH the chart path (push_metric refs, then
    # legacy_selected_measure_refs appended after) and the preview path
    # (explicit_measure_refs + reclassified_refs). Order matters: response
    # shaping / KPI use measures[0].
    for ref, agg in metrics:
        r = str(ref or "").strip()
        if r:
            _add_measure(r, str(agg or "").strip().lower() or None)
    for ref in reclassifiable_dims:
        r = str(ref or "").strip()
        if not r:
            continue
        if is_declared_measure_ref(r, measure_fields, measure_bare_names):
            _add_measure(r)
        else:
            _add_dim(r)

    return dimensions, measures, agg_overrides


# ── Compile: direct semantic API (routers/semantic) ─────────────────────────
def compile_from_semantic_request(query_request: Any) -> SemanticQuerySpec:
    """Direct ``/semantic/query`` body → spec. This path sends pre-qualified
    refs (MCP/API contract), so there is NO reclassification — dims/measures
    pass through. 1:1 with the args the route currently builds for
    ``generate_sql`` (routers/semantic.py)."""
    filters = {k: (v.model_dump() if hasattr(v, "model_dump") else v)
               for k, v in (query_request.filters or {}).items()}
    sorts = [s.model_dump() if hasattr(s, "model_dump") else s
             for s in (query_request.sorts or [])]
    window_functions = [w.model_dump() if hasattr(w, "model_dump") else w
                        for w in (query_request.window_functions or [])]
    calculated_fields = [c.model_dump() if hasattr(c, "model_dump") else c
                         for c in (query_request.calculated_fields or [])]
    top_n = query_request.top_n.model_dump() if getattr(query_request, "top_n", None) else None
    return SemanticQuerySpec(
        explore_name=query_request.explore,
        dimensions=list(query_request.dimensions or []),
        measures=list(query_request.measures or []),
        measure_agg_overrides=dict(getattr(query_request, "measure_agg_overrides", None) or {}),
        filters=filters,
        time_grains=dict(getattr(query_request, "time_grains", None) or {}),
        pivots=list(getattr(query_request, "pivots", None) or []),
        sorts=sorts,
        window_functions=window_functions,
        calculated_fields=calculated_fields,
        top_n=top_n,
        limit=getattr(query_request, "limit", None),
        model_id=getattr(query_request, "model_id", None),
    )
