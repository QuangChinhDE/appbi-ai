"""
Semantic join graph resolver.

Builds an in-memory join graph from a SemanticModel's explores and resolves
multi-hop join paths between views. Supports role-playing dimensions via the
optional `alias` field on a JoinDefinition.

Reference key concepts:
- "view name": the name of a SemanticView (logical table)
- "alias": an optional name on a join used to reference a joined view when the
  same view is joined multiple times (e.g. orders → users as creator vs updater).
  When alias is missing, falls back to the view name.
- "node id": the identifier used in the resolver graph. Equals alias when
  set, otherwise the view name. Semantic field references in chart bindings,
  filters, etc. use `node_id.field`.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Iterable

from sqlalchemy.orm import Session

from app.models.semantic import SemanticExplore, SemanticModel, SemanticView
from app.core.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True)
class JoinEdge:
    """A directed join edge from one node to another in the graph."""
    from_node: str       # source node id (alias or view)
    to_node: str         # target node id (alias or view)
    to_view: str         # actual view name to query
    type: str            # "left" | "inner" | "right" | "full"
    sql_on: str          # raw sql_on from join definition
    from_column: str | None
    to_column: str | None
    relationship: str | None


@dataclass(frozen=True)
class JoinStep:
    """One step in a resolved join path."""
    edge: JoinEdge
    alias_sql: str       # the SQL alias used in the FROM clause for this step
                         # (e.g. _appbi_sem_join_2)


@dataclass
class JoinPath:
    """A resolved multi-hop join path from base node to a target node."""
    target_node: str
    steps: list[JoinStep] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.steps


class SemanticJoinResolver:
    """Resolve multi-hop join paths within a SemanticModel.

    Build once per (model, base_view) — graph construction collects every
    explore in the model so multi-hop traversal can chain joins owned by
    different from-views.
    """

    def __init__(
        self,
        db: Session,
        model: SemanticModel | None,
        base_node: str,
        bidirectional: bool = False,
    ) -> None:
        self._db = db
        self._model = model
        self._base_node = base_node
        self._bidirectional = bidirectional
        # adjacency: from_node -> list[JoinEdge]
        self._adj: dict[str, list[JoinEdge]] = {}
        # node_id -> view_name (so we can find dimensions/measures)
        self._node_to_view: dict[str, str] = {base_node: base_node}
        if model is not None:
            self._build_graph(model)

    # ── graph construction ─────────────────────────────────────────────

    def _build_graph(self, model: SemanticModel) -> None:
        explores = list(model.explores or [])
        for explore in explores:
            from_view = str(getattr(explore, "base_view_name", "") or "").strip()
            if not from_view:
                continue
            self._node_to_view.setdefault(from_view, from_view)
            for join in explore.joins or []:
                edge = self._edge_from_join_dict(from_view, join)
                if edge is None:
                    continue
                self._adj.setdefault(edge.from_node, []).append(edge)
                self._node_to_view.setdefault(edge.to_node, edge.to_view)
                # In bidirectional mode add a reverse edge so views that are
                # normally only join *targets* can reach the base view.  We
                # only do this for simple column-equality joins because the
                # sql_on template cannot be reliably reversed.
                if self._bidirectional and edge.from_column and edge.to_column:
                    reverse = JoinEdge(
                        from_node=edge.to_node,
                        to_node=edge.from_node,
                        to_view=edge.from_node,
                        type="left",
                        sql_on="",
                        from_column=edge.to_column,
                        to_column=edge.from_column,
                        relationship=edge.relationship,
                    )
                    self._adj.setdefault(reverse.from_node, []).append(reverse)
                    self._node_to_view.setdefault(reverse.to_node, reverse.to_view)

    @staticmethod
    def _edge_from_join_dict(from_view: str, join: dict) -> JoinEdge | None:
        to_view = str(join.get("view") or "").strip()
        if not to_view:
            return None
        alias = str(join.get("alias") or "").strip() or to_view
        # `from_view` field may be set on a join when the explore base differs
        # from the actual source view (legacy data). Honor it when present.
        explicit_from = str(join.get("from_view") or "").strip()
        from_node = explicit_from or from_view
        return JoinEdge(
            from_node=from_node,
            to_node=alias,
            to_view=to_view,
            type=str(join.get("type") or "left"),
            sql_on=str(join.get("sql_on") or ""),
            from_column=(str(join.get("from_column") or "").strip() or None),
            to_column=(str(join.get("to_column") or "").strip() or None),
            relationship=(join.get("relationship") or None),
        )

    # ── public API ─────────────────────────────────────────────────────

    @property
    def base_node(self) -> str:
        return self._base_node

    def view_for_node(self, node_id: str) -> str | None:
        return self._node_to_view.get(node_id)

    def reachable_nodes(self) -> set[str]:
        """All node ids reachable from base_node, including base_node itself."""
        visited: set[str] = {self._base_node}
        queue: deque[str] = deque([self._base_node])
        while queue:
            current = queue.popleft()
            for edge in self._adj.get(current, []):
                if edge.to_node in visited:
                    continue
                visited.add(edge.to_node)
                queue.append(edge.to_node)
        return visited

    def resolve_path(self, target_node: str) -> JoinPath | None:
        """BFS shortest path from base_node to target_node.

        Returns None when target is unreachable. Returns an empty-step path
        when target equals base_node. Logs a warning on ambiguous ties.
        """
        if target_node == self._base_node:
            return JoinPath(target_node=target_node, steps=[])

        # BFS tracking parent edge per discovered node
        parent: dict[str, JoinEdge] = {}
        visited: set[str] = {self._base_node}
        queue: deque[str] = deque([self._base_node])
        ambiguous_tie = False

        while queue:
            current = queue.popleft()
            for edge in self._adj.get(current, []):
                if edge.to_node in visited:
                    # tie at same depth → ambiguous (we keep the first path)
                    if edge.to_node == target_node:
                        ambiguous_tie = True
                    continue
                visited.add(edge.to_node)
                parent[edge.to_node] = edge
                if edge.to_node == target_node:
                    if ambiguous_tie:
                        logger.warning(
                            "Ambiguous join paths to %r in model; using first discovered path.",
                            target_node,
                        )
                    return self._reconstruct_path(target_node, parent)
                queue.append(edge.to_node)

        return None

    def _reconstruct_path(
        self,
        target_node: str,
        parent: dict[str, JoinEdge],
    ) -> JoinPath:
        edges_reversed: list[JoinEdge] = []
        node = target_node
        while node != self._base_node:
            edge = parent.get(node)
            if edge is None:
                break
            edges_reversed.append(edge)
            node = edge.from_node
        edges = list(reversed(edges_reversed))
        steps = [
            JoinStep(edge=edge, alias_sql=f"_appbi_sem_join_{idx}")
            for idx, edge in enumerate(edges)
        ]
        return JoinPath(target_node=target_node, steps=steps)


def reachable_fields_for_model(
    db: Session,
    model: SemanticModel | None,
    base_view: SemanticView | None,
) -> tuple[list[str], list[str], list[str]]:
    """Compute the reachable views and fields from `base_view` within `model`.

    Returns (reachable_node_ids, reachable_dimension_fields, reachable_measure_fields)
    where each field is qualified `node_id.field_name`.

    "Reachable" means traversable via explore joins (multi-hop) starting from
    base_view's node. Includes base_view fields.
    """
    if base_view is None:
        return [], [], []
    base_node = base_view.name
    resolver = SemanticJoinResolver(db, model, base_node, bidirectional=True)

    nodes = resolver.reachable_nodes()

    # Map node_id -> SemanticView (lookup once)
    view_by_name: dict[str, SemanticView] = {}
    target_view_names = {resolver.view_for_node(n) for n in nodes if resolver.view_for_node(n)}
    if target_view_names:
        rows = (
            db.query(SemanticView)
            .filter(SemanticView.name.in_(list(target_view_names)))
            .all()
        )
        view_by_name = {v.name: v for v in rows}

    dimension_fields: list[str] = []
    measure_fields: list[str] = []
    for node_id in sorted(nodes):
        view_name = resolver.view_for_node(node_id)
        if not view_name:
            continue
        view_obj = view_by_name.get(view_name)
        if view_obj is None:
            continue
        for dim in view_obj.dimensions or []:
            name = str((dim or {}).get("name") or "").strip()
            if name:
                dimension_fields.append(f"{node_id}.{name}")
        for meas in view_obj.measures or []:
            name = str((meas or {}).get("name") or "").strip()
            if name:
                measure_fields.append(f"{node_id}.{name}")

    return sorted(nodes), sorted(set(dimension_fields)), sorted(set(measure_fields))


__all__ = [
    "JoinEdge",
    "JoinStep",
    "JoinPath",
    "SemanticJoinResolver",
    "reachable_fields_for_model",
]
