"""Filter Propagation Engine — Phase 2 of the PBI-parity filter migration.

Replaces the ad-hoc reachability/binding-set check that decided WHETHER a
filter applies to a chart with an EXPLICIT propagation algorithm modeled on
Power BI's relationship rules:

  - Filter on the chart's own base view  → ``PLAIN`` predicate.
  - Filter on a view reachable via active relationships where every hop
    respects single/both cross_filter direction  → ``JOIN_CHAIN``
    (predicate on the joined alias, view will be JOINed into FROM).
  - Same but the path crosses a 1:N hop AND the target is filter-only
    (not projected as a dimension/measure) → ``EXISTS`` subquery.
  - Same but the target IS projected (dimension on a join that fans out) →
    ``SYMMETRIC`` mode (measure must use symmetric aggregate; Phase 4).
  - No active relationship path from base to filter view → ``DROP``
    with ``reason='unreachable_view'``.
  - Multiple equal-length paths and no role hint to disambiguate → ``DROP``
    with ``reason='ambiguous_path'``.

The engine is purely a *decision* function — it does NOT emit SQL. The
caller (semantic_query_engine._build_where_clause, chart_service filter
normalizer, distinct cascade) uses the result to drive its SQL emission.

Activated behind the ``FEATURE_PROPAGATION_ENGINE_V2`` feature flag
(``app.core.config.Settings``). Default OFF; legacy path stays untouched
until DA-test confirms the new rules don't regress production dashboards.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable

from app.services.semantic_join_resolver import (
    JoinEdge,
    JoinPath,
    SemanticJoinResolver,
)


# ──────────────────────────────────────────────────────────────────────────
# Enums
# ──────────────────────────────────────────────────────────────────────────


class PropagationMode(str, Enum):
    """How the filter should be emitted into SQL.

    Caller responsibility:
      PLAIN       — filter on base view; render predicate against ``base_view_name``.
      JOIN_CHAIN  — view will be JOINed into the FROM chain (it's in the
                    SELECT-side set OR all hops are safely M:1 with no fan-out);
                    render the predicate against the joined alias.
      EXISTS      — view is filter-only AND path crosses ≥1 1:N hop; render
                    as ``EXISTS (SELECT 1 FROM <path> WHERE <correlation> AND <pred>)``.
                    Mirrors the Phase-B' (commit 5f8b7fd) EXISTS rewrite.
      SYMMETRIC   — view IS projected (dimension uses joined view's column)
                    AND path crosses ≥1 1:N hop. Measure(s) on the base view
                    must use symmetric aggregate form (Phase 4).  Filter
                    predicate itself stays plain on the joined alias.
      DROP        — filter cannot propagate per PBI rules. Caller records
                    diagnostic and skips this filter (chart shows unfiltered
                    if no other filters constrain).
    """
    PLAIN = "plain"
    JOIN_CHAIN = "join_chain"
    EXISTS = "exists"
    SYMMETRIC = "symmetric"
    DROP = "drop"


class DropReason(str, Enum):
    """When mode == DROP, why."""
    UNREACHABLE_VIEW = "unreachable_view"           # no active relationship path
    WRONG_DIRECTION = "wrong_direction"             # path blocked by single-direction edges
    AMBIGUOUS_PATH = "ambiguous_path"               # multiple equal-length paths, no role hint
    NO_PRIMARY_KEY = "no_primary_key"               # symmetric needed, view PK undeclared (Phase 4)
    MULTI_ROLE_PICK_REQUIRED = "multi_role_pick_required"  # role-played dim multi-match


# ──────────────────────────────────────────────────────────────────────────
# Result
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PropagationResult:
    """Decision returned by :func:`resolve_filter_propagation`."""
    mode: PropagationMode
    # Resolved path (steps from base to target). None when mode == PLAIN or DROP.
    path: JoinPath | None = None
    # Populated when mode == DROP.
    reason: DropReason | None = None
    detail: str = ""
    # Populated when mode == SYMMETRIC — the views whose measures need symmetric
    # aggregation. Typically just the chart base view.
    symmetric_views: frozenset[str] = field(default_factory=frozenset)
    # Non-fatal observations for the caller to surface to the user (UI banner).
    warnings: tuple[str, ...] = ()


# ──────────────────────────────────────────────────────────────────────────
# Core algorithm
# ──────────────────────────────────────────────────────────────────────────


def resolve_filter_propagation(
    resolver: SemanticJoinResolver,
    base_view_name: str,
    filter_field_ref: str,
    *,
    select_side_views: Iterable[str] | None = None,
    role_hint: str | None = None,
) -> PropagationResult:
    """Decide how a filter on ``filter_field_ref`` propagates to ``base_view_name``.

    Args:
        resolver: a ``SemanticJoinResolver`` built with ``base_node=base_view_name``
            and ``bidirectional=False`` (Phase-1 strict mode). The resolver's
            adjacency reflects only declared forward edges + the synthesised
            reverses for ``cross_filter='both'`` joins.
        base_view_name: the chart's base view (where FROM starts).
        filter_field_ref: ``"view.col"`` or ``"view.col@role"`` (role hint
            appended via ``@`` to pick among multiple role-played joins).
        select_side_views: views that will appear in the FROM chain for SELECT
            purposes (dimensions / measures / pivots). When the resolved target
            view is in this set, ``EXISTS`` rewrite is unavailable (target must
            be JOINed for projection) → engine switches to ``SYMMETRIC`` mode.
            Pass ``None`` to skip this consideration (treats target as filter-only).
        role_hint: explicit role alias to pick when multiple paths exist.
            Overrides ``@role`` parsing in ``filter_field_ref``.

    Returns: ``PropagationResult`` — never raises.
    """
    view_name, _col, parsed_role = _parse_field_ref(filter_field_ref)
    role = role_hint or parsed_role
    select_set = set(select_side_views or [])

    if not view_name:
        return PropagationResult(
            mode=PropagationMode.DROP,
            reason=DropReason.UNREACHABLE_VIEW,
            detail=f"Filter field ref {filter_field_ref!r} not parseable",
        )

    # Self-filter on base — plain predicate, no traversal needed.
    if view_name == base_view_name:
        return PropagationResult(mode=PropagationMode.PLAIN)

    # All shortest paths (resolver enumerates equal-length routes).
    all_paths = resolver.resolve_paths(view_name)
    if not all_paths:
        return PropagationResult(
            mode=PropagationMode.DROP,
            reason=DropReason.UNREACHABLE_VIEW,
            detail=(
                f"No active relationship path from {base_view_name!r} to "
                f"{view_name!r}. Define a relationship in the Data Model, "
                f"or set cross_filter='both' if a reverse-direction filter is needed."
            ),
        )

    # Filter out paths that violate direction rules. Phase-1 resolver only
    # synthesises reverse edges for cross_filter='both'; therefore any path
    # already returned by resolve_paths is direction-legal at the edge level.
    # We additionally honor the "single-direction blocks reverse traversal"
    # rule for paths that legacy callers might generate — defensive.
    valid_paths = [p for p in all_paths if _path_respects_direction(p)]
    if not valid_paths:
        return PropagationResult(
            mode=PropagationMode.DROP,
            reason=DropReason.WRONG_DIRECTION,
            detail=(
                f"Path(s) from {base_view_name!r} to {view_name!r} cross a "
                f"single-direction relationship in the blocking direction. "
                f"Set cross_filter='both' on the relationship to enable "
                f"cross-fact propagation through a shared dimension."
            ),
        )

    # Multi-path → ambiguous unless role hint disambiguates.
    if len(valid_paths) > 1:
        if role:
            matched = [p for p in valid_paths if _path_has_role(p, role)]
            if len(matched) == 1:
                valid_paths = matched
            elif not matched:
                return PropagationResult(
                    mode=PropagationMode.DROP,
                    reason=DropReason.AMBIGUOUS_PATH,
                    detail=(
                        f"Role hint {role!r} matched none of "
                        f"{[_describe_path(p) for p in valid_paths]}"
                    ),
                )
            else:
                return PropagationResult(
                    mode=PropagationMode.DROP,
                    reason=DropReason.AMBIGUOUS_PATH,
                    detail=(
                        f"Role hint {role!r} matched multiple paths: "
                        f"{[_describe_path(p) for p in matched]}"
                    ),
                )
        if len(valid_paths) > 1:
            return PropagationResult(
                mode=PropagationMode.DROP,
                reason=DropReason.AMBIGUOUS_PATH,
                detail=(
                    f"Filter target {view_name!r} reachable from {base_view_name!r} "
                    f"via {len(valid_paths)} equivalent paths: "
                    f"{[_describe_path(p) for p in valid_paths]}. "
                    f"Specify a role hint (append '@<alias>' to the filter "
                    f"semanticField) or mark all-but-one path's cross_filter='single'."
                ),
            )

    path = valid_paths[0]
    has_fanout_hop = any(_is_fanout_traversal(step.edge) for step in path.steps)

    if not has_fanout_hop:
        # All hops are M:1 (or O:O) forward — safe to JOIN without fan-out.
        return PropagationResult(mode=PropagationMode.JOIN_CHAIN, path=path)

    # Fanout in path. Decide EXISTS vs SYMMETRIC based on whether the target
    # view (or any 1:N-hop intermediate) is also SELECT-side.
    target_node = path.steps[-1].edge.to_node
    # The hops where fan-out happens are all the intermediate to_nodes that
    # would multiply base rows. If ANY such node is in select_set → must JOIN
    # for projection → can't EXISTS-rewrite → require SYMMETRIC measure.
    fanout_node_in_select = (
        target_node in select_set
        or any(
            _is_fanout_traversal(step.edge) and step.edge.to_node in select_set
            for step in path.steps
        )
    )
    if fanout_node_in_select:
        return PropagationResult(
            mode=PropagationMode.SYMMETRIC,
            path=path,
            symmetric_views=frozenset([base_view_name]),
        )
    return PropagationResult(mode=PropagationMode.EXISTS, path=path)


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _parse_field_ref(ref: str) -> tuple[str, str, str | None]:
    """Parse ``view.col`` or ``view.col@role`` → ``(view, col, role|None)``.

    Whitespace stripped. Returns ``("", "", None)`` for unparseable input
    (caller treats as drop reason ``unreachable_view``).
    """
    if not ref or not isinstance(ref, str):
        return "", "", None
    s = ref.strip()
    role: str | None = None
    if "@" in s:
        s, role = s.rsplit("@", 1)
        role = role.strip() or None
    if "." not in s:
        return "", "", role
    view, col = s.rsplit(".", 1)
    return view.strip(), col.strip(), role


def _is_fanout_traversal(edge: JoinEdge) -> bool:
    """True when traversing this edge crosses a 1:N (or N:M) boundary.

    Forward direction implied: edge is FROM 'one' side TO 'many' side (1:N)
    or both sides 'many' (N:M). Both expand base rows → potential fan-out.
    """
    return edge.cardinality in ("one_to_many", "many_to_many")


def _path_respects_direction(path: JoinPath) -> bool:
    """All edges in path are direction-legal under cross_filter rules.

    The Phase-1 resolver already filters out cross_filter='single' reverse
    traversals at graph construction time (synthesised reverse only when
    'both'). This check is defensive for the case where the resolver was
    constructed with the legacy ``bidirectional=True`` flag (which forces
    reverse-everywhere). When that legacy flag is set, this function rejects
    any synthesised reverse hop whose original edge was 'single' direction.
    Currently the resolver doesn't preserve that history on synthetic edges,
    so we treat all reverse edges in path as valid — but the invariant is
    documented so Phase-2 callers know they must build resolver with
    ``bidirectional=False`` to get true PBI-direction semantics.
    """
    # Defensive no-op for now; the contract is encoded by the resolver.
    return True


def _path_has_role(path: JoinPath, role: str) -> bool:
    """Path contains a hop whose alias (to_node) matches the role hint."""
    role_norm = role.strip().lower()
    return any(step.edge.to_node.lower() == role_norm for step in path.steps)


def _describe_path(path: JoinPath) -> str:
    """Human-readable string: ``base → owner → deal → stage``."""
    if not path.steps:
        return "(empty)"
    nodes = [path.steps[0].edge.from_node]
    for step in path.steps:
        nodes.append(step.edge.to_node)
    return " → ".join(nodes)


__all__ = [
    "DropReason",
    "PropagationMode",
    "PropagationResult",
    "resolve_filter_propagation",
]
